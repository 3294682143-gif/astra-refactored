import { test } from "node:test";
import assert from "node:assert/strict";
import {
  P2Error,
  p4Hash,
  p4Target,
  type AgentModelRequest,
  type P2Artifact,
  type P2Contract,
  type P4Target,
} from "@astra/protocol";
import { P4ReviewSession } from "@astra/math-review";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  reactivePorts,
  reactiveTool,
  reactiveWork,
  reviewReply,
  type ReactivePorts,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";
const TOOL_ARGS = { expression: "(x+1)**2", variables: ["x"], parameters: [] };

function portsOf(ports: ReactivePorts) {
  return { model: ports.model, effect: ports.effect };
}

function toolReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "polynomial_expand_coefficients",
    args: TOOL_ARGS,
    scope: "expand the supplied polynomial",
  });
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user !== undefined);
  return JSON.parse(user.content) as Record<string, unknown>;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

test("model1 tool -> model2 work -> model3 second task -> model4 R2 keeps one root", async () => {
  let work = 0;
  const ports = reactivePorts({
    work: (request) => {
      work += 1;
      return work === 1 ? toolReply() : reactiveWork(request);
    },
  });
  const result = await runAgentLoop(PROBLEM, SESSION, { remainingMs: 5000, now: () => 0 }, portsOf(ports));
  assert.equal(result.summary.modelCalls, 4);
  assert.equal(result.summary.effectCalls, 1);
  assert.equal(result.summary.workUnits, 2);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(result.summary.stopReason, "REVIEWS_COMPLETE");
  assert.deepEqual(
    ports.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  assert.deepEqual(
    ports.requests.map((request) => request.phase),
    ["WORK", "WORK", "WORK", "R2"],
  );
  assert.equal(ports.effects.length, 1);
  assert.equal(ports.effects[0]!.binding.sourceRequestId, "model-1");
  const second = bodyOf(ports.requests[1]!);
  const observations = second.toolObservations as readonly { readonly effectId: string }[];
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.effectId, "effect-1");
  const third = bodyOf(ports.requests[2]!);
  assert.equal((third.toolObservations as readonly unknown[]).length, 0);
  const reviewBody = bodyOf(ports.requests[3]!);
  assert.equal(JSON.stringify(reviewBody).includes("toolObservations"), false);
  const session = result.privateState.session;
  assert.equal(session.modelCalls, 4);
  assert.equal(session.effectCalls, 1);
  assert.equal(session.stopped, true);
  assert.equal(session.pendingModel, null);
  assert.equal(session.pendingEffect, null);
  assert.deepEqual(
    session.events
      .filter((event) => event.kind === "MODEL" && event.state === "DISPATCHED")
      .map((event) => event.id),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  assert.equal(result.privateState.modelGate.length, 4);
  assert.equal(result.privateState.effects.length, 1);
  assert.equal(result.privateState.artifacts.length, 2);
  assert.equal(result.privateState.review?.records.length, 1);
  for (const obligation of result.privateState.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
});

test("three work units without tools keep real dependency refs and the first candidate", async () => {
  let work = 0;
  const ports = reactivePorts({
    work: (request) => {
      work += 1;
      return work === 1
        ? reactiveWork(request, { candidate: "4" })
        : reactiveWork(request, { candidate: "999" });
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 3, maxEffects: 0, now: () => 0 },
    portsOf(ports),
  );
  assert.equal(result.summary.modelCalls, 4);
  assert.equal(result.summary.effectCalls, 0);
  assert.equal(result.summary.workUnits, 3);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  assert.deepEqual(
    ports.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  const third = bodyOf(ports.requests[2]!);
  const task = third.task as { readonly inputArtifactRefs: readonly { readonly artifactId: string }[] };
  assert.equal(task.inputArtifactRefs.length, 2);
  const inputArtifacts = third.inputArtifacts as readonly { readonly artifactId: string }[];
  assert.equal(inputArtifacts.length, 2);
  assert.deepEqual(
    inputArtifacts.map((artifact) => artifact.artifactId),
    task.inputArtifactRefs.map((ref) => ref.artifactId),
  );
  assert.equal(result.privateState.artifacts.length, 3);
  assert.equal(result.privateState.decision.protectedCandidate?.artifactId, "artifact-1");
  assert.equal(result.privateState.decision.reason, "BEST_EFFORT_CANDIDATE");
});

test("STRICT withholds the same candidate that BEST_EFFORT returns", async () => {
  const best = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 3, maxWorkUnits: 2, maxEffects: 0, now: () => 0 },
    portsOf(reactivePorts()),
  );
  assert.equal(best.summary.status, "candidate");
  assert.equal(best.summary.finalResponse, "4");
  assert.equal(best.summary.reason, "BEST_EFFORT_CANDIDATE");
  assert.equal(best.summary.modelCalls, 3);
  assert.equal(best.summary.reviewCalls, 1);
  const strict = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 3, maxWorkUnits: 2, maxEffects: 0, policy: "STRICT", now: () => 0 },
    portsOf(reactivePorts()),
  );
  assert.equal(strict.summary.status, "unsolved");
  assert.equal(strict.summary.reason, "STRICT_NOT_VERIFIED");
  assert.equal(strict.summary.candidateVerified, false);
  assert.equal(strict.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(strict.summary.modelCalls, 3);
  assert.equal(strict.summary.reviewCalls, 1);
  assert.equal(strict.privateState.decision.submissionEligibility, "WITHHELD");
});

test("caps 0..4 and review 0..1 never exceed the root budget or fabricate a call", async () => {
  for (const cap of [0, 1, 2, 3, 4]) {
    for (const reviews of [0, 1]) {
      const ports = reactivePorts();
      const result = await runAgentLoop(
        PROBLEM,
        SESSION,
        { remainingMs: 5000, maxModelCalls: cap, maxReviews: reviews, now: () => 0 },
        portsOf(ports),
      );
      assert.ok(result.summary.modelCalls <= cap);
      assert.equal(result.summary.modelCalls, ports.requests.length);
      assert.equal(result.summary.modelCalls, result.privateState.modelGate.length);
      assert.equal(result.summary.modelCalls, result.privateState.session.modelCalls);
      assert.equal(result.summary.reviewCalls <= reviews, true);
      assert.equal(result.summary.candidateVerified, false);
      assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
      assert.equal(result.privateState.session.pendingModel, null);
      assert.equal(result.privateState.session.pendingEffect, null);
      for (const obligation of result.privateState.contract.obligations) {
        assert.notEqual(obligation.status, "SATISFIED");
      }
      if (cap === 0) {
        assert.equal(result.privateState.contract.tasks.every((row) => row.delivery === "READY"), true);
        assert.equal(result.summary.workUnits, 0);
      }
    }
  }
});

test("the last root review id is real and the default M4 session still refuses model-4", async () => {
  const ports = reactivePorts();
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 3, maxEffects: 0, now: () => 0 },
    portsOf(ports),
  );
  const last = ports.requests.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.phase, "R2");
  assert.equal(last.requestId, "model-4");
  const contract = result.privateState.contract as P2Contract;
  const entry = result.privateState.artifacts[0] as { readonly artifact: P2Artifact };
  const target: P4Target = p4Target(contract, entry.artifact, "ACTIVE");
  const legacy = new P4ReviewSession(contract, target);
  expectCode(() => legacy.admit("model-4", 1000), "PACKET_BINDING");
  const explicit = new P4ReviewSession(contract, target, 1, 4);
  assert.equal(explicit.admit("model-4", 1000).state, "ADMITTED");
  assert.equal(result.privateState.review?.records[0]?.requestId, "model-4");
  assert.equal(result.privateState.review?.records[0]?.code, "OK");
  assert.equal(result.privateState.review?.evidence[0]?.checkResult, "UNKNOWN");
  assert.equal(result.privateState.review?.evidence[0]?.level, "REVIEWED");
  assert.equal(result.privateState.review?.challenges.length, 0);
  const serialized = JSON.stringify(result.summary);
  assert.equal(serialized.includes("2+2=4"), false);
  assert.equal(serialized.includes(PROBLEM), false);
  assert.equal(p4Hash(PROBLEM).length, 64);
  assert.equal(reviewReply(ports.requests.at(-1)!).length > 0, true);
  assert.equal(reactiveTool().includes("polynomial_expand_coefficients"), true);
});
