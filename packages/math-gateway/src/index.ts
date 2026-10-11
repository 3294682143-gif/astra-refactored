/**
 * @astra/math-gateway — P1 M2 gateway module.
 *
 * A pure admission decision for the single mock model call. It dispatches
 * nothing, owns no budget and never refreshes a rejected allowance; the
 * runtime core remains the authority that reserves the call.
 */

import type { P1AdmissionDecision } from "@astra/protocol";

export const MATH_GATEWAY_VERSION = "0.0.0-p1" as const;
export * from "./p2-gate.js";
export * from "./p3-parser.js";
export * from "./p3-effect-data.js";
export * from "./p3-gate.js";
export * from "./p4-mapping-gate.js";
export * from "./p4-recheck-gate.js";

/** Below this remaining time the call is refused rather than started. */
export const MIN_REMAINING_MS = 25 as const;

/**
 * Decide whether one model call may be admitted. Non-integer, NaN or negative
 * budgets are refused instead of being coerced into a passing value.
 */
export function admitModelCall(remainingMs: number, remainingCalls: number): P1AdmissionDecision {
  if (!Number.isSafeInteger(remainingMs) || !Number.isSafeInteger(remainingCalls)) {
    return { admitted: false, reason: "BUDGET_EXHAUSTED" };
  }
  if (remainingCalls > 1 || remainingMs > 5000) {
    return { admitted: false, reason: "BUDGET_EXHAUSTED" };
  }
  if (remainingCalls <= 0) {
    return { admitted: false, reason: "BUDGET_EXHAUSTED" };
  }
  if (remainingMs <= MIN_REMAINING_MS) {
    return { admitted: false, reason: "BUDGET_EXHAUSTED" };
  }
  return { admitted: true, reason: "ADMITTED" };
}
