import test from "node:test";
import assert from "node:assert/strict";

import { ContractLedger, compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { P2ModelGate, P4R0ModelGate } from "@astra/math-gateway";
import { P2Error, p4Hash, type P2Task, type P4R0Preparation } from "@astra/protocol";

import { makeR0, type Mutable } from "./p4-r0-fixtures.js";

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

function bindingOf(prep: P4R0Preparation) {
  return {
    sessionId: prep.target.binding.sessionId,
    problemHash: prep.target.binding.problemHash,
    contractVersion: prep.target.binding.contractVersion,
    planHash: prep.target.binding.planHash,
  };
}

function gateFor(prep: P4R0Preparation, cap: number, percent = 25): P4R0ModelGate {
  return new P4R0ModelGate(bindingOf(prep), cap, percent);
}

/** Real RUNNING candidate task from the real M1 ledger. */
function runningTask(prep: P4R0Preparation): P2Task {
  const ledger = new ContractLedger(prep.target.contract);
  const ready = ledger.readyTasks();
  const chosen = ready.find((row) => {
    const obligation = prep.target.contract.obligations.find(
      (item) => item.obligationId === row.obligationId,
    );
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  if (chosen === undefined) {
    throw new Error("no candidate task");
  }
  return ledger.startTask(chosen.taskId);
}

function r0Admitted(prep: P4R0Preparation, cap = 4, percent = 25): P4R0ModelGate {
  const gate = gateFor(prep, cap, percent);
  gate.admitR0(prep, 1000);
  return gate;
}

test("group 1: planning allowance matrix and shared-root sequencing", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  for (const cap of [0, 1, 2, 3, 4]) {
    for (const percent of [0, 25, 50, 100]) {
      const gate = gateFor(prep, cap, percent);
      assert.equal(gate.planningAllowance(), Math.min(1, Math.floor((cap * percent) / 100)));
    }
  }
  assert.equal(gateFor(prep, 4, 25).planningAllowance(), 1);
  assert.equal(gateFor(prep, 3, 25).planningAllowance(), 0);
  assert.equal(gateFor(prep, 2, 50).planningAllowance(), 1);
  assert.equal(gateFor(prep, 1, 100).planningAllowance(), 1);
  rejects(() => gateFor(prep, 1, 100).admitR0(prep, 1000), "BUDGET_EXHAUSTED");
  rejects(() => gateFor(prep, 3, 25).admitR0(prep, 1000), "BUDGET_EXHAUSTED");
  rejects(() => gateFor(prep, 0, 100).admitR0(prep, 1000), "BUDGET_EXHAUSTED");

  const gate = gateFor(prep, 4, 25);
  const r0 = gate.admitR0(prep, 1000);
  assert.equal(r0.requestId, "model-1");
  assert.equal(r0.phase, "R0");
  assert.equal(r0.taskId, null);
  assert.equal(r0.scopeId, null);
  assert.equal(r0.ordinal, 1);
  assert.equal(r0.planHash, prep.target.binding.planHash);
  assert.equal(r0.state, "ADMITTED");
  assert.equal(r0.transport, null);
  gate.markDispatched("model-1");
  gate.settle("model-1", "COMPLETE");
  const task = runningTask(prep);
  const work = gate.admitWork(task, 1000);
  assert.equal(work.requestId, "model-2");
  assert.equal(work.phase, "WORK");
  assert.equal(work.taskId, task.taskId);
  assert.equal(work.scopeId, task.scopeId);
  assert.equal(work.ordinal, 2);
  assert.equal(work.planHash, prep.target.binding.planHash);
  gate.markDispatched("model-2");
  gate.settle("model-2", "COMPLETE");
  rejects(() => gate.admitWork(task, 1000), "BUDGET_EXHAUSTED");
  assert.equal(gate.snapshot().length, 2);

  const defaultGate = gateFor(prep, 1, 25);
  assert.equal(defaultGate.planningAllowance(), 0);
  const onlyWork = defaultGate.admitWork(runningTask(prep), 1000);
  assert.equal(onlyWork.requestId, "model-1");
  assert.equal(onlyWork.phase, "WORK");
  assert.equal(onlyWork.ordinal, 1);
});

test("group 2: atomic rejection of malformed bindings, tasks and preparations", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const good = bindingOf(prep);
  const badBindings: readonly unknown[] = [
    { ...good, extra: 1 },
    { sessionId: good.sessionId, problemHash: good.problemHash, contractVersion: good.contractVersion },
    { ...good, problemHash: "0".repeat(63) },
    { ...good, planHash: "Z".repeat(64) },
    { ...good, contractVersion: true },
    { ...good, contractVersion: 0 },
    { ...good, sessionId: `${"a".repeat(128)}😀` },
    { ...good, sessionId: "   " },
    null,
    [],
  ];
  for (const binding of badBindings) {
    rejects(() => new P4R0ModelGate(binding as never, 4, 25), "PACKET_BINDING");
  }
  rejects(() => new P4R0ModelGate(good, 5, 25), "PACKET_BINDING");
  rejects(() => new P4R0ModelGate(good, 4, 101), "PACKET_BINDING");
  rejects(() => new P4R0ModelGate(good, 4, 1.5), "PACKET_BINDING");

  const gate = gateFor(prep, 4, 25);
  const before = JSON.stringify(gate.snapshot());
  const badPreps: readonly unknown[] = [
    { ...clone(prep), action: "SKIPPED_BY_POLICY" },
    { ...clone(prep), action: "INSUFFICIENT_BUDGET" },
    { ...clone(prep), planningModelCalls: 0 },
    { ...clone(prep), remainingRootCalls: 5 },
    { ...clone(prep), remainingRootCalls: 1 },
    { ...clone(prep), remainingMs: 3600001 },
    { ...clone(prep), semanticResult: "PASS" },
    { ...clone(prep), canSupportObligation: true },
    { ...clone(prep), structuralMatch: false },
    { ...clone(prep), target: { ...clone(prep.target), binding: { ...good, planHash: "0".repeat(64) } } },
  ];
  for (const bad of badPreps) {
    rejects(() => gate.admitR0(bad as P4R0Preparation, 1000), "PACKET_BINDING");
  }
  rejects(() => gate.admitR0(prep, 25), "DEADLINE_EXCEEDED");
  rejects(() => gate.admitR0(prep, Number.NaN), "PACKET_BINDING");
  rejects(() => gate.admitR0(prep, 1001), "PACKET_BINDING");
  assert.equal(JSON.stringify(gate.snapshot()), before);

  const task = runningTask(prep);
  const badTasks: readonly unknown[] = [
    { ...clone(task), delivery: "READY" },
    { ...clone(task), envelope: { ...clone(task.envelope), sessionId: "other" } },
    { ...clone(task), envelope: { ...clone(task.envelope), sourceModule: "M3" } },
    { ...clone(task), scopeId: "0".repeat(64) },
  ];
  for (const bad of badTasks) {
    rejects(() => gate.admitWork(bad as P2Task, 1000), "PACKET_BINDING");
  }
  assert.equal(JSON.stringify(gate.snapshot()), before);
  const unreviewedWork = gate.admitWork(task, 1000);
  assert.equal(unreviewedWork.requestId, "model-1");
  assert.equal(unreviewedWork.phase, "WORK");
  rejects(() => gate.admitR0(prep, 1000), "ILLEGAL_TRANSITION");

  const r0Gate = r0Admitted(prep);
  rejects(() => r0Gate.admitR0(prep, 1000), "ILLEGAL_TRANSITION");
  rejects(() => r0Gate.settle("model-1", "COMPLETE"), "ILLEGAL_TRANSITION");
  rejects(() => r0Gate.markDispatched("model-2"), "ILLEGAL_TRANSITION");
  rejects(() => r0Gate.admitWork(task, 1000), "ILLEGAL_TRANSITION");
  const frozen = r0Gate.snapshot();
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen[0]), true);
  r0Gate.markDispatched("model-1");
  assert.equal(frozen[0]!.state, "ADMITTED");
  r0Gate.settle("model-1", "COMPLETE");
  const work = r0Gate.admitWork(task, 1000);
  rejects(() => r0Gate.admitWork(task, 1000), "BUDGET_EXHAUSTED");
  assert.equal(work.ordinal, 2);
});

test("group 3: non-COMPLETE R0 stops the shared root; legacy gate unchanged", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const task = runningTask(prep);
  for (const transport of ["UNKNOWN", "ERROR", "TRUNCATED"] as const) {
    const gate = r0Admitted(prep);
    gate.markDispatched("model-1");
    const settled = gate.settle("model-1", transport);
    assert.equal(settled.transport, transport);
    assert.equal(settled.state, transport === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "RETURNED");
    rejects(() => gate.admitWork(task, 1000), "ILLEGAL_TRANSITION");
    rejects(() => gate.admitR0(prep, 1000), "ILLEGAL_TRANSITION");
    assert.equal(gate.snapshot().length, 1);
  }
  const complete = r0Admitted(prep);
  complete.markDispatched("model-1");
  complete.settle("model-1", "COMPLETE");
  const work = complete.admitWork(task, 1000);
  complete.markDispatched("model-2");
  complete.settle("model-2", "TRUNCATED");
  rejects(() => complete.admitR0(prep, 1000), "ILLEGAL_TRANSITION");
  rejects(() => complete.admitWork(task, 1000), "ILLEGAL_TRANSITION");
  assert.equal(work.phase, "WORK");
  assert.equal(complete.snapshot().length, 2);

  const contract = compileP2Contract("😀 Compute 1+1", "legacy");
  const legacy = new P2ModelGate(contract.envelope.sessionId, contract.problemHash, contract.contractVersion, 3);
  const ledger = new ContractLedger(contract);
  const legacyTask = ledger.startTask(ledger.readyTasks()[0]!.taskId);
  legacy.admit(legacyTask, "model-1", 1000);
  legacy.markDispatched("model-1");
  legacy.settle("model-1", "COMPLETE");
  legacy.admit(legacyTask, "model-2", 1000);
  legacy.markDispatched("model-2");
  legacy.settle("model-2", "COMPLETE");
  legacy.admit(legacyTask, "model-3", 1000);
  legacy.markDispatched("model-3");
  legacy.settle("model-3", "COMPLETE");
  rejects(() => legacy.admit(legacyTask, "model-4", 1000), "BUDGET_EXHAUSTED");
  assert.equal(legacy.snapshot().length, 3);
  assert.equal(p4Hash(JSON.stringify(contract)).length, 64);
});
