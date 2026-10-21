import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2Error } from "@astra/protocol";
import { P2RouteRegistry, prepareP2Context } from "@astra/math-workunit";
import { runP2Fixture } from "../src/p2-fixture.js";
import type { P2FixtureUnit } from "../src/p2-fixture.js";
import type { P2RouteInput } from "@astra/math-workunit";
import type { P2MethodPort } from "@astra/protocol";

const PROBLEM = "PRIVATE_PROBLEM_SENTINEL";
const contract = compileP2Contract(PROBLEM, "fixture-session");
const task = contract.tasks[0]!;
const route: P2RouteInput = {
  routeId: "r",
  representation: "rep",
  operation: "op",
  lemmas: ["l"],
  construction: "con",
};
const options = {
  routes: [route],
  maxWorkUnits: 3,
  remainingMs: 5000,
  maxMethods: 2,
  maxMethodChars: 12000,
  now: () => 0,
};

function unit(index: number, transport: "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN" = "COMPLETE", patch: Record<string, unknown> = {}): P2FixtureUnit {
  const packet = {
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: task.taskId,
    goalId: task.goalId,
    scopeId: task.scopeId,
    routeId: "r",
    sourceRequestId: `fixture-${index}`,
    claim: "c",
    derivation: "d",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "fixture candidate",
    ...patch,
  };
  return { taskId: task.taskId, routeId: "r", methodIds: [], transportStatus: transport, text: JSON.stringify(packet) };
}

test("one normal unit is consumed and stays unverified", () => {
  const result = runP2Fixture(contract, [unit(1)], options);
  assert.equal(result.summary.fixtureReceiptsConsumed, 1);
  assert.equal(result.summary.stopReason, "FIXTURE_EXHAUSTED");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.candidateProposal, "fixture candidate");
  assert.equal(result.privateState.contract.tasks[0]!.delivery, "DELIVERED");
  assert.equal(result.privateState.artifacts.length, 1);
  assert.equal(result.privateState.artifacts[0]!.artifact.level, "PROVISIONAL");
  assert.equal(result.privateState.artifacts[0]!.artifact.checkResult, "UNKNOWN");
  const request = result.privateState.requests[0]!;
  const serialized = JSON.stringify(request.messages);
  assert.equal(request.contextBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(request.contextHash, createHash("sha256").update(serialized, "utf8").digest("hex"));
  const user = JSON.parse(request.messages[1]!.content) as Record<string, unknown>;
  assert.equal(user.problemFullText, contract.problemFullText);
  const running = user.task as { taskId: string; goalId: string; obligationId: string; scopeId: string; delivery: string };
  assert.equal(running.taskId, task.taskId);
  assert.equal(running.goalId, task.goalId);
  assert.equal(running.obligationId, task.obligationId);
  assert.equal(running.scopeId, task.scopeId);
  assert.equal(running.delivery, "RUNNING");
  const obligations = user.obligations as readonly { obligationId: string; status: string }[];
  assert.equal(obligations.length, contract.obligations.length);
  for (const row of obligations) {
    const expected = row.obligationId === task.obligationId ? "IN_PROGRESS" : "OPEN";
    assert.equal(row.status, expected);
  }
  assert.equal((user.scope as { scopeId: string }).scopeId, task.scopeId);
  const summaryText = JSON.stringify(result.summary);
  assert.equal(summaryText.includes(PROBLEM), false);
  assert.equal(summaryText.includes("methodAssets"), false);
});

test("non-complete transports and packets never yield a candidate", () => {
  const cases: readonly [readonly P2FixtureUnit[], string][] = [
    [[unit(1, "TRUNCATED")], "FIXTURE_EXHAUSTED"],
    [[unit(1, "COMPLETE", { deliveryStatus: "INCOMPLETE" })], "FIXTURE_EXHAUSTED"],
    [[unit(1, "ERROR"), unit(2)], "TRANSPORT_STOP"],
    [[unit(1, "UNKNOWN"), unit(2)], "TRANSPORT_STOP"],
  ];
  for (const [entries, stop] of cases) {
    const result = runP2Fixture(contract, entries, options);
    assert.equal(result.summary.status, "unsolved");
    assert.equal(result.summary.candidateProposal, null);
    assert.equal(result.summary.stopReason, stop);
    assert.equal(result.summary.fixtureReceiptsConsumed, 1);
  }
});

test("zero budget consumes nothing while a rejected packet consumes one", () => {
  const zero = runP2Fixture(contract, [unit(1)], { ...options, maxWorkUnits: 0 });
  assert.equal(zero.summary.fixtureReceiptsConsumed, 0);
  const tight = runP2Fixture(contract, [unit(1)], { ...options, remainingMs: 25 });
  assert.equal(tight.summary.fixtureReceiptsConsumed, 0);
  assert.equal(tight.summary.stopReason, "DEADLINE_EXCEEDED");
  const notReady = runP2Fixture(contract, [{ ...unit(1), taskId: "missing" }], options);
  assert.equal(notReady.summary.fixtureReceiptsConsumed, 0);
  assert.equal(notReady.summary.stopReason, "TASK_NOT_READY");
  // The eight packet identity fields are control data: a model copy error is
  // rebound to the trusted binding instead of being accepted as authority or
  // rejected as a mismatch.
  const rebound = runP2Fixture(contract, [unit(1, "COMPLETE", { sessionId: "other", problemHash: "f".repeat(64) })], options);
  assert.equal(rebound.summary.fixtureReceiptsConsumed, 1);
  assert.equal(rebound.summary.status, "candidate");
  assert.equal(rebound.summary.candidateProposal, "fixture candidate");
  assert.equal(rebound.privateState.artifacts.length, 1);
  // A packet whose mathematics is unusable is still a fixed rejection.
  const blankClaim = runP2Fixture(contract, [unit(1, "COMPLETE", { claim: "   " })], options);
  assert.equal(blankClaim.summary.fixtureReceiptsConsumed, 1);
  assert.equal(blankClaim.summary.stopReason, "PACKET_REJECTED");
  assert.equal(blankClaim.privateState.artifacts.length, 0);
  assert.equal(blankClaim.privateState.requests[0]!.errorCode, "PACKET_DELIVERY");
});

const CHAIN_PROBLEM = "求全部实数解";
const chainContract = compileP2Contract(CHAIN_PROBLEM, "chain");
const chainKinds = ["CANDIDATE_VALIDITY", "BOUNDARY_EXCEPTIONS", "EXHAUSTIVENESS"];
const chainTasks = chainKinds.map((kind) => {
  const obligationId = chainContract.obligations.find((row) => row.kind === kind)!.obligationId;
  return chainContract.tasks.find((row) => row.obligationId === obligationId)!;
});

function chainUnit(index: number): P2FixtureUnit {
  const task = chainTasks[index - 1]!;
  const packet = {
    schemaVersion: "p2a-work-v1",
    sessionId: chainContract.envelope.sessionId,
    problemHash: chainContract.problemHash,
    contractVersion: chainContract.contractVersion,
    taskId: task.taskId,
    goalId: task.goalId,
    scopeId: task.scopeId,
    routeId: "r",
    sourceRequestId: `fixture-${index}`,
    claim: "c",
    derivation: "d",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: `candidate-${index}`,
  };
  return { taskId: task.taskId, routeId: "r", methodIds: [], transportStatus: "COMPLETE", text: JSON.stringify(packet) };
}

test("three-task dependency chain keeps conservative inputs and the first candidate", () => {
  const result = runP2Fixture(chainContract, [chainUnit(1), chainUnit(2), chainUnit(3)], options);
  assert.equal(result.summary.fixtureReceiptsConsumed, 3);
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.candidateProposal, "candidate-1");
  const requests = result.privateState.requests;
  assert.equal(requests.length, 3);
  const thirdUser = JSON.parse(requests[2]!.messages[1]!.content) as Record<string, unknown>;
  const thirdInputs = thirdUser.inputArtifacts as readonly { artifactId: string; envelope: { artifactVersion: number } }[];
  assert.equal(thirdInputs.length, 2);
  assert.equal(thirdInputs[0]!.artifactId, "fixture-artifact-1");
  assert.equal(thirdInputs[0]!.envelope.artifactVersion, 1);
  assert.equal(thirdInputs[1]!.artifactId, "fixture-artifact-2");
  assert.equal(thirdInputs[1]!.envelope.artifactVersion, 1);
  const thirdArtifact = result.privateState.artifacts.find((entry) => entry.artifact.artifactId === "fixture-artifact-3")!;
  assert.equal(thirdArtifact.artifact.provisionalDependency, true);
  for (const task of chainTasks) {
    const recorded = result.privateState.contract.tasks.find((row) => row.taskId === task.taskId)!;
    assert.equal(recorded.delivery, "DELIVERED");
  }
  for (const obligation of result.privateState.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
});

test("a one-unit budget consumes one receipt and stops with BUDGET_EXHAUSTED", () => {
  const result = runP2Fixture(chainContract, [chainUnit(1), chainUnit(2), chainUnit(3)], { ...options, maxWorkUnits: 1 });
  assert.equal(result.summary.fixtureReceiptsConsumed, 1);
  assert.equal(result.summary.stopReason, "BUDGET_EXHAUSTED");
  assert.equal(result.privateState.artifacts.length, 1);
  assert.equal(result.privateState.requests.length, 1);
});

const METHOD_IDS = Array.from({ length: 20 }, (_, index) => `m-${index}`);

function slowPort(advance: () => void, catalogOverrun = true): { port: P2MethodPort; loads: () => number } {
  let loads = 0;
  return {
    port: {
      catalog: () => {
        if (catalogOverrun) {
          advance();
        }
        return { version: "1.1.0", entries: METHOD_IDS.map((id) => ({ id, title: id })) };
      },
      load: () => {
        loads += 1;
        advance();
        return { status: "disabled", asset: null };
      },
    },
    loads: () => loads,
  };
}

test("a method host that overruns the deadline stops before any receipt", () => {
  let now = 0;
  const slow = slowPort(() => { now = 6000; });
  const slowResult = runP2Fixture(contract, [{ ...unit(1), methodIds: ["m-0"] }], {
    ...options, methodPort: slow.port, now: () => now,
  });
  assert.equal(slowResult.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(slowResult.summary.fixtureReceiptsConsumed, 0);
  assert.equal(slow.loads(), 0);
  let fresh = 0;
  const late = slowPort(() => { fresh = 6000; }, false);
  const lateResult = runP2Fixture(contract, [{ ...unit(1), methodIds: ["m-0"] }], {
    ...options, methodPort: late.port, now: () => fresh,
  });
  assert.equal(lateResult.summary.fixtureReceiptsConsumed, 0);
  assert.equal(lateResult.summary.methodLoadAttempts, 1);
  assert.equal(late.loads(), 1);
  const ticks = [10, 0];
  let tick = 0;
  const back = runP2Fixture(contract, [unit(1)], { ...options, now: () => ticks[Math.min(tick++, 1)]! });
  assert.equal(back.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(back.summary.fixtureReceiptsConsumed, 0);
  assert.throws(
    () => runP2Fixture(contract, [unit(1)], { ...options, now: () => { throw new Error("PRIVATE_CLOCK"); } }),
    (error: unknown) =>
      error instanceof P2Error &&
      error.code === "DEADLINE_EXCEEDED" &&
      !error.message.includes("PRIVATE_CLOCK"),
  );
});

test("a late delivery is invalidated and a rejected packet keeps the first candidate", () => {
  let calls = 0;
  const late = runP2Fixture(contract, [unit(1)], {
    ...options, now: () => (calls++ < 3 ? 0 : 6000),
  });
  assert.equal(late.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(late.summary.status, "unsolved");
  assert.equal(late.summary.candidateProposal, null);
  assert.equal(late.summary.fixtureReceiptsConsumed, 1);
  assert.equal(late.privateState.artifacts[0]!.availability, "STALE");
  assert.equal(late.summary.trace[0]!.code, "DEADLINE_EXCEEDED");
  const rejected = runP2Fixture(chainContract, [chainUnit(1), { ...chainUnit(2), text: JSON.stringify({ ...JSON.parse(chainUnit(2).text), claim: "  " }) }], options);
  assert.equal(rejected.summary.fixtureReceiptsConsumed, 2);
  assert.equal(rejected.summary.stopReason, "PACKET_REJECTED");
  assert.equal(rejected.summary.candidateProposal, "candidate-1");
  assert.equal(rejected.summary.candidateVerified, false);
});

const CAPACITY_PROBLEM = "界".repeat(8192);
const capacityContract = compileP2Contract(CAPACITY_PROBLEM, "capacity");
const capacityLedger = new ContractLedger(capacityContract);
const capacityTask = capacityLedger.startTask(capacityContract.tasks[0]!.taskId);
const capacityRegistry = new P2RouteRegistry();
const capacityRoute = capacityRegistry.register({
  routeId: "r",
  representation: "rep",
  operation: "op",
  lemmas: ["l"],
  construction: "con",
});
const capacityCatalog = Array.from({ length: 20 }, (_, index) => ({
  id: `m-${index}`,
  title: "界".repeat(256),
}));

function capacityAsset(id: string, body: string) {
  return {
    id,
    title: "界".repeat(256),
    version: "1.1.0" as const,
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    bodyChars: [...body].length,
  };
}

test("a full-length problem keeps both method assets and drops only the catalog", () => {
  const assets = [capacityAsset("m-0", "a".repeat(12000)), capacityAsset("m-1", "a".repeat(12000))];
  const prepared = prepareP2Context(
    capacityContract,
    capacityTask,
    capacityRoute,
    "req",
    [],
    capacityCatalog,
    assets,
  );
  assert.equal(prepared.contextBytes <= 65536, true);
  assert.equal(prepared.contextBytes, Buffer.byteLength(JSON.stringify(prepared.messages), "utf8"));
  assert.equal(prepared.contextHash, createHash("sha256").update(JSON.stringify(prepared.messages), "utf8").digest("hex"));
  const user = JSON.parse(prepared.messages[1]!.content) as Record<string, unknown>;
  assert.equal(user.problemFullText, CAPACITY_PROBLEM);
  assert.equal((user.obligations as readonly unknown[]).length, capacityContract.obligations.length);
  assert.equal((user.task as { taskId: string }).taskId, capacityTask.taskId);
  assert.equal((user.scope as { scopeId: string }).scopeId, capacityTask.scopeId);
  assert.equal("methodCatalog" in user, false);
  const kept = user.methodAssets as readonly { id: string; body: string; bodyChars: number }[];
  assert.equal(kept.length, 2);
  assert.equal(kept[0]!.id, "m-0");
  assert.equal(kept[1]!.id, "m-1");
  assert.equal(kept[0]!.body, assets[0]!.body);
  assert.equal(kept[1]!.body, assets[1]!.body);
  assert.equal(kept[0]!.bodyChars, 12000);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.messages), true);
  assert.equal(Object.isFrozen(prepared.messages[0]), true);
  assert.equal(Object.isFrozen(prepared.messages[1]), true);
});

test("an oversized critical context is rejected instead of truncated", () => {
  const assets = [capacityAsset("m-0", "a".repeat(24000)), capacityAsset("m-1", "a".repeat(24000))];
  assert.throws(
    () => prepareP2Context(capacityContract, capacityTask, capacityRoute, "req", [], capacityCatalog, assets),
    (error: unknown) => error instanceof P2Error && error.code === "BOUND_EXCEEDED",
  );
});
