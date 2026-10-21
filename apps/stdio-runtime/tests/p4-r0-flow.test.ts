import test from "node:test";
import assert from "node:assert/strict";

import { ContractLedger, compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P2Error, p2Snapshot, p4Hash, type P2Contract, type P2Task } from "@astra/protocol";

import { runP4R0Fixture, type P4FixtureReceipt } from "../src/p4-r0-fixture.js";
import { makeR0, r0Report } from "./p4-r0-fixtures.js";

const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
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

/** Real M1 contract/task material for one work receipt; no fabricated binding. */
function workRaw(
  contract: P2Contract,
  sourceRequestId: string,
  candidate = "x=1",
): { readonly raw: string; readonly task: P2Task } {
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
    const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  if (task === undefined) {
    throw new Error("no candidate task");
  }
  const running = ledger.startTask(task.taskId);
  return {
    task: running,
    raw: JSON.stringify({
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
      candidateProposal: candidate,
    }),
  };
}

function complete(text: string): P4FixtureReceipt {
  return { transportStatus: "COMPLETE", text };
}

test("group 1: default shortpath and R0 NO_ISSUE shared root", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work1 = workRaw(contract, "model-1");

  const plain = runP4R0Fixture(problem, session, { work: complete(work1.raw) }, {
    remainingMs: 1000,
    policy: "BEST_EFFORT",
    now: () => 0,
  });
  assert.equal(plain.summary.modelCalls, 1);
  assert.equal(plain.summary.workCalls, 1);
  assert.equal(plain.summary.r0Calls, 0);
  assert.equal(plain.summary.r0Action, "SKIPPED_BY_POLICY");
  assert.equal(plain.summary.r0Conclusion, "NONE");
  assert.equal(plain.summary.planningAllowance, 0);
  assert.equal(plain.summary.candidateVerified, false);
  assert.equal(plain.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(plain.privateState.r0, null);
  assert.notEqual(plain.privateState.preparation, null);
  assert.equal(plain.privateState.preparation!.action, "SKIPPED_BY_POLICY");
  assert.equal(plain.privateState.preparation!.semanticResult, "UNKNOWN");
  assert.equal(plain.privateState.preparation!.canSupportObligation, false);
  assert.equal(plain.privateState.requests.length, 1);
  assert.equal((plain.privateState.requests[0] as Record<string, unknown>).requestId, "model-1");
  assert.equal((plain.privateState.requests[0] as Record<string, unknown>).phase, "WORK");
  assert.equal(plain.privateState.modelGate.length, 1);
  assert.equal(plain.privateState.modelGate[0]!.phase, "WORK");
  assert.equal(plain.privateState.modelGate[0]!.requestId, "model-1");
  assert.equal(plain.privateState.modelGate[0]!.state, "RETURNED");
  assert.equal(plain.privateState.modelGate[0]!.transport, "COMPLETE");
  assert.equal(plain.privateState.artifacts.length, 1);
  assert.equal(plain.privateState.artifacts[0]!.artifact.checkResult, "UNKNOWN");
  assert.equal(plain.privateState.artifacts[0]!.artifact.level, "PROVISIONAL");
  assert.equal(plain.privateState.artifacts[0]!.artifact.packet!.candidateProposal, "x=1");
  assert.equal(plain.summary.parentProtected, true);
  assert.equal(plain.summary.status, "candidate");
  assert.equal(plain.summary.finalResponse.includes(problem), false);
  assert.equal(plain.summary.finalResponse.includes(prep.target.planText), false);
  for (const obligation of plain.privateState.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }

  const work2 = workRaw(contract, "model-2");
  const reviewed = runP4R0Fixture(
    problem,
    session,
    { r0: complete(r0Report(prep)), work: complete(work2.raw) },
    { maxModelCalls: 4, r0Enabled: true, planningPercent: 25, remainingMs: 1000, policy: "STRICT", now: () => 0 },
  );
  assert.equal(reviewed.summary.planningAllowance, 1);
  assert.equal(reviewed.summary.rootMaxModelCalls, 4);
  assert.equal(reviewed.summary.r0Action, "REQUEST_REVIEW");
  assert.equal(reviewed.summary.r0Conclusion, "NO_ISSUE");
  assert.equal(reviewed.summary.r0Calls, 1);
  assert.equal(reviewed.summary.workCalls, 1);
  assert.equal(reviewed.summary.modelCalls, 2);
  assert.equal(reviewed.privateState.modelGate.length, 2);
  assert.equal(reviewed.privateState.modelGate[0]!.phase, "R0");
  assert.equal(reviewed.privateState.modelGate[0]!.requestId, "model-1");
  assert.equal(reviewed.privateState.modelGate[0]!.taskId, null);
  assert.equal(reviewed.privateState.modelGate[0]!.scopeId, null);
  assert.equal(reviewed.privateState.modelGate[0]!.ordinal, 1);
  assert.equal(reviewed.privateState.modelGate[0]!.planHash, prep.target.binding.planHash);
  assert.equal(reviewed.privateState.modelGate[1]!.phase, "WORK");
  assert.equal(reviewed.privateState.modelGate[1]!.requestId, "model-2");
  assert.equal(reviewed.privateState.modelGate[1]!.ordinal, 2);
  assert.equal(reviewed.privateState.modelGate[1]!.planHash, prep.target.binding.planHash);
  assert.equal(reviewed.privateState.r0!.record!.code, "OK");
  assert.equal(reviewed.privateState.r0!.record!.checkResult, "UNKNOWN");
  assert.equal(reviewed.privateState.r0!.record!.canSupportObligation, false);
  assert.equal(reviewed.privateState.r0!.record!.canReviseContract, false);
  assert.equal(reviewed.privateState.r0!.record!.rawResponseText, r0Report(prep));
  assert.equal(
    reviewed.privateState.r0!.record!.context.contextHash,
    p4Hash(JSON.stringify(reviewed.privateState.r0!.record!.context.messages)),
  );
  assert.equal(
    reviewed.privateState.r0!.record!.context.contextBytes,
    Buffer.byteLength(JSON.stringify(reviewed.privateState.r0!.record!.context.messages), "utf8"),
  );
  const r0Request = reviewed.privateState.requests[0] as Record<string, unknown>;
  assert.equal(r0Request.requestId, "model-1");
  assert.equal(r0Request.phase, "R0");
  assert.equal(r0Request.taskId, null);
  assert.equal(r0Request.contextHash, reviewed.privateState.r0!.record!.context.contextHash);
  assert.equal(r0Request.contextBytes, reviewed.privateState.r0!.record!.context.contextBytes);
  assert.deepEqual(r0Request.receipt, { transportStatus: "COMPLETE", text: r0Report(prep) });
  const workRequest = reviewed.privateState.requests[1] as Record<string, unknown>;
  assert.equal(workRequest.requestId, "model-2");
  assert.equal(workRequest.phase, "WORK");
  assert.equal(workRequest.taskId, work2.task.taskId);
  assert.deepEqual(workRequest.receipt, { transportStatus: "COMPLETE", text: work2.raw });
  assert.equal(reviewed.privateState.artifacts[0]!.artifact.sourceRequestId, "model-2");
  assert.equal(reviewed.privateState.artifacts[0]!.artifact.packet!.sourceRequestId, "model-2");
  assert.equal(reviewed.summary.parentProtected, true);
  assert.equal(reviewed.summary.status, "unsolved");
  assert.equal(reviewed.privateState.decision.submissionEligibility, "WITHHELD");
  assert.equal(reviewed.summary.reason, "STRICT_NOT_VERIFIED");
  assert.equal(reviewed.summary.finalResponse.includes(problem), false);
  assert.equal(reviewed.summary.finalResponse.includes(prep.target.planText), false);
  assert.equal(reviewed.summary.finalResponse.includes("fixture PROBLEM_ALIGNMENT"), false);
  for (const obligation of reviewed.privateState.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  const r0Events = reviewed.privateState.events.filter((event) => event.eventType === "TASK_STARTED");
  assert.equal(r0Events.length, 1);
  assert.equal(r0Events[0]!.taskId, work2.task.taskId);
});

test("group 2: root quota and planning percent matrix", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const cases: readonly { readonly root: number; readonly percent: number }[] = [
    { root: 0, percent: 25 },
    { root: 1, percent: 25 },
    { root: 2, percent: 25 },
    { root: 2, percent: 50 },
    { root: 3, percent: 25 },
    { root: 3, percent: 50 },
    { root: 4, percent: 25 },
    { root: 4, percent: 50 },
    { root: 4, percent: 100 },
    { root: 4, percent: 0 },
  ];
  for (const row of cases) {
    const allowance = Math.min(1, Math.floor((row.root * row.percent) / 100));
    const reviewWanted = allowance >= 1 && row.root >= 2;
    const source = reviewWanted ? "model-2" : "model-1";
    const work = workRaw(contract, source);
    const receipts: { r0?: P4FixtureReceipt; work?: P4FixtureReceipt } = { work: complete(work.raw) };
    if (reviewWanted) {
      receipts.r0 = complete(r0Report(prep));
    }
    const result = runP4R0Fixture(problem, session, receipts, {
      maxModelCalls: row.root,
      r0Enabled: true,
      planningPercent: row.percent,
      remainingMs: 1000,
      policy: "BEST_EFFORT",
      now: () => 0,
    });
    assert.equal(result.summary.planningAllowance, allowance);
    assert.equal(result.summary.rootMaxModelCalls, row.root);
    assert.equal(result.summary.planningPercent, row.percent);
    if (row.root === 0) {
      assert.equal(result.summary.modelCalls, 0);
      assert.equal(result.summary.workCalls, 0);
      assert.equal(result.privateState.artifacts.length, 0);
      assert.equal(result.privateState.modelGate.length, 0);
      assert.equal(result.summary.parentProtected, false);
      continue;
    }
    if (reviewWanted) {
      assert.equal(result.summary.r0Action, "REQUEST_REVIEW");
      assert.equal(result.summary.r0Calls, 1);
      assert.equal(result.summary.workCalls, 1);
      assert.equal(result.summary.modelCalls, 2);
      assert.equal(result.privateState.modelGate[1]!.requestId, "model-2");
      assert.equal(result.privateState.artifacts[0]!.artifact.sourceRequestId, "model-2");
    } else {
      assert.equal(result.summary.r0Calls, 0);
      assert.equal(result.summary.workCalls, 1);
      assert.equal(result.summary.modelCalls, 1);
      assert.equal(result.privateState.modelGate[0]!.requestId, "model-1");
      assert.equal(result.privateState.artifacts[0]!.artifact.sourceRequestId, "model-1");
      if (row.root === 3 && row.percent === 25) {
        assert.equal(result.summary.r0Action, "INSUFFICIENT_BUDGET");
        assert.notEqual(result.summary.r0Action, "REQUEST_REVIEW");
      }
    }
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  }

  const low = makeR0("VALUE");
  const lowContract = low.target.contract;
  const lowWork = workRaw(lowContract, "model-1");
  const lowResult = runP4R0Fixture(
    lowContract.problemFullText,
    lowContract.envelope.sessionId,
    { r0: complete(r0Report(low)), work: complete(lowWork.raw) },
    { maxModelCalls: 4, r0Enabled: true, planningPercent: 100, remainingMs: 1000, policy: "BEST_EFFORT", now: () => 0 },
  );
  assert.equal(lowResult.summary.r0Action, "SKIPPED_BY_POLICY");
  assert.equal(lowResult.summary.r0Calls, 0);
  assert.equal(lowResult.summary.workCalls, 1);
  assert.equal(lowResult.summary.modelCalls, 1);
  assert.equal(lowResult.privateState.r0, null);
  assert.equal(lowResult.privateState.modelGate[0]!.requestId, "model-1");
});

test("group 3: R0 stop, missing slots and malformed work", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work2 = workRaw(contract, "model-2");
  const options = {
    maxModelCalls: 4,
    r0Enabled: true,
    planningPercent: 25,
    remainingMs: 1000,
    policy: "BEST_EFFORT",
    now: () => 0,
  } as const;

  const stops: readonly P4FixtureReceipt[] = [
    complete(r0Report(prep, "ISSUES")),
    complete(r0Report(prep, "UNKNOWN")),
    complete("not json"),
    complete(r0Report(prep).replace('"planHash":"', '"planHash":"0')),
    complete(r0Report(prep).replace('"reviewCoverage":', '"reviewCoverage":[] ,"ignored":')),
    { transportStatus: "UNKNOWN", text: r0Report(prep) },
    { transportStatus: "ERROR", text: r0Report(prep) },
    { transportStatus: "TRUNCATED", text: r0Report(prep) },
  ];
  for (const r0 of stops) {
    const result = runP4R0Fixture(problem, session, { r0, work: complete(work2.raw) }, options);
    assert.equal(result.summary.r0Calls, 1);
    assert.equal(result.summary.workCalls, 0);
    assert.equal(result.summary.modelCalls, 1);
    assert.equal(result.summary.stopReason, "R0_STOP");
    assert.equal(result.privateState.artifacts.length, 0);
    assert.equal(result.summary.parentProtected, false);
    assert.equal(result.privateState.r0!.record!.rawResponseText, r0.text);
    assert.equal(result.privateState.r0!.record!.checkResult, "UNKNOWN");
    assert.equal(result.privateState.r0!.record!.canSupportObligation, false);
    assert.equal(result.privateState.modelGate.length, 1);
    assert.equal(result.privateState.modelGate[0]!.phase, "R0");
    assert.equal(result.privateState.requests.length, 1);
    assert.equal((result.privateState.requests[0] as Record<string, unknown>).receipt !== null, true);
  }

  const missingR0 = runP4R0Fixture(problem, session, { work: complete(work2.raw) }, options);
  assert.equal(missingR0.summary.r0Calls, 0);
  assert.equal(missingR0.summary.workCalls, 0);
  assert.equal(missingR0.summary.modelCalls, 0);
  assert.equal(missingR0.summary.stopReason, "FIXTURE_EXHAUSTED");
  assert.equal(missingR0.privateState.modelGate.length, 0);
  assert.equal(missingR0.privateState.artifacts.length, 0);

  const missingWork = runP4R0Fixture(problem, session, { r0: complete(r0Report(prep)) }, options);
  assert.equal(missingWork.summary.r0Calls, 1);
  assert.equal(missingWork.summary.workCalls, 0);
  assert.equal(missingWork.summary.modelCalls, 1);
  assert.equal(missingWork.summary.stopReason, "FIXTURE_EXHAUSTED");
  assert.equal(missingWork.privateState.artifacts.length, 0);

  // A packet that echoes a stale request id is control-copy noise: the trusted
  // receipt request id is the only authority, so the artifact is accepted and
  // carries the trusted id.
  const staleId = runP4R0Fixture(problem, session, {
    r0: complete(r0Report(prep)),
    work: complete(workRaw(contract, "model-1").raw),
  }, options);
  assert.equal(staleId.summary.workCalls, 1);
  for (const entry of staleId.privateState.artifacts) {
    assert.equal(entry.artifact.sourceRequestId, "model-2");
    assert.equal(entry.artifact.packet?.sourceRequestId, "model-2");
  }
  const badWork: readonly P4FixtureReceipt[] = [
    complete(JSON.stringify({ ...(JSON.parse(work2.raw) as Record<string, unknown>), assumptions: ["undeclared"] })),
    { transportStatus: "TRUNCATED", text: work2.raw },
    { transportStatus: "ERROR", text: work2.raw },
    { transportStatus: "UNKNOWN", text: work2.raw },
    complete("not json"),
  ];
  for (const work of badWork) {
    const result = runP4R0Fixture(problem, session, { r0: complete(r0Report(prep)), work }, options);
    assert.equal(result.summary.r0Calls, 1);
    assert.equal(result.summary.workCalls, 1);
    assert.equal(result.summary.modelCalls, 2);
    assert.equal(result.privateState.artifacts.length <= 1, true);
    for (const entry of result.privateState.artifacts) {
      assert.notEqual(entry.artifact.deliveryStatus, "COMPLETE");
      assert.equal(entry.artifact.level, "PROVISIONAL");
      assert.equal(entry.artifact.checkResult, "UNKNOWN");
    }
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.summary.parentProtected, false);
    assert.equal(result.summary.status, "unsolved");
    assert.equal(result.privateState.requests.length, 2);
    const last = result.privateState.requests[1] as Record<string, unknown>;
    assert.equal(last.requestId, "model-2");
    assert.deepEqual(last.receipt, { transportStatus: work.transportStatus, text: work.text });
    assert.equal(result.privateState.modelGate.length, 2);
    assert.equal(result.privateState.modelGate[1]!.requestId, "model-2");
  }
});

test("group 4: strict option and receipt shape rejection", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const contract = prep.target.contract;
  const problem = contract.problemFullText;
  const session = contract.envelope.sessionId;
  const work = workRaw(contract, "model-1");
  const base = { remainingMs: 1000, policy: "BEST_EFFORT", now: () => 0 } as const;

  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, extra: 1 } as never),
    "PACKET_BINDING",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, maxModelCalls: 5 }),
    "BOUND_EXCEEDED",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, planningPercent: 101 }),
    "BOUND_EXCEEDED",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, planningPercent: Number.NaN }),
    "BOUND_EXCEEDED",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, r0Enabled: "yes" } as never),
    "PACKET_BINDING",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, remainingMs: 0 }),
    "BOUND_EXCEEDED",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, now: null } as never),
    "DEADLINE_EXCEEDED",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { other: complete(work.raw) } as never, base),
    "PACKET_BINDING",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: { transportStatus: "COMPLETE" } } as never, base),
    "PACKET_SCHEMA",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: { transportStatus: "OK", text: work.raw } } as never, base),
    "PACKET_BINDING",
  );
  rejects(
    () => runP4R0Fixture(problem, session, { work: { transportStatus: "COMPLETE", text: "\ud800" } }, base),
    "PACKET_SCHEMA",
  );
  rejects(() => runP4R0Fixture(problem, session, { work: complete(work.raw) }, { ...base, policy: "LOOSE" } as never), "PACKET_BINDING");
  rejects(() => runP4R0Fixture("", session, { work: complete(work.raw) }, base), "PACKET_SCHEMA");
  rejects(() => runP4R0Fixture(problem, "", { work: complete(work.raw) }, base), "PACKET_SCHEMA");

  const frozen = p2Snapshot({ transportStatus: "COMPLETE" as const, text: work.raw });
  const result = runP4R0Fixture(problem, session, { work: frozen }, base);
  assert.equal(result.summary.workCalls, 1);
  assert.equal(result.privateState.artifacts.length, 1);
  assert.equal(result.privateState.artifacts[0]!.artifact.packet!.candidateProposal, "x=1");
});
