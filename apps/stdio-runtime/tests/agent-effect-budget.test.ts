import { test } from "node:test";
import assert from "node:assert/strict";
import { P2Error, type AgentModelRequest, type P3EffectReceipt, type P3EffectRequest } from "@astra/protocol";
import {
  AGENT_MAX_EFFECTS,
  AGENT_MAX_EFFECT_OPTION,
  AGENT_MAX_METHOD_LOADS,
  AgentSession,
} from "@astra/runtime-core";
import { P3_MAX_EFFECTS } from "@astra/math-gateway";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  goodEffect,
  methodEffect,
  reactivePorts,
  reactiveTool,
  reactiveWork,
  syntheticCatalog,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";
const CATALOG = syntheticCatalog();

function methodReply(id = "method-0"): string {
  return JSON.stringify({ action: "method", id });
}

function linearToolReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "linear_system_solution_set",
    args: { expression: ["x+y-1", "x-y-1"], variables: ["x", "y"] },
    scope: "solve the supplied linear system",
  });
}

function realRootToolReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "real_root_count_expr",
    args: { expression: "x^3-3*x+1", variable: "x" },
    scope: "count distinct real roots",
  });
}

function effectReply(request: P3EffectRequest): P3EffectReceipt {
  return request.action.action === "method"
    ? methodEffect(request, CATALOG)
    : goodEffect(request);
}

async function runToolBudget(options: {
  readonly maxEffects: number;
  readonly maxMethodLoads: number;
  readonly replies: readonly ((request: AgentModelRequest) => string)[];
}) {
  let work = 0;
  const ports = reactivePorts({
    work: (request) => {
      const reply = options.replies[Math.min(work, options.replies.length - 1)]!;
      work += 1;
      return reply(request);
    },
    effect: effectReply,
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 8,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: options.maxEffects,
      maxMethodLoads: options.maxMethodLoads,
      now: () => 0,
    },
    { model: ports.model, effect: ports.effect, catalog: { async read() { return CATALOG; } } },
  );
  return { result, effects: ports.effects };
}

test("one method plus one tool runs under independent quotas", async () => {
  const run = await runToolBudget({
    maxEffects: 1,
    maxMethodLoads: 1,
    replies: [() => methodReply(), () => reactiveTool(), (request) => reactiveWork(request)],
  });
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.effectCalls, 2);
  assert.deepEqual(
    run.effects.map((request) => request.action.action),
    ["method", "tool"],
  );
  assert.equal(run.result.summary.status, "candidate");
});

test("the method load does not consume the single public tool slot", async () => {
  const run = await runToolBudget({
    maxEffects: 1,
    maxMethodLoads: 1,
    replies: [
      () => methodReply(),
      () => reactiveTool(),
      () => realRootToolReply(),
      (request) => reactiveWork(request),
    ],
  });
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.effectCalls, 2);
  assert.equal(run.effects.length, 2);
  assert.deepEqual(
    run.effects.map((request) => request.action.action),
    ["method", "tool"],
  );
  assert.equal(run.result.summary.stopReason, "CONTROL_REJECTED");
});

test("one method plus two tools runs when maxEffects=2 and the third tool is refused", async () => {
  const run = await runToolBudget({
    maxEffects: 2,
    maxMethodLoads: 1,
    replies: [
      () => methodReply(),
      () => reactiveTool(),
      () => linearToolReply(),
      () => realRootToolReply(),
      (request) => reactiveWork(request),
    ],
  });
  assert.equal(run.result.summary.methodLoads, 1);
  assert.equal(run.result.summary.effectCalls, 3);
  assert.deepEqual(
    run.effects.map((request) => request.action.action),
    ["method", "tool", "tool"],
  );
  assert.equal(run.result.summary.stopReason, "CONTROL_REJECTED");
});

test("the root effect table has the 4-method + 2-tool capacity", () => {
  assert.equal(AGENT_MAX_EFFECT_OPTION, 2);
  assert.equal(AGENT_MAX_METHOD_LOADS, 4);
  assert.equal(AGENT_MAX_EFFECTS, AGENT_MAX_EFFECT_OPTION + AGENT_MAX_METHOD_LOADS);
  assert.equal(P3_MAX_EFFECTS, AGENT_MAX_EFFECTS);
  const root = new AgentSession({
    sessionId: SESSION,
    problemHash: "0".repeat(64),
    maxModelCalls: 16,
    maxEffects: AGENT_MAX_EFFECTS,
    remainingMs: 5000,
    now: () => 0,
  });
  const shape = ["method", "method", "method", "method", "tool", "tool"] as const;
  for (let ordinal = 1; ordinal <= shape.length; ordinal += 1) {
    const modelId = `model-${ordinal}`;
    root.reserveModel("WORK");
    root.settleModel(modelId, "COMPLETE");
    const effectId = `effect-${ordinal}`;
    assert.equal(root.reserveEffect(effectId), effectId);
    root.settleEffect(effectId, "COMPLETE");
  }
  assert.throws(
    () => root.reserveEffect("effect-1"),
    (error: unknown) => error instanceof P2Error && error.code === "BUDGET_EXHAUSTED",
  );
  assert.equal(root.effectCalls(), shape.length);
});

test("maxMethodLoads=0 keeps the old run byte-identical", async () => {
  const replies = [
    () => reactiveTool(),
    (request: AgentModelRequest) => reactiveWork(request),
  ];
  const explicit = await runToolBudget({
    maxEffects: 1,
    maxMethodLoads: 0,
    replies,
  });
  const omitted = await (async () => {
    let work = 0;
    const ports = reactivePorts({
      work: (request) => {
        const reply = replies[Math.min(work, replies.length - 1)]!;
        work += 1;
        return reply(request);
      },
      effect: effectReply,
    });
    const result = await runAgentLoop(
      PROBLEM,
      SESSION,
      {
        remainingMs: 5000,
        maxModelCalls: 8,
        maxWorkUnits: 1,
        maxReviews: 0,
        maxEffects: 1,
        now: () => 0,
      },
      { model: ports.model, effect: ports.effect },
    );
    return { result, effects: ports.effects };
  })();
  assert.equal(JSON.stringify(explicit.result), JSON.stringify(omitted.result));
  assert.equal(explicit.effects.length, omitted.effects.length);
});
