/**
 * @astra/math-gateway — P4 R0/WORK shared-root model-call gate (pure, no I/O).
 *
 * Owns transport/resource bookkeeping only. It dispatches nothing, keeps no
 * timer, refreshes no root budget and makes no mathematical decision.
 */

import { P2Error, p2Snapshot } from "@astra/protocol";
import type { P2Task, P2TransportStatus, P4R0Binding, P4R0Preparation } from "@astra/protocol";

export const P4_R0_GATE_VERSION = "0.0.0-p4r0" as const;

/** Below this remaining time a call is refused rather than started. */
export const P4_R0_MIN_REMAINING_MS = 25 as const;

/**
 * Hard ceiling on the shared root call allowance. The R0 stage is a fixed
 * five-call design (three independent role reviews + one targeted recheck +
 * at most one plan revision), so the shared root allowance it can be admitted
 * against is five, never four.
 */
export const P4_R0_MAX_MODEL_CALLS = 5 as const;

/** Default share of the root allowance reserved for R0 planning. */
export const P4_R0_DEFAULT_PLANNING_PERCENT = 25 as const;

export const P4_R0_MODEL_STATE = ["ADMITTED", "DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN"] as const;
export type P4R0ModelState = (typeof P4_R0_MODEL_STATE)[number];

export const P4_R0_PHASE = ["R0", "WORK"] as const;
export type P4R0Phase = (typeof P4_R0_PHASE)[number];

/** One admitted call. `taskId`/`scopeId` are null for the R0 planning call. */
export interface P4R0ModelRecord {
  readonly requestId: string;
  readonly phase: P4R0Phase;
  readonly taskId: string | null;
  readonly scopeId: string | null;
  readonly ordinal: number;
  readonly planHash: string;
  readonly state: P4R0ModelState;
  readonly transport: P2TransportStatus | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Session ids are bounded at 128 codepoints, matching the P0 id bound. */
const MAX_SESSION_CHARS = 128;

function requireShortString(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maxChars) {
    throw new P2Error("PACKET_BINDING");
  }
  if (value.trim().length === 0 || LONE_SURROGATE.test(value)) {
    throw new P2Error("PACKET_BINDING");
  }
  return value;
}

function requireSessionId(value: unknown): string {
  return requireShortString(value, MAX_SESSION_CHARS);
}

function requireTaskId(value: unknown): string {
  return requireShortString(value, 256);
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new P2Error("PACKET_BINDING");
  }
  return value;
}

function requireTransport(value: unknown): P2TransportStatus {
  if (value === "COMPLETE" || value === "TRUNCATED" || value === "ERROR" || value === "UNKNOWN") {
    return value;
  }
  throw new P2Error("PACKET_BINDING");
}

function requireRemainingMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 3_600_000) {
    throw new P2Error("PACKET_BINDING");
  }
  if ((value as number) <= P4_R0_MIN_REMAINING_MS) {
    throw new P2Error("DEADLINE_EXCEEDED");
  }
  return value as number;
}

/** The exact four binding keys; an extra or missing key is a hard failure. */
const R0_BINDING_FIELDS = ["sessionId", "problemHash", "contractVersion", "planHash"] as const;

/**
 * Strict structural read of one R0 binding: exactly the four declared keys,
 * no extra and no missing field, each value of the declared shape. Returns the
 * frozen binding so callers never keep a live reference.
 */
function readR0Binding(value: unknown): P4R0Binding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error("PACKET_BINDING");
  }
  const frozen = p2Snapshot(value) as Record<string, unknown>;
  const keys = Object.keys(frozen);
  if (keys.length !== R0_BINDING_FIELDS.length) {
    throw new P2Error("PACKET_BINDING");
  }
  for (const field of R0_BINDING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(frozen, field)) {
      throw new P2Error("PACKET_BINDING");
    }
  }
  const sessionId = requireSessionId(frozen.sessionId);
  const problemHash = requireHash(frozen.problemHash);
  const planHash = requireHash(frozen.planHash);
  const contractVersion = frozen.contractVersion;
  if (!Number.isSafeInteger(contractVersion) || (contractVersion as number) < 1) {
    throw new P2Error("PACKET_BINDING");
  }
  return p2Snapshot({
    sessionId,
    problemHash,
    contractVersion: contractVersion as number,
    planHash,
  }) as P4R0Binding;
}

/** Exact four-key equality of two already-validated bindings. */
function sameBinding(left: P4R0Binding, right: P4R0Binding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.problemHash === right.problemHash &&
    left.contractVersion === right.contractVersion &&
    left.planHash === right.planHash
  );
}

/**
 * Sequential gate over one shared root allowance of at most `maxModelCalls`
 * (0..4) calls. `planningPercent` (0..100) only splits the call count; it is
 * not a token or wall-clock share. Every guard runs before the first mutation.
 */
export class P4R0ModelGate {
  private readonly binding: P4R0Binding;
  private readonly maxModelCalls: number;
  private readonly planningPercent: number;
  private readonly records: P4R0ModelRecord[] = [];
  private stopped = false;

  constructor(binding: P4R0Binding, maxModelCalls: number = 1, planningPercent: number = P4_R0_DEFAULT_PLANNING_PERCENT) {
    const frozen = readR0Binding(binding);
    if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > P4_R0_MAX_MODEL_CALLS) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(planningPercent) || planningPercent < 0 || planningPercent > 100) {
      throw new P2Error("PACKET_BINDING");
    }
    this.binding = frozen;
    this.maxModelCalls = maxModelCalls;
    this.planningPercent = planningPercent;
  }

  /** Planning share of the root allowance, capped at one call. */
  planningAllowance(): number {
    return Math.min(1, Math.floor((this.maxModelCalls * this.planningPercent) / 100));
  }

  /**
   * Admit the R0 planning calls. Requires an exact plan binding, a
   * REQUEST_REVIEW preparation with UNKNOWN semantics, and a root allowance
   * that covers at least two calls and still leaves one call for later work.
   * The per-role review records and the aggregate are owned by M4; this gate
   * only admits the shared-root phase once, in ordinal order.
   */
  admitR0(prep: P4R0Preparation, remainingMs: number): P4R0ModelRecord {
    if (typeof prep !== "object" || prep === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const frozen = p2Snapshot(prep);
    const remaining = requireRemainingMs(remainingMs);
    const target = frozen.target;
    if (typeof target !== "object" || target === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const targetBinding = readR0Binding(target.binding);
    const planHash = targetBinding.planHash;

    if (this.records.length !== 0) {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    if (this.stopped) {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    if (this.maxModelCalls < 2 || this.planningAllowance() !== 1) {
      throw new P2Error("BUDGET_EXHAUSTED");
    }
    if (remaining <= P4_R0_MIN_REMAINING_MS) {
      throw new P2Error("DEADLINE_EXCEEDED");
    }
    if (
      frozen.action !== "REQUEST_REVIEW" ||
      frozen.structuralMatch !== true ||
      frozen.semanticResult !== "UNKNOWN" ||
      frozen.canSupportObligation !== false
    ) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!sameBinding(targetBinding, this.binding)) {
      throw new P2Error("PACKET_BINDING");
    }
    if (
      !Number.isSafeInteger(frozen.planningModelCalls) ||
      frozen.planningModelCalls !== 1 ||
      !Number.isSafeInteger(frozen.remainingRootCalls) ||
      frozen.remainingRootCalls < 2 ||
      frozen.remainingRootCalls > this.maxModelCalls ||
      !Number.isSafeInteger(frozen.remainingMs) ||
      frozen.remainingMs < remaining ||
      frozen.remainingMs > 3_600_000
    ) {
      throw new P2Error("PACKET_BINDING");
    }

    const record: P4R0ModelRecord = p2Snapshot({
      requestId: "model-1",
      phase: "R0",
      taskId: null,
      scopeId: null,
      ordinal: 1,
      planHash,
      state: "ADMITTED",
      transport: null,
    });
    this.records.push(record);
    return record;
  }

  /**
   * Admit at most one WORK call for a real RUNNING M1 task bound to this root.
   * The request id is derived from the phase, never chosen by a model.
   */
  admitWork(task: P2Task, remainingMs: number): P4R0ModelRecord {
    if (typeof task !== "object" || task === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const frozen = p2Snapshot(task);
    const remaining = requireRemainingMs(remainingMs);
    const envelope = frozen.envelope;
    if (typeof envelope !== "object" || envelope === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const taskId = requireTaskId(frozen.taskId);
    const scopeId = requireHash(frozen.scopeId);

    if (this.stopped) {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    if (this.records.some((record) => record.phase === "WORK")) {
      throw new P2Error("BUDGET_EXHAUSTED");
    }
    if (this.records.length >= this.maxModelCalls) {
      throw new P2Error("BUDGET_EXHAUSTED");
    }
    if (this.maxModelCalls - this.records.length < 1) {
      throw new P2Error("BUDGET_EXHAUSTED");
    }
    if (remaining <= P4_R0_MIN_REMAINING_MS) {
      throw new P2Error("DEADLINE_EXCEEDED");
    }
    for (const record of this.records) {
      if (record.phase !== "R0" || record.state !== "RETURNED" || record.transport !== "COMPLETE") {
        throw new P2Error("ILLEGAL_TRANSITION");
      }
    }
    if (
      frozen.delivery !== "RUNNING" ||
      envelope.sourceModule !== "M1" ||
      envelope.sessionId !== this.binding.sessionId ||
      envelope.problemHash !== this.binding.problemHash ||
      envelope.contractVersion !== this.binding.contractVersion ||
      envelope.taskId !== taskId ||
      envelope.scopeId !== scopeId
    ) {
      throw new P2Error("PACKET_BINDING");
    }

    const ordinal = this.records.length + 1;
    const record: P4R0ModelRecord = p2Snapshot({
      requestId: ordinal === 1 ? "model-1" : "model-2",
      phase: "WORK",
      taskId,
      scopeId,
      ordinal,
      planHash: this.binding.planHash,
      state: "ADMITTED",
      transport: null,
    });
    this.records.push(record);
    return record;
  }

  /** Move the current last record ADMITTED -> DISPATCHED, exactly once. */
  markDispatched(requestId: string): P4R0ModelRecord {
    const request = requireTaskId(requestId);
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.requestId !== request || last.state !== "ADMITTED") {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    const next: P4R0ModelRecord = p2Snapshot({ ...last, state: "DISPATCHED" });
    this.records[this.records.length - 1] = next;
    return next;
  }

  /**
   * Settle the current last DISPATCHED record. `UNKNOWN` becomes
   * OUTCOME_UNKNOWN; any status other than COMPLETE stops the gate permanently.
   */
  settle(requestId: string, transport: P2TransportStatus): P4R0ModelRecord {
    const request = requireTaskId(requestId);
    const status = requireTransport(transport);
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.requestId !== request || last.state !== "DISPATCHED") {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    const state: P4R0ModelState = status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "RETURNED";
    const next: P4R0ModelRecord = p2Snapshot({ ...last, state, transport: status });
    this.records[this.records.length - 1] = next;
    if (status !== "COMPLETE") {
      this.stopped = true;
    }
    return next;
  }

  /** Deep-frozen copy of every record; no live reference escapes. */
  snapshot(): readonly P4R0ModelRecord[] {
    return p2Snapshot(this.records);
  }
}
