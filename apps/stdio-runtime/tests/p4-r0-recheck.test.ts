import test from "node:test";
import assert from "node:assert/strict";

import { prepareP4R0, prepareP4R0Recheck } from "@astra/math-contract";
import { P4R0RecheckSession, validateP4R0RecheckInput } from "@astra/math-review";
import { P2Error, p4Hash } from "@astra/protocol";

import {
  makeNonDefaultSeqR0,
  makeRecheck,
  makeRecheckMultipart,
  recheckReport,
  type Mutable,
} from "./p4-r0-recheck-fixtures.js";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

test("group 1: real preparation keeps the actual child contract and REOPENED", () => {
  const { original, trigger, revision, preparation } = makeRecheck();
  const child = preparation.target.contract;
  assert.equal(preparation.parent.planHash, original.target.binding.planHash);
  assert.equal(preparation.reviewHash, trigger.reviewHash);
  assert.equal(preparation.revisionHash, p4Hash(JSON.stringify(revision)));
  assert.equal(preparation.target.binding.planHash, p4Hash(JSON.stringify(child)));
  assert.equal(preparation.target.binding.contractVersion, original.target.binding.contractVersion + 1);
  assert.equal(child.contractVersion, original.target.contract.contractVersion + 1);
  assert.equal(child.problemFullText, original.target.contract.problemFullText);
  assert.equal(preparation.action, "REQUEST_REVIEW");
  assert.equal(preparation.semanticResult, "UNKNOWN");
  assert.equal(preparation.canSupportObligation, false);
  let reopened = 0;
  let opened = 0;
  for (const item of child.obligations) {
    const previous = original.target.contract.obligations.find(
      (entry) => entry.obligationId === item.obligationId,
    );
    if (previous === undefined) {
      assert.equal(item.status, "OPEN");
      opened += 1;
    } else {
      assert.equal(item.status, "REOPENED");
      reopened += 1;
    }
  }
  assert.equal(reopened, 4);
  assert.equal(opened, 2);
  assert.throws(
    () => prepareP4R0(child, { enabled: true, planningModelCalls: 1, remainingRootCalls: 3, remainingMs: 1000 }),
    P2Error,
  );
  assert.equal(Object.isFrozen(preparation), true);
  assert.equal(Object.isFrozen(preparation.target.contract), true);
  assert.equal(Object.isFrozen(preparation.revision), true);
  assert.equal(validateP4R0RecheckInput(preparation).revisionHash, preparation.revisionHash);
});

test("group 1b: non-default event sequence and contract version pass M1 and M4", () => {
  const original = makeNonDefaultSeqR0();
  assert.equal(original.target.contract.envelope.eventSeq, 7);
  assert.equal(original.target.contract.contractVersion, 3);
  const { preparation } = makeRecheck({}, original);
  assert.equal(preparation.target.contract.envelope.eventSeq, 8);
  assert.equal(preparation.target.contract.contractVersion, 4);
  assert.notEqual(preparation.target.contract.envelope.eventSeq, preparation.target.contract.contractVersion);
  assert.equal(validateP4R0RecheckInput(preparation).target.binding.contractVersion, 4);
});

test("group 2: three conclusions settle with the fixed evidence flags", () => {
  const { original, revision, preparation } = makeRecheck();
  const revisionBefore = JSON.stringify(revision);
  const parentBefore = JSON.stringify(original.target.contract);
  for (const verdict of ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const) {
    const session = new P4R0RecheckSession(preparation);
    const admitted = session.admit(700, 1, 2);
    assert.equal(admitted.state, "ADMITTED");
    assert.equal(admitted.code, "NOT_DISPATCHED");
    assert.equal(admitted.checkResult, "UNKNOWN");
    assert.equal(admitted.canSupportObligation, false);
    assert.equal(admitted.canActivate, false);
    session.markDispatched();
    const record = session.settle("COMPLETE", recheckReport(preparation, verdict), 600);
    assert.equal(record.code, "OK");
    assert.equal(record.state, "RETURNED");
    assert.equal(record.report!.conclusion, verdict);
    assert.equal(record.checkResult, "UNKNOWN");
    assert.equal(record.canSupportObligation, false);
    assert.equal(record.canActivate, false);
    assert.equal(record.source, "MODEL_REVIEW");
    assert.equal(record.level, verdict === "UNKNOWN" ? "PROVISIONAL" : "REVIEWED");
    assert.equal(record.report!.checks.every((check) => check.verdict === verdict), true);
    const snapshot = session.snapshot();
    assert.equal(snapshot.parent.planHash, preparation.parent.planHash);
    assert.equal(snapshot.target.planHash, preparation.target.binding.planHash);
    assert.equal(snapshot.reviewHash, preparation.reviewHash);
    assert.equal(snapshot.revisionHash, preparation.revisionHash);
    assert.equal(snapshot.record!.report!.reviewCoverage.length, preparation.target.contract.obligations.length);
  }
  assert.equal(JSON.stringify(revision), revisionBefore);
  assert.equal(JSON.stringify(original.target.contract), parentBefore);
});

test("group 2b: context carries the new plan and excludes the old rationale", () => {
  const { preparation } = makeRecheck();
  const session = new P4R0RecheckSession(preparation);
  const admitted = session.admit(700, 1, 2);
  const messages = admitted.context.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[1]!.role, "user");
  assert.equal(admitted.context.contextBytes, Buffer.byteLength(JSON.stringify(messages), "utf8"));
  assert.equal(admitted.context.contextHash, p4Hash(JSON.stringify(messages)));
  const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.stage, "R0_RECHECK");
  assert.equal(payload.requestId, "model-3");
  assert.equal(payload.problemFullText, preparation.target.contract.problemFullText);
  assert.equal(payload.planText, preparation.target.planText);
  assert.equal(payload.reviewHash, preparation.reviewHash);
  assert.equal(payload.revisionHash, preparation.revisionHash);
  assert.deepEqual(payload.reviewCoverage, preparation.target.contract.obligations.map((item) => item.obligationId));
  assert.deepEqual(payload.dimensions, ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"]);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("fixture revision"), false);
  assert.equal(serialized.includes("issueRows"), false);
  assert.equal(serialized.includes("changes"), false);
  assert.equal(serialized.includes("selfAssessment"), false);
  const child = preparation.target.contract;
  assert.deepEqual(JSON.parse(payload.planText as string), {
    goals: child.goals,
    obligations: child.obligations,
    tasks: child.tasks,
    riskHints: child.riskHints,
  });
  assert.equal(
    (JSON.parse(payload.planText as string) as { obligations: readonly { status: string }[] }).obligations.some(
      (item) => item.status === "REOPENED",
    ),
    true,
  );
});

test("group 3: options view bounds and forged action are rejected", () => {
  const { original, trigger, revision } = makeRecheck();
  const base = { planningModelCalls: 1, remainingRootCalls: 2, remainingMs: 700 } as const;
  for (const override of [
    { planningModelCalls: 0 },
    { remainingRootCalls: 1 },
    { remainingMs: 25 },
  ] as const) {
    const preparation = prepareP4R0Recheck(original, trigger, revision, { ...base, ...override });
    assert.equal(preparation.action, "INSUFFICIENT_BUDGET");
  }
  assert.equal(prepareP4R0Recheck(original, trigger, revision, { ...base, remainingMs: 26 }).action, "REQUEST_REVIEW");
  for (const bad of [
    { ...base, planningModelCalls: 2 },
    { ...base, remainingRootCalls: 3 },
    { ...base, remainingMs: 1001 },
    { ...base, extra: 1 },
    { planningModelCalls: 1, remainingRootCalls: 2 },
  ] as const) {
    assert.throws(() => prepareP4R0Recheck(original, trigger, revision, bad as never), P2Error);
  }
  const preparation = prepareP4R0Recheck(original, trigger, revision, base);
  const forged = clone(preparation);
  forged.action = "INSUFFICIENT_BUDGET";
  assert.throws(() => validateP4R0RecheckInput(forged as never), P2Error);
  const forgedBudget = clone(preparation);
  forgedBudget.remainingRootCalls = 1;
  assert.throws(() => validateP4R0RecheckInput(forgedBudget as never), P2Error);
});

test("group 4: M1 replay rejects every tampered revision clone", () => {
  const { original, trigger, revision } = makeRecheck();
  const base = { planningModelCalls: 1, remainingRootCalls: 2, remainingMs: 700 } as const;
  const mutations: readonly ((value: Mutable<typeof revision>) => void)[] = [
    (value) => {
      value.availability = "STALE";
    },
    (value) => {
      value.record = null;
    },
    (value) => {
      value.record!.rawResponseText = "not json";
    },
    (value) => {
      value.record!.report = null;
    },
    (value) => {
      value.record!.lineage = null;
    },
    (value) => {
      value.record!.code = "INVALID_REVISION";
    },
    (value) => {
      value.record!.state = "OUTCOME_UNKNOWN";
    },
    (value) => {
      value.revisedContract!.obligations[0]!.status = "OPEN";
    },
    (value) => {
      value.delta!.changedGoalIds = [];
    },
    (value) => {
      value.events = [];
    },
    (value) => {
      value.record!.context.contextHash = "0".repeat(64);
    },
    (value) => {
      value.reviewHash = "0".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const tampered = clone(revision);
    mutate(tampered);
    assert.throws(() => prepareP4R0Recheck(original, trigger, tampered as never, base), P2Error);
  }
  assert.equal(prepareP4R0Recheck(original, trigger, revision, base).action, "REQUEST_REVIEW");
});

test("group 4b: multipart parent keeps the root and retypes only leaf a", () => {
  const { preparation } = makeRecheckMultipart();
  const root = preparation.target.contract.goals[0]!;
  assert.equal(root.kind, "MULTIPART");
  assert.equal(root.subgoals.length, 2);
  assert.equal(root.subgoals[0]!.goalId, "a");
  assert.equal(root.subgoals[0]!.kind, "ALL_SOLUTIONS");
  assert.equal(root.subgoals[1]!.goalId, "b");
  assert.equal(root.subgoals[1]!.kind, "VALUE");
  assert.deepEqual(root.scope, preparation.revision.parentContract.goals[0]!.scope);
  assert.equal(validateP4R0RecheckInput(preparation).target.binding.contractVersion, preparation.parent.contractVersion + 1);
});
