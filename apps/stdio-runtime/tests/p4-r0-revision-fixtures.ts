/**
 * Shared R0 revision test fixtures. These helpers build real M1 preparations,
 * real R0 review sessions and real M4 triggers from the real components;
 * nothing here is a model judgement or a mathematical claim.
 */

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P4R0ReviewSession } from "@astra/math-review";
import { createP4R0RevisionTrigger } from "@astra/math-review";
import type {
  P2GoalSpec,
  P4R0Preparation,
  P4R0RevisionTrigger,
  P4R0ReviewSnapshot,
} from "@astra/protocol";

import { r0Report, type Mutable } from "./p4-r0-fixtures.js";

export type { Mutable };

const PROBLEM = "😀 Find all real solutions x(x-1)=0";

/** Real M1 preparation whose template is a single VALUE leaf goal. */
export function makeRevisionR0(): P4R0Preparation {
  const base = compileP2Contract(PROBLEM, "r0");
  const contract = compileP2Contract(PROBLEM, "r0", [
    { goalId: "goal-1", kind: "VALUE", scope: base.goals[0]!.scope, subgoals: [] },
  ]);
  return prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 5,
    remainingMs: 1000,
  });
}

/** Real M1 preparation whose template is a MULTIPART root with two VALUE leaves. */
export function makeRevisionMultipartR0(): P4R0Preparation {
  const base = compileP2Contract(PROBLEM, "r0");
  const contract = compileP2Contract(PROBLEM, "r0", [
    {
      goalId: "goal-1",
      kind: "MULTIPART",
      scope: base.goals[0]!.scope,
      subgoals: [
        { goalId: "a", kind: "VALUE", scope: base.goals[0]!.scope, subgoals: [] },
        { goalId: "b", kind: "VALUE", scope: base.goals[0]!.scope, subgoals: [] },
      ],
    },
  ]);
  return prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 5,
    remainingMs: 1000,
  });
}

/** Real R0 review snapshot with an ISSUES report, produced by a real session. */
export function makeIssuesReview(prep: P4R0Preparation): P4R0ReviewSnapshot {
  const session = new P4R0ReviewSession(prep);
  session.admit("MEANING", "model-1", 1000, 5);
  session.markDispatched("MEANING");
  session.settle("MEANING", "COMPLETE", r0Report(prep, "ISSUES"), 900);
  return session.snapshot("MEANING");
}

/** Real M4 revision trigger built from a real preparation and review snapshot. */
export function makeRevisionTrigger(
  prep: P4R0Preparation = makeRevisionR0(),
): { readonly prep: P4R0Preparation; readonly trigger: P4R0RevisionTrigger } {
  const review = makeIssuesReview(prep);
  return { prep, trigger: createP4R0RevisionTrigger(prep, review) };
}

/** Depth-first leaf walk in declared order; MULTIPART parents are not leaves. */
export function leavesOf(goals: readonly P2GoalSpec[]): readonly P2GoalSpec[] {
  const out: P2GoalSpec[] = [];
  const walk = (goal: P2GoalSpec): void => {
    if (goal.subgoals.length === 0 && goal.kind !== "MULTIPART") {
      out.push(goal);
    }
    for (const child of goal.subgoals) {
      walk(child);
    }
  };
  for (const goal of goals) {
    walk(goal);
  }
  return out;
}

/** Exact codepoint span of one slice of `source`, never a UTF-16 offset. */
export function codepointSpan(
  source: string,
  quote: string,
): { readonly start: number; readonly end: number; readonly quote: string } {
  const index = source.indexOf(quote);
  if (index < 0) {
    throw new Error("quote not found");
  }
  const start = [...source.slice(0, index)].length;
  return { start, end: start + [...quote].length, quote };
}

/** Literal synthetic model-2 revision report bound to a real trigger. */
export function revisionReport(
  prep: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
  goalId = "goal-1",
  toKind = "ALL_SOLUTIONS",
): string {
  const leaf = leavesOf(prep.target.contract.goals).find((goal) => goal.goalId === goalId);
  if (leaf === undefined) {
    throw new Error("unknown leaf");
  }
  const goalJson = JSON.stringify(leaf);
  const problem = prep.target.contract.problemFullText;
  const plan = prep.target.planText;
  return JSON.stringify({
    schemaVersion: "p4-r0-plan-revision-v1",
    requestId: "model-2",
    parent: prep.target.binding,
    reviewHash: trigger.reviewHash,
    changes: [
      {
        goalId,
        fromKind: leaf.kind,
        toKind,
        issueDimension: trigger.issueDimensions[0],
        rationale: "fixture revision",
        problemSpan: codepointSpan(problem, [...problem].slice(0, 1).join("")),
        planSpan: codepointSpan(plan, goalJson),
      },
    ],
  });
}

/** Parse a revision report into a mutable object for test-side tampering. */
export function revisionReportOf(
  prep: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
  goalId = "goal-1",
  toKind = "ALL_SOLUTIONS",
): Record<string, unknown> {
  return JSON.parse(revisionReport(prep, trigger, goalId, toKind)) as Record<string, unknown>;
}

/** Raw text of one mutated revision report. */
export function revisionRawOf(
  prep: P4R0Preparation,
  trigger: P4R0RevisionTrigger,
  mutate: (report: Record<string, unknown>) => void,
): string {
  const report = revisionReportOf(prep, trigger);
  mutate(report);
  return JSON.stringify(report);
}
