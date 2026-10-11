/**
 * P2 M2 admission gate + ready-task selection tests. Pure in-process: no
 * network, no child process, no model call. Nothing here is mathematical
 * acceptance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { P2Error, type P2Task } from "@astra/protocol";
import { compileP2Contract, ContractLedger } from "@astra/math-contract";
import { P2ModelGate, chooseP2ReadyTask } from "@astra/math-gateway";

const PROBLEM = "求全部实数解 x(x-1)=0";

function ledgerFor(problem: string): ContractLedger {
  return new ContractLedger(compileP2Contract(problem, "session-gate"));
}

function runningTask(ledger: ContractLedger): P2Task {
  const ready = ledger.readyTasks();
  assert.ok(ready.length > 0);
  const first = ready[0];
  assert.ok(first !== undefined);
  return ledger.startTask(first.taskId);
}

function gateFor(ledger: ContractLedger, maxCalls: number): P2ModelGate {
  const contract = ledger.snapshot();
  return new P2ModelGate(
    contract.envelope.sessionId,
    contract.problemHash,
    contract.contractVersion,
    maxCalls,
  );
}

test("gate admits, dispatches and settles sequentially without partial state", () => {
  const ledger = ledgerFor(PROBLEM);
  const task = runningTask(ledger);
  const gate = gateFor(ledger, 3);

  const first = gate.admit(task, "model-1", 4000);
  assert.equal(first.ordinal, 1);
  assert.equal(gate.snapshot().at(-1)!.state, "ADMITTED");
  const frozen = gate.snapshot();
  assert.equal(frozen.length, 1);
  assert.throws(() => {
    (frozen as unknown as { push: (value: unknown) => void }).push({});
  }, TypeError);

  assert.throws(() => gate.settle("model-1", "COMPLETE"), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "ILLEGAL_TRANSITION");
    return true;
  });
  assert.deepEqual(gate.snapshot(), frozen);

  assert.throws(() => gate.admit(task, "model-2", 4000), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "ILLEGAL_TRANSITION");
    return true;
  });

  const dispatched = gate.markDispatched("model-1");
  assert.equal(dispatched.state, "DISPATCHED");
  assert.throws(() => gate.markDispatched("model-1"), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "ILLEGAL_TRANSITION");
    return true;
  });

  const returned = gate.settle("model-1", "COMPLETE");
  assert.equal(returned.state, "RETURNED");
  assert.equal(returned.transport, "COMPLETE");

  const second = gate.admit(task, "model-2", 4000);
  assert.equal(second.ordinal, 2);
  assert.equal(gate.snapshot().at(-1)!.state, "ADMITTED");
  gate.markDispatched("model-2");
  assert.equal(gate.settle("model-2", "COMPLETE").state, "RETURNED");
});

test("rejected admissions never consume budget or change state", () => {
  const ledger = ledgerFor(PROBLEM);
  const task = runningTask(ledger);
  const gate = gateFor(ledger, 3);
  const before = gate.snapshot();

  const expectCode = (code: string) => (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, code);
    return true;
  };

  const emptyTaskId = { ...task, taskId: "" } as P2Task;
  const emptyScopeId = { ...task, scopeId: "" } as P2Task;
  const notRunning = { ...task, delivery: "READY" } as P2Task;
  assert.throws(() => gate.admit(emptyTaskId, "model-1", 4000), expectCode("PACKET_BINDING"));
  assert.throws(() => gate.admit(emptyScopeId, "model-1", 4000), expectCode("PACKET_BINDING"));
  assert.throws(() => gate.admit(notRunning, "model-1", 4000), expectCode("PACKET_BINDING"));
  assert.throws(() => gate.admit(task, "model-1", 25), expectCode("DEADLINE_EXCEEDED"));
  assert.throws(() => gate.admit(task, "model-1", Number.NaN), expectCode("PACKET_BINDING"));
  assert.deepEqual(gate.snapshot(), before);

  const wrongSession = structuredClone(task) as P2Task;
  (wrongSession.envelope as { sessionId: string }).sessionId = "session-other";
  assert.throws(() => gate.admit(wrongSession, "model-1", 4000), expectCode("PACKET_BINDING"));

  const wrongVersion = structuredClone(task) as P2Task;
  (wrongVersion.envelope as { contractVersion: number }).contractVersion = 99;
  assert.throws(() => gate.admit(wrongVersion, "model-1", 4000), expectCode("PACKET_BINDING"));

  const readyTask = ledger.readyTasks()[0];
  assert.ok(readyTask !== undefined);
  assert.throws(() => gate.admit(readyTask, "model-1", 4000), expectCode("PACKET_BINDING"));

  assert.throws(
    () => gate.admit(null as unknown as P2Task, "model-1", 4000),
    expectCode("PACKET_BINDING"),
  );
  assert.throws(
    () => gate.admit({} as unknown as P2Task, "model-1", 4000),
    expectCode("PACKET_BINDING"),
  );
  assert.deepEqual(gate.snapshot(), before);
  assert.equal(gate.admit(task, "model-1", 4000).ordinal, 1);
  assert.equal(gate.snapshot().length, 1);
});

test("non-COMPLETE transports stop the gate and never reset the budget", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["UNKNOWN", "OUTCOME_UNKNOWN"],
    ["TRUNCATED", "RETURNED"],
    ["ERROR", "RETURNED"],
  ];
  for (const [transport, expectedState] of cases) {
    const ledger = ledgerFor(PROBLEM);
    const task = runningTask(ledger);
    const gate = gateFor(ledger, 3);
    gate.admit(task, "model-1", 4000);
    gate.markDispatched("model-1");
    const settled = gate.settle("model-1", transport as never);
    assert.equal(settled.state, expectedState);
    assert.equal(settled.transport, transport);
    assert.throws(() => gate.admit(task, "model-2", 4000), (error: unknown) => {
      assert.ok(error instanceof P2Error);
      assert.equal(error.code, "ILLEGAL_TRANSITION");
      return true;
    });
    assert.equal(gate.snapshot().length, 1);
  }

  const ledger = ledgerFor(PROBLEM);
  const task = runningTask(ledger);
  const zero = gateFor(ledger, 0);
  assert.throws(() => zero.admit(task, "model-1", 4000), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "BUDGET_EXHAUSTED");
    return true;
  });
  assert.equal(zero.snapshot().length, 0);

  assert.throws(() => gateFor(ledger, 4), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "PACKET_BINDING");
    return true;
  });
  assert.throws(() => gateFor(ledger, true as never), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "PACKET_BINDING");
    return true;
  });

  const full = gateFor(ledger, 3);
  for (const id of ["model-1", "model-2", "model-3"]) {
    full.admit(task, id, 4000);
    full.markDispatched(id);
    assert.equal(full.settle(id, "COMPLETE").state, "RETURNED");
  }
  assert.throws(() => full.admit(task, "model-4", 4000), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.ok(error.code === "BUDGET_EXHAUSTED" || error.code === "PACKET_BINDING");
    return true;
  });
  assert.equal(full.snapshot().length, 3);
});

test("ready-task selection prefers candidate, then boundary, then inputs", () => {
  const ledger = ledgerFor(PROBLEM);
  const contract = ledger.snapshot();
  const ready = ledger.readyTasks();
  assert.ok(ready.length > 0);

  const chosen = chooseP2ReadyTask(contract, ready);
  assert.ok(chosen !== null);
  const obligations = new Map(contract.obligations.map((entry) => [entry.obligationId, entry]));
  const chosenObligation = obligations.get(chosen.obligationId);
  assert.ok(chosenObligation !== undefined);
  assert.equal(chosenObligation.kind, "CANDIDATE_VALIDITY");

  const frozenReady = structuredClone(ready) as P2Task[];
  const again = chooseP2ReadyTask(contract, frozenReady);
  assert.deepEqual(again, chosen);
  assert.deepEqual(frozenReady, ready);

  assert.equal(chooseP2ReadyTask(contract, []), null);
  assert.throws(
    () => chooseP2ReadyTask(contract, new Array(33).fill(ready[0]) as P2Task[]),
    (error: unknown) => {
      assert.ok(error instanceof P2Error);
      assert.equal(error.code, "PACKET_BINDING");
      return true;
    },
  );

  const unknownObligation = structuredClone(ready[0]) as P2Task;
  (unknownObligation as { obligationId: string }).obligationId = "obligation-missing";
  assert.throws(() => chooseP2ReadyTask(contract, [unknownObligation]), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "PACKET_BINDING");
    return true;
  });

  const delivered = structuredClone(ready[0]) as P2Task;
  (delivered as { delivery: string }).delivery = "DELIVERED";
  assert.throws(() => chooseP2ReadyTask(contract, [delivered]), (error: unknown) => {
    assert.ok(error instanceof P2Error);
    assert.equal(error.code, "PACKET_BINDING");
    return true;
  });

  const started = ledger.startTask(chosen.taskId);
  assert.equal(started.delivery, "RUNNING");
  const seq = ledger.nextEventSeq();
  ledger.recordDelivery(
    started.taskId,
    { artifactId: "artifact-1", artifactVersion: 1 },
    "DELIVERED",
    seq,
  );
  const boundary = ledger.readyTasks().find((entry) => entry.taskId !== started.taskId);
  assert.ok(boundary !== undefined);
  const boundaryStarted = ledger.startTask(boundary.taskId);
  const seq2 = ledger.nextEventSeq();
  ledger.recordDelivery(
    boundaryStarted.taskId,
    { artifactId: "artifact-2", artifactVersion: 1 },
    "DELIVERED",
    seq2,
  );
  const after = ledger.readyTasks();
  const next = chooseP2ReadyTask(ledger.snapshot(), after);
  assert.ok(next !== null);
  const nextObligation = new Map(
    ledger.snapshot().obligations.map((entry) => [entry.obligationId, entry]),
  ).get(next.obligationId);
  assert.ok(nextObligation !== undefined);
  assert.equal(nextObligation.kind, "EXHAUSTIVENESS");
  assert.equal(next.inputArtifactRefs.length, 2);
  assert.deepEqual(
    next.inputArtifactRefs.map((ref) => ref.artifactId).sort(),
    ["artifact-1", "artifact-2"],
  );
  assert.equal(
    ledger.snapshot().obligations.every((entry) => entry.status !== "SATISFIED"),
    true,
  );
});
