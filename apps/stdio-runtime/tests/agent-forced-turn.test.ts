import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentModelRequest, P3EffectReceipt, P3EffectRequest } from "@astra/protocol";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  goodEffect,
  methodEffect,
  reactivePorts,
  reactiveWork,
  syntheticCatalog,
} from "./agent-loop-test-support.js";

const SESSION = "s";
const CATALOG = syntheticCatalog();

function methodReply(id = "method-0"): string {
  return JSON.stringify({ action: "method", id });
}

function exactReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "exact_check_expr",
    args: {
      operation: "MAXIMAL_MINORS",
      matrix: [["t", "0"], ["0", "t-1"]],
      variable: "t",
    },
    scope: "maximal minors of the supplied matrix",
  });
}

function realRootReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "real_root_count_expr",
    args: { expression: "x^3-3*x+1", variable: "x" },
    scope: "count distinct real roots of the supplied polynomial",
  });
}

function enumerationReply(): string {
  return JSON.stringify({
    action: "tool",
    name: "bounded_enumeration",
    args: { ranges: [2, 2], choose: 2, predicate: "distinct(0)" },
    scope: "enumerate the two-item sample space",
  });
}

async function runForced(options: {
  readonly problem: string;
  readonly prompt: string;
  readonly reply: (turn: number, request: AgentModelRequest) => string;
  readonly maxEffects?: number;
  readonly maxMethodLoads?: number;
  readonly effect?: (request: P3EffectRequest) => P3EffectReceipt;
}) {
  let turns = 0;
  const ports = reactivePorts({
    work: (request) => {
      const system = request.messages[0]!.content;
      if (system.includes(options.prompt)) {
        turns += 1;
        return options.reply(turns, request);
      }
      return reactiveWork(request);
    },
    effect:
      options.effect ??
      ((request) =>
        request.action.action === "method"
          ? methodEffect(request, CATALOG)
          : goodEffect(request)),
  });
  const result = await runAgentLoop(
    options.problem,
    SESSION,
    {
      remainingMs: 5000,
      maxModelCalls: 12,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: options.maxEffects ?? 1,
      maxMethodLoads: options.maxMethodLoads ?? 0,
      maxConsensus: 1,
      now: () => 0,
    },
    {
      model: ports.model,
      effect: ports.effect,
      ...(options.maxMethodLoads === 1
        ? { catalog: { async read() { return CATALOG; } } }
        : {}),
    },
  );
  return { result, effects: ports.effects, requests: ports.requests, turns };
}

function eventData(result: Awaited<ReturnType<typeof runAgentLoop>>, kind: string) {
  return (result.privateState.sessionLog?.events ?? [])
    .filter((event) => event.kind === kind)
    .map((event) => event.data);
}

test("forced exact-check: first refusal -> one retry -> valid tool action", async () => {
  const run = await runForced({
    problem: "计算给定矩阵的亚历山大多项式 P(t)。",
    prompt: "EXACT CHECK TURN",
    reply: (turn, request) => (turn === 1 ? reactiveWork(request) : exactReply()),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]?.action.action, "tool");
  const routes = eventData(run.result, "REPAIR").filter((row) => row["kind"] === "TOOL_ROUTE");
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.["toolName"], "exact_check_expr");
  assert.equal(routes[0]?.["operation"], "MAXIMAL_MINORS");
  assert.equal(routes[0]?.["routeId"], "EXACT_MAXIMAL_MINORS");
  const observations = eventData(run.result, "TOOL_OBSERVATION");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.["toolName"], "exact_check_expr");
  assert.equal(observations[0]?.["operation"], "MAXIMAL_MINORS");
  assert.equal(observations[0]?.["forced"], true);
  assert.equal(observations[0]?.["routeId"], "EXACT_MAXIMAL_MINORS");
});

test("forced definite-integral check names the lower and upper JSON-string arguments", async () => {
  const run = await runForced({
    problem: "计算定积分 ∫_0^1 x^2 dx。",
    prompt: "EXACT CHECK TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("EXACT CHECK TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  assert.match(prompt, /DEFINITE_INTEGRAL/u);
  assert.match(prompt, /expression: <the integrand as a JSON string>/u);
  assert.match(prompt, /lower: <the lower bound as a JSON string>/u);
  assert.match(prompt, /upper: <the upper bound as a JSON string>/u);
});

test("forced exact-check keeps the LIMIT point argument", async () => {
  const run = await runForced({
    problem: "求极限 lim_{x->0} sin(x)/x。",
    prompt: "EXACT CHECK TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("EXACT CHECK TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  assert.match(prompt, /operation":"LIMIT/u);
  assert.match(prompt, /point: <the limit point>/u);
  assert.doesNotMatch(prompt, /lower: <the lower bound/u);
});

test("forced exact-check: persistent refusal stops after exactly one retry and invents no receipt", async () => {
  const run = await runForced({
    problem: "计算给定矩阵的亚历山大多项式 P(t)。",
    prompt: "EXACT CHECK TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 0);
  assert.deepEqual(eventData(run.result, "TOOL_OBSERVATION"), []);
  assert.equal(run.result.summary.status, "candidate");
  const retries = eventData(run.result, "REPAIR").filter(
    (row) => row["kind"] === "FORCED_TURN_RETRY",
  );
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.["attempt"], 1);
});

test("forced enumeration: first refusal -> one retry -> valid tool action", async () => {
  const run = await runForced({
    problem: "从袋中随机抽取两个球，求概率。",
    prompt: "FINITE ENUMERATION TURN",
    reply: (turn, request) => (turn === 1 ? reactiveWork(request) : enumerationReply()),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]?.action.action, "tool");
  const routes = eventData(run.result, "REPAIR").filter((row) => row["kind"] === "TOOL_ROUTE");
  assert.equal(routes[0]?.["routeId"], "FINITE_ENUMERATION");
});

test("forced method: first refusal -> one retry -> a real method action", async () => {
  const run = await runForced({
    problem: "Compute 2+2",
    prompt: "METHOD SELECTION TURN",
    maxMethodLoads: 1,
    reply: (turn, request) => (turn === 1 ? reactiveWork(request) : methodReply()),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]?.action.action, "method");
  const methods = eventData(run.result, "METHOD_LOAD");
  assert.equal(methods.length, 1);
  assert.equal(methods[0]?.["methodId"], "method-0");
  assert.deepEqual(eventData(run.result, "TOOL_OBSERVATION"), []);
});

test("forced method: persistent refusal stops after one retry without a fabricated load", async () => {
  const run = await runForced({
    problem: "Compute 2+2",
    prompt: "METHOD SELECTION TURN",
    maxMethodLoads: 1,
    reply: (_turn, request) => reactiveWork(request),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 0);
  assert.deepEqual(eventData(run.result, "METHOD_LOAD"), []);
  assert.equal(run.result.summary.status, "candidate");
});

test("a new semantic route accepts its exact tool and records the route fields", async () => {
  const run = await runForced({
    problem: "求方程 x^3-3x+1=0 的实根个数。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (turn, request) => (turn === 1 ? reactiveWork(request) : realRootReply()),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]?.action.action, "tool");
  const observations = eventData(run.result, "TOOL_OBSERVATION");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.["toolName"], "real_root_count_expr");
  assert.equal(observations[0]?.["operation"], "REAL_ROOT_COUNT");
  assert.equal(observations[0]?.["forced"], true);
  assert.equal(observations[0]?.["routeId"], "REAL_ROOT_COUNT");
});

test("the new semantic tool prompt names the exact tool and a safe argument template", async () => {
  const run = await runForced({
    problem: "求方程 x^3-3x+1=0 的实根个数。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 0);
  const routes = eventData(run.result, "REPAIR").filter((row) => row["kind"] === "TOOL_ROUTE");
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.["toolName"], "real_root_count_expr");
  assert.equal(routes[0]?.["operation"], "REAL_ROOT_COUNT");
  assert.equal(routes[0]?.["routeId"], "REAL_ROOT_COUNT");
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("SEMANTIC TOOL TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  assert.match(prompt, /real_root_count_expr/u);
  assert.match(prompt, /REAL_ROOT_COUNT/u);
  assert.match(prompt, /"expression":"<explicit univariate polynomial>"/u);
});

test("a wrong tool after fail-open is not recorded as the forced route", async () => {
  const run = await runForced({
    problem: "求方程 x^3-3x+1=0 的实根个数。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (turn, request) => (turn === 1 ? reactiveWork(request) : exactReply()),
  });
  assert.equal(run.turns, 2);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0]?.action.action, "tool");
  assert.equal(run.effects[0]?.action.name, "exact_check_expr");
  const observations = eventData(run.result, "TOOL_OBSERVATION");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.["forced"], false);
  assert.equal(observations[0]?.["routeId"], null);
});

test("forced semantic Diophantine turn carries integer constraints, not the quote-all blanket", async () => {
  const run = await runForced({
    problem: "求丢番图方程 x^2+y^2=5 的整数解。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("SEMANTIC TOOL TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  assert.match(prompt, /solve_quadratic_diophantine/u);
  assert.match(prompt, /JSON integers with \|coeff\|<=32 and a!=0/u);
  assert.match(prompt, /do not quote numbers/u);
  assert.doesNotMatch(
    prompt,
    /Every expression and matrix entry must be a quoted JSON string/u,
  );
});

test("forced semantic GF(2) rank turn does not ask for quoted rows", async () => {
  const run = await runForced({
    problem: "计算 GF(2) 上矩阵的秩。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("SEMANTIC TOOL TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  const semanticNote = prompt.slice(prompt.lastIndexOf("\n\nSEMANTIC TOOL TURN"));
  assert.match(semanticNote, /"name":"gf2_rank"/u);
  assert.match(semanticNote, /non-negative JSON integers encoding binary rows/u);
  assert.match(semanticNote, /do not pass width or strings/u);
  assert.doesNotMatch(semanticNote, /quoted JSON string/u);
});

test("forced semantic GF(2) nullspace turn asks for an integer width", async () => {
  const run = await runForced({
    problem: "求 GF(2) 上矩阵的零空间。",
    prompt: "SEMANTIC TOOL TURN",
    reply: (_turn, request) => reactiveWork(request),
  });
  const forcedRequest = run.requests.find((request) =>
    request.messages[0]!.content.includes("SEMANTIC TOOL TURN"),
  );
  assert.ok(forcedRequest !== undefined);
  const prompt = forcedRequest.messages[0]!.content;
  const semanticNote = prompt.slice(prompt.lastIndexOf("\n\nSEMANTIC TOOL TURN"));
  assert.match(semanticNote, /"name":"gf2_nullspace"/u);
  assert.match(semanticNote, /integer width \(1\.\.8\)/u);
  assert.match(semanticNote, /do not quote integers/u);
  assert.doesNotMatch(semanticNote, /quoted JSON string/u);
});
