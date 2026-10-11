/**
 * @astra/math-review — P1 M4 review module.
 *
 * In this phase no semantic review is performed. The module records that
 * fact explicitly: the status is SKIPPED_BY_POLICY, the candidate is not
 * verified and strict acceptance is NOT_PERFORMED.
 */

import {
  P1_STRICT_ACCEPTANCE,
  p1EventId,
  type P1Contract,
  type P1ReviewResult,
  type RecordEnvelope,
} from "@astra/protocol";

export const MATH_REVIEW_VERSION = "0.0.0-p1" as const;
export * from "./p4-report.js";
export * from "./p4-session.js";
export * from "./p4-mapping-report.js";
export * from "./p4-mapping-session.js";
export * from "./p4-recheck-input.js";
export * from "./p4-recheck-report.js";
export * from "./p4-recheck-session.js";

/** Record the skipped review. No semantic check is run here. */
export function reviewSkipped(contract: P1Contract, eventSeq: number): P1ReviewResult {
  const envelope: RecordEnvelope = Object.freeze({
    recordId: `${contract.envelope.sessionId}:m4:1`,
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    sourceModule: "M4",
    contractVersion: contract.contractVersion,
    artifactVersion: 1,
    causeEventId: p1EventId(contract.envelope.sessionId, contract.envelope.eventSeq),
    eventSeq,
  });
  return Object.freeze({
    envelope,
    status: "SKIPPED_BY_POLICY",
    candidateVerified: false,
    strictAcceptance: P1_STRICT_ACCEPTANCE,
  });
}
