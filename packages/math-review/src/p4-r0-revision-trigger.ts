/**
 * @astra/math-review — P4 R0 revision trigger factory (pure, no I/O).
 *
 * Replays one already recorded R0 review session over the supplied record and
 * binds the resulting trigger to that parent plan. The trigger is a proposal
 * binding only: it is not a cryptographic authentication of an external
 * object, not a refutation, not a verification and not acceptance. No model
 * call, no clock, no network and no new budget is created here.
 */

import {
  P2Error,
  P2_ERROR_CODES,
  P4_R0_ROLE,
  isP4R0RequestId,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  type P4R0Dimension,
  type P4R0Preparation,
  type P4R0ReviewSnapshot,
  type P4R0RevisionTrigger,
} from "@astra/protocol";
import { validateP4R0Input } from "./p4-r0-input.js";
import { P4R0ReviewSession } from "./p4-r0-session.js";

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

/**
 * Build the version-bound revision trigger for one trusted M1 preparation.
 *
 * The preparation must pass `validateP4R0Input` and its action must be
 * `REQUEST_REVIEW`. The supplied snapshot is deep-frozen once; its record must
 * exist, be ACTIVE, be RETURNED with transport COMPLETE, code OK and a report
 * whose conclusion is ISSUES. The snapshot is one *role-scoped* review, so the
 * raw text is replayed through a fresh `P4R0ReviewSession` bound to that same
 * role and request id, and the resulting snapshot must be JSON-equal to the
 * supplied one, so a stale, altered or foreign record is rejected.
 */
export function createP4R0RevisionTrigger(
  preparation: P4R0Preparation,
  review: P4R0ReviewSnapshot,
): P4R0RevisionTrigger {
  try {
    const prep = validateP4R0Input(preparation);
    if (prep.action !== "REQUEST_REVIEW") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    const frozenReview = p2Snapshot(review);
    if (typeof frozenReview !== "object" || frozenReview === null || Array.isArray(frozenReview)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const binding = prep.target.binding;
    if (!p4JsonEqual(frozenReview.target, binding)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenReview.planHash !== binding.planHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (frozenReview.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    const record = frozenReview.record;
    if (record === null || record === undefined) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (record.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    if (record.state !== "RETURNED") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (record.transportStatus !== "COMPLETE") {
      fail(P2_ERROR_CODES.PACKET_DELIVERY);
    }
    if (record.code !== "OK") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (!p4JsonEqual(record.target, binding) || record.planHash !== binding.planHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const report = record.report;
    if (report === null || report === undefined) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (report.conclusion !== "ISSUES") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }
    if (typeof record.rawResponseText !== "string") {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }

    const role = frozenReview.role;
    if (!(P4_R0_ROLE as readonly string[]).includes(role)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (!isP4R0RequestId(record.requestId)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const session = new P4R0ReviewSession(prep);
    session.admit(role, record.requestId, prep.remainingMs, prep.remainingRootCalls);
    session.markDispatched(role);
    session.settle(role, "COMPLETE", record.rawResponseText, prep.remainingMs);
    const replayed = session.snapshot(role);
    if (!p4JsonEqual(replayed, frozenReview)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }

    const issueDimensions: P4R0Dimension[] = [];
    for (const check of report.checks) {
      if (check.verdict === "ISSUES" && !issueDimensions.includes(check.dimension)) {
        issueDimensions.push(check.dimension);
      }
    }
    if (issueDimensions.length === 0) {
      fail(P2_ERROR_CODES.ILLEGAL_TRANSITION);
    }

    return p2Snapshot({
      parent: binding,
      reviewHash: p4Hash(JSON.stringify(frozenReview)),
      issueDimensions,
      review: frozenReview,
    }) as P4R0RevisionTrigger;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
}
