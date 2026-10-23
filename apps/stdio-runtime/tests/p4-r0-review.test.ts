import test from "node:test";
import assert from "node:assert/strict";

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P4R0ReviewSession, parseP4R0Report, validateP4R0Input } from "@astra/math-review";
import { P2Error, p4Hash, type P4R0Preparation, type P4R0Role } from "@astra/protocol";

import { makeR0, makeR0Default, r0Report, type Mutable } from "./p4-r0-fixtures.js";

const ROLE_DIMENSION = {
  MEANING: "PROBLEM_ALIGNMENT",
  METHOD: "SCOPE",
  TASK_TOOL: "TASK_COVERAGE",
} as const;

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

function reportOf(prep: P4R0Preparation, role: P4R0Role = "MEANING"): Record<string, unknown> {
  return JSON.parse(r0Report(prep, "NO_ISSUE", role)) as Record<string, unknown>;
}

function rawOf(
  prep: P4R0Preparation,
  mutate: (report: Record<string, unknown>) => void,
  role: P4R0Role = "MEANING",
): string {
  const report = reportOf(prep, role);
  mutate(report);
  return JSON.stringify(report);
}

function admitted(prep: P4R0Preparation, role: P4R0Role = "MEANING"): P4R0ReviewSession {
  const session = new P4R0ReviewSession(prep);
  session.admit(role, "model-1", 1000, 5);
  return session;
}

test("group 1: real preparation, role-scoped context and session lifecycle", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const before = JSON.stringify(prep.target.contract);
  for (const role of ["MEANING", "METHOD", "TASK_TOOL"] as const) {
    for (const verdict of ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const) {
      const parsed = parseP4R0Report(r0Report(prep, verdict, role), prep, role, "model-1");
      assert.equal(parsed.conclusion, verdict);
      assert.equal(parsed.requestId, "model-1");
      assert.equal(parsed.stage, "R0");
      assert.equal(parsed.role, role);
      // A role-scoped reply carries exactly the one dimension that role owns.
      assert.equal(parsed.checks.length, 1);
      assert.equal(parsed.checks[0]!.dimension, ROLE_DIMENSION[role]);
      assert.deepEqual(
        parsed.reviewCoverage,
        prep.target.contract.obligations.map((item) => item.obligationId),
      );
    }
  }
  const session = new P4R0ReviewSession(prep);
  const record = session.admit("MEANING", "model-1", 1000, 5);
  assert.equal(record.state, "ADMITTED");
  assert.equal(record.role, "MEANING");
  assert.equal(record.requestId, "model-1");
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
  assert.equal(payload.requestId, "model-1");
  assert.equal(payload.role, "MEANING");
  assert.deepEqual(payload.dimensions, ["PROBLEM_ALIGNMENT"]);
  assert.equal(record.context.contextBytes, Buffer.byteLength(JSON.stringify(record.context.messages), "utf8"));
  assert.equal(record.context.contextHash, p4Hash(JSON.stringify(record.context.messages)));
  assert.match(record.context.messages[0]!.content, /method premises/);
  assert.match(record.context.messages[0]!.content, /PROBLEM_ALIGNMENT/);
  assert.doesNotMatch(record.context.messages[0]!.content, /TASK_COVERAGE/);
  session.markDispatched("MEANING");
  const settled = session.settle("MEANING", "COMPLETE", r0Report(prep), 900);
  assert.equal(settled.code, "OK");
  assert.equal(settled.level, "REVIEWED");
  assert.equal(settled.checkResult, "UNKNOWN");
  assert.equal(settled.canSupportObligation, false);
  assert.equal(settled.canReviseContract, false);
  const unknown = new P4R0ReviewSession(prep);
  unknown.admit("MEANING", "model-1", 1000, 5);
  unknown.markDispatched("MEANING");
  assert.equal(
    unknown.settle("MEANING", "COMPLETE", r0Report(prep, "UNKNOWN"), 900).level,
    "PROVISIONAL",
  );
  assert.equal(JSON.stringify(prep.target.contract), before);
  for (const obligation of prep.target.contract.obligations) {
    assert.equal(obligation.status, "OPEN");
  }
});

test("group 1a: three independent role dispatches, disjoint prompts and payloads", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const session = new P4R0ReviewSession(prep);
  const seenRequestIds = new Set<string>();
  const prompts: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const roles = ["MEANING", "METHOD", "TASK_TOOL"] as const;
  roles.forEach((role, index) => {
    const requestId = `model-${index + 1}`;
    const record = session.admit(role, requestId, 1000, 5);
    assert.equal(record.requestId, requestId);
    seenRequestIds.add(record.requestId);
    prompts.push(record.context.messages[0]!.content);
    payloads.push(JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>);
    session.markDispatched(role);
    const settled = session.settle(
      role,
      "COMPLETE",
      r0Report(prep, "NO_ISSUE", role, requestId),
      900,
    );
    assert.equal(settled.code, "OK");
    assert.equal(settled.role, role);
  });
  // Three separate calls, three distinct request ids, never one shared call.
  assert.equal(seenRequestIds.size, 3);
  assert.equal(new Set(prompts).size, 3);
  for (const [index, role] of roles.entries()) {
    const dimension = ROLE_DIMENSION[role];
    assert.deepEqual(payloads[index]!.dimensions, [dimension]);
    assert.equal(payloads[index]!.role, role);
    assert.equal(payloads[index]!.requestId, `model-${index + 1}`);
    // Each prompt names only its own dimension and only its own instruction.
    for (const other of roles) {
      if (other === role) {
        assert.match(prompts[index]!, new RegExp(ROLE_DIMENSION[other]));
      } else {
        assert.doesNotMatch(prompts[index]!, new RegExp(ROLE_DIMENSION[other]));
      }
    }
  }
  // All three per-role snapshots are settled and independently addressable.
  const snapshots = session.snapshots();
  assert.deepEqual(
    snapshots.map((row) => row.role),
    ["MEANING", "METHOD", "TASK_TOOL"],
  );
  for (const snapshot of snapshots) {
    assert.equal(snapshot.record!.state, "RETURNED");
    assert.equal(snapshot.record!.report!.role, snapshot.role);
  }
});

test("group 1b: a second dispatch for a settled role is refused", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const session = new P4R0ReviewSession(prep);
  const roles = ["MEANING", "METHOD", "TASK_TOOL"] as const;
  for (const [index, role] of roles.entries()) {
    const requestId = `model-${index + 1}`;
    session.admit(role, requestId, 1000, 5);
    session.markDispatched(role);
    assert.equal(
      session.settle(role, "COMPLETE", r0Report(prep, "NO_ISSUE", role, requestId), 900).code,
      "OK",
    );
    // The same role is never re-dispatched: no retry and no second opinion.
    rejects(() => session.admit(role, "model-9", 1000, 5), "ILLEGAL_TRANSITION");
    rejects(() => session.markDispatched(role), "ILLEGAL_TRANSITION");
    rejects(
      () => session.settle(role, "COMPLETE", r0Report(prep, "NO_ISSUE", role, requestId), 900),
      "ILLEGAL_TRANSITION",
    );
    assert.equal(session.settled(role), true);
  }
  // An unknown role is refused, and a bound of one review refuses a second role.
  rejects(() => session.admit("OTHER" as never, "model-8", 1000, 5), "PACKET_SCHEMA");
  const single = new P4R0ReviewSession(prep, 1);
  single.admit("MEANING", "model-1", 1000, 5);
  rejects(() => single.admit("METHOD", "model-2", 1000, 5), "BUDGET_EXHAUSTED");
});

test("group 1c: a duplicate request id is refused and ids must be model-<n>", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const session = new P4R0ReviewSession(prep);
  session.admit("MEANING", "model-1", 1000, 5);
  rejects(() => session.admit("METHOD", "model-1", 1000, 5), "PACKET_BINDING");
  rejects(() => session.admit("METHOD", "review-2", 1000, 5), "PACKET_BINDING");
  rejects(() => session.admit("METHOD", "model-0", 1000, 5), "PACKET_BINDING");
  rejects(() => session.admit("METHOD", "model-1000", 1000, 5), "PACKET_BINDING");
  assert.equal(session.admit("METHOD", "model-2", 1000, 5).requestId, "model-2");
});

test("group 1d: session copies its input and ignores later mutation", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const copy = clone(prep);
  const session = new P4R0ReviewSession(copy as P4R0Preparation);
  copy.target.planText = "{}";
  copy.riskCodes = [];
  const record = session.admit("MEANING", "model-1", 1000, 5);
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.planText, prep.target.planText);
  assert.deepEqual(payload.riskCodes, prep.riskCodes);
});

test("group 2: strict role-scoped report rejection", () => {
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
    // The reply must be bound to the role it was dispatched for.
    rawOf(prep, (report) => {
      report.role = "METHOD";
    }),
    rawOf(prep, (report) => {
      report.role = "OTHER";
    }),
    rawOf(prep, (report) => {
      delete report.role;
    }),
    // The reply must be bound to the request id the call really used.
    rawOf(prep, (report) => {
      report.requestId = "model-2";
    }),
    rawOf(prep, (report) => {
      report.requestId = "initial-review";
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
    // Exactly one check, and it must be this role's own dimension.
    rawOf(prep, (report) => {
      report.checks = [];
    }),
    rawOf(prep, (report) => {
      const checks = report.checks as Record<string, unknown>[];
      report.checks = [checks[0]!, checks[0]!];
    }),
    rawOf(prep, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.dimension = "SCOPE";
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
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(
      () => parseP4R0Report(text, prep, "MEANING", "model-1"),
      (error: unknown) => error instanceof P2Error,
    );
  }
  rejects(
    () => parseP4R0Report(`${good}${" ".repeat(20001)}`, prep, "MEANING", "model-1"),
    "BOUND_EXCEEDED",
  );
  rejects(() => parseP4R0Report(good, prep, "OTHER" as never, "model-1"), "PACKET_SCHEMA");
  rejects(() => parseP4R0Report(good, prep, "MEANING", "not-a-request"), "PACKET_BINDING");
  assert.equal(parseP4R0Report(good, prep, "MEANING", "model-1").conclusion, "NO_ISSUE");
  const session = admitted(prep);
  session.markDispatched("MEANING");
  const record = session.settle("MEANING", "COMPLETE", "not json", 900);
  assert.equal(record.code, "INVALID_REPORT");
  assert.equal(record.rawResponseText, "not json");
  assert.equal(record.report, null);
});

test("group 3: admission budget, single flight per role and stale", () => {
  const skipped = makeR0Default("ALL_SOLUTIONS");
  assert.equal(skipped.action, "SKIPPED_BY_POLICY");
  rejects(() => new P4R0ReviewSession(skipped).admit("MEANING", "model-1", 1000, 5), "ILLEGAL_TRANSITION");
  const value = makeR0("VALUE");
  rejects(() => new P4R0ReviewSession(value).admit("MEANING", "model-1", 1000, 5), "ILLEGAL_TRANSITION");
  const low = makeR0("ALL_SOLUTIONS", { planningModelCalls: 0 });
  assert.equal(low.action, "INSUFFICIENT_BUDGET");
  rejects(() => new P4R0ReviewSession(low).admit("MEANING", "model-1", 1000, 5), "ILLEGAL_TRANSITION");
  const prep = makeR0("ALL_SOLUTIONS");
  rejects(() => new P4R0ReviewSession(prep, 0).admit("MEANING", "model-1", 1000, 5), "BUDGET_EXHAUSTED");
  const session = new P4R0ReviewSession(prep);
  const empty = JSON.stringify(session.snapshots());
  rejects(() => session.admit("MEANING", "model-1", 25, 5), "BOUND_EXCEEDED");
  rejects(() => session.admit("MEANING", "model-1", 1001, 5), "BOUND_EXCEEDED");
  rejects(() => session.admit("MEANING", "model-1", 1000, 1), "BOUND_EXCEEDED");
  // The frozen planning view is capped at the fixed five-call stage design.
  rejects(() => session.admit("MEANING", "model-1", 1000, 6), "BOUND_EXCEEDED");
  assert.equal(JSON.stringify(session.snapshots()), empty);
  session.admit("MEANING", "model-1", 26, 5);
  // A second admit of the same role is an illegal transition, never a retry.
  rejects(() => session.admit("MEANING", "model-2", 1000, 5), "ILLEGAL_TRANSITION");
  rejects(() => session.markStale(), "ILLEGAL_TRANSITION");
  rejects(() => session.settle("MEANING", "COMPLETE", r0Report(prep), 900), "ILLEGAL_TRANSITION");
  session.markDispatched("MEANING");
  rejects(() => session.settle("MEANING", "COMPLETE", r0Report(prep), 101), "BOUND_EXCEEDED");
  assert.equal(session.snapshot("MEANING").record!.state, "DISPATCHED");
  session.settle("MEANING", "COMPLETE", r0Report(prep), 26);
  rejects(() => session.admit("MEANING", "model-3", 1000, 5), "ILLEGAL_TRANSITION");
  rejects(() => session.settle("MEANING", "COMPLETE", r0Report(prep), 26), "ILLEGAL_TRANSITION");
  // The other two roles stay admissible: the three reviews are independent.
  assert.equal(session.admit("METHOD", "model-2", 1000, 5).role, "METHOD");
  const stale = admitted(prep);
  rejects(() => stale.markStale(), "ILLEGAL_TRANSITION");
  stale.markDispatched("MEANING");
  stale.settle("MEANING", "COMPLETE", r0Report(prep), 900);
  stale.markStale();
  assert.equal(stale.snapshot("MEANING").availability, "STALE");
  assert.equal(stale.snapshot("MEANING").record!.level, "REVIEWED");
  assert.equal(stale.snapshot("MEANING").record!.availability, "STALE");
  assert.equal(stale.snapshot("MEANING").record!.rawResponseText, r0Report(prep));
  assert.equal(stale.snapshot("MEANING").record!.checkResult, "UNKNOWN");
});

test("group 4: transport and late handling", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const good = r0Report(prep);
  for (const transport of ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    for (const remaining of [0, 25, 26]) {
      const session = new P4R0ReviewSession(prep);
      session.admit("MEANING", "model-1", 100, 5);
      session.markDispatched("MEANING");
      const record = session.settle("MEANING", transport, good, remaining);
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
  session.admit("MEANING", "model-1", 100, 5);
  session.markDispatched("MEANING");
  rejects(() => session.settle("MEANING", "COMPLETE", "\ud800", 26), "PACKET_SCHEMA");
  rejects(() => session.settle("MEANING", "COMPLETE", undefined as never, 26), "PACKET_SCHEMA");
  rejects(
    () => session.settle("MEANING", "COMPLETE", `${good}${" ".repeat(20001)}`, 26),
    "BOUND_EXCEEDED",
  );
  assert.equal(session.snapshot("MEANING").record!.state, "DISPATCHED");
  assert.equal(session.snapshot("MEANING").record!.level, "PROVISIONAL");
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
    remainingRootCalls: 5,
    remainingMs: 1000,
  });
  assert.equal(prep.action, "REQUEST_REVIEW");
  assert.equal(Buffer.byteLength(prep.target.planText, "utf8") <= 65536, true);
  const session = new P4R0ReviewSession(prep);
  rejects(() => session.admit("MEANING", "model-1", 1000, 5), "BOUND_EXCEEDED");
  assert.equal(session.snapshot("MEANING").record, null);
  assert.equal(validateP4R0Input(prep).target.binding.planHash, prep.target.binding.planHash);
});
