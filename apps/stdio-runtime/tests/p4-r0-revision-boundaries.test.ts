import test from "node:test";
import assert from "node:assert/strict";

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P4R0PlanRevisionSession, parseP4R0RevisionReport } from "@astra/math-contract";
import { P2Error, p4Hash, type P2GoalSpec, type P4R0Preparation } from "@astra/protocol";

import { r0Report } from "./p4-r0-fixtures.js";
import {
  codepointSpan,
  leavesOf,
  makeRevisionTrigger,
  revisionRawOf,
  revisionReport,
  type Mutable,
} from "./p4-r0-revision-fixtures.js";

const PROBLEM = "😀 Find all real solutions x(x-1)=0";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function makePrep(goals: readonly P2GoalSpec[]): P4R0Preparation {
  const contract = compileP2Contract(PROBLEM, "r0", goals);
  return prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 4,
    remainingMs: 1000,
  });
}

function valueGoals(count: number): readonly P2GoalSpec[] {
  const base = compileP2Contract(PROBLEM, "r0");
  return Array.from({ length: count }, (_unused, index) => ({
    goalId: `goal-${index + 1}`,
    kind: "VALUE" as const,
    scope: base.goals[0]!.scope,
    subgoals: [],
  }));
}

function dispatched(prep: P4R0Preparation, trigger = makeRevisionTrigger(prep).trigger) {
  const session = new P4R0PlanRevisionSession(prep, trigger);
  session.admit(900, 2, 3);
  session.markDispatched();
  return session;
}

test("group 1: physical raw rejection keeps the DISPATCHED snapshot", () => {
  const prep = makePrep(valueGoals(1));
  const { trigger } = makeRevisionTrigger(prep);
  const good = revisionReport(prep, trigger);
  const session = dispatched(prep, trigger);
  const before = JSON.stringify(session.snapshot());
  const bad: readonly unknown[] = [
    undefined,
    null,
    1,
    "\ud800",
    "x".repeat(20001),
    "😀".repeat(17000),
  ];
  for (const raw of bad) {
    assert.throws(() => session.settle("COMPLETE", raw as never, 800), P2Error);
    assert.equal(JSON.stringify(session.snapshot()), before);
  }
  assert.throws(() => session.settle("COMPLETE", good, 901), P2Error);
  assert.throws(() => session.settle("NOPE" as never, good, 800), P2Error);
  assert.equal(JSON.stringify(session.snapshot()), before);
  assert.equal(session.settle("COMPLETE", good, 800).code, "PROPOSAL_RECORDED");
});

test("group 1b: strict parser rejects malformed raw and keeps legal malformed raw", () => {
  const prep = makePrep(valueGoals(1));
  const { trigger } = makeRevisionTrigger(prep);
  const good = revisionReport(prep, trigger);
  assert.equal(parseP4R0RevisionReport(good, prep, trigger).changes.length, 1);
  const bad: readonly string[] = [
    good.replace('"requestId":"model-2"', '"requestId":"model-2","requestId":"model-2"'),
    good.replace('"start":0', '"start":1e400'),
    good.replace("fixture revision", "\\ud800"),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.extraSpan = { start: 0, end: 1, quote: "x" };
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.rationale = "r".repeat(2049);
    }),
    revisionRawOf(prep, trigger, (report) => {
      const span = (report.changes as Record<string, unknown>[])[0]!.problemSpan as Record<string, unknown>;
      span.quote = "";
    }),
    revisionRawOf(prep, trigger, (report) => {
      const span = (report.changes as Record<string, unknown>[])[0]!.problemSpan as Record<string, unknown>;
      span.start = -1;
    }),
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(() => parseP4R0RevisionReport(text, prep, trigger), P2Error);
  }
  let deep = "1";
  for (let index = 0; index < 25; index += 1) {
    deep = `[${deep}]`;
  }
  assert.throws(() => parseP4R0RevisionReport(deep, prep, trigger), P2Error);
  const session = dispatched(prep, trigger);
  const record = session.settle("COMPLETE", "not json", 800);
  assert.equal(record.code, "INVALID_REVISION");
  assert.equal(record.rawResponseText, "not json");
  assert.equal(record.report, null);
  assert.equal(record.lineage, null);
});

test("group 2: constructor captures inputs and ignores later caller mutation", () => {
  const prep = makePrep(valueGoals(1));
  const { trigger } = makeRevisionTrigger(prep);
  const good = revisionReport(prep, trigger);
  const prepCopy = clone(prep);
  const triggerCopy = clone(trigger);
  const planHash = prep.target.binding.planHash;
  const reviewHash = trigger.reviewHash;
  const session = new P4R0PlanRevisionSession(prepCopy as P4R0Preparation, triggerCopy as never);
  prepCopy.target.planText = "{}";
  prepCopy.target.contract.problemFullText = "mutated";
  prepCopy.target.binding.planHash = "0".repeat(64);
  triggerCopy.reviewHash = "0".repeat(64);
  triggerCopy.issueDimensions = [];
  triggerCopy.review.record!.rawResponseText = r0Report(prep, "NO_ISSUE");
  triggerCopy.review.record!.context.contextHash = "0".repeat(64);
  triggerCopy.review.record!.report!.checks[0]!.rationale = "mutated";
  const record = session.admit(900, 2, 3);
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.planText, prep.target.planText);
  assert.equal(payload.problemFullText, prep.target.contract.problemFullText);
  assert.equal(payload.reviewHash, reviewHash);
  assert.equal(record.parent.planHash, planHash);
  assert.equal(record.context.contextHash, p4Hash(JSON.stringify(record.context.messages)));
  session.markDispatched();
  const settled = session.settle("COMPLETE", good, 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  assert.equal(settled.reviewHash, reviewHash);
  assert.equal(settled.lineage!.parent.planHash, planHash);
  const snapshot = session.snapshot();
  assert.equal(snapshot.parentContract.problemFullText, prep.target.contract.problemFullText);
  assert.equal(Object.isFrozen(snapshot.parentContract), true);
  assert.equal(Object.isFrozen(snapshot.parentContract.goals), true);
  assert.equal(Object.isFrozen(snapshot.parentContract.goals[0]!.scope), true);
  assert.equal(Object.isFrozen(snapshot.record!.context), true);
  assert.equal(Object.isFrozen(snapshot.record!.context.messages), true);
  assert.equal(Object.isFrozen(snapshot.record!.lineage), true);
});

test("group 3: unicode codepoint spans and untouched scopes", () => {
  const base = compileP2Contract(PROBLEM, "r0");
  const scope = { ...base.goals[0]!.scope, localAssumptions: ["😀 assumption"] };
  const prep = makePrep([
    { goalId: "goal-1", kind: "VALUE", scope, subgoals: [] },
    { goalId: "goal-2", kind: "VALUE", scope, subgoals: [] },
  ]);
  const { trigger } = makeRevisionTrigger(prep);
  const leaf = leavesOf(prep.target.contract.goals).find((goal) => goal.goalId === "goal-2")!;
  const goalJson = JSON.stringify(leaf);
  const plan = prep.target.planText;
  const utf16 = plan.indexOf(goalJson);
  const exact = codepointSpan(plan, goalJson);
  assert.notEqual(utf16, exact.start);
  const raw = revisionRawOf(prep, trigger, (report) => {
    const row = (report.changes as Record<string, unknown>[])[0]!;
    row.goalId = "goal-2";
    row.fromKind = "VALUE";
    row.toKind = "ALL_SOLUTIONS";
    row.planSpan = exact;
  });
  assert.equal(parseP4R0RevisionReport(raw, prep, trigger).changes[0]!.goalId, "goal-2");
  const wrong = revisionRawOf(prep, trigger, (report) => {
    const row = (report.changes as Record<string, unknown>[])[0]!;
    row.goalId = "goal-2";
    row.fromKind = "VALUE";
    row.toKind = "ALL_SOLUTIONS";
    row.planSpan = { start: utf16, end: utf16 + goalJson.length, quote: goalJson };
  });
  assert.throws(() => parseP4R0RevisionReport(wrong, prep, trigger), P2Error);
  const session = dispatched(prep, trigger);
  const settled = session.settle("COMPLETE", raw, 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  const revised = session.snapshot().revisedContract!;
  assert.equal(revised.goals[1]!.kind, "ALL_SOLUTIONS");
  assert.deepEqual(revised.goals[1]!.scope, prep.target.contract.goals[1]!.scope);
  assert.deepEqual(revised.goals[1]!.scope.localAssumptions, ["😀 assumption"]);
  assert.deepEqual(revised.goals[0]!.scope, prep.target.contract.goals[0]!.scope);
});

test("group 4: capacity overflow is atomic and oversized context is refused", () => {
  const prep = makePrep(valueGoals(4));
  const { trigger } = makeRevisionTrigger(prep);
  assert.equal(prep.target.contract.obligations.length, 12);
  const raw = revisionRawOf(prep, trigger, (report) => {
    report.changes = ["goal-1", "goal-2", "goal-3", "goal-4"].map((goalId) => ({
      goalId,
      fromKind: "VALUE",
      toKind: "ALL_SOLUTIONS",
      issueDimension: trigger.issueDimensions[0],
      rationale: "fixture revision",
      problemSpan: codepointSpan(prep.target.contract.problemFullText, [...prep.target.contract.problemFullText].slice(0, 1).join("")),
      planSpan: codepointSpan(
        prep.target.planText,
        JSON.stringify(leavesOf(prep.target.contract.goals).find((goal) => goal.goalId === goalId)!),
      ),
    }));
  });
  assert.equal(parseP4R0RevisionReport(raw, prep, trigger).changes.length, 4);
  const session = dispatched(prep, trigger);
  const record = session.settle("COMPLETE", raw, 800);
  assert.equal(record.code, "INVALID_REVISION");
  assert.equal(record.rawResponseText, raw);
  assert.equal(record.report, null);
  assert.equal(record.lineage, null);
  const snapshot = session.snapshot();
  assert.equal(snapshot.revisedContract, null);
  assert.equal(snapshot.delta, null);
  assert.equal(snapshot.events.filter((event) => event.eventType === "CONTRACT_COMPILED").length, 1);
  assert.equal(snapshot.events.some((event) => event.eventType === "GOALS_REVISED"), false);
  assert.equal(JSON.stringify(snapshot.parentContract), JSON.stringify(prep.target.contract));

  const filler = '"'.repeat(3000);
  const bigBase = compileP2Contract(PROBLEM, "r0");
  const bigPrep = makePrep([
    {
      goalId: "goal-1",
      kind: "VALUE",
      scope: { ...bigBase.goals[0]!.scope, localAssumptions: [filler] },
      subgoals: [],
    },
  ]);
  const bigTrigger = makeRevisionTrigger(bigPrep).trigger;
  const reviewSession = new P4R0PlanRevisionSession(bigPrep, bigTrigger);
  assert.throws(() => reviewSession.admit(900, 2, 3), P2Error);
  assert.equal(reviewSession.snapshot().record, null);
});
