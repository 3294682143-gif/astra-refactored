/**
 * @astra/stdio-runtime — unified AgentLoop I/O helpers (deterministic).
 *
 * Bounded await, strict model-receipt validation and one-shot capture of the
 * loop options/ports. No environment access, no network, no retry and no
 * cancellation claim: a late promise is observed, never left unhandled.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  validateP2GoalSpecs,
  type AgentLoopOptions,
  type AgentModelReceipt,
  type AgentPorts,
  type P2MethodCatalog,
  type P2GoalSpec,
  type P2TransportStatus,
} from "@astra/protocol";

export const AGENT_IO_MIN_REMAINING_MS = 25 as const;
export const AGENT_IO_MAX_REMAINING_MS = 5000 as const;
export const AGENT_IO_MAX_TEXT_CHARS = 20000;
export const AGENT_IO_MAX_TEXT_BYTES = 65536;

const TRANSPORTS = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
const RECEIPT_FIELDS = ["transportStatus", "text", "remainingMs"] as const;
const OPTION_FIELDS = [
  "maxModelCalls",
  "maxWorkUnits",
  "maxEffects",
  "maxReviews",
  "maxMethodLoads",
  "maxRepairs",
  "remainingMs",
  "policy",
  "now",
  "goalSpecs",
  "deriveBudget",
] as const;
const PORT_FIELDS = ["model", "effect", "catalog"] as const;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

/**
 * Await one async operation under the current remaining window. The timer is
 * the caller's remaining budget, not a new deadline; a timeout throws the
 * fixed DEADLINE_EXCEEDED code and the late promise is still observed so it
 * can never become an unhandled rejection. No retry, no cancel claim.
 */
export function boundedAwait<T>(operation: () => Promise<T>, remainingMs: number): Promise<T> {
  if (typeof operation !== "function") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (
    typeof remainingMs !== "number" ||
    !Number.isSafeInteger(remainingMs) ||
    remainingMs <= AGENT_IO_MIN_REMAINING_MS ||
    remainingMs > AGENT_IO_MAX_REMAINING_MS
  ) {
    fail(P2_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const started = Promise.resolve().then(operation);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new P2Error(P2_ERROR_CODES.DEADLINE_EXCEEDED));
    }, remainingMs);
  });
  const observed = started.then(
    (value) => value,
    (error: unknown) => {
      throw error;
    },
  );
  return Promise.race([observed, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    observed.catch(() => undefined);
  });
}

/**
 * Strict validation of one model receipt. Exactly the declared fields are
 * allowed; `text` may be empty (the parser decides invalid) but must be
 * surrogate-free and bounded. A provider error message is never attached.
 */
export function checkedAgentReceipt(value: unknown): AgentModelReceipt {
  const frozen = p2Snapshot(value);
  if (!isPlainObject(frozen)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = frozen as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length < 2 || keys.length > RECEIPT_FIELDS.length) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const key of keys) {
    if (!(RECEIPT_FIELDS as readonly string[]).includes(key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(source, "transportStatus")) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!Object.prototype.hasOwnProperty.call(source, "text")) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const transportStatus = source.transportStatus;
  if (typeof transportStatus !== "string" || !(TRANSPORTS as readonly string[]).includes(transportStatus)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const text = source.text;
  if (typeof text !== "string" || !detectLoneSurrogates(text).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...text].length > AGENT_IO_MAX_TEXT_CHARS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (Buffer.byteLength(text, "utf8") > AGENT_IO_MAX_TEXT_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const receipt: {
    transportStatus: P2TransportStatus;
    text: string;
    remainingMs?: number;
  } = { transportStatus: transportStatus as P2TransportStatus, text };
  if (Object.prototype.hasOwnProperty.call(source, "remainingMs")) {
    receipt.remainingMs = boundedInt(source.remainingMs, 0, AGENT_IO_MAX_REMAINING_MS);
  }
  return p2Snapshot(receipt) as AgentModelReceipt;
}

export interface CapturedAgentOptions {
  readonly maxModelCalls: number;
  readonly maxWorkUnits: number;
  readonly maxEffects: number;
  readonly maxReviews: number;
  readonly maxMethodLoads: number;
  readonly maxRepairs: number;
  readonly remainingMs: number;
  readonly policy: "BEST_EFFORT" | "STRICT";
  readonly goalSpecs: readonly P2GoalSpec[];
  readonly now: () => number;
  readonly deriveBudget: boolean;
}

/**
 * Capture the loop options once. Every property is read exactly once, unknown
 * keys are refused rather than ignored, and the clock handle is kept as a
 * function (it cannot survive a snapshot).
 */
export function captureAgentOptions(options: AgentLoopOptions): CapturedAgentOptions {
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = options as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(OPTION_FIELDS as readonly string[]).includes(key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const rawMaxModelCalls = source.maxModelCalls;
  const rawMaxWorkUnits = source.maxWorkUnits;
  const rawMaxEffects = source.maxEffects;
  const rawMaxReviews = source.maxReviews;
  const rawMaxMethodLoads = source.maxMethodLoads;
  const rawMaxRepairs = source.maxRepairs;
  const rawRemainingMs = source.remainingMs;
  const rawPolicy = source.policy;
  const rawNow = source.now;
  const rawGoalSpecs = source.goalSpecs;
  // Hard caps for the explicit root budget; defaults are the preview profile.
  const maxModelCalls =
    rawMaxModelCalls === undefined ? 4 : boundedInt(rawMaxModelCalls, 0, 32);
  const maxWorkUnits =
    rawMaxWorkUnits === undefined ? 2 : boundedInt(rawMaxWorkUnits, 1, 32);
  const maxEffects = rawMaxEffects === undefined ? 1 : boundedInt(rawMaxEffects, 0, 2);
  const maxReviews = rawMaxReviews === undefined ? 1 : boundedInt(rawMaxReviews, 0, 1);
  const maxMethodLoads =
    rawMaxMethodLoads === undefined ? 0 : boundedInt(rawMaxMethodLoads, 0, 1);
  const maxRepairs = rawMaxRepairs === undefined ? 0 : boundedInt(rawMaxRepairs, 0, 1);
  const remainingMs = boundedInt(rawRemainingMs, 1, AGENT_IO_MAX_REMAINING_MS);
  const policy = rawPolicy === undefined ? "BEST_EFFORT" : rawPolicy;
  if (policy !== "BEST_EFFORT" && policy !== "STRICT") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const now = rawNow === undefined ? (() => performance.now()) : rawNow;
  if (typeof now !== "function") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const goalSpecs =
    rawGoalSpecs === undefined
      ? []
      : validateP2GoalSpecs(p2Snapshot(rawGoalSpecs));
  const rawDeriveBudget = source.deriveBudget;
  if (rawDeriveBudget !== undefined && typeof rawDeriveBudget !== "boolean") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const deriveBudget = rawDeriveBudget === true;
  return Object.freeze({
    maxModelCalls,
    maxWorkUnits,
    maxEffects,
    maxReviews,
    maxMethodLoads,
    maxRepairs,
    remainingMs,
    policy,
    goalSpecs: p2Snapshot(goalSpecs) as readonly P2GoalSpec[],
    now: now as () => number,
    deriveBudget,
  });
}

/**
 * The single root-budget derivation. From the compiled task graph it asks for
 * one work unit per task plus the review and one final slot, clamped to the
 * hard caps. Node decides this budget and Python only verifies it.
 */
export const AGENT_ROOT_MAX_MODEL_CALLS = 32 as const;
export const AGENT_ROOT_MAX_WORK_UNITS = 32 as const;

export function deriveRootBudget(
  taskCount: number,
  maxReviews: number,
): { readonly maxWorkUnits: number; readonly maxModelCalls: number } {
  if (
    !Number.isSafeInteger(taskCount) ||
    taskCount < 1 ||
    !Number.isSafeInteger(maxReviews) ||
    maxReviews < 0
  ) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const maxWorkUnits = Math.min(Math.max(taskCount, 1), AGENT_ROOT_MAX_WORK_UNITS);
  const maxModelCalls = Math.min(maxWorkUnits + maxReviews + 1, AGENT_ROOT_MAX_MODEL_CALLS);
  return Object.freeze({ maxWorkUnits, maxModelCalls });
}

export interface CapturedAgentPorts {
  readonly model: { generate: (request: unknown) => Promise<unknown> };
  readonly effect: { execute: (request: unknown) => Promise<unknown> } | null;
  readonly catalog: { read: (remainingMs: number) => Promise<unknown> } | null;
}

/**
 * Capture the injected ports once. `model.generate` and `effect.execute` are
 * bound at capture time, so a later mutation of the caller's object cannot
 * redirect a call. A null effect port stays null.
 */
export function captureAgentPorts(ports: AgentPorts): CapturedAgentPorts {
  if (!isPlainObject(ports)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const source = ports as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(PORT_FIELDS as readonly string[]).includes(key)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const rawModel = source.model;
  const rawEffect = source.effect;
  const rawCatalog = source.catalog;
  if (!isPlainObject(rawModel)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const rawGenerate = (rawModel as Record<string, unknown>).generate;
  if (typeof rawGenerate !== "function") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const generate = rawGenerate.bind(rawModel) as (request: unknown) => Promise<unknown>;
  let catalog: { read: (remainingMs: number) => Promise<unknown> } | null = null;
  if (rawCatalog !== null && rawCatalog !== undefined) {
    if (!isPlainObject(rawCatalog)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const rawRead = (rawCatalog as Record<string, unknown>).read;
    if (typeof rawRead !== "function") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const read = rawRead.bind(rawCatalog) as (remainingMs: number) => Promise<unknown>;
    catalog = Object.freeze({ read });
  }
  if (rawEffect === null || rawEffect === undefined) {
    return Object.freeze({ model: Object.freeze({ generate }), effect: null, catalog });
  }
  if (!isPlainObject(rawEffect)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const rawExecute = (rawEffect as Record<string, unknown>).execute;
  if (typeof rawExecute !== "function") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const execute = rawExecute.bind(rawEffect) as (request: unknown) => Promise<unknown>;
  return Object.freeze({
    model: Object.freeze({ generate }),
    effect: Object.freeze({ execute }),
    catalog,
  });
}
