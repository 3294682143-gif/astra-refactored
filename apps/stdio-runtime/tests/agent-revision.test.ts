/**
 * Focused Node tests for the real artifact-redo chain.
 *
 * The ports are real async functions that build their reply from the request
 * they actually receive. Nothing here is mathematical verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentModelRequest, P2Artifact } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const MECHANISM = {
  representation: "auxiliary-parameter-space",
  operation: "eliminate-and-substitute",
  lemmas: ["rank-nullspace-identity"],
  construction: "explicit-witness-construction",
};

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user);
  return JSON.parse(user.content) as Record<string, unknown>;
}

function continuation(request: AgentModelRequest): string {
  const body = bodyOf(request);
  const obligationId = (body.task as { obligationId: string }).obligationId;
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

function routeProposal(request: AgentModelRequest): string {
  const body = bodyOf(request);
  const obligationId = (body.task as { obligationId: string }).obligationId;
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

function redoProposal(request: AgentModelRequest, self: boolean): string {
  const body = bodyOf(request);
  const obligationId = (body.task as { obligationId: string }).obligationId;
  const refs = (body.task as { inputArtifactRefs: readonly unknown[] }).inputArtifactRefs;
  return reactiveWork(request, {
    schemaVersion: "p2a-work-v4",
    candidate: "OTHER",
    pendingObligations: [obligationId],
    workflowProposal: {
      kind: "REDO_ARTIFACT",
      targetArtifactRef: self ? null : refs[0],
      rationale: "redo the artifact this work depends on",
    },
  });
}

for (const mode of ["parent", "self"] as const) {
  test(`a real ${mode} redo commits one new version and its exact closure`, async () => {
    const ports = reactivePorts({
      work: (request: AgentModelRequest): string => {
        if (request.requestId === "model-1") {
          return mode === "parent" ? continuation(request) : routeProposal(request);
        }
        if (request.requestId === "model-2") {
          return redoProposal(request, mode === "self");
        }
        return reactiveWork(request, {
          claim: "2+2=4 (redone)",
          derivation: "2+2=4 (redone)",
        });
      },
    });
    const result = await runAgentLoop(
      PROBLEM,
      `session-revision-${mode}`,
      {
        remainingMs: 5000,
        maxEffects: 0,
        maxModelCalls: 4,
        maxWorkUnits: 3,
        maxReviews: 0,
        now: () => 0,
      },
      { model: ports.model, effect: ports.effect },
    );
    assert.equal(result.summary.modelCalls, 3);
    assert.equal(result.summary.workUnits, 3);
    assert.equal(result.summary.reviewCalls, 0);
    const revisions = result.privateState.revisions ?? [];
    assert.equal(revisions.length, 1);
    const record = revisions[0]!;
    assert.equal(record.status, "COMMITTED");
    assert.equal(record.newRef?.artifactVersion, 2);
    assert.ok(record.staleRefs.length >= 1);
    const entries = result.privateState.artifacts as readonly {
      readonly artifact: P2Artifact;
      readonly availability: string;
    }[];
    const targetRef = record.provenance.targetArtifactRef;
    const oldEntry = entries.find(
      (row) =>
        row.artifact.artifactId === targetRef.artifactId &&
        row.artifact.envelope.artifactVersion === targetRef.artifactVersion,
    );
    assert.ok(oldEntry);
    assert.equal(oldEntry.availability, "STALE");
    const newEntry = entries.find(
      (row) =>
        row.artifact.artifactId === record.newRef?.artifactId &&
        row.artifact.envelope.artifactVersion === record.newRef?.artifactVersion,
    );
    assert.ok(newEntry);
    assert.equal(newEntry.availability, "ACTIVE");
    const tasks = result.privateState.contract.tasks;
    const readyTasks = result.privateState.readyTasks ?? [];
    if (mode === "parent") {
      const child = tasks.find((task) => task.taskId === "dep-task-model-1");
      assert.ok(child);
      assert.equal(child.delivery, "READY");
      // The ledger snapshot clears the stale input refs of a reopened task;
      // the real new refs are projected by the ready-task view.
      assert.deepEqual(child.inputArtifactRefs, []);
      const readyChild = readyTasks.find((task) => task.taskId === "dep-task-model-1");
      assert.ok(readyChild);
      assert.deepEqual(readyChild.inputArtifactRefs, [
        { artifactId: record.newRef!.artifactId, artifactVersion: 2 },
      ]);
    } else {
      // The unrelated original task is the one that produced artifact-1; the
      // route-task-model-1 task is the redo target itself, not unrelated.
      const firstEntry = entries.find(
        (row) => row.artifact.artifactId === "artifact-1",
      );
      assert.ok(firstEntry);
      const first = tasks.find(
        (task) => task.taskId === firstEntry.artifact.envelope.taskId,
      );
      assert.ok(first);
      assert.equal(first.delivery, "DELIVERED");
      assert.deepEqual(first.inputArtifactRefs, []);
      const untouched = entries.find(
        (row) => row.artifact.artifactId === "artifact-1",
      );
      assert.ok(untouched);
      assert.equal(untouched.availability, "ACTIVE");
    }
  });
}
