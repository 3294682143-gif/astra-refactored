/**
 * @astra/math-gateway — P3 effect binding/identity helpers (pure, no I/O).
 *
 * Validates trusted control-side bindings, computes a canonical effect
 * identity key and checks effect receipts against their request. Nothing here
 * dispatches, authenticates or promotes evidence.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  type P3Binding,
  type P3EffectAction,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { createHash } from "node:crypto";
import { parseP3Action } from "./p3-parser.js";

const MAX_SESSION_CHARS = 128;
const MAX_TASK_CHARS = 256;
const MAX_OBSERVATION_BYTES = 16000;
const MIN_REMAINING_MS = 26;
const MAX_REMAINING_MS = 3_600_000;
// Effect bindings may name any root model request id the session can produce;
// the previous three-entry table made every tool call after the third one a
// fixed PACKET_BINDING once the contract grew past three obligations.
const REQUEST_ID = /^model-(?:[1-9][0-9]{0,2})$/u;
// Six ids: up to four method cards and two tool effects coexist in one window.
const EFFECT_IDS = [
  "effect-1",
  "effect-2",
  "effect-3",
  "effect-4",
  "effect-5",
  "effect-6",
] as const;
const HASH = /^[0-9a-f]{64}$/u;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

function boundedId(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(value).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if ([...value].length > maxChars) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function hashOf(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Validate one trusted control-side binding. Identity is never rewritten. */
export function p3Binding(value: unknown): P3Binding {
  const source = p2Snapshot(value);
  if (!isPlainObject(source) || !exactKeys(source, ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"])) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const sessionId = boundedId(source.sessionId, MAX_SESSION_CHARS);
  const problemHash = hashOf(source.problemHash);
  const contractVersion = source.contractVersion;
  if (typeof contractVersion !== "number" || !Number.isSafeInteger(contractVersion) || contractVersion <= 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const taskId = boundedId(source.taskId, MAX_TASK_CHARS);
  const scopeId = hashOf(source.scopeId);
  const sourceRequestId = source.sourceRequestId;
  if (typeof sourceRequestId !== "string" || !REQUEST_ID.test(sourceRequestId)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return p2Snapshot({ sessionId, problemHash, contractVersion, taskId, scopeId, sourceRequestId }) as P3Binding;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareCodePoints);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare two strings by Unicode code point, not by UTF-16 code unit. The
 * built-in `<` orders a surrogate pair after U+E000..U+FFFF, which would make
 * the canonical key order depend on the encoding rather than on the text.
 */
function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  if (leftPoints.length === rightPoints.length) {
    return 0;
  }
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

/**
 * Canonical identity of one tool/method/exploration action. The description
 * wording of a `scope` is excluded (an exploration is identified by its source
 * alone); array order is preserved. This is an identity of the same data, not
 * a mathematical equivalence.
 */
export function p3EffectKey(action: P3EffectAction): string {
  const parsed = parseP3Action(JSON.stringify(p2Snapshot(action)));
  if (parsed.action === "tool") {
    return sha256(canonical(["tool", parsed.name, parsed.args]));
  }
  if (parsed.action === "method") {
    return sha256(canonical(["method", parsed.id]));
  }
  if (parsed.action === "explore") {
    return sha256(canonical(["explore", parsed.code]));
  }
  fail(P2_ERROR_CODES.PACKET_SCHEMA);
}

/**
 * The fixed receipt `source` of one effect action. A tool produces a program
 * observation, a method card a method reference, and a bounded generated-Python
 * exploration an explicitly untrusted generated observation.
 */
function sourceOf(action: P3EffectAction): P3EffectReceipt["source"] {
  if (action.action === "tool") return "PROGRAM_OBSERVATION";
  if (action.action === "method") return "METHOD_REFERENCE";
  return "GENERATED_OBSERVATION";
}

/**
 * The fixed receipt `level` of one effect action. Only a generated observation
 * is `OBSERVED`; it is still never a proof, a certificate or a verification.
 */
function levelOf(action: P3EffectAction): P3EffectReceipt["level"] {
  return action.action === "explore" ? "OBSERVED" : "PROVISIONAL";
}

/** Validate one admitted effect request. */
export function p3EffectRequest(value: unknown): P3EffectRequest {
  const source = p2Snapshot(value);
  if (!isPlainObject(source) || !exactKeys(source, ["effectId", "binding", "action", "remainingMs"])) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const effectId = source.effectId;
  if (typeof effectId !== "string" || !(EFFECT_IDS as readonly string[]).includes(effectId)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const binding = p3Binding(source.binding);
  const action = parseP3Action(JSON.stringify(source.action));
  if (action.action !== "tool" && action.action !== "method" && action.action !== "explore") {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const remainingMs = source.remainingMs;
  if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs < MIN_REMAINING_MS || remainingMs > MAX_REMAINING_MS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return p2Snapshot({ effectId, binding, action, remainingMs }) as P3EffectRequest;
}

/** Validate one effect receipt against the request it claims to answer. */
export function p3EffectReceipt(value: unknown, request: P3EffectRequest): P3EffectReceipt {
  const source = p2Snapshot(value);
  if (!isPlainObject(source) || !exactKeys(source, ["effectId", "binding", "status", "source", "observation", "observationHash", "level", "checkResult"])) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (source.effectId !== request.effectId) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const binding = p3Binding(source.binding);
  for (const key of ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"] as const) {
    if (binding[key] !== request.binding[key]) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  const status = source.status;
  if (status !== "COMPLETE" && status !== "ERROR" && status !== "UNKNOWN") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const expectedSource = sourceOf(request.action);
  if (source.source !== expectedSource) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const observation = source.observation;
  if (typeof observation !== "string" || observation.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (!detectLoneSurrogates(observation).ok) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (Buffer.byteLength(observation, "utf8") > MAX_OBSERVATION_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const observationHash = hashOf(source.observationHash);
  if (sha256(observation) !== observationHash) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const expectedLevel = levelOf(request.action);
  if (source.level !== expectedLevel || source.checkResult !== "UNKNOWN") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  return p2Snapshot({
    effectId: request.effectId,
    binding: request.binding,
    status,
    source: expectedSource,
    observation,
    observationHash,
    level: expectedLevel,
    checkResult: "UNKNOWN",
  }) as P3EffectReceipt;
}

/** Fixed non-echoing failure receipt for a controller-side exception. */
export function p3EffectFailure(request: P3EffectRequest, status: "ERROR" | "UNKNOWN"): P3EffectReceipt {
  if (status !== "ERROR" && status !== "UNKNOWN") {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  const bound = p3EffectRequest(request);
  const observation = JSON.stringify({ code: status });
  return p2Snapshot({
    effectId: bound.effectId,
    binding: bound.binding,
    status,
    source: sourceOf(bound.action),
    observation,
    observationHash: sha256(observation),
    level: levelOf(bound.action),
    checkResult: "UNKNOWN",
  }) as P3EffectReceipt;
}
