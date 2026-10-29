/**
 * Focused Node tests for the real three-WORK dependent-task chain.
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
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const MECHANISM = {
  representation: "auxiliary-parameter-space",
  operation: "eliminate-and-substitute",
  lemmas: ["rank-nullspace-identity"],
  construction: "explicit-witness-construction",
};

function continuation(request: AgentModelRequest): string {
  const user = request.messages[1];
  assert.ok(user);
  const body = JSON.parse(user.content);
  const obligationId = body.task.obligationId;
  return reactiveWork(request, {
    schemaVersion: "p2a-work-v3",
    pendingObligations: [obligationId],
    workflowProposal: {
      kind: "DEPENDENT_TASK",
      obligationId,
      rationale: "one dependent task for the same obligation",
    },
  });
}

test("a real v3 continuation chains three WORK units on one route", async () => {
  const raw = new Map<string, string>();
  const ports = reactivePorts({
    work: (request: AgentModelRequest): string => {
      const text =
        request.requestId === "model-1" || request.requestId === "model-2"
          ? continuation(request)
          : reactiveWork(request, { candidate: "OTHER" });
      raw.set(request.requestId, text);
      return text;
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "session-dep",
    {
      remainingMs: 5000,
      maxEffects: 0,
      maxModelCalls: 4,
      maxWorkUnits: 3,
      maxReviews: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  assert.equal(result.summary.modelCalls, 4);
  assert.equal(result.summary.workUnits, 3);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.dependencyAdmissions?.length, 2);
  assert.equal(result.privateState.artifacts.length, 3);
  assert.equal(
    result.privateState.events.filter((event) => event.eventType === "TASK_ADDED").length,
    2,
  );
  const tasks = result.privateState.contract.tasks;
  const second = tasks.find((task) => task.taskId === "dep-task-model-1");
  assert.ok(second);
  assert.deepEqual(second.dependencyTaskIds, [ports.requests[0]!.taskId]);
  assert.deepEqual(second.inputArtifactRefs, [{ artifactId: "artifact-1", artifactVersion: 1 }]);
  const third = tasks.find((task) => task.taskId === "dep-task-model-2");
  assert.ok(third);
  assert.deepEqual(third.dependencyTaskIds, ["dep-task-model-1"]);
  assert.deepEqual(third.inputArtifactRefs, [{ artifactId: "artifact-2", artifactVersion: 1 }]);
  const first = result.privateState.artifacts[0];
  assert.ok(first);
  const secondEntry = result.privateState.artifacts[1];
  assert.ok(secondEntry);
  const thirdEntry = result.privateState.artifacts[2];
  assert.ok(thirdEntry);
  const artifact1 = (first as { artifact: P2Artifact }).artifact;
  const artifact2 = (secondEntry as { artifact: P2Artifact }).artifact;
  const artifact3 = (thirdEntry as { artifact: P2Artifact }).artifact;
  assert.deepEqual(artifact2.dependencies, [{ artifactId: "artifact-1", artifactVersion: 1 }]);
  assert.deepEqual(artifact3.dependencies, [{ artifactId: "artifact-2", artifactVersion: 1 }]);
  for (const [index, artifact] of [artifact1, artifact2, artifact3].entries()) {
    const text = raw.get(`model-${index + 1}`);
    assert.ok(text !== undefined);
    assert.equal(artifact.rawResponseText, text);
    assert.equal(artifact.rawResponseHash, p4Hash(text));
    assert.deepEqual(artifact.packet, parseP2WorkPacketAny(text));
  }
  assert.throws(() => parseP2WorkPacket(raw.get("model-1")!), P2Error);
});

test("a v2 route proposal and a v3 continuation keep their own routes", async () => {
  const ports = reactivePorts({
    work: (request: AgentModelRequest): string => {
      if (request.requestId === "model-1") {
        const user = request.messages[1];
        assert.ok(user);
        const body = JSON.parse(user.content);
        const obligationId = body.task.obligationId;
        return reactiveWork(request, {
          schemaVersion: "p2a-work-v2",
          pendingObligations: [obligationId],
          workflowProposal: {
            kind: "NEW_ROUTE",
            obligationId,
            mechanism: MECHANISM,
            rationale: "a second declared mechanism for the same obligation",
          },
        });
      }
      if (request.requestId === "model-2") {
        return continuation(request);
      }
      return reactiveWork(request, { candidate: "OTHER" });
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    "session-dep-route",
    {
      remainingMs: 5000,
      maxEffects: 0,
      maxModelCalls: 4,
      maxWorkUnits: 3,
      maxReviews: 1,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect },
  );
  assert.equal(result.summary.modelCalls, 4);
  assert.equal(result.summary.workUnits, 3);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.privateState.routes?.length, 2);
  assert.equal(result.privateState.routeAdmissions?.length, 1);
  assert.equal(result.privateState.dependencyAdmissions?.length, 1);
  const child = result.privateState.contract.tasks.find(
    (task) => task.taskId === "dep-task-model-2",
  );
  assert.ok(child);
  assert.deepEqual(child.dependencyTaskIds, ["route-task-model-1"]);
  assert.deepEqual(child.inputArtifactRefs, [{ artifactId: "artifact-2", artifactVersion: 1 }]);
  const firstEntry = result.privateState.artifacts[0];
  assert.ok(firstEntry);
  const secondEntry = result.privateState.artifacts[1];
  assert.ok(secondEntry);
  const thirdEntry = result.privateState.artifacts[2];
  assert.ok(thirdEntry);
  const parent1 = (firstEntry as { artifact: P2Artifact }).artifact;
  const parent2 = (secondEntry as { artifact: P2Artifact }).artifact;
  const child3 = (thirdEntry as { artifact: P2Artifact }).artifact;
  assert.equal(child3.routeId, parent2.routeId);
  assert.notEqual(child3.routeId, parent1.routeId);
  assert.deepEqual(child3.dependencies, [
    {
      artifactId: parent2.artifactId,
      artifactVersion: parent2.envelope.artifactVersion,
    },
  ]);
  assert.ok(child3.dependencies.every((ref) => ref.artifactId !== parent1.artifactId));
});

test("the v3 parser stays strict while the v1 parser rejects v3", () => {
  const request = {
    messages: [
      { role: "system", content: "s" },
      {
        role: "user",
        content: JSON.stringify({
          sessionId: "session-dep",
          problemHash: "0".repeat(64),
          contractVersion: 1,
          task: {
            taskId: "task-1",
            goalId: "goal-1",
            obligationId: "obligation-1",
            scopeId: "scope-1",
            inputArtifactRefs: [],
          },
          route: { routeId: "route-1" },
          sourceRequestId: "model-1",
        }),
      },
    ],
  } as unknown as AgentModelRequest;
  const raw = continuation(request);
  assert.throws(() => parseP2WorkPacket(raw), P2Error);
  const parsed = parseP2WorkPacketAny(raw);
  assert.equal(parsed.schemaVersion, "p2a-work-v3");
  const wrongKind = raw.replace('"DEPENDENT_TASK"', '"NEW_ROUTE"');
  assert.throws(() => parseP2WorkPacketAny(wrongKind), P2Error);
  const extra = raw.replace('"rationale"', '"refs":[],"rationale"');
  assert.throws(() => parseP2WorkPacketAny(extra), P2Error);
  const unsafe = raw.replace('"contractVersion":1', '"contractVersion":9007199254740993');
  assert.throws(() => parseP2WorkPacketAny(unsafe), P2Error);
  const dup = raw.replace('"candidateProposal"', '"candidateProposal":null,"candidateProposal"');
  assert.throws(() => parseP2WorkPacketAny(dup), P2Error);
});
