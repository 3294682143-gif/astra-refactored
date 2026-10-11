import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentModelRequest } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  reactivePorts,
  reactiveTool,
  reactiveWork,
  type ReactivePorts,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";

function portsOf(ports: ReactivePorts) {
  return { model: ports.model, effect: ports.effect };
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user !== undefined);
  return JSON.parse(user.content) as Record<string, unknown>;
}

function finalReply(request: AgentModelRequest, mutate?: (action: Record<string, unknown>) => void): string {
  const body = bodyOf(request);
  const candidate = body.protectedCandidate as { readonly answer: string } | null;
  assert.ok(candidate !== null);
  const action: Record<string, unknown> = {
    action: "final",
    answer: candidate.answer,
    complete: true,
    unresolved: [],
  };
  if (mutate !== undefined) {
    mutate(action);
  }
  return JSON.stringify(action);
}

function finalPorts(mutate?: (action: Record<string, unknown>) => void): ReactivePorts {
  let work = 0;
  return reactivePorts({
    work: (request) => {
      work += 1;
      if (work === 1) {
        return reactiveTool();
      }
      if (work === 2) {
        return reactiveWork(request);
      }
      return finalReply(request, mutate);
    },
  });
}

test("tool -> work -> final keeps one root and the model-2 source", async () => {
  const ports = finalPorts();
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 1, now: () => 0 },
    portsOf(ports),
  );
  assert.equal(result.summary.modelCalls, 4);
  assert.equal(result.summary.effectCalls, 1);
  assert.equal(result.summary.workUnits, 1);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.artifacts.length, 1);
  assert.deepEqual(
    ports.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  const finalRequest = ports.requests[2]!;
  assert.equal(finalRequest.phase, "WORK");
  const action = JSON.parse(finalRequest.messages[1]!.content) as Record<string, unknown>;
  assert.equal(action.allowFinal, true);
  const candidate = action.protectedCandidate as { readonly binding: { readonly sourceRequestId: string } };
  assert.equal(candidate.binding.sourceRequestId, "model-2");
  assert.equal(result.privateState.decision.protectedCandidate?.sourceRequestId, "model-2");
  const raw = result.privateState.requests[2] as { readonly receipt: { readonly text: string } };
  assert.equal((JSON.parse(raw.receipt.text) as { readonly action: string }).action, "final");
});

for (const [name, mutate] of [
  ["answer", (action: Record<string, unknown>) => { action.answer = "ATTACK"; }],
  ["complete", (action: Record<string, unknown>) => { action.complete = false; }],
  ["unresolved", (action: Record<string, unknown>) => { action.unresolved = ["open"]; }],
] as const) {
  test(`illegal final ${name} is control rejected and keeps the old candidate`, async () => {
    const ports = reactivePorts({
      work: (request) =>
        request.requestId === "model-1" ? reactiveWork(request) : finalReply(request, mutate),
    });
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, now: () => 0 },
      portsOf(ports),
    );
    assert.equal(result.summary.modelCalls, 2);
    assert.equal(result.summary.reviewCalls, 0);
    assert.equal(result.summary.workUnits, 1);
    assert.equal(result.summary.stopReason, "CONTROL_REJECTED");
    assert.equal(result.summary.finalResponse, "4");
    assert.equal(result.summary.candidateVerified, false);
    const finalRequest = ports.requests[1]!;
    assert.equal(finalRequest.phase, "WORK");
    const finalBody = bodyOf(finalRequest);
    assert.equal(finalBody.allowFinal, true);
    const raw = result.privateState.requests[1] as { readonly receipt: { readonly text: string } };
    assert.equal(JSON.parse(raw.receipt.text).action, "final");
    assert.equal(result.privateState.artifacts.length, 1);
  });
}

test("first turn final is refused", async () => {
  const ports = reactivePorts({
    work: () => JSON.stringify({ action: "final", answer: "4", complete: true, unresolved: [] }),
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 0, now: () => 0 },
    portsOf(ports),
  );
  assert.equal(result.summary.modelCalls, 1);
  assert.equal(result.summary.status, "unsolved");
  assert.equal(result.summary.finalResponse, "Unsolved.");
  assert.equal(result.summary.stopReason, "CONTROL_REJECTED");
});
