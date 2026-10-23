/**
 * @astra/math-contract — P4 R0 initial-template planning precheck (M1 side).
 *
 * Rebuilds the whole P2 template from the pristine contract material and
 * compares it structurally. A structural match is an identity of the same
 * template, never a mathematical equivalence: `semanticResult` stays `UNKNOWN`
 * and `canSupportObligation` stays false. No model, environment or I/O access.
 */

import {
  P2_LIMITS,
  P2Error,
  P2_ERROR_CODES,
  P4_R0_MAX_ROOT_CALLS,
  P4_R0_RISK_CODES,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  type P2Contract,
  type P2GoalSpec,
  type P4R0Action,
  type P4R0Options,
  type P4R0Preparation,
  type P4R0RiskCode,
} from "@astra/protocol";

import { compileP2Contract } from "./p2-compiler.js";

/**
 * Maximum size of the template plan text, in UTF-8 bytes.
 *
 * `P4_R0_MAX_ROOT_CALLS` is the number of root model calls the whole R0 stage
 * may spend (three role reviews, one targeted recheck, at most one revision),
 * so a root that cannot cover it gets `INSUFFICIENT_BUDGET` and the stage
 * spends nothing at all.
 */
export const P4_R0_MAX_PLAN_BYTES = 65536;

/** Fixed goal-kind to risk-code mapping. No keyword inference is performed. */
const KIND_RISK: Readonly<Record<string, P4R0RiskCode>> = {
  ALL_SOLUTIONS: "BRANCH_COVERAGE",
  COUNT: "COUNT_COVERAGE",
  OPTIMIZATION: "BOUND_ATTAINMENT",
  PROOF: "PROOF_PREMISES",
  MULTIPART: "MULTIPART_COVERAGE",
  UNKNOWN: "UNKNOWN_GOAL",
};

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
function readOptions(options: unknown): {
  readonly enabled: boolean;
  readonly planningModelCalls: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
} {
  if (!isPlainObject(options)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const allowed = ["enabled", "planningModelCalls", "remainingRootCalls", "remainingMs"];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
  }
  const enabled = options.enabled === undefined ? false : options.enabled;
  if (typeof enabled !== "boolean") {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const planning = options.planningModelCalls === undefined ? 0 : options.planningModelCalls;
  if (!isBoundedInteger(planning, 1)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!isBoundedInteger(options.remainingRootCalls, P4_R0_MAX_ROOT_CALLS)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!isBoundedInteger(options.remainingMs, 3_600_000)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return {
    enabled,
    planningModelCalls: planning,
    remainingRootCalls: options.remainingRootCalls,
    remainingMs: options.remainingMs,
  };
}

/** Depth-first goal walk in declared order; a repeated node is visited once. */
function walkGoals(goals: readonly P2GoalSpec[], visit: (goal: P2GoalSpec) => void): void {
  const seen = new Set<object>();
  const walk = (goal: P2GoalSpec): void => {
    if (seen.has(goal)) {
      return;
    }
    seen.add(goal);
    visit(goal);
    for (const child of goal.subgoals) {
      walk(child);
    }
  };
  for (const goal of goals) {
    walk(goal);
  }
}

/** Risk codes in the fixed `P4_R0_RISK_CODES` order, deduplicated. */
function riskCodesOf(contract: P2Contract): readonly P4R0RiskCode[] {
  const found = new Set<P4R0RiskCode>();
  walkGoals(contract.goals, (goal) => {
    const code = KIND_RISK[goal.kind];
    if (code !== undefined) {
      found.add(code);
    }
  });
  if (contract.riskHints.length > 0) {
    found.add("EXPLICIT_RISK_HINT");
  }
  return P4_R0_RISK_CODES.filter((code) => found.has(code));
}

/**
 * M1 initial-template planning precheck.
 *
 * The contract and options are snapshotted once. The template is rebuilt from
 * the contract's own material and compared structurally; a mismatch is a hard
 * `PACKET_BINDING` failure and the original input is never repaired into a new
 * plan. The three budget fields are a frozen view, not a global authority.
 */
export function prepareP4R0(contract: P2Contract, options: P4R0Options): P4R0Preparation {
  try {
    const frozenContract = p2Snapshot(contract);
    const frozenOptions = readOptions(p2Snapshot(options));

    const envelope = frozenContract.envelope;
    if (!isPlainObject(envelope)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (
      typeof envelope.sessionId !== "string" ||
      envelope.sessionId.length === 0 ||
      typeof frozenContract.problemFullText !== "string" ||
      frozenContract.problemFullText.length === 0 ||
      typeof frozenContract.problemHash !== "string" ||
      !Number.isSafeInteger(frozenContract.contractVersion) ||
      !Number.isSafeInteger(envelope.eventSeq)
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }

    const rebuilt = compileP2Contract(
      frozenContract.problemFullText,
      envelope.sessionId,
      frozenContract.goals,
      envelope.eventSeq,
      frozenContract.contractVersion,
    );
    if (!p4JsonEqual(rebuilt, frozenContract)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }

    const planText = JSON.stringify({
      goals: frozenContract.goals,
      obligations: frozenContract.obligations,
      tasks: frozenContract.tasks,
      riskHints: frozenContract.riskHints,
    });
    if (Buffer.byteLength(planText, "utf8") > P4_R0_MAX_PLAN_BYTES) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }

    const riskCodes = riskCodesOf(frozenContract);
    if (frozenContract.riskHints.length > P2_LIMITS.maxArrayItems) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    let action: P4R0Action;
    if (!frozenOptions.enabled || riskCodes.length === 0) {
      action = "SKIPPED_BY_POLICY";
    } else if (
      frozenOptions.planningModelCalls === 0 ||
      frozenOptions.remainingRootCalls < P4_R0_MAX_ROOT_CALLS ||
      frozenOptions.remainingMs <= 25
    ) {
      action = "INSUFFICIENT_BUDGET";
    } else {
      action = "REQUEST_REVIEW";
    }

    return p2Snapshot({
      target: {
        binding: {
          sessionId: envelope.sessionId,
          problemHash: frozenContract.problemHash,
          contractVersion: frozenContract.contractVersion,
          planHash: p4Hash(JSON.stringify(frozenContract)),
        },
        contract: frozenContract,
        planText,
      },
      action,
      riskCodes,
      structuralMatch: true,
      semanticResult: "UNKNOWN",
      canSupportObligation: false,
      planningModelCalls: frozenOptions.planningModelCalls,
      remainingRootCalls: frozenOptions.remainingRootCalls,
      remainingMs: frozenOptions.remainingMs,
    });
  } catch (error) {
    if (error instanceof P2Error) {
      throw error;
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
}
