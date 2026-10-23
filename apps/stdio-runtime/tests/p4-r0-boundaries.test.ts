import test from "node:test";
import assert from "node:assert/strict";

import { ContractLedger } from "@astra/math-contract";
import { P2Error, type P2Contract, type P2Task } from "@astra/protocol";

import {
  runP4R0Fixture,
  type P4FixtureReceipt,
  type P4R0FixtureOptions,
} from "../src/p4-r0-fixture.js";
import { makeR0, r0Report } from "./p4-r0-fixtures.js";

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

function workRaw(contract: P2Contract, sourceRequestId: string): string {
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
    const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  if (task === undefined) {
    throw new Error("no candidate task");
  }
  const running: P2Task = ledger.startTask(task.taskId);
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: running.taskId,
    goalId: running.goalId,
    scopeId: running.scopeId,
    routeId: "route-1",
    sourceRequestId,
    claim: "the candidate is x=1",
    derivation: "offline fixture derivation",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "x=1",
  });
}

function complete(text: string): P4FixtureReceipt {
  return { transportStatus: "COMPLETE", text };
}

test("group 1: clock sampling points stay bounded and never fabricate a candidate", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const cases = [
    { maxModelCalls: 5, r0Enabled: true, planningPercent: 25, source: "model-2" },
    { maxModelCalls: 1, r0Enabled: false, planningPercent: 25, source: "model-1" },
  ] as const;
  for (const row of cases) {
    const work = workRaw(contract, row.source);
    const receipts: { r0?: P4FixtureReceipt; work?: P4FixtureReceipt } = { work: complete(work) };
    if (row.r0Enabled) {
      receipts.r0 = complete(r0Report(prep));
    }
    let total = 0;
    const base = runP4R0Fixture(problem, session, receipts, {
      maxModelCalls: row.maxModelCalls,
      r0Enabled: row.r0Enabled,
      planningPercent: row.planningPercent,
      remainingMs: 1000,
      policy: "BEST_EFFORT",
      now: () => {
        total += 1;
        return 0;
      },
    });
    const baselineCalls = base.summary.modelCalls;
    assert.equal(baselineCalls, row.r0Enabled ? 2 : 1);
    assert.equal(total, row.r0Enabled ? 12 : 8);
    assert.equal(base.summary.candidateVerified, false);
    assert.equal(base.summary.strictAcceptance, "NOT_PERFORMED");

    rejects(
      () =>
        runP4R0Fixture(problem, session, receipts, {
          maxModelCalls: row.maxModelCalls,
          r0Enabled: row.r0Enabled,
          planningPercent: row.planningPercent,
          remainingMs: 1000,
          policy: "BEST_EFFORT",
          now: () => Number.NaN,
        }),
      "DEADLINE_EXCEEDED",
    );
    rejects(
      () =>
        runP4R0Fixture(problem, session, receipts, {
          maxModelCalls: row.maxModelCalls,
          r0Enabled: row.r0Enabled,
          planningPercent: row.planningPercent,
          remainingMs: 1000,
          policy: "BEST_EFFORT",
          now: () => {
            throw new Error("clock");
          },
        }),
      "DEADLINE_EXCEEDED",
    );

    for (let point = 2; point <= total; point += 1) {
      for (const mode of ["NAN", "THROW", "REWIND"] as const) {
        let reads = 0;
        const broken = runP4R0Fixture(problem, session, receipts, {
          maxModelCalls: row.maxModelCalls,
          r0Enabled: row.r0Enabled,
          planningPercent: row.planningPercent,
          remainingMs: 1000,
          policy: "BEST_EFFORT",
          now: () => {
            reads += 1;
            if (reads === point) {
              if (mode === "NAN") {
                return Number.NaN;
              }
              if (mode === "THROW") {
                throw new Error("clock");
              }
              return -1;
            }
            return 0;
          },
        });
        assert.equal(broken.summary.modelCalls <= baselineCalls, true);
        assert.equal(broken.summary.candidateVerified, false);
        assert.equal(broken.summary.status, "unsolved");
        assert.equal(
          broken.privateState.modelGate.filter((record) => record.state !== "ADMITTED").length,
          broken.summary.modelCalls,
        );
        if (broken.summary.parentProtected) {
          assert.notEqual(broken.privateState.decision.protectedCandidate, null);
        }
      }
    }
  }
});

test("group 2: first-read option tampering and single-read getters", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work = workRaw(contract, "model-1");

  let tampered = 0;
  const options = {
    get maxModelCalls() {
      tampered += 1;
      return tampered === 1 ? 1 : 4;
    },
    get r0Enabled() {
      return false;
    },
    get planningPercent() {
      return 25;
    },
    get remainingMs() {
      return 1000;
    },
    get policy() {
      return "BEST_EFFORT" as const;
    },
    get now() {
      return () => 0;
    },
  };
  const captured = runP4R0Fixture(problem, session, { work: complete(work) }, options);
  assert.equal(captured.summary.rootMaxModelCalls, 1);
  assert.equal(captured.summary.r0Calls, 0);
  assert.equal(captured.summary.workCalls, 1);
  assert.equal(captured.summary.planningAllowance, 0);
  assert.equal(tampered, 1);

  const prep2 = makeR0("ALL_SOLUTIONS");
  const contract2 = prep2.target.contract;
  const work2 = workRaw(contract2, "model-2");
  let reads = 0;
  const enabled = {
    maxModelCalls: 5,
    get r0Enabled() {
      reads += 1;
      return true;
    },
    planningPercent: 25,
    remainingMs: 1000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  };
  const reviewed = runP4R0Fixture(
    contract2.problemFullText,
    contract2.envelope.sessionId,
    { r0: complete(r0Report(prep2)), work: complete(work2) },
    enabled,
  );
  assert.equal(reads, 1);
  assert.equal(reviewed.summary.r0Action, "REQUEST_REVIEW");
  assert.equal(reviewed.summary.r0Conclusion, "NO_ISSUE");
  assert.equal(reviewed.summary.r0Calls, 1);
  assert.equal(reviewed.summary.workCalls, 1);
  assert.equal(reviewed.privateState.r0!.record!.rawResponseText, r0Report(prep2));
  assert.equal(reviewed.privateState.artifacts[0]!.artifact.sourceRequestId, "model-2");
});

test("group 2b: callback tampering after the first clock read is ignored", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work = workRaw(contract, "model-1");

  const mutable: {
    maxModelCalls: number;
    r0Enabled: boolean;
    planningPercent: number;
    remainingMs: number;
    policy: "BEST_EFFORT" | "STRICT";
    now: () => number;
  } = {
    maxModelCalls: 1,
    r0Enabled: false,
    planningPercent: 25,
    remainingMs: 100,
    policy: "BEST_EFFORT",
    now: () => {
      mutable.maxModelCalls = 4;
      mutable.r0Enabled = true;
      mutable.planningPercent = 100;
      mutable.remainingMs = 5000;
      mutable.now = () => Number.NaN;
      return 0;
    },
  };
  const captured = runP4R0Fixture(
    problem,
    session,
    { work: complete(work) },
    mutable as P4R0FixtureOptions,
  );
  assert.equal(captured.summary.rootMaxModelCalls, 1);
  assert.equal(captured.summary.planningPercent, 25);
  assert.equal(captured.summary.planningAllowance, 0);
  assert.equal(captured.summary.r0Calls, 0);
  assert.equal(captured.summary.workCalls, 1);
  assert.equal(captured.summary.modelCalls, 1);
  assert.equal(captured.privateState.modelGate[0]!.requestId, "model-1");
  assert.equal(captured.privateState.artifacts[0]!.artifact.sourceRequestId, "model-1");

  const prep2 = makeR0("ALL_SOLUTIONS");
  const contract2 = prep2.target.contract;
  const work2 = workRaw(contract2, "model-2");
  const goodR0 = r0Report(prep2);
  const mutable2: {
    maxModelCalls: number;
    r0Enabled: boolean;
    planningPercent: number;
    remainingMs: number;
    policy: "BEST_EFFORT" | "STRICT";
    now: () => number;
  } = {
    maxModelCalls: 5,
    r0Enabled: true,
    planningPercent: 25,
    remainingMs: 1000,
    policy: "BEST_EFFORT",
    now: () => {
      (receipts.r0 as { text: string }).text = "{";
      (receipts.work as { text: string }).text = "{";
      mutable2.policy = "STRICT";
      mutable2.maxModelCalls = 0;
      return 0;
    },
  };
  const receipts: { r0?: P4FixtureReceipt; work?: P4FixtureReceipt } = {
    r0: complete(goodR0),
    work: complete(work2),
  };
  const reviewed = runP4R0Fixture(
    contract2.problemFullText,
    contract2.envelope.sessionId,
    receipts,
    mutable2 as P4R0FixtureOptions,
  );
  assert.equal(reviewed.summary.policy, "BEST_EFFORT");
  assert.equal(reviewed.summary.rootMaxModelCalls, 5);
  assert.equal(reviewed.summary.r0Action, "REQUEST_REVIEW");
  assert.equal(reviewed.summary.r0Conclusion, "NO_ISSUE");
  assert.equal(reviewed.summary.r0Calls, 1);
  assert.equal(reviewed.summary.workCalls, 1);
  assert.equal(reviewed.summary.modelCalls, 2);
  assert.equal(reviewed.privateState.r0!.record!.rawResponseText, goodR0);
  assert.equal(reviewed.privateState.r0!.record!.code, "OK");
  assert.equal(reviewed.privateState.artifacts[0]!.artifact.sourceRequestId, "model-2");
});

test("group 3: deadline boundary at 26/25 and pristine R0 plan binding", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work = workRaw(contract, "model-2");
  const receipts = { r0: complete(r0Report(prep)), work: complete(work) };
  const options = {
    maxModelCalls: 5,
    r0Enabled: true,
    planningPercent: 25,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
  } as const;

  let ticks26 = 0;
  const at26 = runP4R0Fixture(problem, session, receipts, {
    ...options,
    now: () => {
      ticks26 += 1;
      return ticks26 === 1 ? 0 : 4974;
    },
  });
  assert.equal(at26.summary.r0Calls, 1);
  assert.equal(at26.summary.workCalls, 1);
  assert.equal(at26.summary.modelCalls, 2);
  assert.equal(at26.summary.r0Conclusion, "NO_ISSUE");
  assert.equal(at26.summary.candidateVerified, false);
  assert.equal(at26.privateState.r0!.record!.code, "OK");
  assert.equal(at26.privateState.r0!.record!.checkResult, "UNKNOWN");
  assert.equal(at26.privateState.r0!.record!.canSupportObligation, false);
  assert.equal(at26.privateState.r0!.record!.canReviseContract, false);
  assert.equal(at26.privateState.modelGate[0]!.planHash, prep.target.binding.planHash);
  assert.equal(at26.privateState.modelGate[1]!.planHash, prep.target.binding.planHash);
  const started = at26.privateState.events.filter((event) => event.eventType === "TASK_STARTED");
  assert.equal(started.length, 1);
  assert.equal(started[0]!.taskId, (JSON.parse(work) as { taskId: string }).taskId);
  const deliveries = at26.privateState.events.filter((event) => event.eventType === "DELIVERY_RECORDED");
  assert.equal(deliveries.length, 1);
  for (const obligation of at26.privateState.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  assert.equal(at26.summary.finalResponse.includes(problem), false);
  assert.equal(at26.summary.finalResponse.includes(prep.target.planText), false);
  assert.equal(at26.summary.finalResponse.includes("fixture PROBLEM_ALIGNMENT"), false);

  let ticks25 = 0;
  const at25 = runP4R0Fixture(problem, session, receipts, {
    ...options,
    now: () => {
      ticks25 += 1;
      return ticks25 === 1 ? 0 : 4975;
    },
  });
  assert.equal(at25.summary.r0Calls, 0);
  assert.equal(at25.summary.workCalls, 0);
  assert.equal(at25.summary.modelCalls, 0);
  assert.equal(at25.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(at25.privateState.modelGate.length, 0);
  assert.equal(at25.privateState.artifacts.length, 0);
  assert.equal(at25.summary.parentProtected, false);
  assert.equal(at25.summary.status, "unsolved");
  assert.equal(at25.privateState.events.filter((event) => event.eventType === "TASK_STARTED").length, 0);
});

test("group 4: late UNKNOWN R0 transport stops without retry", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work = workRaw(contract, "model-2");
  const good = r0Report(prep);
  let reads = 0;
  const result = runP4R0Fixture(
    problem,
    session,
    { r0: { transportStatus: "UNKNOWN", text: good }, work: complete(work) },
    {
      maxModelCalls: 5,
      r0Enabled: true,
      planningPercent: 25,
      remainingMs: 1000,
      policy: "BEST_EFFORT",
      now: () => {
        reads += 1;
        return reads < 7 ? 0 : Number.NaN;
      },
    },
  );
  assert.equal(result.summary.r0Calls, 1);
  assert.equal(result.summary.workCalls, 0);
  assert.equal(result.summary.modelCalls, 1);
  assert.equal(result.summary.stopReason, "R0_STOP");
  assert.equal(result.privateState.r0!.record!.state, "OUTCOME_UNKNOWN");
  assert.equal(result.privateState.r0!.record!.code, "OUTCOME_UNKNOWN");
  assert.equal(result.privateState.r0!.record!.rawResponseText, good);
  assert.equal(result.privateState.r0!.record!.checkResult, "UNKNOWN");
  assert.equal(result.privateState.r0!.record!.canSupportObligation, false);
  assert.equal(result.privateState.modelGate.length, 1);
  assert.equal(result.privateState.modelGate[0]!.phase, "R0");
  assert.equal(result.privateState.modelGate[0]!.state, "OUTCOME_UNKNOWN");
  assert.equal(result.privateState.modelGate[0]!.transport, "UNKNOWN");
  assert.equal(result.privateState.artifacts.length, 0);
  assert.equal(result.summary.parentProtected, false);
  assert.equal(result.summary.status, "unsolved");
});
