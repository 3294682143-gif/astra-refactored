import test from "node:test";
import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import {
  P2Error,
  P2_LIMITS,
  p2Snapshot,
  canonicalScope,
  P2_WORK_PACKET_SCHEMA,
  parseP2WorkPacket,
  type P2Contract,
  type P2GoalSpec,
  type P2Task,
  type P2AcceptanceReceipt,
  type P2WorkPacket,
  type Scope,
} from "@astra/protocol";

const PROBLEM = "求x(x−1)=0的全部实数解";
const SESSION = "s";
const MULTI = "求x(x−1)=0的全部实数解，并说明每个解";

function scope(scopeId: string, domain = "REAL"): Scope {
  return { scopeId, domain, variableBindings: {}, quantifiers: [], localAssumptions: [], branchConditions: [], referenceablePremises: [] };
}

function goal(goalId: string, kind: P2GoalSpec["kind"], subgoals: readonly P2GoalSpec[] = []): P2GoalSpec {
  return { goalId, kind, scope: scope(`${goalId}:scope`), subgoals };
}

function base(problem = PROBLEM): ContractLedger {
  return new ContractLedger(compileP2Contract(problem, SESSION));
}

function custom(ledger: ContractLedger, id: string, deps: readonly string[]): P2Task {
  const template = ledger.snapshot().tasks[0]!;
  return { ...template, envelope: { ...template.envelope, taskId: id, recordId: `${SESSION}:custom:${id}` }, taskId: id, dependencyTaskIds: deps };
}

function receipt(ledger: ContractLedger, obligationId: string, refs: readonly string[]): P2AcceptanceReceipt {
  const contract = ledger.snapshot();
  const obligation = contract.obligations.find((item) => item.obligationId === obligationId)!;
  return { mode: "MOCK_ONLY", sourceModule: "M5", sessionId: SESSION, problemHash: contract.problemHash, contractVersion: contract.contractVersion, goalId: obligation.goalId, scopeId: obligation.envelope.scopeId!, policy: "mock", evidenceRefs: refs };
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

function clone(contract: P2Contract): any {
  return JSON.parse(JSON.stringify(contract));
}

test("template obligations, risk hint and multipart coverage graph", () => {
  const ledger = base();
  const contract = ledger.snapshot();
  assert.equal(contract.riskHints.some((hint) => hint.includes("x=0")), true);
  assert.deepEqual(contract.goals[0]!.scope.branchConditions, []);
  const kinds = contract.obligations.map((item) => item.kind);
  assert.deepEqual(kinds, ["DOMAIN_VALIDITY", "CANDIDATE_VALIDITY", "BOUNDARY_EXCEPTIONS", "EXHAUSTIVENESS", "OUTPUT_COVERAGE"]);
  const multi = new ContractLedger(compileP2Contract(MULTI, SESSION, [goal("root", "MULTIPART", [goal("a", "VALUE"), goal("b", "VALUE")])]));
  const tasks = multi.snapshot().tasks;
  const cover = tasks.filter((task) => task.taskId.includes("cover"));
  assert.equal(cover.length, 2);
  const coverA = tasks.find((task) => task.taskId.endsWith("root:cover:a"))!;
  const coverB = tasks.find((task) => task.taskId.endsWith("root:cover:b"))!;
  assert.deepEqual(coverA.dependencyTaskIds, ["a:OUTPUT_COVERAGE"]);
  assert.deepEqual(coverB.dependencyTaskIds, ["b:OUTPUT_COVERAGE"]);
  const rootOutput = tasks.find((task) => task.taskId.endsWith("root:OUTPUT_COVERAGE"))!;
  assert.deepEqual([...rootOutput.dependencyTaskIds].sort(), [coverA.taskId, coverB.taskId].sort());
});

test("revision reopens only affected goals and rejects custom tasks", () => {
  const ledger = base();
  const specs = [goal("a", "VALUE"), goal("b", "VALUE")];
  const revised = new ContractLedger(compileP2Contract(PROBLEM, SESSION, specs));
  const v1 = revised.snapshot();
  const bTask = v1.tasks.find((task) => task.taskId.startsWith("b:"))!;
  revised.startTask(bTask.taskId);
  revised.recordDelivery(bTask.taskId, { artifactId: "rb", artifactVersion: 1 }, "DELIVERED", revised.nextEventSeq());
  const changed = [{ ...specs[0]!, scope: scope("a:scope", "INTEGER") }, specs[1]!];
  const delta = revised.reviseGoals(changed);
  assert.equal(delta.fromVersion, 1);
  assert.equal(delta.toVersion, 2);
  assert.equal(revised.snapshot().contractVersion, 2);
  assert.equal(v1.contractVersion, 1);
  assert.equal(revised.snapshot().obligations.find((item) => item.goalId === "a")!.status, "REOPENED");
  assert.equal(revised.snapshot().tasks.find((task) => task.taskId === bTask.taskId)!.delivery, "DELIVERED");
  const withC = revised.reviseGoals([...changed, goal("c", "VALUE")]);
  assert.equal(withC.changedGoalIds.includes("c"), true);
  assert.equal(revised.snapshot().obligations.filter((item) => item.goalId === "c").every((item) => item.status === "OPEN"), true);
  revised.addTasks([custom(revised, "X", [])]);
  const before = frozen(revised);
  rejects(() => revised.reviseGoals([...changed, goal("c", "VALUE")]), "ILLEGAL_TRANSITION");
  assert.equal(frozen(revised), before);
});

test("constructor rejects malformed contracts and accepts a fresh one", () => {
  const good = compileP2Contract(PROBLEM, SESSION);
  assert.equal(new ContractLedger(good).snapshot().contractVersion, 1);
  const sat = clone(good);
  sat.obligations[0].status = "SATISFIED";
  rejects(() => new ContractLedger(sat), "ILLEGAL_TRANSITION");
  const delivered = clone(good);
  delivered.tasks[0].delivery = "DELIVERED";
  rejects(() => new ContractLedger(delivered), "ILLEGAL_TRANSITION");
  const badHash = clone(good);
  badHash.problemHash = "0".repeat(64);
  rejects(() => new ContractLedger(badHash), "PACKET_BINDING");
  const staleScope = clone(good);
  staleScope.goals[0].scope.domain = "INTEGER";
  rejects(() => new ContractLedger(staleScope), "SCOPE_MISMATCH");
  const dup = clone(good);
  dup.obligations.push({ ...dup.obligations[0] });
  rejects(() => new ContractLedger(dup), "DUPLICATE_ID");
  const noEnvelope = clone(good);
  delete noEnvelope.tasks[0].envelope;
  rejects(() => new ContractLedger(noEnvelope), "PACKET_BINDING");
  const noRefs = clone(good);
  delete noRefs.tasks[0].inputArtifactRefs;
  rejects(() => new ContractLedger(noRefs), "ILLEGAL_TRANSITION");
  const hugeSeq = clone(good);
  hugeSeq.envelope.eventSeq = Number.MAX_SAFE_INTEGER;
  rejects(() => new ContractLedger(hugeSeq), "PACKET_BINDING");
});

test("event budget is enforced without partial mutation", () => {
  const ledger = base();
  const obligationId = ledger.snapshot().obligations[0]!.obligationId;
  while (ledger.eventsSnapshot().length < P2_LIMITS.maxLedgerEvents) {
    const status = ledger.snapshot().obligations.find((item) => item.obligationId === obligationId)!.status;
    if (status === "BLOCKED") {
      ledger.reopenObligation(obligationId);
    } else {
      ledger.blockObligation(obligationId);
    }
  }
  assert.equal(ledger.eventsSnapshot().length, P2_LIMITS.maxLedgerEvents);
  const before = frozen(ledger);
  rejects(() => ledger.reopenObligation(obligationId), "BOUND_EXCEEDED");
  rejects(() => ledger.startTask(ledger.readyTasks()[0]!.taskId), "BOUND_EXCEEDED");
  assert.equal(frozen(ledger), before);
  const near = clone(compileP2Contract(PROBLEM, SESSION));
  near.envelope.eventSeq = Number.MAX_SAFE_INTEGER - 1;
  const edge = new ContractLedger(near);
  assert.equal(edge.nextEventSeq(), Number.MAX_SAFE_INTEGER);
  const edgeBefore = frozen(edge);
  rejects(() => edge.blockObligation(edge.snapshot().obligations[0]!.obligationId), "PACKET_BINDING");
  assert.equal(frozen(edge), edgeBefore);
});

test("snapshot, canonical scope and packet schema are strict", () => {
  const cyclic: any = { a: 1 };
  cyclic.self = cyclic;
  rejects(() => p2Snapshot(cyclic), "DEPENDENCY_CYCLE");
  rejects(() => p2Snapshot({ n: Number.MAX_SAFE_INTEGER + 1 }), "PACKET_SCHEMA");
  rejects(() => p2Snapshot({ d: new Date() }), "PACKET_SCHEMA");
  const proto = p2Snapshot(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(proto, "__proto__"), true);
  const shared = { inner: { v: 1 } };
  const cloned = p2Snapshot({ left: shared, right: shared });
  assert.notEqual(cloned.left, cloned.right);
  assert.equal(Object.isFrozen(cloned.left.inner), true);
  const s1 = scope("z", "REAL");
  const s2: Scope = { ...s1, variableBindings: { b: "2", a: "1" } };
  const s3: Scope = { ...s1, variableBindings: { a: "1", b: "2" } };
  assert.equal(canonicalScope(s2), canonicalScope(s3));
  assert.notEqual(canonicalScope({ ...s1, quantifiers: ["x", "y"] }), canonicalScope({ ...s1, quantifiers: ["y", "x"] }));
  assert.equal(Object.isFrozen(P2_WORK_PACKET_SCHEMA), true);
  assert.equal(Object.isFrozen(P2_WORK_PACKET_SCHEMA.properties), true);
  const packet: P2WorkPacket = {
    schemaVersion: "p2a-work-v1", sessionId: SESSION, problemHash: "a".repeat(64), contractVersion: 1,
    taskId: "t", goalId: "g", scopeId: "s", routeId: "r", sourceRequestId: "q", claim: "c", derivation: "d",
    assumptions: [], dependencies: [], pendingObligations: [], suggestedChecks: [], deliveryStatus: "COMPLETE", candidateProposal: null,
  };
  assert.deepEqual(parseP2WorkPacket(JSON.stringify(packet)), packet);
  rejects(() => parseP2WorkPacket('{"a":1,"a":2}'), "PACKET_SCHEMA");
  rejects(() => parseP2WorkPacket(JSON.stringify({ ...packet, acceptance: {} })), "PACKET_SCHEMA");
  rejects(() => parseP2WorkPacket(JSON.stringify({ ...packet, contractVersion: 1.5 })), "PACKET_SCHEMA");
  rejects(() => parseP2WorkPacket("{"), "PACKET_SCHEMA");
  rejects(() => parseP2WorkPacket(JSON.stringify({ ...packet, claim: "\ud800" })), "PACKET_SCHEMA");
});

test("long artifact ids still need a real delivered ref for M5 acceptance", () => {
  const ledger = base();
  const task = ledger.readyTasks()[0]!;
  ledger.startTask(task.taskId);
  const artifactId = "a".repeat(P2_LIMITS.maxShortStringChars);
  ledger.recordDelivery(task.taskId, { artifactId, artifactVersion: 1 }, "DELIVERED", ledger.nextEventSeq());
  const ref = `${artifactId}@1`;
  assert.equal(ref.length > P2_LIMITS.maxShortStringChars, true);
  const before = frozen(ledger);
  rejects(() => ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, [])), "UNTRUSTED_ACCEPTANCE");
  rejects(() => ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, ["ghost@1"])), "UNTRUSTED_ACCEPTANCE");
  assert.equal(frozen(ledger), before);
  ledger.acceptObligation(task.obligationId, receipt(ledger, task.obligationId, [ref]));
  assert.equal(ledger.snapshot().obligations.find((item) => item.obligationId === task.obligationId)!.status, "SATISFIED");
});
