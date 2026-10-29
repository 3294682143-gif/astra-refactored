import test from "node:test";
import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2Error, type P2Task, type P2AcceptanceReceipt } from "@astra/protocol";

const PROBLEM = "求x(x−1)=0的全部实数解";
const SESSION = "s";

function base(): ContractLedger {
  return new ContractLedger(compileP2Contract(PROBLEM, SESSION));
}

function custom(ledger: ContractLedger, id: string, deps: readonly string[]): P2Task {
  const template = ledger.snapshot().tasks[0]!;
  return {
    ...template,
    envelope: { ...template.envelope, taskId: id, recordId: `${SESSION}:custom:${id}` },
    taskId: id,
    dependencyTaskIds: deps,
  };
}

function receipt(ledger: ContractLedger, obligationId: string, refs: readonly string[]): P2AcceptanceReceipt {
  const contract = ledger.snapshot();
  const obligation = contract.obligations.find((item) => item.obligationId === obligationId)!;
  return {
    mode: "MOCK_ONLY",
    sourceModule: "M5",
    sessionId: SESSION,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    goalId: obligation.goalId,
    scopeId: obligation.envelope.scopeId!,
    policy: "mock",
    evidenceRefs: refs,
  };
}

function frozen(ledger: ContractLedger): string {
  return JSON.stringify([ledger.snapshot(), ledger.eventsSnapshot(), ledger.nextEventSeq()]);
}

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

test("rejections are atomic and only a bound mock M5 receipt satisfies", () => {
  const ledger = base();
  const task = ledger.readyTasks()[0]!;
  const before = frozen(ledger);
  rejects(() => ledger.startTask("missing"), "ILLEGAL_TRANSITION");
  rejects(() => ledger.recordDelivery(task.taskId, { artifactId: "a", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq()), "ILLEGAL_TRANSITION");
  rejects(() => ledger.recordDelivery(task.taskId, { artifactId: "a", artifactVersion: 1, extra: 1 } as never, "DELIVERED", ledger.nextEventSeq()), "PACKET_SCHEMA");
  assert.equal(frozen(ledger), before);
  const running = ledger.startTask(task.taskId);
  assert.equal(running.delivery, "RUNNING");
  const afterStart = frozen(ledger);
  rejects(() => ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, [])), "UNTRUSTED_ACCEPTANCE");
  rejects(() => ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, ["a@1"])), "UNTRUSTED_ACCEPTANCE");
  assert.equal(frozen(ledger), afterStart);
  ledger.recordDelivery(task.taskId, { artifactId: "a", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  assert.equal(ledger.snapshot().obligations.find((item) => item.obligationId === task.obligationId)!.status, "IN_PROGRESS");
  const afterDelivery = frozen(ledger);
  rejects(() => ledger.acceptObligation(task.obligationId, { ...receipt(ledger, task.obligationId, ["a@1"]), extra: 1 } as never), "UNTRUSTED_ACCEPTANCE");
  assert.equal(frozen(ledger), afterDelivery);
  rejects(() => ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, ["b@1"])), "UNTRUSTED_ACCEPTANCE");
  ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, ["a@1"]));
  assert.equal(ledger.snapshot().obligations.find((item) => item.obligationId === task.obligationId)!.status, "SATISFIED");
  ledger.reopenObligation(task.obligationId);
  assert.equal(ledger.snapshot().obligations.find((item) => item.obligationId === task.obligationId)!.acceptance, null);
});

test("ready ordering, dependency inputs and external mutation isolation", () => {
  const ledger = base();
  const first = ledger.readyTasks()[0]!;
  assert.deepEqual(first.inputArtifactRefs, []);
  const a = custom(ledger, "A", []);
  const b = custom(ledger, "B", []);
  const c = custom(ledger, "C", ["A", "B"]);
  ledger.addTasks([a, b, c]);
  assert.equal(ledger.readyTasks().some((task) => task.taskId === "C"), false);
  assert.equal(ledger.startTask("A").delivery, "RUNNING");
  const aRef = { artifactId: "ra", artifactVersion: 1 };
  ledger.recordDelivery("A", aRef, "DELIVERED", ledger.nextEventSeq());
  aRef.artifactId = "mutated";
  assert.equal(ledger.startTask("B").delivery, "RUNNING");
  ledger.recordDelivery("B", { artifactId: "rb", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  const prepared = ledger.readyTasks().find((task) => task.taskId === "C")!;
  assert.deepEqual(prepared.inputArtifactRefs.map((ref) => ref.artifactId), ["ra", "rb"]);
  assert.equal(ledger.startTask("C").delivery, "RUNNING");
  ledger.recordDelivery("C", { artifactId: "rc", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  assert.deepEqual(ledger.snapshot().tasks.find((task) => task.taskId === "C")!.inputArtifactRefs, prepared.inputArtifactRefs);
  assert.equal(aRef.artifactId, "mutated");
});

test("obligation-kind priority is observable on a plain base ledger", () => {
  const ledger = base();
  assert.equal(ledger.readyTasks()[0]!.obligationId.endsWith("CANDIDATE_VALIDITY"), true);
  const candidate = ledger.readyTasks()[0]!;
  ledger.startTask(candidate.taskId);
  ledger.recordDelivery(candidate.taskId, { artifactId: "cand", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  assert.equal(ledger.readyTasks()[0]!.obligationId.endsWith("BOUNDARY_EXCEPTIONS"), true);
});

test("partial delivery requires a start and a fresh sequence", () => {
  const ledger = base();
  const task = ledger.readyTasks()[0]!;
  rejects(() => ledger.recordDelivery(task.taskId, { artifactId: "p", artifactVersion: 1 }, "PARTIAL", ledger.nextEventSeq()), "ILLEGAL_TRANSITION");
  ledger.startTask(task.taskId);
  rejects(() => ledger.recordDelivery(task.taskId, { artifactId: "p", artifactVersion: 1 }, "PARTIAL", ledger.nextEventSeq() + 1), "PACKET_BINDING");
  ledger.recordDelivery(task.taskId, { artifactId: "p", artifactVersion: 1 }, "PARTIAL", ledger.nextEventSeq());
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.tasks.find((item) => item.taskId === task.taskId)!.delivery, "PARTIAL");
  assert.equal(Object.isFrozen(snapshot), true);
  const afterPartial = frozen(ledger);
  rejects(() => ledger.recordDelivery(task.taskId, { artifactId: "p2", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq()), "ILLEGAL_TRANSITION");
  assert.equal(frozen(ledger), afterPartial);
  assert.equal(ledger.startTask(task.taskId).delivery, "RUNNING");
  ledger.recordDelivery(task.taskId, { artifactId: "p2", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  assert.equal(ledger.snapshot().tasks.find((item) => item.taskId === task.taskId)!.delivery, "DELIVERED");
});

test("addTasks is atomic and event sequences stay strictly increasing", () => {
  const ledger = base();
  const start = ledger.nextEventSeq();
  ledger.addTasks([]);
  assert.equal(ledger.nextEventSeq(), start);
  ledger.addTasks([custom(ledger, "A", []), custom(ledger, "B", [])]);
  assert.equal(ledger.nextEventSeq(), start + 2);
  const before = frozen(ledger);
  rejects(() => ledger.addTasks([custom(ledger, "A", [])]), "DUPLICATE_ID");
  rejects(() => ledger.addTasks([custom(ledger, "D", ["ghost"])]), "DANGLING_REFERENCE");
  rejects(() => ledger.addTasks([custom(ledger, "E", ["F"]), custom(ledger, "F", ["E"])]), "DEPENDENCY_CYCLE");
  rejects(() => ledger.addTasks([{ ...custom(ledger, "G", []), delivery: "DELIVERED" }]), "ILLEGAL_TRANSITION");
  assert.equal(frozen(ledger), before);
  const seqs = ledger.eventsSnapshot().map((event) => event.eventSeq);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
  assert.equal(new Set(seqs).size, seqs.length);
});
