import test from "node:test";
import assert from "node:assert/strict";

import {
  P4R0PlanRevisionSession,
  parseP4R0RevisionReport,
  prepareP4R0,
  validateP4R0RevisionInput,
} from "@astra/math-contract";
import { P4R0ReviewSession, createP4R0RevisionTrigger } from "@astra/math-review";
import { P2Error, p4Hash, type P4R0Preparation } from "@astra/protocol";

import { r0Report } from "./p4-r0-fixtures.js";
import {
  codepointSpan,
  leavesOf,
  makeIssuesReview,
  makeRevisionMultipartR0,
  makeRevisionR0,
  makeRevisionTrigger,
  revisionRawOf,
  revisionReport,
  revisionReportOf,
  type Mutable,
} from "./p4-r0-revision-fixtures.js";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function admitted(prep: P4R0Preparation, trigger = makeRevisionTrigger(prep).trigger) {
  const session = new P4R0PlanRevisionSession(prep, trigger);
  session.admit(900, 2, 3);
  return session;
}

test("group 1: valid revision records version+1, REOPENED and lineage flags", () => {
  const prep = makeRevisionR0();
  const { trigger } = makeRevisionTrigger(prep);
  const before = JSON.stringify(prep.target.contract);
  const reviewBefore = JSON.stringify(trigger.review);
  const session = new P4R0PlanRevisionSession(prep, trigger);
  const record = session.admit(900, 2, 3);
  assert.equal(record.state, "ADMITTED");
  assert.equal(record.code, "NOT_DISPATCHED");
  assert.equal(record.lineage, null);
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.problemFullText, prep.target.contract.problemFullText);
  assert.equal(payload.planText, prep.target.planText);
  assert.equal(payload.reviewHash, trigger.reviewHash);
  assert.equal(record.context.contextBytes, Buffer.byteLength(JSON.stringify(record.context.messages), "utf8"));
  assert.equal(record.context.contextHash, p4Hash(JSON.stringify(record.context.messages)));
  session.markDispatched();
  const settled = session.settle("COMPLETE", revisionReport(prep, trigger), 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  assert.equal(settled.state, "RETURNED");
  assert.equal(settled.report!.changes.length, 1);
  const lineage = settled.lineage!;
  assert.equal(lineage.parent.planHash, prep.target.binding.planHash);
  assert.equal(lineage.child.contractVersion, prep.target.binding.contractVersion + 1);
  assert.equal(lineage.reviewHash, trigger.reviewHash);
  assert.equal(lineage.sourceRequestId, "model-2");
  assert.equal(lineage.requiresRecheck, true);
  assert.equal(lineage.canActivate, false);
  assert.equal(lineage.checkResult, "UNKNOWN");
  assert.equal(lineage.canSupport, false);
  const snapshot = session.snapshot();
  assert.equal(snapshot.revisedContract!.contractVersion, prep.target.binding.contractVersion + 1);
  assert.equal(lineage.child.planHash, p4Hash(JSON.stringify(snapshot.revisedContract)));
  assert.deepEqual(new Set(lineage.changedGoalIds), new Set(snapshot.delta!.changedGoalIds));
  assert.equal(snapshot.delta!.fromVersion, prep.target.binding.contractVersion);
  assert.equal(snapshot.delta!.toVersion, lineage.child.contractVersion);
  const revised = snapshot.revisedContract!;
  const old = prep.target.contract;
  let reopened = 0;
  let opened = 0;
  for (const item of revised.obligations) {
    const previous = old.obligations.find((entry) => entry.obligationId === item.obligationId);
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
  assert.equal(revised.obligations.some((item) => item.kind === "EXHAUSTIVENESS" && item.status === "OPEN"), true);
  assert.equal(revised.obligations.some((item) => item.status === "OPEN"), true);
  assert.equal(revised.obligations.some((item) => item.kind === "BOUNDARY_EXCEPTIONS" && item.status === "OPEN"), true);
  const seqs = snapshot.events.map((event) => event.eventSeq);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(snapshot.events.some((event) => event.eventType === "GOALS_REVISED"), true);
  assert.equal(JSON.stringify(prep.target.contract), before);
  assert.equal(JSON.stringify(trigger.review), reviewBefore);
  assert.throws(() => prepareP4R0(revised, { enabled: true, planningModelCalls: 1, remainingRootCalls: 3, remainingMs: 1000 }), P2Error);
  assert.equal(session.snapshot().parentContract.contractVersion, prep.target.binding.contractVersion);
  assert.deepEqual(lineage.changedGoalIds, snapshot.delta!.changedGoalIds);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.record), true);
  assert.equal(Object.isFrozen(snapshot.record!.report), true);
  assert.equal(Object.isFrozen(snapshot.revisedContract), true);
  assert.equal(Object.isFrozen(snapshot.parentContract), true);
  assert.equal(Object.isFrozen(snapshot.delta), true);
  assert.equal(Object.isFrozen(snapshot.events), true);
  assert.equal(Object.isFrozen(snapshot.record!.lineage), true);
});

test("group 2: multipart scope is preserved and delta lists ancestors first", () => {
  const prep = makeRevisionMultipartR0();
  const { trigger } = makeRevisionTrigger(prep);
  const session = admitted(prep, trigger);
  session.markDispatched();
  const settled = session.settle("COMPLETE", revisionReport(prep, trigger, "a", "COUNT"), 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  const snapshot = session.snapshot();
  const revised = snapshot.revisedContract!;
  const root = revised.goals[0]!;
  assert.equal(root.kind, "MULTIPART");
  assert.equal(root.subgoals.length, 2);
  assert.equal(root.subgoals[0]!.goalId, "a");
  assert.equal(root.subgoals[0]!.kind, "COUNT");
  assert.equal(root.subgoals[1]!.goalId, "b");
  assert.equal(root.subgoals[1]!.kind, "VALUE");
  assert.deepEqual(root.scope, prep.target.contract.goals[0]!.scope);
  assert.deepEqual(root.subgoals[0]!.scope, prep.target.contract.goals[0]!.subgoals[0]!.scope);
  assert.deepEqual(root.subgoals[1]!.scope, prep.target.contract.goals[0]!.subgoals[1]!.scope);
  assert.deepEqual(root.scope.localAssumptions, prep.target.contract.goals[0]!.scope.localAssumptions);
  assert.deepEqual(root.subgoals[0]!.scope.localAssumptions, prep.target.contract.goals[0]!.subgoals[0]!.scope.localAssumptions);
  assert.equal(revised.problemFullText, prep.target.contract.problemFullText);
  assert.equal(revised.problemHash, prep.target.contract.problemHash);
  assert.deepEqual(snapshot.delta!.changedGoalIds, ["goal-1", "a"]);
  assert.deepEqual(settled.lineage!.changedGoalIds, snapshot.delta!.changedGoalIds);
  assert.equal(settled.lineage!.canActivate, false);
  assert.equal(settled.lineage!.requiresRecheck, true);
  assert.equal(settled.lineage!.checkResult, "UNKNOWN");
  assert.equal(settled.lineage!.canSupport, false);
  assert.equal(snapshot.record!.lineage!.child.planHash, p4Hash(JSON.stringify(revised)));
});

test("group 3: trigger replay rejects non-ISSUES, stale, foreign and altered records", () => {
  const prep = makeRevisionR0();
  const issues = makeIssuesReview(prep);
  assert.equal(createP4R0RevisionTrigger(prep, issues).issueDimensions.length > 0, true);
  for (const verdict of ["NO_ISSUE", "UNKNOWN"] as const) {
    const session = new P4R0ReviewSession(prep);
    session.admit(1000, 4);
    session.markDispatched();
    session.settle("COMPLETE", r0Report(prep, verdict), 900);
    assert.throws(() => createP4R0RevisionTrigger(prep, session.snapshot()), P2Error);
  }
  const nulled = clone(issues);
  nulled.record = null;
  assert.throws(() => createP4R0RevisionTrigger(prep, nulled as never), P2Error);
  const stale = clone(issues);
  stale.availability = "STALE";
  assert.throws(() => createP4R0RevisionTrigger(prep, stale as never), P2Error);
  const staleRecord = clone(issues);
  staleRecord.record!.availability = "STALE";
  assert.throws(() => createP4R0RevisionTrigger(prep, staleRecord as never), P2Error);
  const foreign = clone(issues);
  foreign.target.sessionId = "other";
  assert.throws(() => createP4R0RevisionTrigger(prep, foreign as never), P2Error);
  const alteredRaw = clone(issues);
  alteredRaw.record!.rawResponseText = r0Report(prep, "NO_ISSUE");
  assert.throws(() => createP4R0RevisionTrigger(prep, alteredRaw as never), P2Error);
  const alteredContext = clone(issues);
  alteredContext.record!.context.contextHash = "0".repeat(64);
  assert.throws(() => createP4R0RevisionTrigger(prep, alteredContext as never), P2Error);
  const trigger = createP4R0RevisionTrigger(prep, issues);
  assert.equal(trigger.parent.planHash, prep.target.binding.planHash);
  assert.equal(trigger.reviewHash, p4Hash(JSON.stringify(issues)));
  assert.deepEqual(trigger.issueDimensions, ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"]);
  const badHash = clone(trigger);
  badHash.reviewHash = "0".repeat(64);
  assert.throws(() => validateP4R0RevisionInput(prep, badHash as never), P2Error);
  const badDims = clone(trigger);
  badDims.issueDimensions = [];
  assert.throws(() => validateP4R0RevisionInput(prep, badDims as never), P2Error);
  const badLevel = clone(trigger);
  badLevel.review.record!.level = "PROVISIONAL";
  badLevel.reviewHash = p4Hash(JSON.stringify(badLevel.review));
  assert.throws(() => validateP4R0RevisionInput(prep, badLevel as never), P2Error);
  const badParent = clone(trigger);
  badParent.parent.contractVersion = 99;
  assert.throws(() => validateP4R0RevisionInput(prep, badParent as never), P2Error);
  assert.equal(validateP4R0RevisionInput(prep, trigger).trigger.reviewHash, trigger.reviewHash);
});

test("group 4: parser rejects schema, row, span and rationale violations", () => {
  const prep = makeRevisionR0();
  const { trigger } = makeRevisionTrigger(prep);
  const good = revisionReport(prep, trigger);
  assert.equal(parseP4R0RevisionReport(good, prep, trigger).changes.length, 1);
  const bad: readonly string[] = [
    revisionRawOf(prep, trigger, (report) => {
      report.schemaVersion = "p4-r0-plan-revision-v2";
    }),
    revisionRawOf(prep, trigger, (report) => {
      report.requestId = "model-1";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.parent as Record<string, unknown>).sessionId = "other";
    }),
    revisionRawOf(prep, trigger, (report) => {
      report.reviewHash = "0".repeat(64);
    }),
    revisionRawOf(prep, trigger, (report) => {
      report.extra = 1;
    }),
    revisionRawOf(prep, trigger, (report) => {
      report.changes = [];
    }),
    revisionRawOf(prep, trigger, (report) => {
      const rows = report.changes as Record<string, unknown>[];
      report.changes = [rows[0]!, rows[0]!];
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.goalId = "ghost";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.fromKind = "ALL_SOLUTIONS";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.toKind = "VALUE";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.toKind = "MULTIPART";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.issueDimension = "OTHER";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.rationale = "   ";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.scope = {};
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.assumptions = [];
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.subgoals = [];
    }),
    revisionRawOf(prep, trigger, (report) => {
      report.goals = [];
    }),
    revisionRawOf(prep, trigger, (report) => {
      const row = (report.changes as Record<string, unknown>[])[0]!;
      row.planSpan = row.problemSpan;
    }),
    revisionRawOf(prep, trigger, (report) => {
      const span = (report.changes as Record<string, unknown>[])[0]!.planSpan as Record<string, unknown>;
      span.quote = "{}";
    }),
    revisionRawOf(prep, trigger, (report) => {
      (report.changes as Record<string, unknown>[])[0]!.problemSpan = null;
    }),
    good.replace('"requestId":"model-2"', '"requestId":"model-2","requestId":"model-2"'),
    good.replace('"start":0', '"start":0.5'),
    good.replace("fixture revision", "\\ud800"),
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(() => parseP4R0RevisionReport(text, prep, trigger), P2Error);
  }
  const session = admitted(prep, trigger);
  session.markDispatched();
  const record = session.settle("COMPLETE", "not json", 800);
  assert.equal(record.code, "INVALID_REVISION");
  assert.equal(record.rawResponseText, "not json");
  assert.equal(record.report, null);
  assert.equal(record.lineage, null);
  assert.equal(session.snapshot().revisedContract, null);
  assert.equal(session.snapshot().delta, null);
  session.markStale();
  assert.equal(session.snapshot().availability, "STALE");
  assert.equal(session.snapshot().record!.code, "INVALID_REVISION");
});

test("group 5: revision admission budget, single flight and stale", () => {
  const prep = makeRevisionR0();
  const { trigger } = makeRevisionTrigger(prep);
  for (const args of [
    [25, 2, 3],
    [1001, 2, 3],
    [900, 1, 3],
    [900, 2, 2],
    [900, 2, 4],
    [900, 3, 3],
  ] as const) {
    const session = new P4R0PlanRevisionSession(prep, trigger);
    assert.throws(() => session.admit(args[0], args[1], args[2]), P2Error);
    assert.equal(session.snapshot().record, null);
  }
  assert.throws(() => new P4R0PlanRevisionSession(prep, trigger, 0).admit(900, 2, 3), P2Error);
  assert.throws(() => new P4R0PlanRevisionSession(prep, trigger, 2), P2Error);

  const session = new P4R0PlanRevisionSession(prep, trigger);
  const record = session.admit(900, 2, 3);
  assert.equal(record.state, "ADMITTED");
  assert.throws(() => session.admit(900, 2, 3), P2Error);
  assert.throws(() => session.markStale(), P2Error);
  assert.throws(() => session.settle("COMPLETE", revisionReport(prep, trigger), 800), P2Error);
  session.markDispatched();
  assert.throws(() => session.markDispatched(), P2Error);
  assert.throws(() => session.settle("COMPLETE", revisionReport(prep, trigger), 901), P2Error);
  assert.equal(session.snapshot().record!.state, "DISPATCHED");
  const settled = session.settle("COMPLETE", revisionReport(prep, trigger), 800);
  assert.equal(settled.code, "PROPOSAL_RECORDED");
  assert.throws(() => session.settle("COMPLETE", revisionReport(prep, trigger), 800), P2Error);
  assert.throws(() => session.admit(900, 2, 3), P2Error);
  const childHash = session.snapshot().record!.lineage!.child.planHash;
  const raw = session.snapshot().record!.rawResponseText;
  session.markStale();
  assert.equal(session.snapshot().availability, "STALE");
  assert.equal(session.snapshot().record!.lineage!.child.planHash, childHash);
  assert.equal(session.snapshot().record!.rawResponseText, raw);
});

test("group 6: revision transport and late handling", () => {
  const prep = makeRevisionR0();
  const { trigger } = makeRevisionTrigger(prep);
  const good = revisionReport(prep, trigger);
  for (const transport of ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    for (const remaining of [0, 25, 26]) {
      const session = new P4R0PlanRevisionSession(prep, trigger);
      session.admit(900, 2, 3);
      session.markDispatched();
      const record = session.settle(transport, good, remaining);
      assert.equal(record.rawResponseText, good);
      const snapshot = session.snapshot();
      if (transport === "UNKNOWN") {
        assert.equal(record.code, "OUTCOME_UNKNOWN");
        assert.equal(record.state, "OUTCOME_UNKNOWN");
      } else if (remaining <= 25) {
        assert.equal(record.code, "DEADLINE_EXCEEDED");
      } else if (transport !== "COMPLETE") {
        assert.equal(record.code, "TRANSPORT_INCOMPLETE");
      } else {
        assert.equal(record.code, "PROPOSAL_RECORDED");
      }
      if (record.code === "PROPOSAL_RECORDED") {
        assert.notEqual(record.lineage, null);
        assert.notEqual(snapshot.revisedContract, null);
        assert.notEqual(snapshot.delta, null);
      } else {
        assert.equal(record.lineage, null);
        assert.equal(snapshot.revisedContract, null);
        assert.equal(snapshot.delta, null);
      }
      assert.equal(snapshot.events.some((event) => event.eventType === "OBLIGATION_SATISFIED"), false);
      assert.equal(snapshot.events.filter((event) => event.eventType === "CONTRACT_COMPILED").length, 1);
      assert.throws(() => session.settle(transport, good, remaining), P2Error);
    }
  }
});

test("group 7: multipart parent is not a retypeable leaf", () => {
  const prep = makeRevisionMultipartR0();
  const { trigger } = makeRevisionTrigger(prep);
  const root = prep.target.contract.goals[0]!;
  assert.equal(root.kind, "MULTIPART");
  const report = revisionReportOf(prep, trigger, "a");
  const row = (report.changes as Record<string, unknown>[])[0]!;
  row.goalId = "goal-1";
  row.fromKind = "MULTIPART";
  row.planSpan = codepointSpan(prep.target.planText, JSON.stringify(root));
  const raw = JSON.stringify(report);
  assert.throws(() => parseP4R0RevisionReport(raw, prep, trigger), P2Error);
  const session = new P4R0PlanRevisionSession(prep, trigger);
  session.admit(900, 2, 3);
  session.markDispatched();
  const record = session.settle("COMPLETE", raw, 800);
  assert.equal(record.code, "INVALID_REVISION");
  assert.equal(record.rawResponseText, raw);
  assert.equal(record.report, null);
  assert.equal(record.lineage, null);
  assert.equal(session.snapshot().revisedContract, null);
});

test("group 8: only the recorded ISSUES dimension is accepted", () => {
  const prep = makeRevisionR0();
  const review = makeIssuesReview(prep);
  const report = JSON.parse(review.record!.rawResponseText!) as Record<string, unknown>;
  const checks = report.checks as Record<string, unknown>[];
  assert.equal(checks[0]!.verdict, "ISSUES");
  for (const index of [1, 2]) {
    checks[index]!.verdict = "NO_ISSUE";
  }
  const raw = JSON.stringify(report);
  const session = new P4R0ReviewSession(prep);
  session.admit(1000, 4);
  session.markDispatched();
  const settled = session.settle("COMPLETE", raw, 900);
  assert.equal(settled.code, "OK");
  assert.equal(settled.report!.conclusion, "ISSUES");
  const trigger = createP4R0RevisionTrigger(prep, session.snapshot());
  assert.deepEqual(trigger.issueDimensions, ["PROBLEM_ALIGNMENT"]);
  const good = revisionReport(prep, trigger);
  assert.equal(parseP4R0RevisionReport(good, prep, trigger).changes[0]!.issueDimension, "PROBLEM_ALIGNMENT");
  const bad = revisionReportOf(prep, trigger);
  (bad.changes as Record<string, unknown>[])[0]!.issueDimension = "SCOPE";
  assert.throws(() => parseP4R0RevisionReport(JSON.stringify(bad), prep, trigger), P2Error);
});

test("group 9: extra span key is rejected and the raw is kept", () => {
  const prep = makeRevisionR0();
  const { trigger } = makeRevisionTrigger(prep);
  const report = revisionReportOf(prep, trigger);
  const span = (report.changes as Record<string, unknown>[])[0]!.planSpan as Record<string, unknown>;
  span.extra = 1;
  const raw = JSON.stringify(report);
  assert.throws(() => parseP4R0RevisionReport(raw, prep, trigger), P2Error);
  const session = new P4R0PlanRevisionSession(prep, trigger);
  session.admit(900, 2, 3);
  session.markDispatched();
  const record = session.settle("COMPLETE", raw, 800);
  assert.equal(record.code, "INVALID_REVISION");
  assert.equal(record.rawResponseText, raw);
  assert.equal(record.report, null);
  assert.equal(record.lineage, null);
  assert.equal(session.snapshot().revisedContract, null);
  assert.equal(session.snapshot().delta, null);
});
