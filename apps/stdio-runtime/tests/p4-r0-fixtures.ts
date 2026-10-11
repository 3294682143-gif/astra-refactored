/**
 * Shared R0 test fixtures. These helpers build real M1 preparations from the
 * real P2 compiler; nothing here is a model judgement or a mathematical claim.
 */

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import type {
  P2GoalKind,
  P2GoalSpec,
  P4R0Options,
  P4R0Preparation,
  P4R0Verdict,
} from "@astra/protocol";

/** Recursive mutable view of a readonly DTO, for test-side tampering only. */
export type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const ALL_PROBLEM = "😀 Find all real solutions x(x-1)=0";
const VALUE_PROBLEM = "😀 Compute 1+1";

function specsFor(kind: P2GoalKind, base: P2GoalSpec): readonly P2GoalSpec[] {
  if (kind === "MULTIPART") {
    return [
      {
        goalId: "goal-1",
        kind: "MULTIPART",
        scope: base.scope,
        subgoals: [
          { goalId: "a", kind: "VALUE", scope: base.scope, subgoals: [] },
          { goalId: "b", kind: "VALUE", scope: base.scope, subgoals: [] },
        ],
      },
    ];
  }
  return [{ goalId: "goal-1", kind, scope: base.scope, subgoals: [] }];
}

/** Real M1 preparation over a real compiled template. */
export function makeR0(
  kind: P2GoalKind = "ALL_SOLUTIONS",
  optionsOverride: Partial<P4R0Options> = {},
): P4R0Preparation {
  const problem = kind === "VALUE" ? VALUE_PROBLEM : ALL_PROBLEM;
  const base = compileP2Contract(problem, "r0");
  const contract = compileP2Contract(problem, "r0", specsFor(kind, base.goals[0]!));
  return prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 3,
    remainingMs: 1000,
    ...optionsOverride,
  });
}

/** Real M1 preparation with the default (disabled) options shape. */
export function makeR0Default(kind: P2GoalKind = "ALL_SOLUTIONS"): P4R0Preparation {
  const problem = kind === "VALUE" ? VALUE_PROBLEM : ALL_PROBLEM;
  const base = compileP2Contract(problem, "r0");
  const contract = compileP2Contract(problem, "r0", specsFor(kind, base.goals[0]!));
  return prepareP4R0(contract, { remainingRootCalls: 3, remainingMs: 1000 });
}

function span(source: string, start: number, end: number) {
  return { start, end, quote: [...source].slice(start, end).join("") };
}

/**
 * Literal synthetic report bound to a real preparation. It is a hand-written
 * fixture, not a model opinion and not a claim about the template.
 */
export function r0Report(prep: P4R0Preparation, verdict: P4R0Verdict = "NO_ISSUE"): string {
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const plan = prep.target.planText;
  const binding = prep.target.binding;
  const problemSpan = verdict === "UNKNOWN" ? null : span(problem, 0, 1);
  const planSpan = verdict === "UNKNOWN" ? null : span(plan, 0, 2);
  const checks = ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"].map((dimension) => ({
    dimension,
    verdict,
    rationale: `fixture ${dimension}`,
    problemSpan,
    planSpan,
  }));
  return JSON.stringify({
    schemaVersion: "p4-r0-review-v1",
    requestId: "model-1",
    stage: "R0",
    target: binding,
    planHash: binding.planHash,
    conclusion: verdict,
    reviewCoverage: contract.obligations.map((item) => item.obligationId),
    checks,
  });
}
