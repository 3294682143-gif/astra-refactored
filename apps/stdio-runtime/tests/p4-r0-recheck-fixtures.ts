/**
 * Shared R0 revised-plan recheck test fixtures. These helpers build real M1
 * preparations, real revision sessions and real M1 recheck preparations from
 * the real components; nothing here is a model judgement or a mathematical
 * claim.
 */

import { compileP2Contract, prepareP4R0, prepareP4R0Recheck } from "@astra/math-contract";
import { P4R0PlanRevisionSession } from "@astra/math-contract";
import type {
  P4R0Preparation,
  P4R0RecheckOptions,
  P4R0RecheckPreparation,
  P4R0RevisionSnapshot,
  P4R0RevisionTrigger,
  P4R0Verdict,
} from "@astra/protocol";

import {
  codepointSpan,
  leavesOf,
  makeRevisionMultipartR0,
  makeRevisionR0,
  makeRevisionTrigger,
  revisionReport,
  type Mutable,
} from "./p4-r0-revision-fixtures.js";

export type { Mutable };

const PROBLEM = "😀 Find all real solutions x(x-1)=0";

/** Real M1 preparation whose template is a MULTIPART root with two VALUE leaves. */
export function makeRecheckMultipartR0(): P4R0Preparation {
  return makeRevisionMultipartR0();
}

/** Real M1 preparation whose template is a single VALUE leaf goal. */
export function makeRecheckR0(): P4R0Preparation {
  return makeRevisionR0();
}

/** Real recorded revision snapshot produced by a real M1 revision session. */
export function makeRevisionSnapshot(
  prep: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
  goalId?: string,
): P4R0RevisionSnapshot {
  const leaf = leavesOf(prep.target.contract.goals)[0]!;
  const target = goalId ?? leaf.goalId;
  const session = new P4R0PlanRevisionSession(prep, trigger);
  session.admit(900, 2, 3);
  session.markDispatched();
  session.settle("COMPLETE", revisionReport(prep, trigger, target), 800);
  return session.snapshot();
}

/**
 * Real M1 recheck preparation over a real revision snapshot. The revision is
 * replayed by `prepareP4R0Recheck`; the options are a caller-supplied view.
 */
export function makeRecheck(
  optionsOverride: Partial<P4R0RecheckOptions> = {},
  originalPrep?: P4R0Preparation,
): {
  readonly original: P4R0Preparation;
  readonly trigger: P4R0RevisionTrigger;
  readonly revision: P4R0RevisionSnapshot;
  readonly preparation: P4R0RecheckPreparation;
} {
  const original = originalPrep ?? makeRevisionR0();
  const { trigger } = makeRevisionTrigger(original);
  const revision = makeRevisionSnapshot(original, trigger);
  const preparation = prepareP4R0Recheck(original, trigger, revision, {
    planningModelCalls: 1,
    remainingRootCalls: 2,
    remainingMs: 700,
    ...optionsOverride,
  });
  return { original, trigger, revision, preparation };
}

/** Real M1 recheck preparation over a MULTIPART parent, retyping leaf `a`. */
export function makeRecheckMultipart(): {
  readonly original: P4R0Preparation;
  readonly trigger: P4R0RevisionTrigger;
  readonly revision: P4R0RevisionSnapshot;
  readonly preparation: P4R0RecheckPreparation;
} {
  const original = makeRevisionMultipartR0();
  const { trigger } = makeRevisionTrigger(original);
  const revision = makeRevisionSnapshot(original, trigger, "a");
  const preparation = prepareP4R0Recheck(original, trigger, revision, {
    planningModelCalls: 1,
    remainingRootCalls: 2,
    remainingMs: 700,
  });
  return { original, trigger, revision, preparation };
}

/** Exact codepoint span of the first problem codepoint, never a UTF-16 offset. */
export function problemSpanOf(prep: P4R0RecheckPreparation) {
  const problem = prep.target.contract.problemFullText;
  return codepointSpan(problem, [...problem].slice(0, 1).join(""));
}

/** Exact codepoint span of one real child goal JSON inside the child plan. */
export function childGoalSpanOf(prep: P4R0RecheckPreparation, goalId: string) {
  const goal = leavesOf(prep.target.contract.goals).find((entry) => entry.goalId === goalId);
  if (goal === undefined) {
    throw new Error("unknown child leaf");
  }
  return codepointSpan(prep.target.planText, JSON.stringify(goal));
}

/**
 * Literal synthetic model-3 recheck report bound to a real M1 recheck
 * preparation. It is a hand-written fixture, not a model opinion and not a
 * claim about the revised plan.
 */
export function recheckReport(prep: P4R0RecheckPreparation, verdict: P4R0Verdict = "NO_ISSUE"): string {
  const contract = prep.target.contract;
  const problemSpan = verdict === "UNKNOWN" ? null : problemSpanOf(prep);
  const planSpan = verdict === "UNKNOWN" ? null : childGoalSpanOf(prep, leavesOf(contract.goals)[0]!.goalId);
  const checks = ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"].map((dimension) => ({
    dimension,
    verdict,
    rationale: `fixture recheck ${dimension}`,
    problemSpan,
    planSpan,
  }));
  return JSON.stringify({
    schemaVersion: "p4-r0-recheck-v1",
    requestId: "model-3",
    stage: "R0_RECHECK",
    parent: prep.parent,
    target: prep.target.binding,
    reviewHash: prep.reviewHash,
    revisionHash: prep.revisionHash,
    conclusion: verdict,
    reviewCoverage: contract.obligations.map((item) => item.obligationId),
    checks,
  });
}

/** Parse a recheck report into a mutable object for test-side tampering. */
export function recheckReportOf(
  prep: P4R0RecheckPreparation,
  verdict: P4R0Verdict = "NO_ISSUE",
): Record<string, unknown> {
  return JSON.parse(recheckReport(prep, verdict)) as Record<string, unknown>;
}

/** Raw text of one mutated recheck report. */
export function recheckRawOf(
  prep: P4R0RecheckPreparation,
  mutate: (report: Record<string, unknown>) => void,
  verdict: P4R0Verdict = "NO_ISSUE",
): string {
  const report = recheckReportOf(prep, verdict);
  mutate(report);
  return JSON.stringify(report);
}

/** Real M1 preparation with a non-default event sequence and contract version. */
export function makeNonDefaultSeqR0(): P4R0Preparation {
  const base = compileP2Contract(PROBLEM, "r0");
  const contract = compileP2Contract(
    PROBLEM,
    "r0",
    [{ goalId: "goal-1", kind: "VALUE", scope: base.goals[0]!.scope, subgoals: [] }],
    7,
    3,
  );
  return prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 4,
    remainingMs: 1000,
  });
}
