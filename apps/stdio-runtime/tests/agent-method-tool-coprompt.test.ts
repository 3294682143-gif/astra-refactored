/**
 * Task 3: the immediate WORK turn after a method-card load is told, in the
 * same request, which registered tool the deterministic route names and what
 * its safe argument skeleton looks like. This is prompt-only: the request
 * ordinals, the effect count and the existing forced-tool fallback are
 * unchanged. A problem without a route must keep the pre-change prompt bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentModelRequest,
  P2MethodCatalog,
  P3EffectReceipt,
  P3EffectRequest,
} from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import { semanticToolRoute } from "../src/agent-semantics.js";
import {
  goodEffect,
  methodEffect,
  reactivePorts,
  reactiveWork,
  syntheticCatalog,
} from "./agent-loop-test-support.js";

const SESSION = "s";
const CATALOG = syntheticCatalog();
const METHOD_ROUTED_CATALOG: P2MethodCatalog = {
  version: "1.1.0",
  entries: CATALOG.entries.map((entry, index) =>
    index === 0 ? { ...entry, objects: ["equation"], structures: ["root"] } : entry,
  ),
};
const ROUTED_PROBLEM = "求方程 x^3-3x+1=0 的实根个数。";
const NO_ROUTE_PROBLEM = "Compute 2+2";
const ADVISORY_MARKER = "\n\nMETHOD+TOOL ADVISORY";

function methodReply(id = "method-0"): string {
  return JSON.stringify({ action: "method", id });
}

function routedToolReply(): string {
  const route = semanticToolRoute(ROUTED_PROBLEM);
  assert.ok(route !== null);
  return JSON.stringify({
    action: "tool",
    name: route.toolName,
    args: { expression: "x^3-3*x+1", variable: "x" },
    scope: "count the distinct real roots of the supplied polynomial",
  });
}

/** The protocol JSON prefix of a user message, with the advisory removed. */
function withoutAdvisory(request: AgentModelRequest): AgentModelRequest {
  const content = request.messages[1]!.content;
  const cut = content.indexOf(ADVISORY_MARKER);
  if (cut < 0) {
    return request;
  }
  return {
    ...request,
    messages: [request.messages[0]!, { role: "user", content: content.slice(0, cut) }],
  };
}

function userJson(request: AgentModelRequest): Record<string, unknown> {
  return JSON.parse(withoutAdvisory(request).messages[1]!.content) as Record<string, unknown>;
}

function eventOrder(result: Awaited<ReturnType<typeof runAgentLoop>>): string[] {
  const events = result.privateState.sessionLog?.events ?? [];
  const out: string[] = [];
  for (const event of events) {
    if (event.kind === "METHOD_LOAD" || event.kind === "TOOL_OBSERVATION") {
      out.push(event.kind);
      continue;
    }
    const row = event.data as Record<string, unknown>;
    if (event.kind === "REPAIR" && row["kind"] === "METHOD_ROUTE") {
      out.push("METHOD_ROUTE");
    } else if (event.kind === "REPAIR" && row["kind"] === "TOOL_ROUTE") {
      out.push("TOOL_ROUTE");
    }
  }
  return out;
}

async function run(options: {
  readonly problem: string;
  readonly work: (request: AgentModelRequest) => string;
  readonly maxModelCalls: number;
  readonly catalog?: P2MethodCatalog;
}) {
  const activeCatalog = options.catalog ?? CATALOG;
  const ports = reactivePorts({
    work: options.work,
    effect: (request: P3EffectRequest): P3EffectReceipt =>
      request.action.action === "method"
        ? methodEffect(request, activeCatalog)
        : goodEffect(request),
  });
  const result = await runAgentLoop(
    options.problem,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: options.maxModelCalls,
      maxWorkUnits: 1,
      maxEffects: 1,
      maxReviews: 0,
      maxMethodLoads: 1,
      maxConsensus: 1,
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      catalog: { async read() { return activeCatalog; } },
    },
  );
  return { result, requests: ports.requests, effects: ports.effects };
}

test("the post-card WORK turn names the routed tool and its exact args skeleton", async () => {
  const route = semanticToolRoute(ROUTED_PROBLEM);
  assert.ok(route !== null);
  assert.equal(route.toolName, "real_root_count_expr");

  let toolSubmitted = false;
  const runResult = await run({
    problem: ROUTED_PROBLEM,
    maxModelCalls: 4,
    catalog: METHOD_ROUTED_CATALOG,
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes("METHOD SELECTION TURN")) {
        return methodReply();
      }
      if (!toolSubmitted && request.messages[1]!.content.includes(ADVISORY_MARKER)) {
        toolSubmitted = true;
        return routedToolReply();
      }
      return reactiveWork(withoutAdvisory(request));
    },
  });

  assert.deepEqual(
    runResult.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4"],
  );
  const postCard = runResult.requests[2]!;
  const content = postCard.messages[1]!.content;
  const markerAt = content.indexOf(ADVISORY_MARKER);
  assert.ok(markerAt > 0);
  const block = content.slice(markerAt);
  assert.match(block, /method-0/u);
  assert.match(block, /real_root_count_expr/u);
  assert.ok(block.includes(route.argsTemplate));
  assert.match(block, /quoted JSON strings/u);
  assert.match(block, /PROGRAM_OBSERVATION/u);
  assert.match(block, /complete WorkPacket/u);
  assert.ok([...block].length <= 600);

  const toolEffects = runResult.effects.filter((effect) => effect.action.action === "tool");
  assert.equal(toolEffects.length, 1);
  assert.equal(toolEffects[0]!.action.action, "tool");
  assert.equal(toolEffects[0]!.action.action === "tool" ? toolEffects[0]!.action.name : null, route.toolName);
  assert.equal(runResult.result.summary.effectCalls, 2);
  assert.equal(runResult.result.summary.methodLoads, 1);
  assert.equal(runResult.result.summary.status, "candidate");
  assert.deepEqual(eventOrder(runResult.result), [
    "METHOD_ROUTE",
    "METHOD_LOAD",
    "TOOL_OBSERVATION",
  ]);
});

test("a routed problem with a card loaded still falls back to the forced tool turn", async () => {
  const runResult = await run({
    problem: ROUTED_PROBLEM,
    maxModelCalls: 5,
    catalog: METHOD_ROUTED_CATALOG,
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes("METHOD SELECTION TURN")) {
        return methodReply();
      }
      if (system.includes("SEMANTIC TOOL TURN")) {
        return routedToolReply();
      }
      // The post-card packet ignores the advisory on purpose.
      return reactiveWork(withoutAdvisory(request));
    },
  });

  assert.deepEqual(
    runResult.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3", "model-4", "model-5"],
  );
  assert.ok(runResult.requests[2]!.messages[1]!.content.includes(ADVISORY_MARKER));
  assert.deepEqual(eventOrder(runResult.result), [
    "METHOD_ROUTE",
    "METHOD_LOAD",
    "TOOL_ROUTE",
    "TOOL_OBSERVATION",
  ]);
  const toolEffects = runResult.effects.filter((effect) => effect.action.action === "tool");
  assert.equal(toolEffects.length, 1);
  assert.equal(runResult.result.summary.methodLoads, 1);
  assert.equal(runResult.result.summary.status, "candidate");
});

test("a problem without a tool route keeps the post-card prompt byte-identical", async () => {
  assert.equal(semanticToolRoute(NO_ROUTE_PROBLEM), null);
  const runResult = await run({
    problem: NO_ROUTE_PROBLEM,
    maxModelCalls: 3,
    work: (request) =>
      request.messages[0]!.content.includes("METHOD SELECTION TURN")
        ? methodReply()
        : reactiveWork(withoutAdvisory(request)),
  });

  assert.deepEqual(
    runResult.requests.map((request) => request.requestId),
    ["model-1", "model-2", "model-3"],
  );
  const postCard = runResult.requests[2]!;
  const content = postCard.messages[1]!.content;
  assert.doesNotMatch(content, /METHOD\+TOOL ADVISORY/u);
  // Exactly the builder's own JSON serialization: no appended text remains.
  const body = userJson(postCard);
  assert.equal(content, JSON.stringify(body));
  assert.equal((body["methodAssets"] as readonly unknown[]).length, 1);
  assert.equal(runResult.result.summary.methodLoads, 1);
  assert.equal(runResult.result.summary.effectCalls, 1);
  assert.equal(runResult.result.summary.status, "candidate");
});
