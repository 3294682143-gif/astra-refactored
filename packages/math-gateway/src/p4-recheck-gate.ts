/**
 * @astra/math-gateway — P4 S2 recheck M2 model-call admission gate (pure, no I/O).
 *
 * One shared ledger for the four sequenced calls of the S2 recheck run
 * (work1 -> review2 -> repair3 -> recheck4). It records the four distinct call
 * states ADMITTED / DISPATCHED / RETURNED / OUTCOME_UNKNOWN. A record is never
 * mathematical acceptance, and this module dispatches nothing: it owns no
 * transport, no timer, no clock and no budget refresh.
 */

import { P2Error } from "@astra/protocol";
import type { P2Task, P2TransportStatus } from "@astra/protocol";
import { p2Snapshot } from "@astra/protocol";
import type { P2ModelPermit, P2ModelRecord } from "./p2-gate.js";

export const P4_RECHECK_GATE_VERSION = "0.0.0-p4s2" as const;

/** Below this remaining time a call is refused rather than started. */
export const P4_RECHECK_MIN_REMAINING_MS = 26 as const;

/** Hard ceiling on admitted calls in this phase. */
export const P4_RECHECK_MAX_MODEL_CALLS = 32 as const;

/** Default ceiling when the caller does not explicitly widen it. */
export const P4_RECHECK_DEFAULT_MODEL_CALLS = 3 as const;

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
 * Sequential admission gate for at most `maxCalls` (0..4) model calls sharing
 * one ledger. The default is 3; only an explicit 4 admits the fourth call.
 *
 * Every guard runs before the first mutation, so a rejected call leaves the
 * record list, the sequence and the stopped flag untouched.
 */
export class P4RecheckModelGate {
  private readonly sessionId: string;
  private readonly problemHash: string;
  private readonly contractVersion: number;
  private readonly maxCalls: number;
  private readonly records: P2ModelRecord[] = [];
  private stopped = false;

  private readonly startOrdinal: number;

  constructor(
    sessionId: string,
    problemHash: string,
    contractVersion: number,
    maxCalls: number = P4_RECHECK_DEFAULT_MODEL_CALLS,
    startOrdinal: number = 0,
  ) {
    this.sessionId = requireShortString(sessionId);
    if (typeof problemHash !== "string" || !HEX64.test(problemHash)) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > P4_RECHECK_MAX_MODEL_CALLS) {
      throw new P2Error("PACKET_BINDING");
    }
    // B1: the number of root ordinals already consumed before this gate opened
    // (e.g. by the bounded R0 pre-phase). The gate's own call sequence still
    // starts at `model-(startOrdinal+1)`.
    if (!Number.isSafeInteger(startOrdinal) || startOrdinal < 0) {
      throw new P2Error("PACKET_BINDING");
    }
    this.problemHash = problemHash;
    this.contractVersion = contractVersion;
    this.maxCalls = maxCalls;
    this.startOrdinal = startOrdinal;
  }

  /**
   * Admit one call for a RUNNING task. The task snapshot must be fully bound to
   * this gate; its input refs are carried, never interpreted.
   *
   * `phase` defaults to `WORK`, which keeps the original RUNNING-only rule. An
   * explicit `R2` admits a real DELIVERED task as well, so a review of an
   * already delivered artifact never has to be faked as RUNNING.
   */
  admit(
    task: P2Task,
    requestId: string,
    remainingMs: number,
    phase: "WORK" | "R2" | "REPAIR" = "WORK",
  ): P2ModelPermit {
    if (phase !== "WORK" && phase !== "R2" && phase !== "REPAIR") {
      throw new P2Error("PACKET_BINDING");
    }
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
    if (request !== `model-${this.records.length + 1 + this.startOrdinal}`) {
      throw new P2Error("PACKET_BINDING");
    }
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 0 || remainingMs > 3_600_000) {
      throw new P2Error("PACKET_BINDING");
    }
    if (remainingMs < P4_RECHECK_MIN_REMAINING_MS) {
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

    const deliveryOk =
      phase === "R2" || phase === "REPAIR"
        ? frozen.delivery === "RUNNING" || frozen.delivery === "DELIVERED"
        : frozen.delivery === "RUNNING";
    if (
      !deliveryOk ||
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
      ordinal: this.records.length + 1 + this.startOrdinal,
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
    const state = status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "RETURNED";
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
