/**
 * Focused Node tests for the dynamic second route and the task-sync pre-check.
 *
 * The ports are real async functions that build their reply from the request
 * they actually receive. Nothing here is mathematical verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  P2Error,
  p4Hash,
  parseP2WorkPacket,
  parseP2WorkPacketAny,
  type AgentModelRequest,
  type P2Artifact,
  type P2Contract,
  type P2Task,
} from "@astra/protocol";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const MECHANISM = {
  representation: "auxiliary-parameter-space",
  operation: "eliminate-and-substitute",
  lemmas: ["rank-nullspace-identity"],
  construction: "explicit-witness-construction",
};

test("a real v2 proposal opens one second route and keeps the first candidate", async () => {
  const sentRaw: string[] = [];
  const ports = reactivePorts({
    work: (request: AgentModelRequest): string => {
      if (request.requestId !== "model-1") {
        return reactiveWork(request, { candidate: "OTHER" });
      }
      const user = request.messages[1];
      assert.ok(user);
      const body = JSON.parse(user.content);
      const packet = JSON.parse(reactiveWork(request));
      packet.schemaVersion = "p2a-work-v2";
      const obligationId = body.task.obligationId;
      packet.pendingObligations = [obligationId];
      packet.workflowProposal = {
        kind: "NEW_ROUTE",
        obligationId,
        mechanism: MECHANISM,
        rationale: "a second declared mechanism for the same obligation",
      };
      const text = JSON.stringify(packet);
      sentRaw.push(text);
      return text;
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "session-1",
    {
      remainingMs: 5000,
      maxEffects: 0,
      maxModelCalls: 4,
      maxWorkUnits: 2,
      maxReviews: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  assert.equal(result.summary.modelCalls, 3);
  assert.equal(result.summary.workUnits, 2);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  const raw = sentRaw[0];
  assert.ok(raw !== undefined);
  const routes = result.privateState.routes;
  assert.equal(routes?.length, 2);
  assert.equal(result.privateState.routeAdmissions?.length, 1);
  assert.ok(
    result.privateState.events.some((event) => event.eventType === "TASK_ADDED"),
  );
  const entry = result.privateState.artifacts[0];
  assert.ok(entry);
  const artifact = (entry as { artifact: P2Artifact }).artifact;
  assert.equal(artifact.rawResponseText, raw);
  assert.equal(artifact.rawResponseHash, p4Hash(raw));
  assert.deepEqual(artifact.packet, parseP2WorkPacketAny(raw));
  assert.throws(() => parseP2WorkPacket(raw), P2Error);
  const extra = raw.replace('"claim"', '"extraKey":1,"claim"');
  assert.throws(() => parseP2WorkPacketAny(extra), P2Error);
  const dup = raw.replace('"candidateProposal"', '"candidateProposal":null,"candidateProposal"');
  assert.throws(() => parseP2WorkPacketAny(dup), P2Error);
  const unsafe = raw.replace('"contractVersion":1', '"contractVersion":9007199254740993');
  assert.throws(() => parseP2WorkPacketAny(unsafe), P2Error);
});

test("task sync pre-check rejects a changed, removed or malformed task", () => {
  const contract = compileP2Contract(PROBLEM, "session-2");
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  const template = ledger.snapshot().tasks[0];
  assert.ok(template);
  const task: P2Task = {
    ...template,
    envelope: {
      ...template.envelope,
      taskId: "new",
      recordId: "new-task",
      eventSeq: ledger.nextEventSeq(),
    },
    taskId: "new",
    delivery: "READY",
    inputArtifactRefs: [],
    dependencyTaskIds: [],
  };
  const before = ledger.snapshot();
  const prospective: P2Contract = { ...before, tasks: [...before.tasks, task] };
  ledger.validateTaskAddition([task]);
  store.validateAddedTasks(prospective);
  assert.deepEqual(ledger.snapshot(), before);
  ledger.addTasks([task]);
  store.syncAddedTasks(ledger.snapshot());
  const after = ledger.snapshot();
  assert.equal(after.contractVersion, before.contractVersion);
  assert.ok(after.tasks.some((row) => row.taskId === template.taskId));
  assert.ok(after.tasks.some((row) => row.taskId === "new"));
  const entries = store.snapshot();
  const routes = store.routesSnapshot();
  const changed = {
    ...after,
    tasks: after.tasks.map((row) =>
      row.taskId === template.taskId ? { ...row, expectedResult: "tampered" } : row,
    ),
  } as unknown as P2Contract;
  assert.throws(() => store.validateAddedTasks(changed), P2Error);
  assert.throws(() => store.syncAddedTasks(changed), P2Error);
  const removed = {
    ...after,
    tasks: after.tasks.filter((row) => row.taskId !== template.taskId),
  } as unknown as P2Contract;
  assert.throws(() => store.validateAddedTasks(removed), P2Error);
  assert.throws(() => store.syncAddedTasks(removed), P2Error);
  const malformed = {
    ...after,
    tasks: [...after.tasks, null],
  } as unknown as P2Contract;
  assert.throws(() => store.syncAddedTasks(malformed), P2Error);
  assert.deepEqual(store.snapshot(), entries);
  assert.deepEqual(store.routesSnapshot(), routes);
});
