import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseFrame,
  p2HostPayload,
  validateP2HostManifest,
  type JsonRpcMessage,
  type P2HostManifest,
  type P2HostMethod,
} from "@astra/protocol";
import { P2HostFlow } from "../src/p2-host-flow.js";

const MANIFEST = validateP2HostManifest(
  JSON.parse(
    readFileSync(new URL(import.meta.resolve("@astra/protocol/schema/p2-host.schema.json")), "utf8"),
  ) as unknown,
);
const HASH = createHash("sha256").update("fixture").digest("hex");

function resultOf(message: JsonRpcMessage): Record<string, unknown> {
  assert.ok("result" in message);
  return message.result;
}

function setup(budget = 1, problem = "fixture") {
  const sent: JsonRpcMessage[] = [];
  const stopped: JsonRpcMessage[] = [];
  let left = 1000;
  const io = {
    remainingMs: () => left,
    tighten: (ms: number) => {
      left = Math.min(left, ms);
    },
    send: (message: JsonRpcMessage, method: P2HostMethod) => {
      if ("method" in message) {
        p2HostPayload(MANIFEST, method, "params", message.params, "s-1");
      } else if ("result" in message) {
        p2HostPayload(MANIFEST, method, "result", message.result, "s-1");
      } else {
        assert.fail("send expects a request or a success");
      }
      sent.push(message);
    },
    stop: (message: JsonRpcMessage) => {
      stopped.push(message);
    },
  };
  const flow = new P2HostFlow(MANIFEST, io);
  flow.handle({
    jsonrpc: "2.0",
    id: "host-1",
    method: "runtime.initialize",
    params: {
      protocolVersion: "1.0-p2-host-local",
      sessionId: "s-1",
      remainingMs: 1000,
      maxModelCalls: budget,
      maxMethodLoads: 1,
      maxTokens: 8192,
      mode: "MOCK_ONLY",
    },
  });
  flow.handle({
    jsonrpc: "2.0",
    id: "host-2",
    method: "session.solve",
    params: {
      protocolVersion: "1.0-p2-host-local",
      sessionId: "s-1",
      problem,
      problemHash: createHash("sha256").update(problem).digest("hex"),
      methodId: null,
    },
  });
  const last = sent[sent.length - 1];
  assert.ok(last !== undefined);
  const callback = "method" in last ? (last.params as Record<string, unknown>) : {};
  return { flow, sent, stopped, callback };
}

function packet(params: Record<string, unknown>): string {
  const messages = params["messages"] as { role: string; content: string }[];
  const inner = JSON.parse(messages[1]!.content) as Record<string, unknown>;
  const task = inner["task"] as Record<string, unknown>;
  const route = inner["route"] as Record<string, unknown>;
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: inner["sessionId"],
    problemHash: inner["problemHash"],
    contractVersion: inner["contractVersion"],
    taskId: task["taskId"],
    goalId: task["goalId"],
    scopeId: task["scopeId"],
    routeId: route["routeId"],
    sourceRequestId: inner["sourceRequestId"],
    claim: "c",
    derivation: "d",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "candidate",
  });
}

function receipt(params: Record<string, unknown>, patch: Record<string, unknown> = {}): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: "node-model-1",
    result: {
      protocolVersion: "1.0-p2-host-local",
      sessionId: "s-1",
      requestId: "model-1",
      mode: "MOCK_ONLY",
      deliveryStatus: "COMPLETE",
      text: packet(params),
      remainingMs: 900,
      ...patch,
    },
  };
}

test("manifest and frame guards", () => {
  assert.equal(Object.keys(MANIFEST.methods).length, 6);
  const missing = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
  delete (missing["methods"] as Record<string, unknown>)["method.load"];
  assert.throws(() => validateP2HostManifest(missing));
  const dup = Buffer.from('{"jsonrpc":"2.0","id":"a","id":"b"}', "utf8");
  assert.equal(parseFrame(dup, MANIFEST).ok, false);
  assert.equal(parseFrame(Buffer.from([0xff, 0xfe, 0x0a]), MANIFEST).ok, false);
  assert.equal(parseFrame(Buffer.alloc(65537, 0x61), MANIFEST).ok, false);
  assert.throws(() =>
    p2HostPayload(MANIFEST, "session.stop", "params", { protocolVersion: "1.0-p2-host-local", sessionId: "s-1", extra: 1 }, "s-1"),
  );
});

test("flow order, negatives and stop", () => {
  const { flow, sent, stopped, callback } = setup();
  assert.equal(sent.length, 2);
  const first = sent[1]!;
  assert.ok("method" in first && first.method === "model.generate");
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.0-p2-host-local", sessionId: "s-1" } }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-1", method: "runtime.initialize", params: { protocolVersion: "1.0-p2-host-local", sessionId: "s-1", remainingMs: 1000, maxModelCalls: 1, maxMethodLoads: 1, maxTokens: 8192, mode: "MOCK_ONLY" } }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "node-model-9", result: {} }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "node-model-1", result: { protocolVersion: "1.0-p2-host-local", sessionId: "s-2", requestId: "model-1", mode: "MOCK_ONLY", deliveryStatus: "COMPLETE", text: "x", remainingMs: 900 } }));
  assert.equal(sent.length, 2);
  flow.handle(receipt(callback));
  const solve = sent[2]!;
  const result = resultOf(solve);
  assert.equal(result["status"], "candidate");
  assert.equal(result["artifactCount"], 1);
  assert.ok((result["openObligations"] as number) > 0);
  assert.equal(result["candidateVerified"], false);
  const before = sent.length;
  assert.throws(() => flow.handle(receipt(callback)));
  assert.equal(sent.length, before);
  flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.0-p2-host-local", sessionId: "s-1" } });
  assert.equal(stopped.length, 1);
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.0-p2-host-local", sessionId: "s-1" } }));
  const zero = setup(0);
  assert.equal(zero.sent.length, 2);
  assert.equal(resultOf(zero.sent[1]!)["status"], "unsolved");
});

test("delivery, scope and proof table", () => {
  for (const [status, expected] of [["COMPLETE", "candidate"], ["TRUNCATED", "unsolved"], ["ERROR", "unsolved"], ["UNKNOWN", "unsolved"]] as const) {
    const { flow, sent, callback } = setup();
    flow.handle(receipt(callback, { deliveryStatus: status }));
    assert.equal(resultOf(sent[2]!)["status"], expected);
  }
  const short = setup();
  short.flow.handle(receipt(short.callback, { remainingMs: 1 }));
  const shortResult = resultOf(short.sent[2]!);
  assert.equal(shortResult["status"], "unsolved");
  assert.equal(shortResult["artifactCount"], 0);
  const wrong = setup();
  const bad = JSON.parse(packet(wrong.callback)) as Record<string, unknown>;
  bad["scopeId"] = "other-scope";
  wrong.flow.handle(receipt(wrong.callback, { text: JSON.stringify(bad) }));
  const wrongResult = resultOf(wrong.sent[2]!);
  assert.equal(wrongResult["status"], "unsolved");
  assert.equal(wrongResult["artifactCount"], 0);
  const proof = setup(1, "证明一个命题");
  proof.flow.handle(receipt(proof.callback));
  assert.equal(resultOf(proof.sent[2]!)["status"], "unsolved");
});
