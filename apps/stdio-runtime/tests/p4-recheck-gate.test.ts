/**
 * P4 S2 recheck M2 gate tests. Pure in-process: no network, no child process,
 * no model call. Nothing here is mathematical acceptance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { P2Error, type P2Task } from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import {
  P2ModelGate,
  P4RecheckModelGate,
  P4_RECHECK_DEFAULT_MODEL_CALLS,
  P4_RECHECK_MAX_MODEL_CALLS,
} from "@astra/math-gateway";

const PROBLEM = "Find all real solutions x(x-1)=0";
const SESSION = "s";

function ledgerFor(): ContractLedger {
  return new ContractLedger(compileP2Contract(PROBLEM, SESSION));
}

function runningTask(ledger: ContractLedger): P2Task {
  const ready = ledger.readyTasks();
  const first = ready[0];
  assert.ok(first !== undefined);
  return ledger.startTask(first.taskId);
}

function gateFor(ledger: ContractLedger, maxCalls?: number): P4RecheckModelGate {
  const contract = ledger.snapshot();
  return maxCalls === undefined
    ? new P4RecheckModelGate(contract.envelope.sessionId, contract.problemHash, contract.contractVersion)
    : new P4RecheckModelGate(
        contract.envelope.sessionId,
        contract.problemHash,
        contract.contractVersion,
        maxCalls,
      );
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, code);
    return true;
  };
}

function runOne(gate: P4RecheckModelGate, task: P2Task, id: string, transport: string): void {
  gate.admit(task, id, 4000);
  gate.markDispatched(id);
  gate.settle(id, transport as never);
}

test("old P2 gate still rejects a fourth call while the new gate defaults to three", () => {
  const ledger = ledgerFor();
  const contract = ledger.snapshot();
  assert.throws(
    () => new P2ModelGate(contract.envelope.sessionId, contract.problemHash, contract.contractVersion, 4),
    expectCode("PACKET_BINDING"),
  );
  assert.equal(P4_RECHECK_DEFAULT_MODEL_CALLS, 3);
  assert.equal(P4_RECHECK_MAX_MODEL_CALLS, 256);
  const task = runningTask(ledger);
  const gate = gateFor(ledger);
  for (const id of ["model-1", "model-2", "model-3"]) {
    runOne(gate, task, id, "COMPLETE");
  }
  assert.equal(gate.snapshot().length, 3);
  assert.throws(() => gate.admit(task, "model-4", 4000), expectCode("BUDGET_EXHAUSTED"));
  assert.equal(gate.snapshot().length, 3);
});

test("explicit four admits one shared ledger of records 1..4 with ordinal, state and transport", () => {
  const ledger = ledgerFor();
  const task = runningTask(ledger);
  const gate = gateFor(ledger, 4);
  const transports = ["COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE"] as const;
  for (const [index, id] of ["model-1", "model-2", "model-3", "model-4"].entries()) {
    const admitted = gate.admit(task, id, 4000);
    assert.equal(admitted.ordinal, index + 1);
    assert.equal(gate.snapshot().at(-1)?.state, "ADMITTED");
    assert.equal(gate.snapshot().at(-1)?.transport, null);
    gate.markDispatched(id);
    assert.equal(gate.snapshot().at(-1)?.state, "DISPATCHED");
    const settled = gate.settle(id, transports[index]!);
    assert.equal(settled.ordinal, index + 1);
    assert.equal(gate.snapshot().at(-1)?.state, "RETURNED");
    assert.equal(gate.snapshot().at(-1)?.transport, transports[index]!);
  }
  const snapshot = gate.snapshot();
  assert.equal(snapshot.length, 4);
  assert.deepEqual(
    snapshot.map((row) => row.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  assert.deepEqual(
    snapshot.map((row) => row.ordinal),
    [1, 2, 3, 4],
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.throws(() => {
    (snapshot as unknown as { push: (value: unknown) => void }).push({});
  }, TypeError);
  assert.throws(() => gate.admit(task, "model-5", 4000), expectCode("BUDGET_EXHAUSTED"));
});

test("caps 0..4 bound the ledger and bad caps or times are refused without mutation", () => {
  const ledger = ledgerFor();
  const task = runningTask(ledger);
  for (const cap of [0, 1, 2, 3, 4]) {
    const gate = gateFor(ledger, cap);
    for (let index = 0; index < cap; index += 1) {
      runOne(gate, task, `model-${index + 1}`, "COMPLETE");
    }
    assert.equal(gate.snapshot().length, cap);
    assert.throws(() => gate.admit(task, `model-${cap + 1}`, 4000), expectCode("BUDGET_EXHAUSTED"));
    assert.equal(gate.snapshot().length, cap);
  }
  const contract = ledger.snapshot();
  for (const bad of [257, -1, true, Number.NaN, 1.5]) {
    assert.throws(
      () =>
        new P4RecheckModelGate(
          contract.envelope.sessionId,
          contract.problemHash,
          contract.contractVersion,
          bad as never,
        ),
      expectCode("PACKET_BINDING"),
    );
  }
  const gate = gateFor(ledger, 4);
  const before = gate.snapshot();
  for (const bad of [25, Number.NaN, -1, 3600001]) {
    assert.throws(() => gate.admit(task, "model-1", bad as never), (error: unknown) => {
      assert.ok(error instanceof P2Error);
      assert.ok(error.code === "DEADLINE_EXCEEDED" || error.code === "PACKET_BINDING");
      return true;
    });
  }
  assert.deepEqual(gate.snapshot(), before);
  assert.equal(gate.admit(task, "model-1", 26).ordinal, 1);
});

test("foreign session, wrong scope and non-RUNNING tasks are refused before any mutation", () => {
  const ledger = ledgerFor();
  const task = runningTask(ledger);
  const gate = gateFor(ledger, 4);
  const before = gate.snapshot();
  const wrongSession = structuredClone(task) as P2Task;
  (wrongSession.envelope as { sessionId: string }).sessionId = "other";
  const wrongScope = structuredClone(task) as P2Task;
  (wrongScope as { scopeId: string }).scopeId = "other";
  const notRunning = structuredClone(task) as P2Task;
  (notRunning as { delivery: string }).delivery = "READY";
  const ready = ledger.readyTasks()[0];
  assert.ok(ready !== undefined);
  for (const candidate of [wrongSession, wrongScope, notRunning, ready]) {
    assert.throws(() => gate.admit(candidate, "model-1", 4000), expectCode("PACKET_BINDING"));
  }
  assert.throws(() => gate.admit(null as unknown as P2Task, "model-1", 4000), expectCode("PACKET_BINDING"));
  assert.deepEqual(gate.snapshot(), before);
});

test("skipped ids, replays and a pending record never advance the shared ledger", () => {
  const ledger = ledgerFor();
  const task = runningTask(ledger);
  const gate = gateFor(ledger, 4);
  assert.throws(() => gate.admit(task, "model-2", 4000), expectCode("PACKET_BINDING"));
  assert.equal(gate.snapshot().length, 0);
  gate.admit(task, "model-1", 4000);
  assert.throws(() => gate.admit(task, "model-1", 4000), expectCode("DUPLICATE_REQUEST_ID"));
  assert.throws(() => gate.admit(task, "model-2", 4000), expectCode("ILLEGAL_TRANSITION"));
  assert.throws(() => gate.settle("model-1", "COMPLETE"), expectCode("ILLEGAL_TRANSITION"));
  assert.equal(gate.snapshot().length, 1);
  gate.markDispatched("model-1");
  assert.throws(() => gate.markDispatched("model-1"), expectCode("ILLEGAL_TRANSITION"));
  assert.equal(gate.settle("model-1", "COMPLETE").state, "RETURNED");
  assert.equal(gate.admit(task, "model-2", 4000).ordinal, 2);
});

test("only UNKNOWN stops the shared ledger; determinate failures allow a retry", () => {
  // UNKNOWN means the request's terminal state is not known to the Host, so
  // the gate stays fail-closed: no further admit is ever allowed.
  {
    const ledger = ledgerFor();
    const task = runningTask(ledger);
    const gate = gateFor(ledger, 4);
    gate.admit(task, "model-1", 4000);
    gate.markDispatched("model-1");
    const settled = gate.settle("model-1", "UNKNOWN");
    assert.equal(settled.state, "OUTCOME_UNKNOWN");
    assert.equal(settled.transport, "UNKNOWN");
    assert.throws(() => gate.admit(task, "model-2", 4000), expectCode("ILLEGAL_TRANSITION"));
    assert.equal(gate.snapshot().length, 1);
  }
  // TRUNCATED and ERROR are determinate terminal answers from the provider:
  // the record settles as RETURNED and the next bounded admit proceeds, so the
  // stage above can retry or skip the failed turn instead of aborting the run.
  for (const transport of ["TRUNCATED", "ERROR"] as const) {
    const ledger = ledgerFor();
    const task = runningTask(ledger);
    const gate = gateFor(ledger, 4);
    gate.admit(task, "model-1", 4000);
    gate.markDispatched("model-1");
    const settled = gate.settle("model-1", transport);
    assert.equal(settled.state, "RETURNED");
    assert.equal(settled.transport, transport);
    const next = gate.admit(task, "model-2", 4000);
    assert.equal(next.ordinal, 2);
    gate.markDispatched("model-2");
    assert.equal(gate.settle("model-2", "COMPLETE").state, "RETURNED");
    assert.equal(gate.snapshot().length, 2);
  }
});
