/**
 * @astra/math-gateway — P3 effect admission gate (pure, no I/O).
 *
 * Owns the sequential ADMITTED/DISPATCHED/OBSERVED/OUTCOME_UNKNOWN record
 * list, the per-key cache and the effect/method quotas. It dispatches nothing:
 * a receipt is validated against its request before any mutation, and every
 * receipt stays PROVISIONAL/UNKNOWN.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type P3Action,
  type P3Binding,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { parseP3Action } from "./p3-parser.js";
import { p3Binding, p3EffectKey, p3EffectReceipt, p3EffectRequest } from "./p3-effect-data.js";

export const P3_EFFECT_GATE_VERSION = "0.0.0-p3a" as const;
export const P3_MAX_EFFECTS = 2 as const;
export const P3_MAX_METHOD_ATTEMPTS = 1 as const;
export const P3_MIN_REMAINING_MS = 26 as const;
export const P3_MAX_REMAINING_MS = 5000 as const;
export const P3_MAX_TURNS = 3 as const;
export const P3_EFFECT_STATE = ["ADMITTED", "DISPATCHED", "OBSERVED", "OUTCOME_UNKNOWN"] as const;
export type P3EffectState = (typeof P3_EFFECT_STATE)[number];
export const P3_ACTION_ID = ["PROPOSE_FINAL", "MARK_UNSOLVED", "CALL_REGISTERED_TOOL", "LOAD_METHOD"] as const;
export type P3ActionId = (typeof P3_ACTION_ID)[number];

export interface P3EffectRecord {
  readonly effectId: string;
  readonly request: P3EffectRequest;
  readonly key: string;
  readonly state: P3EffectState;
  readonly receipt: P3EffectReceipt | null;
}

export type P3AdmitResult =
  | { readonly status: "ADMITTED"; readonly request: P3EffectRequest }
  | { readonly status: "CACHED"; readonly receipt: P3EffectReceipt };

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

function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

export class P3EffectGate {
  private readonly base: Omit<P3Binding, "sourceRequestId">;
  private readonly maxEffects: number;
  private readonly firstEffectOrdinal: number;
  private readonly records: P3EffectRecord[] = [];
  private readonly cache = new Map<string, P3EffectReceipt>();
  private readonly usedSources = new Set<string>();
  private methodAttempts = 0;
  private unknown = false;

  constructor(
    base: Omit<P3Binding, "sourceRequestId">,
    maxEffects: number = P3_MAX_EFFECTS,
    firstEffectOrdinal: number = 1,
  ) {
    const bound = p3Binding({ ...p2Snapshot(base), sourceRequestId: "model-1" });
    this.base = p2Snapshot({
      sessionId: bound.sessionId,
      problemHash: bound.problemHash,
      contractVersion: bound.contractVersion,
      taskId: bound.taskId,
      scopeId: bound.scopeId,
    }) as Omit<P3Binding, "sourceRequestId">;
    this.maxEffects = boundedInt(maxEffects, 0, P3_MAX_EFFECTS);
    const first = boundedInt(firstEffectOrdinal, 1, P3_MAX_EFFECTS);
    if (first + this.maxEffects - 1 > P3_MAX_EFFECTS) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    this.firstEffectOrdinal = first;
  }

  private bindingOf(sourceRequestId: string): P3Binding {
    return p3Binding({ ...this.base, sourceRequestId });
  }

  private last(): P3EffectRecord | null {
    return this.records.length === 0 ? null : this.records[this.records.length - 1]!;
  }

  private requireLast(effectId: string): P3EffectRecord {
    const record = this.last();
    if (record === null || record.effectId !== effectId) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    return record;
  }

  private pending(): boolean {
    const record = this.last();
    return record !== null && (record.state === "ADMITTED" || record.state === "DISPATCHED");
  }

  admit(action: unknown, binding: unknown, remainingTurns: unknown, remainingMs: unknown): P3AdmitResult {
    const turns = boundedInt(remainingTurns, 1, P3_MAX_TURNS);
    const ms = boundedInt(remainingMs, P3_MIN_REMAINING_MS, P3_MAX_REMAINING_MS);
    const parsed = parseP3Action(JSON.stringify(p2Snapshot(action)));
    const source = p2Snapshot(binding);
    if (!isPlainObject(source) || !exactKeys(source, ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId", "sourceRequestId"])) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const bound = p3Binding(source);
    for (const key of ["sessionId", "problemHash", "contractVersion", "taskId", "scopeId"] as const) {
      if (bound[key] !== this.base[key]) {
        fail(P2_ERROR_CODES.PACKET_BINDING);
      }
    }
    if (parsed.action !== "tool" && parsed.action !== "method") {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (turns <= 1) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (this.unknown || this.pending()) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (this.usedSources.has(bound.sourceRequestId)) {
      fail(P2_ERROR_CODES.DUPLICATE_REQUEST_ID);
    }
    const key = p3EffectKey(parsed);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.usedSources.add(bound.sourceRequestId);
      return p2Snapshot({ status: "CACHED", receipt: cached }) as P3AdmitResult;
    }
    if (this.records.length >= this.maxEffects) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (parsed.action === "method") {
      if (this.methodAttempts >= P3_MAX_METHOD_ATTEMPTS) {
        fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
      }
    }
    const effectId = `effect-${this.firstEffectOrdinal + this.records.length}`;
    const request = p3EffectRequest({
      effectId,
      binding: this.bindingOf(bound.sourceRequestId),
      action: parsed,
      remainingMs: ms,
    });
    this.records.push(p2Snapshot({ effectId, request, key, state: "ADMITTED", receipt: null }) as P3EffectRecord);
    this.usedSources.add(bound.sourceRequestId);
    if (parsed.action === "method") {
      this.methodAttempts += 1;
    }
    return p2Snapshot({ status: "ADMITTED", request }) as P3AdmitResult;
  }

  markDispatched(effectId: string): P3EffectRecord {
    const record = this.requireLast(effectId);
    if (record.state !== "ADMITTED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const next = p2Snapshot({ ...record, state: "DISPATCHED" }) as P3EffectRecord;
    this.records[this.records.length - 1] = next;
    return p2Snapshot(next) as P3EffectRecord;
  }

  settle(receipt: unknown): P3EffectRecord {
    const record = this.last();
    if (record === null || record.state !== "DISPATCHED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const checked = p3EffectReceipt(receipt, record.request);
    const state: P3EffectState = checked.status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "OBSERVED";
    const next = p2Snapshot({ ...record, state, receipt: checked }) as P3EffectRecord;
    this.records[this.records.length - 1] = next;
    if (state === "OBSERVED") {
      this.cache.set(record.key, checked);
    } else {
      this.unknown = true;
    }
    return p2Snapshot(next) as P3EffectRecord;
  }

  snapshot(): readonly P3EffectRecord[] {
    return p2Snapshot(this.records.map((record) => ({ ...record }))) as readonly P3EffectRecord[];
  }

  allowedActionIds(remainingTurns: unknown, remainingMs: unknown): readonly string[] {
    const turns = boundedInt(remainingTurns, 1, P3_MAX_TURNS);
    const ms = boundedInt(remainingMs, 0, P3_MAX_REMAINING_MS);
    const allowed: string[] = [];
    if (ms <= 25) {
      return p2Snapshot(allowed) as readonly string[];
    }
    allowed.push("PROPOSE_FINAL", "MARK_UNSOLVED");
    if (turns > 1 && !this.unknown && !this.pending()) {
      const observedTool = this.records.some(
        (record) => record.state === "OBSERVED" && record.request.action.action === "tool",
      );
      const observedMethod = this.records.some(
        (record) => record.state === "OBSERVED" && record.request.action.action === "method",
      );
      const toolQuota = this.records.length < this.maxEffects;
      const methodQuota = this.methodAttempts < P3_MAX_METHOD_ATTEMPTS && this.records.length < this.maxEffects;
      if (toolQuota || observedTool) {
        allowed.push("CALL_REGISTERED_TOOL");
      }
      if (methodQuota || observedMethod) {
        allowed.push("LOAD_METHOD");
      }
    }
    return p2Snapshot(allowed) as readonly string[];
  }
}
