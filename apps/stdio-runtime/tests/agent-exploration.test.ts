/**
 * Stage D+ — the one controlled P3 `explore` action on the TS side.
 *
 * Three layers are covered without a provider, a WASI runtime or a child
 * process:
 *
 * * the strict action shape (`parseP3Action`) and the tool/method/exploration
 *   receipt pairing (`p3EffectRequest` / `p3EffectReceipt`);
 * * the default path: with no capability the `explore` reply is treated exactly
 *   like an unparseable one, so no effect is dispatched and the run is
 *   unchanged; with `AVAILABLE_BOUNDED` exactly one bounded exploration is
 *   dispatched, recorded as `generated_exploration` and shown to the model;
 * * the two gates that keep it bounded: one tool-kind effect slot (a second
 *   exploration is refused) and the answer closure, which can never turn a
 *   generated observation into a defect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_HOST_VERSION,
  P2Error,
  p4Hash,
  type AgentModelRequest,
  type JsonRpcMessage,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { parseP3Action, p3EffectReceipt, p3EffectRequest } from "@astra/math-gateway";
import { validateAgentHostManifest, type AgentHostManifest } from "@astra/protocol";
import { AgentHostFlow, type AgentHostIo } from "../src/agent-host-flow.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { answerClosureDefects } from "../src/agent-answer-closure.js";
import { reactivePorts, reactiveWork } from "./agent-loop-test-support.js";

const SOURCE = new URL(
  "../../../../packages/protocol/schema/agent-host-v13.schema.json",
  import.meta.url,
);
const MANIFEST = validateAgentHostManifest(
  JSON.parse(readFileSync(SOURCE, "utf8")) as unknown,
) as AgentHostManifest;

const PROBLEM = "Compute 2+2";
const SESSION = "s-explore";
const CODE = "print(sum(i for i in range(10)))";
const EXPLORATION = "generated_exploration";

function exploreReply(code = CODE, scope = "sum the first ten integers"): string {
  return JSON.stringify({ action: "explore", code, scope });
}

/** One COMPLETE GENERATED_OBSERVATION receipt bound to the request it answers. */
function explorationReceipt(request: P3EffectRequest): P3EffectReceipt {
  const observation = JSON.stringify({
    kind: "BOUNDED_OBSERVATION",
    interpretation: "BOUNDED_OBSERVATION_NOT_PROOF",
    status: "ok",
    result: { output: "45\n", truncated: false },
  });
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "GENERATED_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "OBSERVED",
    checkResult: "UNKNOWN",
  };
}

async function runExploration(options: {
  readonly replies: readonly ((request: AgentModelRequest) => string)[];
  readonly allowExploration?: boolean;
  readonly maxEffects?: number;
}) {
  let work = 0;
  const ports = reactivePorts({
    work: (request) => {
      const reply = options.replies[Math.min(work, options.replies.length - 1)]!;
      work += 1;
      return reply(request);
    },
    effect: explorationReceipt,
  });
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 8000,
      maxModelCalls: 8,
      maxWorkUnits: 1,
      maxReviews: 0,
      maxEffects: options.maxEffects ?? 2,
      maxMethodLoads: 0,
      now: () => 0,
      ...(options.allowExploration === undefined
        ? {}
        : { allowExploration: options.allowExploration }),
    },
    { model: ports.model, effect: ports.effect, catalog: null },
  );
  return { result, effects: ports.effects, requests: ports.requests };
}

// -- the action shape ------------------------------------------------------

test("the strict parser accepts exactly one explore shape", () => {
  const action = parseP3Action(exploreReply());
  assert.deepEqual(action, {
    action: "explore",
    code: CODE,
    scope: "sum the first ten integers",
  });
  // It is not a tool, so it can never satisfy a tool-gated checker.
  assert.notEqual(action.action, "tool");
});

test("the strict parser refuses every malformed explore shape", () => {
  const cases = [
    // overlong source: more than 65536 UTF-8 bytes
    JSON.stringify({ action: "explore", code: "x".repeat(65537), scope: "s" }),
    // empty / blank scope and empty code
    JSON.stringify({ action: "explore", code: CODE, scope: "" }),
    JSON.stringify({ action: "explore", code: "", scope: "s" }),
    JSON.stringify({ action: "explore", code: "  ", scope: "s" }),
    // overlong scope: more than 256 code points
    JSON.stringify({ action: "explore", code: CODE, scope: "s".repeat(257) }),
    // extra / missing keys
    JSON.stringify({ action: "explore", code: CODE, scope: "s", extra: 1 }),
    JSON.stringify({ action: "explore", code: CODE }),
    JSON.stringify({ action: "explore", scope: "s" }),
    // wrong types
    JSON.stringify({ action: "explore", code: 1, scope: "s" }),
    JSON.stringify({ action: "explore", code: CODE, scope: 1 }),
    JSON.stringify({ action: "explore", code: [CODE], scope: "s" }),
  ];
  for (const text of cases) {
    assert.throws(() => parseP3Action(text), P2Error, text.slice(0, 60));
  }
});

test("the effect contract keeps the three receipt pairings disjoint", () => {
  const binding = {
    sessionId: SESSION,
    problemHash: p4Hash(PROBLEM),
    contractVersion: 1,
    taskId: "task-1",
    scopeId: p4Hash("scope"),
    sourceRequestId: "model-1",
  };
  const request = p3EffectRequest({
    effectId: "effect-1",
    binding,
    action: { action: "explore", code: CODE, scope: "s" },
    remainingMs: 1000,
  });
  const receipt = p3EffectReceipt(explorationReceipt(request), request);
  assert.equal(receipt.source, "GENERATED_OBSERVATION");
  assert.equal(receipt.level, "OBSERVED");
  assert.equal(receipt.checkResult, "UNKNOWN");
  // A generated observation can never be re-labelled as a program observation.
  assert.throws(
    () =>
      p3EffectReceipt(
        { ...explorationReceipt(request), source: "PROGRAM_OBSERVATION" } as unknown,
        request,
      ),
    P2Error,
  );
  assert.throws(
    () =>
      p3EffectReceipt(
        { ...explorationReceipt(request), level: "PROVISIONAL" } as unknown,
        request,
      ),
    P2Error,
  );
});

// -- the default path ------------------------------------------------------

test("without the capability an explore reply dispatches no effect", async () => {
  const run = await runExploration({
    replies: [() => exploreReply(), (request) => reactiveWork(request)],
  });
  assert.deepEqual(run.effects, []);
  assert.equal(run.result.summary.effectCalls, 0);
  // The exploration action word never reaches the logged effect vocabulary.
  const events = run.result.privateState.sessionLog?.events ?? [];
  const toolRows = events.filter((row) => row.kind === "TOOL_OBSERVATION");
  assert.deepEqual(toolRows, []);
});

test("an explicit allowExploration:false is byte-identical to omitting it", async () => {
  const replies = [
    () => exploreReply(),
    (request: AgentModelRequest) => reactiveWork(request),
  ];
  const absent = await runExploration({ replies });
  const disabled = await runExploration({ replies, allowExploration: false });
  assert.deepEqual(disabled.result.summary, absent.result.summary);
  assert.deepEqual(
    disabled.result.privateState.sessionLog?.events,
    absent.result.privateState.sessionLog?.events,
  );
  assert.deepEqual(disabled.effects, []);
});

// -- the admitted path -----------------------------------------------------

test("one admitted exploration is visible, bounded and spends one tool slot", async () => {
  const run = await runExploration({
    allowExploration: true,
    replies: [() => exploreReply(), (request) => reactiveWork(request)],
  });
  assert.equal(run.effects.length, 1);
  const dispatched = run.effects[0]!;
  assert.equal(dispatched.action.action, "explore");
  assert.equal(dispatched.effectId, "effect-1");
  assert.equal(run.result.summary.effectCalls, 1);
  assert.equal(run.result.summary.status, "candidate");

  const events = run.result.privateState.sessionLog?.events ?? [];
  const toolRows = events.filter((row) => row.kind === "TOOL_OBSERVATION");
  assert.equal(toolRows.length, 1);
  const data = toolRows[0]!.data as Record<string, unknown>;
  assert.equal(data.toolName, EXPLORATION);
  assert.equal(data.source, "GENERATED_OBSERVATION");
  assert.equal(data.level, "OBSERVED");
  assert.equal(data.checkResult, "UNKNOWN");

  // The next WORK turn sees the exploration receipt as data, tagged untrusted.
  const second = run.requests[1];
  assert.ok(second !== undefined, "a second work turn followed the exploration");
  const payload = JSON.parse(second.messages[1]!.content) as {
    toolObservations?: readonly { source: string; level: string }[];
  };
  assert.deepEqual(
    (payload.toolObservations ?? []).map((row) => [row.source, row.level]),
    [["GENERATED_OBSERVATION", "OBSERVED"]],
  );
});

test("a second exploration beyond the effect capacity is refused", async () => {
  const run = await runExploration({
    allowExploration: true,
    maxEffects: 1,
    replies: [() => exploreReply(), (request) => reactiveWork(request)],
  });
  assert.match(run.requests[0]!.messages[0]!.content, /BOUNDED EXPLORATION AVAILABLE/u);
  const second = await runExploration({
    allowExploration: true,
    maxEffects: 1,
    replies: [
      () => exploreReply(),
      () => exploreReply(),
      (request) => reactiveWork(request),
    ],
  });
  assert.equal(second.effects.length, 1);
  assert.equal(second.result.summary.effectCalls, 1);
  assert.equal(second.result.summary.stopReason, "CONTROL_REJECTED");
});

test("a failed exploration never becomes a defect or a certificate", () => {
  // The closure looks an observation up by registered tool name. The recorded
  // exploration identity is not one, so a "perfect" generated number can never
  // contradict (or confirm) the candidate.
  const problem = "求方程 x^3-3x+1=0 的实根个数。";
  const observations = [
    { name: "real_root_count_expr", operation: "REAL_ROOT_COUNT", result: 3 },
  ];
  const toolDefect = answerClosureDefects({
    problemText: problem,
    candidate: "2",
    packet: { candidateProposal: "2" },
    toolObservations: observations,
  });
  assert.equal(toolDefect[0]?.kind, "REAL_ROOT_COUNT");
  const explorationOnly = answerClosureDefects({
    problemText: problem,
    candidate: "2",
    packet: { candidateProposal: "2" },
    toolObservations: [
      { name: EXPLORATION, operation: null, result: 3 },
      { name: EXPLORATION, operation: null, result: { output: "3\n" } },
    ],
  });
  assert.deepEqual(explorationOnly, []);
});

// -- the capability flow (AgentHostFlow) -----------------------------------

interface RecordedIo extends AgentHostIo {
  readonly sent: { readonly method: string; readonly message: JsonRpcMessage }[];
  readonly failures: unknown[];
}

function recordingIo(): RecordedIo {
  const sent: { readonly method: string; readonly message: JsonRpcMessage }[] = [];
  const failures: unknown[] = [];
  const io = {
    sent,
    failures,
    remainingMs: () => 8000,
    tighten: () => undefined,
    send: (message: JsonRpcMessage, method: string) => {
      sent.push({ method, message });
    },
    stop: () => undefined,
    fail: (error: unknown) => {
      failures.push(error);
    },
  };
  return io as unknown as RecordedIo;
}

function initFrame(generatedPython: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: "host-1",
    method: "runtime.initialize",
    params: {
      protocolVersion: AGENT_HOST_VERSION,
      sessionId: SESSION,
      profileId: "math-agent-preview-v2",
      capabilities: {
        modelGenerate: "AVAILABLE",
        toolExecute: "AVAILABLE",
        methodLoad: "UNAVAILABLE",
        generatedPython,
        maxTokens: 8192,
        maxTokensVerified: false,
        journal: "IN_MEMORY_ONLY",
        requireExplicitFinishForTools: true,
      },
      remainingMs: 8000,
      maxModelCalls: 4,
      maxWorkUnits: 1,
      maxEffects: 1,
      maxReviews: 0,
      maxMethodLoads: 0,
      maxRepairs: 0,
      maxConsensus: 0,
      policy: "BEST_EFFORT",
    },
  } as unknown as JsonRpcMessage;
}

const SOLVE: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: "host-2",
  method: "session.solve",
  params: {
    protocolVersion: AGENT_HOST_VERSION,
    sessionId: SESSION,
    problem: PROBLEM,
    problemHash: p4Hash(PROBLEM),
    remainingMs: 8000,
  },
} as unknown as JsonRpcMessage;

function modelTurn(io: RecordedIo): { readonly id: string; readonly message: JsonRpcMessage } {
  const turn = io.sent.find((row) => row.method === "model.generate");
  assert.ok(turn !== undefined, "one model turn was requested");
  const id = "id" in turn.message && typeof turn.message.id === "string" ? turn.message.id : "";
  return { id, message: turn.message };
}

function requestOf(
  entry: { readonly message: JsonRpcMessage },
): Record<string, unknown> {
  const params = (entry.message as unknown as { params: Record<string, unknown> }).params;
  return params["request"] as Record<string, unknown>;
}

test("the capability AVAILABLE_BOUNDED offers the action and dispatches it", async () => {
  const io = recordingIo();
  const flow = new AgentHostFlow(MANIFEST, io);
  flow.handle(initFrame("AVAILABLE_BOUNDED"));
  flow.handle(SOLVE);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const firstTurn = modelTurn(io);
  const messages = requestOf(firstTurn)["messages"] as { readonly content: string }[];
  assert.match(messages[0]!.content, /BOUNDED EXPLORATION AVAILABLE/u);

  flow.handle({
    jsonrpc: "2.0",
    id: firstTurn.id,
    result: {
      protocolVersion: AGENT_HOST_VERSION,
      sessionId: SESSION,
      requestId: firstTurn.id.replace(/^node-/u, ""),
      receipt: { transportStatus: "COMPLETE", text: exploreReply(), remainingMs: 7000 },
    },
  } as unknown as JsonRpcMessage);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const effectTurn = io.sent.find((row) => row.method === "tool.execute");
  assert.ok(effectTurn !== undefined, "the exploration was dispatched on the tool wire");
  const dispathed = requestOf(effectTurn as { message: JsonRpcMessage })["action"] as Record<
    string,
    unknown
  >;
  assert.equal(dispathed["action"], "explore");
  assert.equal(dispathed["code"], CODE);
  assert.equal(io.failures.length, 0);
});

test("the capability UNAVAILABLE keeps the action invisible and refused", async () => {
  const io = recordingIo();
  const flow = new AgentHostFlow(MANIFEST, io);
  flow.handle(initFrame("UNAVAILABLE"));
  flow.handle(SOLVE);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const firstTurn = modelTurn(io);
  const messages = requestOf(firstTurn)["messages"] as { readonly content: string }[];
  assert.doesNotMatch(messages[0]!.content, /BOUNDED EXPLORATION AVAILABLE/u);

  flow.handle({
    jsonrpc: "2.0",
    id: firstTurn.id,
    result: {
      protocolVersion: AGENT_HOST_VERSION,
      sessionId: SESSION,
      requestId: firstTurn.id.replace(/^node-/u, ""),
      receipt: { transportStatus: "COMPLETE", text: exploreReply(), remainingMs: 7000 },
    },
  } as unknown as JsonRpcMessage);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    io.sent.filter((row) => row.method === "tool.execute").length,
    0,
    "no exploration is dispatched without the bounded capability",
  );
});

test("an unknown generatedPython value is a fixed field failure", () => {
  const io = recordingIo();
  const flow = new AgentHostFlow(MANIFEST, io);
  flow.handle(initFrame("AVAILABLE_UNBOUNDED"));
  assert.equal(io.failures.length, 1);
  const failure = io.failures[0];
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "FIELD_VALUE");
  assert.deepEqual(io.sent, []);
});
