import test from "node:test";
import assert from "node:assert/strict";

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P4R0ReviewSession, parseP4R0Report, validateP4R0Input } from "@astra/math-review";
import { P2Error, p4Hash, type P4R0Preparation } from "@astra/protocol";

import { makeR0, makeR0Default, r0Report, type Mutable } from "./p4-r0-fixtures.js";

function rejects(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof P2Error && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function reportOf(prep: P4R0Preparation): Record<string, unknown> {
  return JSON.parse(r0Report(prep)) as Record<string, unknown>;
}

function rawOf(prep: P4R0Preparation, mutate: (report: Record<string, unknown>) => void): string {
  const report = reportOf(prep);
  mutate(report);
  return JSON.stringify(report);
}

function admitted(prep: P4R0Preparation): P4R0ReviewSession {
  const session = new P4R0ReviewSession(prep);
  session.admit(1000, 2);
  return session;
}

test("group 1: real preparation, context and session lifecycle", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const before = JSON.stringify(prep.target.contract);
  for (const verdict of ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const) {
    const parsed = parseP4R0Report(r0Report(prep, verdict), prep);
    assert.equal(parsed.conclusion, verdict);
    assert.equal(parsed.requestId, "model-1");
    assert.equal(parsed.stage, "R0");
    assert.equal(parsed.checks.length, 3);
    assert.deepEqual(
      parsed.reviewCoverage,
      prep.target.contract.obligations.map((item) => item.obligationId),
    );
  }
  const session = new P4R0ReviewSession(prep);
  const record = session.admit(1000, 2);
  assert.equal(record.state, "ADMITTED");
  assert.equal(record.context.messages.length, 2);
  assert.equal(record.context.messages[0]!.role, "system");
  assert.equal(record.context.messages[1]!.role, "user");
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.problemFullText, prep.target.contract.problemFullText);
  assert.equal(payload.planText, prep.target.planText);
  assert.deepEqual(payload.riskCodes, prep.riskCodes);
  assert.deepEqual(
    payload.reviewCoverage,
    prep.target.contract.obligations.map((item) => item.obligationId),
  );
  assert.equal(payload.planHash, prep.target.binding.planHash);
  assert.equal(record.context.contextBytes, Buffer.byteLength(JSON.stringify(record.context.messages), "utf8"));
  assert.equal(record.context.contextHash, p4Hash(JSON.stringify(record.context.messages)));
  assert.match(record.context.messages[0]!.content, /method premises/);
  session.markDispatched();
  const settled = session.settle("COMPLETE", r0Report(prep), 900);
  assert.equal(settled.code, "OK");
  assert.equal(settled.level, "REVIEWED");
  assert.equal(settled.checkResult, "UNKNOWN");
  assert.equal(settled.canSupportObligation, false);
  assert.equal(settled.canReviseContract, false);
  const unknown = new P4R0ReviewSession(prep);
  unknown.admit(1000, 2);
  unknown.markDispatched();
  assert.equal(unknown.settle("COMPLETE", r0Report(prep, "UNKNOWN"), 900).level, "PROVISIONAL");
  assert.equal(JSON.stringify(prep.target.contract), before);
  for (const obligation of prep.target.contract.obligations) {
    assert.equal(obligation.status, "OPEN");
  }
});

test("group 1b: session copies its input and ignores later mutation", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const copy = clone(prep);
  const session = new P4R0ReviewSession(copy as P4R0Preparation);
  copy.target.planText = "{}";
  copy.riskCodes = [];
  const record = session.admit(1000, 2);
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.planText, prep.target.planText);
  assert.deepEqual(payload.riskCodes, prep.riskCodes);
});

test("group 2: strict report rejection", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const good = r0Report(prep);
  const bad: readonly string[] = [
    rawOf(prep, (report) => {
      (report.target as Record<string, unknown>).sessionId = "other";
    }),
    rawOf(prep, (report) => {
      report.planHash = "0".repeat(64);
    }),
    rawOf(prep, (report) => {
      report.schemaVersion = "p4-r0-review-v2";
    }),
    rawOf(prep, (report) => {
      report.stage = "R1";
    }),
    rawOf(prep, (report) => {
      report.requestId = "model-2";
    }),
    rawOf(prep, (report) => {
      report.reviewCoverage = [];
    }),
    rawOf(prep, (report) => {
      report.reviewCoverage = [...(report.reviewCoverage as string[])].reverse();
    }),
    rawOf(prep, (report) => {
      const coverage = report.reviewCoverage as string[];
      report.reviewCoverage = [coverage[0]!, coverage[0]!, ...coverage.slice(1)];
    }),
    rawOf(prep, (report) => {
      report.checks = (report.checks as unknown[]).slice(0, 2);
    }),
    rawOf(prep, (report) => {
      const checks = report.checks as Record<string, unknown>[];
      report.checks = [checks[0]!, checks[0]!, checks[2]!];
    }),
    rawOf(prep, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.dimension = "OTHER";
    }),
    rawOf(prep, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.verdict = "ISSUES";
    }),
    rawOf(prep, (report) => {
      const checks = report.checks as Record<string, unknown>[];
      checks[0]!.problemSpan = checks[0]!.planSpan;
    }),
    rawOf(prep, (report) => {
      const checks = report.checks as Record<string, unknown>[];
      const span = checks[0]!.problemSpan as Record<string, unknown>;
      span.end = 2;
      span.quote = "😀";
    }),
    rawOf(prep, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.problemSpan = null;
    }),
    rawOf(prep, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.rationale = "   ";
    }),
    rawOf(prep, (report) => {
      report.extra = 1;
    }),
    good.replace('"stage":"R0"', '"stage":"R0","stage":"R0"'),
    good.replace('"start":0', '"start":0.5'),
    good.replace('"start":0', '"start":9007199254740993'),
    good.replace("fixture", "\\ud800"),
    `${good.slice(0, -1)}${" ".repeat(0)}`,
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(
      () => parseP4R0Report(text, prep),
      (error: unknown) => error instanceof P2Error,
    );
  }
  rejects(() => parseP4R0Report(`${good}${" ".repeat(20001)}`, prep), "BOUND_EXCEEDED");
  assert.equal(parseP4R0Report(good, prep).conclusion, "NO_ISSUE");
  const session = admitted(prep);
  session.markDispatched();
  const record = session.settle("COMPLETE", "not json", 900);
  assert.equal(record.code, "INVALID_REPORT");
  assert.equal(record.rawResponseText, "not json");
  assert.equal(record.report, null);
});

test("group 3: admission budget, single flight and stale", () => {
  const skipped = makeR0Default("ALL_SOLUTIONS");
  assert.equal(skipped.action, "SKIPPED_BY_POLICY");
  rejects(() => new P4R0ReviewSession(skipped).admit(1000, 2), "ILLEGAL_TRANSITION");
  const value = makeR0("VALUE");
  rejects(() => new P4R0ReviewSession(value).admit(1000, 2), "ILLEGAL_TRANSITION");
  const low = makeR0("ALL_SOLUTIONS", { planningModelCalls: 0 });
  assert.equal(low.action, "INSUFFICIENT_BUDGET");
  rejects(() => new P4R0ReviewSession(low).admit(1000, 2), "ILLEGAL_TRANSITION");
  const prep = makeR0("ALL_SOLUTIONS");
  rejects(() => new P4R0ReviewSession(prep, 0).admit(1000, 2), "BUDGET_EXHAUSTED");
  const session = new P4R0ReviewSession(prep);
  const empty = JSON.stringify(session.snapshot());
  rejects(() => session.admit(25, 2), "BOUND_EXCEEDED");
  rejects(() => session.admit(1001, 2), "BOUND_EXCEEDED");
  rejects(() => session.admit(1000, 1), "BOUND_EXCEEDED");
  rejects(() => session.admit(1000, 4), "BOUND_EXCEEDED");
  assert.equal(JSON.stringify(session.snapshot()), empty);
  session.admit(26, 2);
  rejects(() => session.admit(1000, 2), "BUDGET_EXHAUSTED");
  rejects(() => session.markStale(), "ILLEGAL_TRANSITION");
  rejects(() => session.settle("COMPLETE", r0Report(prep), 900), "ILLEGAL_TRANSITION");
  session.markDispatched();
  rejects(() => session.settle("COMPLETE", r0Report(prep), 101), "BOUND_EXCEEDED");
  assert.equal(session.snapshot().record!.state, "DISPATCHED");
  session.settle("COMPLETE", r0Report(prep), 26);
  rejects(() => session.admit(1000, 2), "BUDGET_EXHAUSTED");
  rejects(() => session.settle("COMPLETE", r0Report(prep), 26), "ILLEGAL_TRANSITION");
  const stale = admitted(prep);
  rejects(() => stale.markStale(), "ILLEGAL_TRANSITION");
  stale.markDispatched();
  stale.settle("COMPLETE", r0Report(prep), 900);
  stale.markStale();
  assert.equal(stale.snapshot().availability, "STALE");
  assert.equal(stale.snapshot().record!.level, "REVIEWED");
  assert.equal(stale.snapshot().record!.availability, "STALE");
  assert.equal(stale.snapshot().record!.rawResponseText, r0Report(prep));
  assert.equal(stale.snapshot().record!.checkResult, "UNKNOWN");
});

test("group 4: transport and late handling", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const good = r0Report(prep);
  for (const transport of ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    for (const remaining of [0, 25, 26]) {
      const session = new P4R0ReviewSession(prep);
      session.admit(100, 2);
      session.markDispatched();
      const record = session.settle(transport, good, remaining);
      assert.equal(record.rawResponseText, good);
      assert.equal(record.checkResult, "UNKNOWN");
      assert.equal(record.canSupportObligation, false);
      if (transport === "UNKNOWN") {
        assert.equal(record.code, "OUTCOME_UNKNOWN");
        assert.equal(record.state, "OUTCOME_UNKNOWN");
      } else if (remaining <= 25) {
        assert.equal(record.code, "DEADLINE_EXCEEDED");
      } else if (transport === "COMPLETE") {
        assert.equal(record.code, "OK");
      } else {
        assert.equal(record.code, "TRANSPORT_INCOMPLETE");
      }
    }
  }
  const session = new P4R0ReviewSession(prep);
  session.admit(100, 2);
  session.markDispatched();
  rejects(() => session.settle("COMPLETE", "\ud800", 26), "PACKET_SCHEMA");
  rejects(() => session.settle("COMPLETE", undefined as never, 26), "PACKET_SCHEMA");
  rejects(() => session.settle("COMPLETE", `${good}${" ".repeat(20001)}`, 26), "BOUND_EXCEEDED");
  assert.equal(session.snapshot().record!.state, "DISPATCHED");
  assert.equal(session.snapshot().record!.level, "PROVISIONAL");
});

test("group 5: oversized context is refused without a record", () => {
  const filler = '"'.repeat(4096);
  const base = compileP2Contract("😀 Prove 1+1=2", "r0");
  const contract = compileP2Contract("😀 Prove 1+1=2", "r0", [
    {
      goalId: "goal-1",
      kind: "PROOF",
      scope: {
        ...base.goals[0]!.scope,
        localAssumptions: Array.from({ length: 2 }, () => filler),
      },
      subgoals: [],
    },
  ]);
  const prep = prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 3,
    remainingMs: 1000,
  });
  assert.equal(prep.action, "REQUEST_REVIEW");
  assert.equal(Buffer.byteLength(prep.target.planText, "utf8") <= 65536, true);
  const session = new P4R0ReviewSession(prep);
  rejects(() => session.admit(1000, 2), "BOUND_EXCEEDED");
  assert.equal(session.snapshot().record, null);
  assert.equal(validateP4R0Input(prep).target.binding.planHash, prep.target.binding.planHash);
});
