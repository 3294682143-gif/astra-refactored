/**
 * A `session.stop` that arrives while `session.solve` is still in flight must
 * fail closed with its own fixed code.
 *
 * Ending the process silently instead would leave the Python Host with a clean
 * exit, no solve result and only a generic field failure to report, which is
 * exactly the opaque outcome this test rules out. Nothing is written on the
 * stop path here: no fabricated `stopped: true`, no fabricated summary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_HOST_VERSION,
  p4Hash,
  validateAgentHostManifest,
  type AgentHostManifest,
  type JsonRpcMessage,
} from "@astra/protocol";
import { AgentHostFlow, type AgentHostIo } from "../src/agent-host-flow.js";

const SOURCE = new URL(
  "../../../../packages/protocol/schema/agent-host-v13.schema.json",
  import.meta.url,
);
const MANIFEST = validateAgentHostManifest(
  JSON.parse(readFileSync(SOURCE, "utf8")) as unknown,
) as AgentHostManifest;

const PROBLEM = "Compute 2+2.";
const SESSION = "s-guard";
const INIT: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: "host-1",
  method: "runtime.initialize",
  params: {
    protocolVersion: AGENT_HOST_VERSION,
    sessionId: SESSION,
    profileId: "math-agent-preview-v2",
    capabilities: {
      modelGenerate: "AVAILABLE",
      toolExecute: "UNAVAILABLE",
      methodLoad: "UNAVAILABLE",
      generatedPython: "UNAVAILABLE",
      maxTokens: 8192,
      maxTokensVerified: false,
      journal: "IN_MEMORY_ONLY",
      requireExplicitFinishForTools: true,
    },
    remainingMs: 5000,
    maxModelCalls: 2,
    maxWorkUnits: 1,
    maxEffects: 0,
    maxReviews: 0,
    maxMethodLoads: 0,
    maxRepairs: 0,
    maxConsensus: 0,
    policy: "BEST_EFFORT",
  },
} as unknown as JsonRpcMessage;

const SOLVE: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: "host-2",
  method: "session.solve",
  params: {
    protocolVersion: AGENT_HOST_VERSION,
    sessionId: SESSION,
    problem: PROBLEM,
    problemHash: p4Hash(PROBLEM),
    remainingMs: 5000,
  },
} as unknown as JsonRpcMessage;

const STOP: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: "host-3",
  method: "session.stop",
  params: { protocolVersion: AGENT_HOST_VERSION, sessionId: SESSION },
} as unknown as JsonRpcMessage;

interface RecordingIo extends AgentHostIo {
  readonly sent: { readonly method: string; readonly id: string }[];
  readonly stops: number;
  readonly failures: unknown[];
}

function recordingIo(): RecordingIo {
  const sent: { method: string; id: string }[] = [];
  const failures: unknown[] = [];
  let stops = 0;
  const io = {
    sent,
    failures,
    get stops(): number {
      return stops;
    },
    remainingMs: () => 5000,
    tighten: () => undefined,
    // The model turn is deliberately left unresolved: the run stays inside
    // `session.solve`, which is the state under test.
    send: (message: JsonRpcMessage, method: string) => {
      const id = "id" in message && typeof message.id === "string" ? message.id : "";
      sent.push({ method, id });
    },
    stop: () => {
      stops += 1;
    },
    // The real Host exits the process here; recording keeps the test able to
    // assert the fixed code without an unhandled rejection from a later turn.
    fail: (error: unknown) => {
      failures.push(error);
    },
  };
  return io as unknown as RecordingIo;
}

test("agent guard: a stop during a pending solve is an illegal transition", async () => {
  const io = recordingIo();
  const flow = new AgentHostFlow(MANIFEST, io);
  flow.handle(INIT);
  flow.handle(SOLVE);
  await new Promise((resolve) => setTimeout(resolve, 25));
  // The solve is still pending: it waits for `model.generate`.
  assert.deepEqual(
    io.sent.map((row) => row.method),
    ["runtime.initialize", "model.generate"],
  );
  flow.handle(STOP);
  assert.equal(io.stops, 0, "no stop ack is written for an illegal transition");
  assert.equal(io.failures.length, 1);
  const failure = io.failures[0];
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "ILLEGAL_TRANSITION");
});

test("agent guard: a stop after the solve result is still accepted", async () => {
  const io = recordingIo();
  const flow = new AgentHostFlow(MANIFEST, io);
  flow.handle(INIT);
  flow.handle(SOLVE);
  await new Promise((resolve) => setTimeout(resolve, 25));
  // Answer the pending model turn with one complete (but wrong-shaped) packet;
  // the loop then finalizes without a candidate and the stop is legal.
  assert.deepEqual(
    io.sent.map((row) => row.method),
    ["runtime.initialize", "model.generate"],
  );
  const turn = io.sent.find((row) => row.method === "model.generate");
  assert.ok(turn !== undefined, "the solve asked for one model turn");
  flow.handle({
    jsonrpc: "2.0",
    id: turn.id,
    result: {
      protocolVersion: AGENT_HOST_VERSION,
      sessionId: SESSION,
      requestId: turn.id.replace(/^node-/u, ""),
      receipt: { transportStatus: "COMPLETE", text: "not a packet", remainingMs: 4000 },
    },
  } as unknown as JsonRpcMessage);
  await new Promise((resolve) => setTimeout(resolve, 50));
  flow.handle(STOP);
  assert.equal(io.stops, 1, "the stop ack is written after the solve result");
  assert.ok(
    io.sent.some((row) => row.method === "session.solve"),
    "the legal path still delivers exactly one solve result",
  );
  assert.equal(
    io.sent.filter((row) => row.method === "session.solve").length,
    1,
  );
});
