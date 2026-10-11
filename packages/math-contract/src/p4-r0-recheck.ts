/**
 * @astra/math-contract — P4 R0 revised-plan recheck preparation (M1 side).
 *
 * Replays the already recorded revision session against the supplied revision
 * snapshot and derives a recheck target from the actual revised contract. The
 * replay is pure: no network, no clock, no new model call. A preparation is a
 * frozen view of a caller-supplied budget, never a resource authority, and
 * `semanticResult` stays `UNKNOWN` with `canSupportObligation` false.
 */

import {
  P2Error,
  P2_ERROR_CODES,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  type P2Contract,
  type P4R0Binding,
  type P4R0Preparation,
  type P4R0RecheckAction,
  type P4R0RecheckOptions,
  type P4R0RecheckPreparation,
  type P4R0RevisionSnapshot,
  type P4R0RevisionTrigger,
} from "@astra/protocol";

import { P4R0PlanRevisionSession } from "./p4-r0-revision-session.js";
import { validateP4R0RevisionInput } from "./p4-r0-revision-report.js";

/** Maximum size of the recheck plan text, in UTF-8 bytes. */
export const P4_R0_RECHECK_MAX_PLAN_BYTES = 65536;

const MIN_REMAINING_MS = 26;
const REPLAY_PLANNING_CALLS = 2;
const REPLAY_ROOT_CALLS = 3;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Strict options check: unknown keys, wrong types and out-of-range values fail. */
function readOptions(
  options: unknown,
  preparation: P4R0Preparation,
): {
  readonly planningModelCalls: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
} {
  if (!isPlainObject(options)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const allowed = ["planningModelCalls", "remainingRootCalls", "remainingMs"];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      fail(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  if (!isBoundedInteger(options.planningModelCalls, 1)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const rootMax = preparation.remainingRootCalls - 2;
  if (rootMax < 0 || !isBoundedInteger(options.remainingRootCalls, rootMax)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!isBoundedInteger(options.remainingMs, preparation.remainingMs)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return {
    planningModelCalls: options.planningModelCalls,
    remainingRootCalls: options.remainingRootCalls,
    remainingMs: options.remainingMs,
  };
}

/** The actual child binding of one revised contract. */
function childBindingOf(parent: P4R0Binding, contract: P2Contract): P4R0Binding {
  return {
    sessionId: parent.sessionId,
    problemHash: parent.problemHash,
    contractVersion: contract.contractVersion,
    planHash: p4Hash(JSON.stringify(contract)),
  };
}

/**
 * M1 revised-plan recheck preparation.
 *
 * The original preparation, trigger, revision snapshot and options are
 * captured once and frozen. The revision is replayed through a fresh
 * `P4R0PlanRevisionSession` and the whole replayed snapshot must be JSON-equal
 * to the supplied one; only a successfully recorded `ACTIVE` proposal is
 * accepted. The target is built from the real revised contract, so a real
 * `REOPENED` obligation status is preserved and never normalized to `OPEN`.
 * This function performs no network call, reads no clock and spends no real
 * budget: the three option fields are a caller-supplied view only.
 */
export function prepareP4R0Recheck(
  originalPrep: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
  revision: P4R0RevisionSnapshot,
  options: P4R0RecheckOptions,
): P4R0RecheckPreparation {
  try {
    const prep = p2Snapshot(originalPrep);
    const trig = p2Snapshot(trigger);
    const rev = p2Snapshot(revision);
    const opts = p2Snapshot(options);

    const validated = validateP4R0RevisionInput(prep, trig);
    const validPrep = validated.preparation;
    const validTrig = validated.trigger;
    const parent = validPrep.target.binding;

    if (rev.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    if (!p4JsonEqual(rev.parent, parent)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rev.reviewHash !== validTrig.reviewHash) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const record = rev.record;
    if (record === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (record.state !== "RETURNED" || record.code !== "PROPOSAL_RECORDED") {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (record.availability !== "ACTIVE") {
      fail(P2_ERROR_CODES.STALE_DEPENDENCY);
    }
    if (typeof record.rawResponseText !== "string" || record.report === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (record.lineage === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (rev.revisedContract === null || rev.delta === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }

    const session = new P4R0PlanRevisionSession(validPrep, validTrig);
    session.admit(validPrep.remainingMs, REPLAY_PLANNING_CALLS, REPLAY_ROOT_CALLS);
    session.markDispatched();
    session.settle("COMPLETE", record.rawResponseText, validPrep.remainingMs);
    const replayed = session.snapshot();
    if (!p4JsonEqual(replayed, rev)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }

    const revisedContract = replayed.revisedContract;
    if (revisedContract === null) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }
    const child = childBindingOf(parent, revisedContract);
    if (!p4JsonEqual(child, record.lineage.child)) {
      fail(P2_ERROR_CODES.PACKET_BINDING);
    }

    const planText = JSON.stringify({
      goals: revisedContract.goals,
      obligations: revisedContract.obligations,
      tasks: revisedContract.tasks,
      riskHints: revisedContract.riskHints,
    });
    if (Buffer.byteLength(planText, "utf8") > P4_R0_RECHECK_MAX_PLAN_BYTES) {
      fail(P2_ERROR_CODES.BOUND_EXCEEDED);
    }

    const budget = readOptions(opts, validPrep);
    let action: P4R0RecheckAction;
    if (
      budget.planningModelCalls === 1 &&
      budget.remainingRootCalls >= 2 &&
      budget.remainingMs >= MIN_REMAINING_MS
    ) {
      action = "REQUEST_REVIEW";
    } else {
      action = "INSUFFICIENT_BUDGET";
    }

    return p2Snapshot({
      target: {
        binding: child,
        contract: revisedContract,
        planText,
      },
      parent,
      reviewHash: validTrig.reviewHash,
      revisionHash: p4Hash(JSON.stringify(rev)),
      revision: rev,
      action,
      planningModelCalls: budget.planningModelCalls,
      remainingRootCalls: budget.remainingRootCalls,
      remainingMs: budget.remainingMs,
      semanticResult: "UNKNOWN",
      canSupportObligation: false,
    }) as P4R0RecheckPreparation;
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
