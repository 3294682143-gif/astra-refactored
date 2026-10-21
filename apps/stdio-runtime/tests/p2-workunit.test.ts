import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileP2Contract } from "@astra/math-contract";
import { ContractLedger } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import type { P2WorkReceipt } from "@astra/math-workunit";
import type { P2ArtifactRef, P2Contract, P2Task, P2TransportStatus } from "@astra/protocol";

function route(routeId: string, operation: string) {
  return {
    routeId,
    representation: "polynomial",
    operation,
    lemmas: ["lemma-a"],
    construction: "expand",
  };
}

function base() {
  const contract = compileP2Contract("fixture", "s");
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(contract);
  store.registerRoute(route("r", "expand"));
  const task = ledger.startTask(ledger.readyTasks()[0]!.taskId);
  return { ledger, contract, task, store };
}

function packet(c: P2Contract, t: P2Task, id: string) {
  return {
    schemaVersion: "p2a-work-v1",
    sessionId: c.envelope.sessionId,
    problemHash: c.problemHash,
    contractVersion: c.contractVersion,
    taskId: t.taskId,
    goalId: t.goalId,
    scopeId: t.scopeId,
    routeId: "r",
    sourceRequestId: id,
    claim: "claim",
    derivation: "derivation",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "candidate",
  };
}

function receipt(c: P2Contract, t: P2Task, id: string, seq: number, overrides: Partial<P2WorkReceipt> = {}): P2WorkReceipt {
  return {
    artifactId: id,
    routeId: "r",
    sourceRequestId: id,
    transportStatus: "COMPLETE",
    text: JSON.stringify(packet(c, t, id)),
    eventSeq: seq,
    supersedes: null,
    ...overrides,
  };
}

test("route identity ignores id and title, enforces limit and duplicate id", () => {
  const { store } = base();
  assert.throws(() => store.registerRoute(route("r2", "expand")), { code: "DUPLICATE_ROUTE_SIGNATURE" });
  store.registerRoute(route("r3", "factor"));
  assert.throws(() => store.registerRoute(route("r4", "solve")), { code: "ROUTE_LIMIT" });
  assert.throws(() => store.registerRoute(route("r", "other")), { code: "DUPLICATE_ID" });
});

test("accepted artifact stays provisional and candidate is a proposal only", () => {
  const { ledger, contract, task, store } = base();
  const seq = ledger.nextEventSeq();
  const input = receipt(contract, task, "a1", seq);
  const artifact = store.accept(task, input);
  assert.equal(artifact.level, "PROVISIONAL");
  assert.equal(artifact.checkResult, "UNKNOWN");
  assert.equal(artifact.rawResponseHash, createHash("sha256").update(input.text, "utf8").digest("hex"));
  assert.equal(store.candidate({ artifactId: "a1", artifactVersion: 1 }), "candidate");
  ledger.recordDelivery(task.taskId, { artifactId: "a1", artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  const obligation = ledger.snapshot().obligations.find((o) => o.obligationId === task.obligationId)!;
  assert.equal(obligation.status, "IN_PROGRESS");
  assert.ok(Object.isFrozen(store.get({ artifactId: "a1", artifactVersion: 1 })));
  assert.ok(Object.isFrozen(artifact));
});

test("transport dominates self-assessment and bad JSON keeps raw material", () => {
  const { ledger, contract, task, store } = base();
  let seq = ledger.nextEventSeq();
  const cases: readonly [P2TransportStatus, string][] = [
    ["COMPLETE", "COMPLETE"],
    ["TRUNCATED", "TRUNCATED"],
    ["ERROR", "ERROR"],
    ["UNKNOWN", "INCOMPLETE"],
  ];
  for (const [transport, effective] of cases) {
    const id = `t-${transport}`;
    const artifact = store.accept(task, receipt(contract, task, id, seq, { transportStatus: transport }));
    seq += 1;
    assert.equal(artifact.deliveryStatus, effective);
    assert.equal(store.candidate({ artifactId: id, artifactVersion: 1 }), transport === "COMPLETE" ? "candidate" : null);
  }
  const broken = store.accept(task, receipt(contract, task, "bad", seq, { transportStatus: "TRUNCATED", text: "{oops" }));
  assert.equal(broken.packet, null);
  assert.equal(broken.rawResponseText, "{oops");
  seq += 1;
  assert.throws(() => store.accept(task, receipt(contract, task, "bad2", seq, { text: "{oops" })), { code: "PACKET_SCHEMA" });
  seq += 1;
  // A model-side identity copy error is rebound to the trusted receipt
  // binding; it is never model authority and never a rejection.
  const wrongSession = { ...packet(contract, task, "bad3"), sessionId: "other" };
  const rebound = store.accept(task, receipt(contract, task, "bad3", seq, { transportStatus: "TRUNCATED", text: JSON.stringify(wrongSession) }));
  assert.equal(rebound.packet?.sessionId, contract.envelope.sessionId);
  assert.equal(JSON.parse(rebound.rawResponseText)["sessionId"], "other");
  seq += 1;
  // An assumption outside the trusted scope is still a fixed rejection.
  const foreignAssumption = { ...packet(contract, task, "bad4"), assumptions: ["undeclared"] };
  assert.throws(
    () => store.accept(task, receipt(contract, task, "bad4", seq, { transportStatus: "TRUNCATED", text: JSON.stringify(foreignAssumption) })),
    { code: "PACKET_SCOPE_VIOLATION" },
  );
});

test("M1 dependency chain version invalidation keeps unrelated records active", () => {
  const contract = compileP2Contract("fixture", "s");
  const ledger = new ContractLedger(contract);
  const template = ledger.snapshot().tasks[0]!;
  const custom = (id: string, deps: readonly string[]): P2Task => ({
    ...template,
    envelope: { ...template.envelope, recordId: `s:custom:${id}`, taskId: id },
    taskId: id,
    dependencyTaskIds: deps,
  });
  ledger.addTasks([custom("A", []), custom("B", ["A"]), custom("C", ["B"]), custom("U", [])]);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(route("r", "expand"));

  const deliver = (id: string, overrides: Partial<P2WorkReceipt> = {}): void => {
    const task = ledger.startTask(id);
    const seq = ledger.nextEventSeq();
    store.accept(task, receipt(ledger.snapshot(), task, id, seq, overrides));
    ledger.recordDelivery(id, { artifactId: id, artifactVersion: 1 }, "DELIVERED", seq);
  };

  deliver("A");
  deliver("B");
  deliver("C");
  deliver("U");

  const b = store.get({ artifactId: "B", artifactVersion: 1 }).artifact;
  const c = store.get({ artifactId: "C", artifactVersion: 1 }).artifact;
  assert.deepEqual(b.dependencies, [{ artifactId: "A", artifactVersion: 1 }]);
  assert.deepEqual(c.dependencies, [{ artifactId: "B", artifactVersion: 1 }]);
  assert.equal(c.provisionalDependency, true);

  ledger.reopenObligation(template.obligationId);
  const taskA = ledger.startTask("A");
  const seqA = ledger.nextEventSeq();
  const a2 = store.accept(taskA, receipt(ledger.snapshot(), taskA, "A2", seqA, {
    artifactId: "A",
    supersedes: { artifactId: "A", artifactVersion: 1 },
  }));
  assert.equal(a2.envelope.artifactVersion, 2);

  assert.equal(store.snapshot().length, 5);
  assert.equal(store.get({ artifactId: "A", artifactVersion: 1 }).availability, "STALE");
  assert.equal(store.get({ artifactId: "B", artifactVersion: 1 }).availability, "STALE");
  assert.equal(store.get({ artifactId: "C", artifactVersion: 1 }).availability, "STALE");
  assert.equal(store.get({ artifactId: "A", artifactVersion: 2 }).availability, "ACTIVE");
  assert.equal(store.get({ artifactId: "U", artifactVersion: 1 }).availability, "ACTIVE");

  assert.equal(store.candidate({ artifactId: "A", artifactVersion: 1 }), null);
  const oldA = store.get({ artifactId: "A", artifactVersion: 1 }).artifact;
  assert.equal(oldA.level, "PROVISIONAL");
  assert.equal(oldA.checkResult, "UNKNOWN");

  const affected = store.invalidate({ artifactId: "A", artifactVersion: 1 });
  assert.equal(affected.length, 3);
  const entry = store.get({ artifactId: "A", artifactVersion: 1 });
  assert.ok(Object.isFrozen(entry));
  assert.throws(() => {
    (entry as { availability: string }).availability = "ACTIVE";
  }, TypeError);
});

test("atomic rejections and dependency negative controls leave state unchanged", () => {
  const { ledger, contract, task, store } = base();
  store.accept(task, receipt(contract, task, "a", 10));
  const a1: P2ArtifactRef = { artifactId: "a", artifactVersion: 1 };
  let baseline = store.snapshot();

  const bad = (input: P2WorkReceipt, code: string, checkedTask: P2Task = task): void => {
    assert.throws(() => store.accept(checkedTask, input), { code });
    assert.deepEqual(store.snapshot(), baseline);
  };

  bad(receipt(contract, task, "a", 11, { artifactId: "other" }), "DUPLICATE_REQUEST_ID");

  const duplicateDependency = {
    ...packet(contract, task, "b"),
    dependencies: [
      { artifactId: "a", artifactVersion: 1 },
      { artifactId: "a", artifactVersion: 1 },
    ],
  };
  const dependentTask: P2Task = { ...task, inputArtifactRefs: [a1] };
  bad(receipt(contract, task, "b", 11, { text: JSON.stringify(duplicateDependency) }), "DUPLICATE_ID", dependentTask);
  // A duplicate-free subset of the declared input refs is admitted, exactly as
  // the M3 receipt reader allows.
  const subset = store.accept(dependentTask, receipt(contract, task, "b", 11, {
    text: JSON.stringify({ ...packet(contract, task, "b"), dependencies: [] }),
  }));
  // The packet keeps its own reported subset; the store records the trusted
  // declared refs of the task (conservative inclusion).
  assert.deepEqual(subset.packet?.dependencies, []);
  assert.deepEqual(subset.dependencies, [a1]);
  baseline = store.snapshot();

  const extraKey = { ...packet(contract, task, "c"), extraField: 1 };
  bad(receipt(contract, task, "c", 12, { text: JSON.stringify(extraKey) }), "PACKET_SCHEMA");

  const extraAssumption = { ...packet(contract, task, "d"), assumptions: ["undeclared"] };
  bad(receipt(contract, task, "d", 12, { text: JSON.stringify(extraAssumption) }), "PACKET_SCOPE_VIOLATION");

  const ghost = { ...packet(contract, task, "e"), dependencies: [{ artifactId: "ghost", artifactVersion: 1 }] };
  bad(receipt(contract, task, "e", 12, { text: JSON.stringify(ghost) }), "UNKNOWN_DEPENDENCY");

  store.registerRoute(route("r2", "other"));
  const crossTask: P2Task = { ...task, inputArtifactRefs: [a1] };
  const crossPacket = { ...packet(contract, task, "f"), routeId: "r2" };
  bad(receipt(contract, task, "f", 12, {
    artifactId: "f",
    routeId: "r2",
    text: JSON.stringify(crossPacket),
  }), "CROSS_ROUTE_REVIEW_REQUIRED", crossTask);

  const cycleTask: P2Task = { ...task, inputArtifactRefs: [a1] };
  assert.throws(
    () => store.accept(cycleTask, receipt(contract, task, "anew", 12, {
      artifactId: "a",
      supersedes: a1,
    })),
    { code: "DEPENDENCY_CYCLE" },
  );
  assert.deepEqual(store.snapshot(), baseline);

  store.invalidate(a1);
  baseline = store.snapshot();
  const staleTask: P2Task = { ...task, inputArtifactRefs: [a1] };
  bad(receipt(contract, task, "g", 12, { artifactId: "g" }), "STALE_DEPENDENCY", staleTask);

  bad(receipt(contract, task, "h", 12, {
    artifactId: "a",
    supersedes: { artifactId: "a", artifactVersion: 99 },
  }), "VERSION_MISMATCH");
});

test("receipt and artifact bounds reject atomically", () => {
  const { ledger, contract, task, store } = base();
  const raw = "x".repeat(65536);
  const truncated = store.accept(task, receipt(contract, task, "raw", 10, { transportStatus: "TRUNCATED", text: raw }));
  assert.equal(truncated.packet, null);
  assert.equal(truncated.rawResponseText, raw);
  let baseline = store.snapshot();
  assert.throws(
    () => store.accept(task, receipt(contract, task, "raw2", 11, { transportStatus: "TRUNCATED", text: `${raw}x` })),
    { code: "BOUND_EXCEEDED" },
  );
  assert.deepEqual(store.snapshot(), baseline);

  assert.throws(() => store.accept(task, receipt(contract, task, "seq", 10)), { code: "ILLEGAL_TRANSITION" });
  assert.deepEqual(store.snapshot(), baseline);
  assert.throws(
    () => store.accept(task, receipt(contract, task, "seq2", Number.MAX_SAFE_INTEGER + 1)),
    { code: "PACKET_SCHEMA" },
  );
  assert.deepEqual(store.snapshot(), baseline);

  const full = base();
  for (let index = 0; index < 32; index += 1) {
    full.store.accept(full.task, receipt(full.contract, full.task, `f${index}`, 10 + index));
  }
  assert.equal(full.store.snapshot().length, 32);
  const fullBaseline = full.store.snapshot();
  assert.throws(
    () => full.store.accept(full.task, receipt(full.contract, full.task, "f32", 42)),
    { code: "BOUND_EXCEEDED" },
  );
  assert.deepEqual(full.store.snapshot(), fullBaseline);
});

test("non-reusable dependencies and extra fields are rejected", () => {
  const { ledger, contract, task, store } = base();
  store.accept(task, receipt(contract, task, "a", 10, { transportStatus: "TRUNCATED", text: "{oops" }));
  const a1: P2ArtifactRef = { artifactId: "a", artifactVersion: 1 };
  const depTask: P2Task = { ...task, inputArtifactRefs: [a1] };
  let baseline = store.snapshot();
  assert.throws(() => store.accept(depTask, receipt(contract, task, "b", 11)), { code: "NOT_REUSABLE" });
  assert.deepEqual(store.snapshot(), baseline);

  const incomplete = { ...packet(contract, task, "c"), deliveryStatus: "INCOMPLETE" };
  const c = store.accept(task, receipt(contract, task, "c", 11, { text: JSON.stringify(incomplete) }));
  assert.equal(c.deliveryStatus, "INCOMPLETE");
  assert.equal(store.candidate({ artifactId: "c", artifactVersion: 1 }), null);

  baseline = store.snapshot();
  assert.throws(
    () => store.accept(task, { ...receipt(contract, task, "d", 12), extra: true } as never),
    { code: "PACKET_BINDING" },
  );
  assert.deepEqual(store.snapshot(), baseline);

  const extraPacket = { ...packet(contract, task, "e"), extra: true };
  assert.throws(
    () => store.accept(task, receipt(contract, task, "e", 12, { text: JSON.stringify(extraPacket) })),
    { code: "PACKET_SCHEMA" },
  );
  assert.deepEqual(store.snapshot(), baseline);
});
