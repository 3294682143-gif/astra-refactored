import test from "node:test";
import assert from "node:assert/strict";

import { compileP2Contract, prepareP4R0, prepareP4R0Recheck } from "@astra/math-contract";
import { P4R0PlanRevisionSession } from "@astra/math-contract";
import { P4R0RecheckSession, P4R0ReviewSession, createP4R0RevisionTrigger } from "@astra/math-review";
import { P2Error, p4Hash, type P4R0Preparation } from "@astra/protocol";

import { r0Report } from "./p4-r0-fixtures.js";
import { revisionReport } from "./p4-r0-revision-fixtures.js";
import { makeRecheck, recheckReport, type Mutable } from "./p4-r0-recheck-fixtures.js";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function dispatched() {
  const { preparation } = makeRecheck();
  const session = new P4R0RecheckSession(preparation);
  session.admit(700, 1, 2);
  session.markDispatched();
  return { preparation, session };
}

test("group 1: admission bounds, single flight and stale discipline", () => {
  const { preparation } = makeRecheck();
  for (const args of [
    [25, 1, 2],
    [701, 1, 2],
    [700, 0, 2],
    [700, 1, 1],
    [700, 1, 3],
    [Number.NaN, 1, 2],
    [700.5, 1, 2],
  ] as const) {
    const session = new P4R0RecheckSession(preparation);
    assert.throws(() => session.admit(args[0], args[1], args[2]), P2Error);
    assert.equal(session.snapshot().record, null);
  }
  assert.throws(() => new P4R0RecheckSession(preparation, 0).admit(700, 1, 2), P2Error);
  assert.throws(() => new P4R0RecheckSession(preparation, 2), P2Error);

  const session = new P4R0RecheckSession(preparation);
  assert.equal(session.admit(26, 1, 2).state, "ADMITTED");
  assert.throws(() => session.admit(700, 1, 2), P2Error);
  assert.throws(() => session.markStale(), P2Error);
  assert.throws(() => session.settle("COMPLETE", recheckReport(preparation), 26), P2Error);
  session.markDispatched();
  assert.throws(() => session.markDispatched(), P2Error);
  assert.throws(() => session.settle("COMPLETE", recheckReport(preparation), 27), P2Error);
  assert.equal(session.snapshot().record!.state, "DISPATCHED");
  assert.equal(session.settle("COMPLETE", recheckReport(preparation), 26).code, "OK");
  assert.throws(() => session.settle("COMPLETE", recheckReport(preparation), 26), P2Error);
  assert.throws(() => session.admit(700, 1, 2), P2Error);
  const binding = session.snapshot().target;
  const raw = session.snapshot().record!.rawResponseText;
  session.markStale();
  assert.equal(session.snapshot().availability, "STALE");
  assert.deepEqual(session.snapshot().target, binding);
  assert.equal(session.snapshot().record!.rawResponseText, raw);
});

test("group 2: transport and late handling keep the raw and the flags", () => {
  const { preparation } = makeRecheck();
  const good = recheckReport(preparation);
  for (const transport of ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    for (const remaining of [0, 25, 26]) {
      const session = new P4R0RecheckSession(preparation);
      session.admit(700, 1, 2);
      session.markDispatched();
      const record = session.settle(transport, good, remaining);
      assert.equal(record.rawResponseText, good);
      assert.equal(record.checkResult, "UNKNOWN");
      assert.equal(record.canSupportObligation, false);
      assert.equal(record.canActivate, false);
      if (transport === "UNKNOWN") {
        assert.equal(record.code, "OUTCOME_UNKNOWN");
        assert.equal(record.state, "OUTCOME_UNKNOWN");
      } else if (remaining <= 25) {
        assert.equal(record.code, "DEADLINE_EXCEEDED");
      } else if (transport !== "COMPLETE") {
        assert.equal(record.code, "TRANSPORT_INCOMPLETE");
      } else {
        assert.equal(record.code, "OK");
      }
      assert.equal(record.report === null, record.code !== "OK");
      assert.equal(record.level, record.code === "OK" ? "REVIEWED" : "PROVISIONAL");
      assert.throws(() => session.settle(transport, good, remaining), P2Error);
    }
  }
});

test("group 3: physical raw guards, legal malformed raw and immutable capture", () => {
  const { preparation } = makeRecheck();
  const good = recheckReport(preparation);
  const bad: readonly unknown[] = [
    undefined,
    null,
    "\ud800",
    "x".repeat(20001),
    "😀".repeat(17000),
  ];
  for (const raw of bad) {
    const session = new P4R0RecheckSession(preparation);
    session.admit(700, 1, 2);
    session.markDispatched();
    const before = JSON.stringify(session.snapshot());
    assert.throws(() => session.settle("COMPLETE", raw as never, 600), P2Error);
    assert.equal(JSON.stringify(session.snapshot()), before);
    assert.equal(session.snapshot().record!.state, "DISPATCHED");
  }
  for (const args of [
    ["MAYBE", good, 600],
    ["COMPLETE", good, 701],
  ] as const) {
    const session = new P4R0RecheckSession(preparation);
    session.admit(700, 1, 2);
    session.markDispatched();
    const before = JSON.stringify(session.snapshot());
    assert.throws(() => session.settle(args[0] as never, args[1], args[2]), P2Error);
    assert.equal(JSON.stringify(session.snapshot()), before);
  }
  const legal = new P4R0RecheckSession(preparation);
  legal.admit(700, 1, 2);
  legal.markDispatched();
  const record = legal.settle("COMPLETE", "not json", 600);
  assert.equal(record.code, "INVALID_REPORT");
  assert.equal(record.rawResponseText, "not json");
  assert.equal(record.report, null);
  assert.equal(record.level, "PROVISIONAL");

  const mutable = clone(preparation);
  const session = new P4R0RecheckSession(mutable as never);
  const expectedTarget = JSON.stringify(session.snapshot().target);
  const expectedRevisionHash = session.snapshot().revisionHash;
  mutable.target.contract.problemFullText = "tampered";
  mutable.target.contract.goals = [];
  mutable.target.planText = "tampered";
  mutable.target.binding.planHash = "0".repeat(64);
  mutable.remainingMs = 1;
  mutable.revisionHash = "0".repeat(64);
  const admitted = session.admit(700, 1, 2);
  const contextHash = admitted.context.contextHash;
  const contextBytes = admitted.context.contextBytes;
  const payload = JSON.parse(admitted.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.problemFullText, preparation.target.contract.problemFullText);
  assert.equal(payload.planText, preparation.target.planText);
  assert.equal(session.snapshot().record!.context.contextHash, contextHash);
  assert.equal(session.snapshot().record!.context.contextBytes, contextBytes);
  assert.equal(JSON.stringify(session.snapshot().target), expectedTarget);
  assert.equal(session.snapshot().revisionHash, expectedRevisionHash);
  session.markDispatched();
  assert.equal(session.settle("COMPLETE", good, 600).code, "OK");
  const snapshot = session.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.record), true);
  assert.equal(Object.isFrozen(snapshot.record!.context), true);
  assert.equal(Object.isFrozen(snapshot.record!.context.messages), true);
  assert.equal(Object.isFrozen(snapshot.record!.report), true);
  assert.equal(snapshot.record!.context.contextHash, p4Hash(JSON.stringify(snapshot.record!.context.messages)));
});

test("group 4: oversized real child context is rejected without truncation", () => {
  const problem = "😀".repeat(8000) + " Find all real solutions x(x-1)=0";
  const base = compileP2Contract(problem, "r0");
  const scope = base.goals[0]!.scope;
  const goals = [0, 1, 2].map((index) => ({
    goalId: `g${index}` + "x".repeat(40),
    kind: "UNKNOWN" as const,
    scope,
    subgoals: [],
  }));
  const contract = compileP2Contract(problem, "r0", goals);
  const original: P4R0Preparation = prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 4,
    remainingMs: 1000,
  });
  assert.equal(original.target.contract.obligations.length, 6);
  const review = new P4R0ReviewSession(original);
  review.admit(1000, 4);
  review.markDispatched();
  review.settle("COMPLETE", r0Report(original, "ISSUES"), 900);
  const trigger = createP4R0RevisionTrigger(original, review.snapshot());
  const revisionSession = new P4R0PlanRevisionSession(original, trigger);
  revisionSession.admit(900, 2, 3);
  revisionSession.markDispatched();
  const raw = JSON.stringify({
    schemaVersion: "p4-r0-plan-revision-v1",
    requestId: "model-2",
    parent: original.target.binding,
    reviewHash: trigger.reviewHash,
    changes: goals.map((goal) => {
      const leaf = original.target.contract.goals.find((entry) => entry.goalId === goal.goalId)!;
      const goalJson = JSON.stringify(leaf);
      const index = original.target.planText.indexOf(goalJson);
      const start = [...original.target.planText.slice(0, index)].length;
      return {
        goalId: goal.goalId,
        fromKind: leaf.kind,
        toKind: "ALL_SOLUTIONS",
        issueDimension: trigger.issueDimensions[0],
        rationale: "fixture revision",
        problemSpan: { start: 0, end: 1, quote: [...problem].slice(0, 1).join("") },
        planSpan: { start, end: start + [...goalJson].length, quote: goalJson },
      };
    }),
  });
  const settled = revisionSession.settle("COMPLETE", raw, 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  assert.equal(settled.report!.changes.length, 3);
  const revision = revisionSession.snapshot();
  assert.equal(revision.revisedContract!.obligations.length, 15);
  const preparation = prepareP4R0Recheck(original, trigger, revision, {
    planningModelCalls: 1,
    remainingRootCalls: 2,
    remainingMs: 700,
  });
  assert.equal(Buffer.byteLength(preparation.target.planText, "utf8") <= 65536, true);
  const session = new P4R0RecheckSession(preparation);
  const before = JSON.stringify(session.snapshot());
  assert.throws(() => session.admit(700, 1, 2), P2Error);
  assert.equal(JSON.stringify(session.snapshot()), before);
  assert.equal(session.snapshot().record, null);
  assert.equal(JSON.stringify(original.target.contract), JSON.stringify(contract));
  assert.equal(JSON.stringify(revisionSession.snapshot()), JSON.stringify(revision));
});
