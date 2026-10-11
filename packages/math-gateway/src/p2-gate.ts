/**
 * @astra/math-gateway — P2 M2 model-call admission gate (pure, no I/O).
 *
 * Records the four distinct call states ADMITTED / DISPATCHED / RETURNED /
 * OUTCOME_UNKNOWN. A record is never mathematical acceptance, and this module
 * dispatches nothing: it owns no transport, no timer and no budget refresh.
 */

import { P2Error } from "@astra/protocol";
import type { P2Contract, P2Task, P2TransportStatus } from "@astra/protocol";
import { p2Snapshot } from "@astra/protocol";

export const P2_MODEL_GATE_VERSION = "0.0.0-p2a" as const;

/** Below this remaining time a call is refused rather than started. */
export const P2_MIN_REMAINING_MS = 25 as const;

/** Hard ceiling on admitted calls in this phase. */
export const P2_MAX_MODEL_CALLS = 3 as const;

export const P2_MODEL_STATE = ["ADMITTED", "DISPATCHED", "RETURNED", "OUTCOME_UNKNOWN"] as const;
export type P2ModelState = (typeof P2_MODEL_STATE)[number];

export interface P2ModelPermit {
  readonly requestId: string;
  readonly taskId: string;
  readonly scopeId: string;
  readonly ordinal: number;
}

export interface P2ModelRecord extends P2ModelPermit {
  readonly state: P2ModelState;
  readonly transport: P2TransportStatus | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function requireShortString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 256) {
    throw new P2Error("PACKET_BINDING");
  }
  if (value.trim().length === 0) {
    throw new P2Error("PACKET_BINDING");
  }
  if (LONE_SURROGATE.test(value)) {
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

/**
 * Sequential admission gate for at most `maxCalls` (0..3) model calls.
 *
 * Every guard runs before the first mutation, so a rejected call leaves the
 * record list, the sequence and the stopped flag untouched.
 */
export class P2ModelGate {
  private readonly sessionId: string;
  private readonly problemHash: string;
  private readonly contractVersion: number;
  private readonly maxCalls: number;
  private readonly records: P2ModelRecord[] = [];
  private stopped = false;

  constructor(sessionId: string, problemHash: string, contractVersion: number, maxCalls: number) {
    this.sessionId = requireShortString(sessionId);
    if (typeof problemHash !== "string" || !HEX64.test(problemHash)) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > P2_MAX_MODEL_CALLS) {
      throw new P2Error("PACKET_BINDING");
    }
    this.problemHash = problemHash;
    this.contractVersion = contractVersion;
    this.maxCalls = maxCalls;
  }

  /**
   * Admit one call for a RUNNING task. The task snapshot must be fully bound to
   * this gate; its input refs are carried, never interpreted.
   */
  admit(task: P2Task, requestId: string, remainingMs: number): P2ModelPermit {
    if (typeof task !== "object" || task === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const frozen = p2Snapshot(task);
    const request = requireShortString(requestId);
    const envelope = frozen.envelope;
    if (typeof envelope !== "object" || envelope === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const taskId = requireShortString(frozen.taskId);
    const scopeId = requireShortString(frozen.scopeId);

    if (this.records.some((record) => record.requestId === request)) {
      throw new P2Error("DUPLICATE_REQUEST_ID");
    }
    if (request !== `model-${this.records.length + 1}`) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 0 || remainingMs > 5000) {
      throw new P2Error("PACKET_BINDING");
    }
    if (remainingMs <= P2_MIN_REMAINING_MS) {
      throw new P2Error("DEADLINE_EXCEEDED");
    }
    if (this.records.length >= this.maxCalls) {
      throw new P2Error("BUDGET_EXHAUSTED");
    }
    if (this.stopped) {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    for (const record of this.records) {
      if (record.state !== "RETURNED" || record.transport !== "COMPLETE") {
        throw new P2Error("ILLEGAL_TRANSITION");
      }
    }

    if (
      frozen.delivery !== "RUNNING" ||
      envelope.sourceModule !== "M1" ||
      envelope.sessionId !== this.sessionId ||
      envelope.problemHash !== this.problemHash ||
      envelope.contractVersion !== this.contractVersion ||
      envelope.taskId !== taskId ||
      envelope.scopeId !== scopeId
    ) {
      throw new P2Error("PACKET_BINDING");
    }

    const record: P2ModelRecord = p2Snapshot({
      requestId: request,
      taskId,
      scopeId,
      ordinal: this.records.length + 1,
      state: "ADMITTED",
      transport: null,
    });
    this.records.push(record);
    return record;
  }

  /** Move the current last record ADMITTED -> DISPATCHED, exactly once. */
  markDispatched(requestId: string): P2ModelRecord {
    const request = requireShortString(requestId);
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.requestId !== request || last.state !== "ADMITTED") {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    const next: P2ModelRecord = p2Snapshot({ ...last, state: "DISPATCHED" });
    this.records[this.records.length - 1] = next;
    return next;
  }

  /**
   * Settle the current last DISPATCHED record. `UNKNOWN` becomes
   * OUTCOME_UNKNOWN; every other status becomes RETURNED. Any status other
   * than COMPLETE stops the gate permanently.
   */
  settle(requestId: string, transport: P2TransportStatus): P2ModelRecord {
    const request = requireShortString(requestId);
    const status = requireTransport(transport);
    const last = this.records[this.records.length - 1];
    if (last === undefined || last.requestId !== request || last.state !== "DISPATCHED") {
      throw new P2Error("ILLEGAL_TRANSITION");
    }
    const state: P2ModelState = status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "RETURNED";
    const next: P2ModelRecord = p2Snapshot({ ...last, state, transport: status });
    this.records[this.records.length - 1] = next;
    if (status !== "COMPLETE") {
      this.stopped = true;
    }
    return next;
  }

  /** Deep-frozen copy of every record; no live reference escapes. */
  snapshot(): readonly P2ModelRecord[] {
    return p2Snapshot(this.records);
  }
}

const KIND_PRIORITY: Readonly<Record<string, number>> = {
  CANDIDATE_VALIDITY: 0,
  BOUNDARY_EXCEPTIONS: 1,
};

/**
 * Pick the next ready task from a trusted M1 ready snapshot: candidate
 * validity first, boundary exceptions second, tasks that already have inputs
 * third, everything else last. Ties keep the M1 order. This ordering is a
 * scheduling rule, not a mathematical planning proof.
 */
export function chooseP2ReadyTask(contract: P2Contract, ready: readonly P2Task[]): P2Task | null {
  const frozenContract = p2Snapshot(contract);
  if (!Array.isArray(ready) || ready.length > 32) {
    throw new P2Error("PACKET_BINDING");
  }
  const frozenReady = p2Snapshot(ready);
  if (frozenReady.length === 0) {
    return null;
  }
  const obligations = new Map(frozenContract.obligations.map((entry) => [entry.obligationId, entry]));
  const ranked = frozenReady.map((task, index) => {
    if (typeof task !== "object" || task === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const envelope = task.envelope;
    if (typeof envelope !== "object" || envelope === null) {
      throw new P2Error("PACKET_BINDING");
    }
    const taskId = requireShortString(task.taskId);
    const scopeId = requireShortString(task.scopeId);
    if (
      envelope.sourceModule !== "M1" ||
      envelope.sessionId !== frozenContract.envelope.sessionId ||
      envelope.problemHash !== frozenContract.problemHash ||
      envelope.contractVersion !== frozenContract.contractVersion ||
      envelope.taskId !== taskId ||
      envelope.scopeId !== scopeId
    ) {
      throw new P2Error("PACKET_BINDING");
    }
    const obligation = obligations.get(task.obligationId);
    if (obligation === undefined) {
      throw new P2Error("PACKET_BINDING");
    }
    if (obligation.goalId !== task.goalId || obligation.envelope.scopeId !== scopeId) {
      throw new P2Error("PACKET_BINDING");
    }
    if (task.delivery !== "READY" && task.delivery !== "PARTIAL") {
      throw new P2Error("PACKET_BINDING");
    }
    const kindRank = KIND_PRIORITY[obligation.kind];
    const rank = kindRank !== undefined ? kindRank : task.inputArtifactRefs.length > 0 ? 2 : 3;
    return { task, rank, index };
  });
  ranked.sort((left, right) => (left.rank !== right.rank ? left.rank - right.rank : left.index - right.index));
  const best = ranked[0];
  return best === undefined ? null : p2Snapshot(best.task);
}
