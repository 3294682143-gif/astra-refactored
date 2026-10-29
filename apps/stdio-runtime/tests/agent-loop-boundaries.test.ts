/**
 * Unified AgentLoop boundary tests: port faults, R2 faults, tool admission and
 * the global effect ceiling. Real async ports only; no prefilled receipts, no
 * fixture, no new mathematical mechanism. Nothing here is acceptance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  p4Hash,
  type AgentModelReceipt,
  type AgentModelRequest,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
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

function portsOf(ports: ReactivePorts) {
  return { model: ports.model, effect: ports.effect };
}

function bodyOf(request: AgentModelRequest): Record<string, unknown> {
  const user = request.messages[1];
  assert.ok(user !== undefined);
  return JSON.parse(user.content) as Record<string, unknown>;
}

/** A model port whose first WORK reply is produced by `first`. */
function faultPorts(first: (request: AgentModelRequest) => Promise<AgentModelReceipt>): ReactivePorts {
  const base = reactivePorts();
  let seen = 0;
  return {
    requests: base.requests,
    effects: base.effects,
    model: {
      async generate(request: AgentModelRequest): Promise<AgentModelReceipt> {
        base.requests.push(request);
        seen += 1;
        if (seen === 1) {
          return first(request);
        }
        return { transportStatus: "COMPLETE", text: reactiveWork(request) };
      },
    },
    effect: base.effect,
  };
}

test("a first WORK port fault stops the root with one call and no effect or unit", async () => {
  const cases: readonly ((request: AgentModelRequest) => Promise<AgentModelReceipt>)[] = [
    async () => {
      throw new Error("provider exploded: secret-token");
    },
    async () => Promise.reject(new Error("rejected: secret-token")),
    async () => ({ transportStatus: "COMPLETE", text: "{}", extra: 1 } as unknown as AgentModelReceipt),
    async () => ({ transportStatus: "TRUNCATED", text: "{}" }),
    async () => ({ transportStatus: "ERROR", text: "{}" }),
    async () => ({ transportStatus: "UNKNOWN", text: "{}" }),
  ];
  for (const first of cases) {
    const ports = faultPorts(first);
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      { remainingMs: 5000, now: () => 0 },
      portsOf(ports),
    );
    assert.equal(result.summary.status, "unsolved");
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.summary.modelCalls, 1);
    assert.equal(result.summary.effectCalls, 0);
    assert.equal(result.summary.workUnits, 0);
    assert.equal(result.summary.reviewCalls, 0);
    assert.equal(ports.requests.length, 1);
    assert.equal(ports.effects.length, 0);
    assert.equal(result.privateState.session.pendingModel, null);
    assert.equal(result.privateState.session.pendingEffect, null);
    assert.equal(result.privateState.session.stopped, true);
    const last = result.privateState.modelGate.at(-1) as { readonly state: string };
    assert.ok(last.state === "OUTCOME_UNKNOWN" || last.state === "RETURNED");
    assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
    assert.equal(JSON.stringify(result.privateState.session).includes("secret-token"), false);
  }
});

test("an R2 fault leaves the review record settled and the evidence UNKNOWN", async () => {
  const cases: readonly ((request: AgentModelRequest) => Promise<AgentModelReceipt>)[] = [
    async () => {
      throw new Error("review exploded: secret-token");
    },
    async () => ({ transportStatus: "TRUNCATED", text: "{}" }),
    async () => ({ transportStatus: "ERROR", text: "{}" }),
    async () => ({ transportStatus: "UNKNOWN", text: "{}" }),
    async () => ({ transportStatus: "COMPLETE", text: "not json" }),
  ];
  for (const review of cases) {
    const base = reactivePorts();
    const ports: ReactivePorts = {
      requests: base.requests,
      effects: base.effects,
      model: {
        async generate(request: AgentModelRequest): Promise<AgentModelReceipt> {
          base.requests.push(request);
          if (request.phase === "R2") {
            return review(request);
          }
          return { transportStatus: "COMPLETE", text: reactiveWork(request) };
        },
      },
      effect: base.effect,
    };
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      { remainingMs: 5000, maxModelCalls: 3, maxWorkUnits: 2, maxEffects: 0, now: () => 0 },
      portsOf(ports),
    );
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
    assert.equal(result.summary.modelCalls, 3);
    assert.equal(result.summary.reviewCalls, 1);
    assert.equal(ports.requests.filter((request) => request.phase === "R2").length, 1);
    const reviewState = result.privateState.review;
    assert.ok(reviewState !== null);
    assert.equal(reviewState.records.length, 1);
    assert.notEqual(reviewState.records[0]!.state, "DISPATCHED");
    for (const row of reviewState.evidence) {
      assert.equal(row.checkResult, "UNKNOWN");
      assert.notEqual(row.level, "CHECKED_SCOPE");
    }
    assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
  }
});

test("a tool is refused when no follow-up model call remains", async () => {
  const ports = reactivePorts({ work: () => reactiveTool() });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 2, maxWorkUnits: 2, maxEffects: 1, maxReviews: 1, now: () => 0 },
    portsOf(ports),
  );
  assert.equal(result.summary.effectCalls, 0);
  assert.equal(ports.effects.length, 0);
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.status, "unsolved");
  assert.equal(result.privateState.session.pendingEffect, null);
});

test("a bad effect receipt stops the root after exactly one call and one effect", async () => {
  const cases: readonly ((request: P3EffectRequest) => Promise<P3EffectReceipt>)[] = [
    async () => {
      throw new Error("effect exploded: secret-token");
    },
    async (request) => ({
      effectId: request.effectId,
      binding: { ...request.binding, taskId: "other" },
      status: "COMPLETE",
      source: "PROGRAM_OBSERVATION",
      observation: "{}",
      observationHash: p4Hash("{}"),
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
    }),
    async (request) => ({
      effectId: request.effectId,
      binding: request.binding,
      status: "COMPLETE",
      source: "PROGRAM_OBSERVATION",
      observation: "{}",
      observationHash: "0".repeat(64),
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
    }),
    async (request) => ({
      effectId: request.effectId,
      binding: request.binding,
      status: "UNKNOWN",
      source: "PROGRAM_OBSERVATION",
      observation: "{}",
      observationHash: p4Hash("{}"),
      level: "PROVISIONAL",
      checkResult: "UNKNOWN",
    }),
  ];
  for (const effect of cases) {
    let work = 0;
    const base = reactivePorts({
      work: (request) => {
        work += 1;
        return work === 1 ? reactiveTool() : reactiveWork(request);
      },
    });
    const ports: ReactivePorts = {
      requests: base.requests,
      effects: base.effects,
      model: base.model,
      effect: {
        async execute(request: P3EffectRequest): Promise<P3EffectReceipt> {
          base.effects.push(request);
          return effect(request);
        },
      },
    };
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      { remainingMs: 5000, now: () => 0 },
      portsOf(ports),
    );
    assert.equal(result.summary.modelCalls, 1);
    assert.equal(result.summary.effectCalls, 1);
    assert.equal(ports.requests.length, 1);
    assert.equal(ports.effects.length, 1);
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.privateState.session.pendingModel, null);
    assert.equal(result.privateState.session.pendingEffect, null);
    assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
  }
});

test("two effects across two tasks share one global ceiling and never reset per task", async () => {
  let work = 0;
  const ports = reactivePorts({
    work: (request) => {
      work += 1;
      return work === 1 || work === 3 ? reactiveTool() : reactiveWork(request);
    },
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 2, maxReviews: 0, now: () => 0 },
    portsOf(ports),
  );
  assert.equal(result.summary.effectCalls, 2);
  assert.equal(ports.effects.length, 2);
  assert.deepEqual(
    ports.effects.map((request) => request.effectId),
    ["effect-1", "effect-2"],
  );
  assert.notEqual(ports.effects[0]!.binding.taskId, ports.effects[1]!.binding.taskId);
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.session.pendingEffect, null);

  let capped = 0;
  const cappedPorts = reactivePorts({
    work: (request) => {
      capped += 1;
      return capped === 1 || capped === 3 ? reactiveTool() : reactiveWork(request);
    },
  });
  const cappedResult = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 5000, maxModelCalls: 4, maxWorkUnits: 2, maxEffects: 1, maxReviews: 0, now: () => 0 },
    portsOf(cappedPorts),
  );
  assert.equal(cappedResult.summary.effectCalls, 1);
  assert.equal(cappedPorts.effects.length, 1);
  assert.equal(cappedResult.summary.candidateVerified, false);
});

test("a raw model reply with bad Unicode or an oversized body never dispatches a tool", async () => {
  const cases: readonly string[] = [
    JSON.stringify({ action: "tool", name: "polynomial_expand_coefficients", args: { expression: "\ud800" }, scope: "x" }),
    JSON.stringify({ action: "tool", name: "polynomial_expand_coefficients", args: { expression: "x".repeat(20000) }, scope: "x" }),
  ];
  for (const text of cases) {
    const ports = reactivePorts({ work: () => text });
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      { remainingMs: 5000, now: () => 0 },
      portsOf(ports),
    );
    assert.equal(result.summary.effectCalls, 0);
    assert.equal(ports.effects.length, 0);
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.privateState.session.pendingEffect, null);
  }
});
