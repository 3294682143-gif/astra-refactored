/**
 * @astra/math-audit — P1 M5 audit module.
 *
 * Performs the lowest final selection: it first checks that the contract, the
 * work result and the review record agree on session, problem hash, contract
 * version and artifact version, then emits a candidate only for a COMPLETE,
 * non-empty receipt. The candidate is never verified, strict acceptance is
 * never performed and the open obligation is never promoted to SATISFIED.
 */

import {
  P1_STRICT_ACCEPTANCE,
  p1EventId,
  type P1Contract,
  type P1FinalDecision,
  type P1ReviewResult,
  type P1WorkResult,
  type RecordEnvelope,
} from "@astra/protocol";

export const MATH_AUDIT_VERSION = "0.0.0-p1" as const;
export * from "./p4-candidate.js";
export * from "./p4-revise.js";
export * from "./p4-s1.js";
export * from "./p4-repair.js";

/** Fixed, non-empty explanation used whenever no candidate is available. */
export const UNSOLVED_RESPONSE =
  "No candidate answer was produced in this offline local prototype. The problem was not solved and no mathematical claim is made." as const;

function sameIdentity(contract: P1Contract, other: { readonly envelope: { readonly sessionId: string; readonly problemHash: string; readonly contractVersion: number } }): boolean {
  return (
    other.envelope.sessionId === contract.envelope.sessionId &&
    other.envelope.problemHash === contract.problemHash &&
    other.envelope.contractVersion === contract.contractVersion
  );
}

/**
 * Lowest final selection. `work` is null when no receipt was accepted. The
 * returned text is the original receipt text, never rewritten.
 */
export function finalize(
  contract: P1Contract,
  work: P1WorkResult | null,
  review: P1ReviewResult,
): P1FinalDecision {
  if (contract.envelope.sourceModule !== "M1") {
    throw new RangeError("contract");
  }
  if (contract.envelope.problemHash !== contract.problemHash) {
    throw new RangeError("contract");
  }
  if (contract.contractVersion !== 1 || contract.envelope.contractVersion !== 1) {
    throw new RangeError("contract");
  }
  if (!sameIdentity(contract, review)) {
    throw new RangeError("review");
  }
  if (review.envelope.sourceModule !== "M4") {
    throw new RangeError("review");
  }
  if (review.envelope.artifactVersion !== 1) {
    throw new RangeError("review");
  }
  if (review.status !== "SKIPPED_BY_POLICY") {
    throw new RangeError("review");
  }
  if (review.candidateVerified !== false || review.strictAcceptance !== P1_STRICT_ACCEPTANCE) {
    throw new RangeError("review");
  }
  if (work !== null) {
    if (!sameIdentity(contract, work)) {
      throw new RangeError("work");
    }
    if (work.envelope.sourceModule !== "M3" || work.envelope.artifactVersion !== 1) {
      throw new RangeError("work");
    }
    if (work.provisional !== true || work.sourceRequestId !== "model-1") {
      throw new RangeError("work");
    }
  }
  const envelope: RecordEnvelope = Object.freeze({
    recordId: `${contract.envelope.sessionId}:m5:1`,
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    sourceModule: "M5",
    contractVersion: contract.contractVersion,
    artifactVersion: 1,
    causeEventId: p1EventId(review.envelope.sessionId, review.envelope.eventSeq),
    eventSeq: review.envelope.eventSeq + 1,
  });
  const usable =
    work !== null && work.deliveryStatus === "COMPLETE" && work.text.trim().length > 0;
  if (usable && work !== null) {
    return Object.freeze({
      envelope,
      status: "candidate",
      finalResponse: work.text,
      candidateVerified: false,
      strictAcceptance: P1_STRICT_ACCEPTANCE,
    });
  }
  return Object.freeze({
    envelope,
    status: "unsolved",
    finalResponse: UNSOLVED_RESPONSE,
    candidateVerified: false,
    strictAcceptance: P1_STRICT_ACCEPTANCE,
  });
}
