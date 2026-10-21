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
      protocolVersion: "1.1-p2-host-local",
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
      protocolVersion: "1.1-p2-host-local",
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
      protocolVersion: "1.1-p2-host-local",
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
    p2HostPayload(MANIFEST, "session.stop", "params", { protocolVersion: "1.1-p2-host-local", sessionId: "s-1", extra: 1 }, "s-1"),
  );
});

test("flow order, negatives and stop", () => {
  const { flow, sent, stopped, callback } = setup();
  assert.equal(sent.length, 2);
  const first = sent[1]!;
  assert.ok("method" in first && first.method === "model.generate");
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.1-p2-host-local", sessionId: "s-1" } }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-1", method: "runtime.initialize", params: { protocolVersion: "1.1-p2-host-local", sessionId: "s-1", remainingMs: 1000, maxModelCalls: 1, maxMethodLoads: 1, maxTokens: 8192, mode: "MOCK_ONLY" } }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "node-model-9", result: {} }));
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "node-model-1", result: { protocolVersion: "1.1-p2-host-local", sessionId: "s-2", requestId: "model-1", mode: "MOCK_ONLY", deliveryStatus: "COMPLETE", text: "x", remainingMs: 900 } }));
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
  flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.1-p2-host-local", sessionId: "s-1" } });
  assert.equal(stopped.length, 1);
  assert.throws(() => flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { protocolVersion: "1.1-p2-host-local", sessionId: "s-1" } }));
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
  // A forged scopeId is control data: it is rebound to the trusted scope, so
  // the packet is accepted under that scope and never under the claimed one.
  const forged = setup();
  const rebound = JSON.parse(packet(forged.callback)) as Record<string, unknown>;
  rebound["scopeId"] = "other-scope";
  forged.flow.handle(receipt(forged.callback, { text: JSON.stringify(rebound) }));
  const reboundResult = resultOf(forged.sent[2]!);
  assert.equal(reboundResult["status"], "candidate");
  assert.equal(reboundResult["artifactCount"], 1);
  // An assumption outside the trusted scope is still a fixed rejection.
  const wrong = setup();
  const bad = JSON.parse(packet(wrong.callback)) as Record<string, unknown>;
  bad["assumptions"] = ["undeclared"];
  wrong.flow.handle(receipt(wrong.callback, { text: JSON.stringify(bad) }));
  const wrongResult = resultOf(wrong.sent[2]!);
  assert.equal(wrongResult["status"], "unsolved");
  assert.equal(wrongResult["artifactCount"], 0);
  const proof = setup(1, "证明一个命题");
  proof.flow.handle(receipt(proof.callback));
  assert.equal(resultOf(proof.sent[2]!)["status"], "unsolved");
});

test("three sequential units, duplicate receipt and unknown stop", () => {
  const h = setup(3, "求全部实数解 x(x-1)=0");
  const contexts: Record<string, unknown>[] = [];
  for (let index = 0; index < 3; index += 1) {
    const frame = h.sent.at(-1)!;
    assert.ok("method" in frame && frame.method === "model.generate");
    const params = frame.params as Record<string, unknown>;
    const messages = params["messages"] as { role: string; content: string }[];
    contexts.push(JSON.parse(messages[1]!.content) as Record<string, unknown>);
    const base = receipt(params);
    assert.ok("result" in base);
    h.flow.handle({
      ...base,
      id: `node-${params["requestId"] as string}`,
      result: { ...base.result, requestId: params["requestId"] },
    });
  }
  const final = resultOf(h.sent.at(-1)!);
  assert.equal(final["status"], "candidate");
  assert.equal(final["candidateRequestId"], "model-1");
  assert.equal(final["artifactCount"], 3);
  assert.equal(final["modelCalls"], 3);
  const gate = h.flow.gateSnapshot() as readonly { state: string; requestId: string }[];
  assert.equal(gate.length, 3);
  assert.ok(gate.every((record) => record.state === "RETURNED"));
  const third = contexts[2]!;
  const refs = (third["task"] as Record<string, unknown>)["inputArtifactRefs"] as {
    artifactId: string;
  }[];
  assert.deepEqual(
    refs.map((ref) => ref.artifactId).sort(),
    ["artifact-1", "artifact-2"],
  );

  const h2 = setup(3, "求全部实数解 x(x-1)=0");
  const first = receipt(h2.callback);
  h2.flow.handle(first);
  const before = h2.flow.gateSnapshot();
  assert.equal(before.length, 2);
  assert.throws(() => h2.flow.handle(first), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "ID_MISMATCH");
    return true;
  });
  assert.deepEqual(h2.flow.gateSnapshot(), before);
  assert.equal(h2.sent.length, 3);
  assert.notEqual(h2.sent.length, 1);
  const secondFrame = h2.sent.at(-1)!;
  assert.ok("method" in secondFrame && secondFrame.method === "model.generate");
  const secondParams = secondFrame.params as Record<string, unknown>;
  const secondBase = receipt(secondParams);
  assert.ok("result" in secondBase);
  assert.throws(
    () =>
      h2.flow.handle({
        ...secondBase,
        id: `node-${secondParams["requestId"] as string}`,
        result: { ...secondBase.result, requestId: "model-1" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "ID_MISMATCH");
      return true;
    },
  );
  assert.deepEqual(h2.flow.gateSnapshot(), before);

  const h3 = setup(3, "求全部实数解 x(x-1)=0");
  h3.flow.handle(receipt(h3.callback, { deliveryStatus: "UNKNOWN" }));
  const unknown = resultOf(h3.sent.at(-1)!);
  assert.equal(unknown["status"], "unsolved");
  assert.equal(unknown["modelCalls"], 1);
  assert.equal(unknown["artifactCount"], 1);
  assert.equal((h3.flow.gateSnapshot() as typeof gate)[0]!.state, "OUTCOME_UNKNOWN");
  assert.equal(h3.sent.length, 3);
  const lastFrame = h3.sent.at(-1)!;
  assert.ok(!("method" in lastFrame));
});
