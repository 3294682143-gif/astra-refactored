/**
 * @astra/math-gateway — P4 S1 diagnostic effect gate (pure, no I/O).
 *
 * Terminal diagnostic admission for one control-side pre-bound check request.
 * It reuses the existing P3 request/receipt validators, owns a single-flight
 * quota and dispatches nothing. It does not require a model turn after the
 * tool, does not refresh any model budget and never promotes evidence.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2Snapshot,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { p3EffectReceipt, p3EffectRequest } from "./p3-effect-data.js";

export const P4_DIAGNOSTIC_GATE_VERSION = "0.0.0-p4a" as const;
export const P4_DIAGNOSTIC_MAX_CHECKS = 1 as const;
export const P4_DIAGNOSTIC_MIN_REMAINING_MS = 26 as const;
export const P4_DIAGNOSTIC_MAX_REMAINING_MS = 3_600_000 as const;
export const P4_DIAGNOSTIC_LATE_MS = 25 as const;

export const P4_DIAGNOSTIC_STATE = [
  "ADMITTED",
  "DISPATCHED",
  "OBSERVED",
  "OUTCOME_UNKNOWN",
] as const;
export type P4DiagnosticState = (typeof P4_DIAGNOSTIC_STATE)[number];

export const P4_DIAGNOSTIC_CODE = [
  "NOT_DISPATCHED",
  "OBSERVED",
  "ERROR",
  "DEADLINE_EXCEEDED",
  "OUTCOME_UNKNOWN",
] as const;
export type P4DiagnosticCode = (typeof P4_DIAGNOSTIC_CODE)[number];

export interface P4DiagnosticRecord {
  readonly request: P3EffectRequest;
  readonly state: P4DiagnosticState;
  readonly receipt: P3EffectReceipt | null;
  readonly code: P4DiagnosticCode;
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function boundedInt(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

export class P4DiagnosticEffectGate {
  private readonly request: P3EffectRequest;
  private readonly maxChecks: number;
  private record: P4DiagnosticRecord | null = null;

  constructor(request: P3EffectRequest, maxChecks: number = P4_DIAGNOSTIC_MAX_CHECKS) {
    const bound = p3EffectRequest(p2Snapshot(request));
    if (bound.effectId !== "effect-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (bound.binding.sourceRequestId !== "model-1") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (bound.action.action !== "tool") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    this.request = bound;
    this.maxChecks = boundedInt(maxChecks, 0, P4_DIAGNOSTIC_MAX_CHECKS);
  }

  admit(remainingMs: number): P4DiagnosticRecord {
    if (this.record !== null) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    if (this.maxChecks < 1) {
      fail(P2_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    const remaining = boundedInt(
      remainingMs,
      P4_DIAGNOSTIC_MIN_REMAINING_MS,
      P4_DIAGNOSTIC_MAX_REMAINING_MS,
    );
    const request = p3EffectRequest({
      effectId: this.request.effectId,
      binding: this.request.binding,
      action: this.request.action,
      remainingMs: Math.min(this.request.remainingMs, remaining),
    });
    const record: P4DiagnosticRecord = Object.freeze({
      request,
      state: "ADMITTED",
      receipt: null,
      code: "NOT_DISPATCHED",
    });
    this.record = record;
    return record;
  }

  markDispatched(): P4DiagnosticRecord {
    const last = this.record;
    if (last === null || last.state !== "ADMITTED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const next: P4DiagnosticRecord = Object.freeze({ ...last, state: "DISPATCHED" });
    this.record = next;
    return next;
  }

  settle(receipt: unknown, remainingMs: number): P4DiagnosticRecord {
    const last = this.record;
    if (last === null || last.state !== "DISPATCHED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const remaining = boundedInt(remainingMs, 0, P4_DIAGNOSTIC_MAX_REMAINING_MS);
    const checked = p3EffectReceipt(receipt, last.request);
    let state: P4DiagnosticState = "OBSERVED";
    let code: P4DiagnosticCode = "OBSERVED";
    if (checked.status === "UNKNOWN") {
      state = "OUTCOME_UNKNOWN";
      code = "OUTCOME_UNKNOWN";
    } else if (remaining <= P4_DIAGNOSTIC_LATE_MS) {
      code = "DEADLINE_EXCEEDED";
    } else if (checked.status === "ERROR") {
      code = "ERROR";
    }
    const next: P4DiagnosticRecord = p2Snapshot({
      request: last.request,
      state,
      receipt: checked,
      code,
    }) as P4DiagnosticRecord;
    this.record = next;
    return next;
  }

  snapshot(): P4DiagnosticRecord | null {
    return this.record === null ? null : (p2Snapshot(this.record) as P4DiagnosticRecord);
  }
}
