import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseFrame,
  p3HostPayload,
  validateP3HostManifest,
  type JsonRpcMessage,
  type P3EffectRequest,
  type P3HostManifest,
  type P3HostMethod,
} from "@astra/protocol";
import { p3EffectFailure } from "@astra/math-gateway";
import { P3HostFlow } from "../src/p3-host-flow.js";

const MANIFEST = validateP3HostManifest(
  JSON.parse(
    readFileSync(new URL(import.meta.resolve("@astra/protocol/schema/p3-host.schema.json")), "utf8"),
  ) as unknown,
);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const PROBLEM = "PRIVATE problem";
const SID = "s";
const COMMON = { protocolVersion: "1.1-p3-host-local", sessionId: SID } as const;

function resultOf(message: JsonRpcMessage): Record<string, unknown> {
  assert.ok("result" in message);
  return message.result;
}

function setup(maxCalls = 3, maxEffects = 2) {
  const sent: JsonRpcMessage[] = [];
  const stopped: JsonRpcMessage[] = [];
  let left = 4000;
  const io = {
    remainingMs: () => left,
    tighten: (ms: number) => {
      left = Math.min(left, ms);
    },
    send: (message: JsonRpcMessage, method: P3HostMethod) => {
      if ("method" in message) {
        p3HostPayload(MANIFEST, method, "params", message.params, SID);
      } else if ("result" in message) {
        p3HostPayload(MANIFEST, method, "result", message.result, SID);
      } else {
        assert.fail("send expects a request or a success");
      }
      sent.push(message);
    },
    stop: (message: JsonRpcMessage) => {
      stopped.push(message);
    },
  };
  const flow = new P3HostFlow(MANIFEST, io);
  flow.handle({
    jsonrpc: "2.0",
    id: "host-1",
    method: "runtime.initialize",
    params: { ...COMMON, remainingMs: 4000, maxModelCalls: maxCalls, maxEffects, maxMethodLoads: 0, maxTokens: 8192, mode: "MOCK_ONLY" },
  });
  flow.handle({
    jsonrpc: "2.0",
    id: "host-2",
    method: "session.solve",
    params: { ...COMMON, problem: PROBLEM, problemHash: sha(PROBLEM) },
  });
  return { flow, sent, stopped, io };
}

function last(sent: JsonRpcMessage[]): JsonRpcMessage {
  const frame = sent.at(-1);
  assert.ok(frame !== undefined);
  return frame;
}

function modelParams(sent: JsonRpcMessage[]): Record<string, unknown> {
  const frame = last(sent);
  assert.ok("method" in frame && frame.method === "model.generate");
  return frame.params as Record<string, unknown>;
}

function model(sent: JsonRpcMessage[], n: number, text: string, status = "COMPLETE"): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: `node-model-${n}`,
    result: { ...COMMON, requestId: `model-${n}`, mode: "MOCK_ONLY", deliveryStatus: status, text, remainingMs: 3000 },
  };
}

function effect(sent: JsonRpcMessage[], receipt: unknown, remainingMs = 3000): JsonRpcMessage {
  const frame = last(sent);
  assert.ok("method" in frame && frame.method === "tool.execute");
  const params = frame.params as Record<string, unknown>;
  const request = params["request"] as P3EffectRequest;
  return {
    jsonrpc: "2.0",
    id: frame.id,
    result: { ...COMMON, receipt, remainingMs },
  };
}

function toolText(name: string, args: Record<string, unknown>, scope: string): string {
  return JSON.stringify({ action: "tool", name, args, scope });
}

const POLY = { expression: "(x+1)**2", variables: ["x"], parameters: [] };
const FINAL = JSON.stringify({ action: "final", answer: "x=1", complete: true, unresolved: [] });

test("manifest and strict frame guards", () => {
  assert.equal(Object.keys(MANIFEST.methods).length, 7);
  assert.ok(Object.isFrozen(MANIFEST));
  const old = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
  old["protocolVersion"] = "1.0-p3-host-local";
  assert.throws(() => validateP3HostManifest(old));
  const p2 = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
  p2["protocolVersion"] = "1.1-p2-host-local";
  assert.throws(() => validateP3HostManifest(p2));
  const widened = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
  (widened["methods"] as Record<string, unknown>)["method.unknown"] = { direction: "node-to-host", kind: "request", params: {}, result: {} };
  assert.throws(() => validateP3HostManifest(widened));
  assert.equal(parseFrame(Buffer.from('{"jsonrpc":"2.0","id":"a","id":"b"}', "utf8"), MANIFEST).ok, false);
  assert.equal(parseFrame(Buffer.from('{"jsonrpc":"2.0","id":"a","method":"m","params":{"x":1.5}}', "utf8"), MANIFEST).ok, false);
  assert.equal(parseFrame(Buffer.from('{"jsonrpc":"2.0","id":"a","method":"m","params":{"x":9007199254740992}}', "utf8"), MANIFEST).ok, false);
  assert.equal(parseFrame(Buffer.from([0xff, 0xfe, 0x0a]), MANIFEST).ok, false);
  assert.throws(() =>
    p3HostPayload(MANIFEST, "session.stop", "params", { ...COMMON, extra: 1 }, SID),
  );
});

test("direct final identity, privacy and zero-call budget", () => {
  const h = setup();
  const params = modelParams(h.sent);
  assert.equal(params["problemHash"], sha(PROBLEM));
  assert.equal(params["contextHash"], sha(JSON.stringify(params["messages"])));
  assert.ok(!JSON.stringify(params).includes("PRIVATE problem") === false);
  h.flow.handle(model(h.sent, 1, FINAL));
  const result = resultOf(last(h.sent));
  assert.equal(result["status"], "candidate");
  assert.equal(result["candidateVerified"], false);
  assert.equal(result["strictAcceptance"], "NOT_PERFORMED");
  assert.equal(result["candidateRequestId"], "model-1");
  assert.equal(result["finalResponse"], "x=1");
  assert.equal(result["stopReason"], "FINAL");
  assert.equal(result["effectCalls"], 0);
  const zero = setup(0, 0);
  assert.equal(zero.sent.length, 2);
  assert.equal(resultOf(zero.sent[1]!)["status"], "unsolved");
  zero.flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { ...COMMON } });
  assert.equal(zero.stopped.length, 1);
  assert.equal(zero.sent.length + zero.stopped.length, 3);
});

test("tool then duplicate cache then final", () => {
  const h = setup();
  h.flow.handle(model(h.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  const frame = last(h.sent);
  assert.ok("method" in frame && frame.method === "tool.execute");
  const request = (frame.params as Record<string, unknown>)["request"] as P3EffectRequest;
  assert.equal(request.effectId, "effect-1");
  assert.equal(request.binding.sourceRequestId, "model-1");
  h.flow.handle(effect(h.sent, p3EffectFailure(request, "ERROR")));
  const second = modelParams(h.sent);
  const inner = JSON.parse((second["messages"] as { content: string }[])[1]!.content) as Record<string, unknown>;
  assert.equal((inner["effects"] as unknown[]).length, 1);
  assert.equal((inner["history"] as unknown[]).length, 1);
  h.flow.handle(model(h.sent, 2, toolText("polynomial_expand_coefficients", { parameters: [], variables: ["x"], expression: "(x+1)**2" }, "different wording")));
  assert.equal(h.sent.filter((m) => "method" in m && m.method === "tool.execute").length, 1);
  h.flow.handle(model(h.sent, 3, FINAL));
  const result = resultOf(last(h.sent));
  assert.equal(result["status"], "candidate");
  assert.equal(result["effectCalls"], 1);
  assert.equal(result["cachedEffects"], 1);
  assert.equal(result["modelCalls"], 3);
});

test("malformed actions, method refusal and budget stops", () => {
  const bad = setup();
  bad.flow.handle(model(bad.sent, 1, "{"));
  assert.equal(resultOf(last(bad.sent))["stopReason"], "ACTION_REJECTED");
  const incomplete = setup();
  incomplete.flow.handle(model(incomplete.sent, 1, JSON.stringify({ action: "final", answer: "x=1", complete: false, unresolved: [] })));
  assert.equal(resultOf(last(incomplete.sent))["status"], "unsolved");
  const unsolved = setup();
  unsolved.flow.handle(model(unsolved.sent, 1, JSON.stringify({ action: "unsolved", reason: "no" })));
  assert.equal(resultOf(last(unsolved.sent))["stopReason"], "UNSOLVED");
  const method = setup();
  method.flow.handle(model(method.sent, 1, JSON.stringify({ action: "method", id: "linearization-spectral" })));
  const methodResult = resultOf(last(method.sent));
  assert.equal(methodResult["stopReason"], "EFFECT_UNAVAILABLE");
  assert.equal(methodResult["candidateRequestId"], null);
  assert.equal(method.sent.filter((m) => "method" in m && m.method === "tool.execute").length, 0);
  const transport = setup();
  transport.flow.handle(model(transport.sent, 1, FINAL, "TRUNCATED"));
  assert.equal(resultOf(last(transport.sent))["stopReason"], "TRANSPORT_STOP");
  const lastTurn = setup(1, 2);
  lastTurn.flow.handle(model(lastTurn.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  assert.equal(resultOf(last(lastTurn.sent))["stopReason"], "BUDGET_EXHAUSTED");
  const noEffect = setup(3, 0);
  noEffect.flow.handle(model(noEffect.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  assert.equal(resultOf(last(noEffect.sent))["stopReason"], "BUDGET_EXHAUSTED");
});

test("host identity, phase and replay negatives", () => {
  const h = setup();
  const before = h.flow.snapshot();
  assert.throws(() => h.flow.handle({ jsonrpc: "2.0", id: "host-9", method: "session.stop", params: { ...COMMON } }));
  assert.throws(() => h.flow.handle({ jsonrpc: "2.0", id: "host-1", method: "runtime.initialize", params: { ...COMMON, remainingMs: 4000, maxModelCalls: 3, maxEffects: 2, maxMethodLoads: 0, maxTokens: 8192, mode: "MOCK_ONLY" } }));
  assert.throws(() => h.flow.handle({ jsonrpc: "2.0", id: "node-model-1", result: { ...COMMON, sessionId: "other", requestId: "model-1", mode: "MOCK_ONLY", deliveryStatus: "COMPLETE", text: FINAL, remainingMs: 3000 } }));
  assert.throws(() => h.flow.handle({ jsonrpc: "2.0", id: "node-model-1", result: { ...COMMON, requestId: "model-2", mode: "MOCK_ONLY", deliveryStatus: "COMPLETE", text: FINAL, remainingMs: 3000 } }));
  assert.throws(() => h.flow.handle({ jsonrpc: "2.0", id: "node-model-1", result: { ...COMMON, requestId: "model-1", mode: "MOCK_ONLY", deliveryStatus: "COMPLETE", text: FINAL, remainingMs: 3000, extra: 1 } }));
  assert.deepEqual(h.flow.snapshot(), before);
  const replay = setup();
  const frame = model(replay.sent, 1, FINAL);
  replay.flow.handle(frame);
  const after = replay.flow.snapshot();
  assert.throws(() => replay.flow.handle(frame));
  assert.deepEqual(replay.flow.snapshot(), after);
  const wrongHash = setup();
  assert.throws(() => wrongHash.flow.handle({ jsonrpc: "2.0", id: "host-2", method: "session.solve", params: { ...COMMON, problem: PROBLEM, problemHash: sha("other") } }));
});

test("forged receipt, unknown outcome and late settle", () => {
  const forged = setup();
  forged.flow.handle(model(forged.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  const frame = last(forged.sent);
  assert.ok("method" in frame && frame.method === "tool.execute");
  const request = (frame.params as Record<string, unknown>)["request"] as P3EffectRequest;
  const good = p3EffectFailure(request, "ERROR");
  forged.flow.handle(effect(forged.sent, { ...good, observationHash: sha("forged") }));
  const forgedResult = resultOf(last(forged.sent));
  assert.equal(forgedResult["stopReason"], "EFFECT_UNKNOWN");
  assert.equal(forgedResult["candidateRequestId"], null);
  assert.equal(forged.sent.filter((m) => "method" in m && m.method === "model.generate").length, 1);
  const unknown = setup();
  unknown.flow.handle(model(unknown.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  const unknownFrame = last(unknown.sent);
  assert.ok("method" in unknownFrame && unknownFrame.method === "tool.execute");
  const unknownRequest = (unknownFrame.params as Record<string, unknown>)["request"] as P3EffectRequest;
  unknown.flow.handle(effect(unknown.sent, p3EffectFailure(unknownRequest, "UNKNOWN")));
  assert.equal(resultOf(last(unknown.sent))["stopReason"], "EFFECT_UNKNOWN");
  const late = setup();
  late.flow.handle(model(late.sent, 1, toolText("polynomial_expand_coefficients", POLY, "expand")));
  const lateFrame = last(late.sent);
  assert.ok("method" in lateFrame && lateFrame.method === "tool.execute");
  const lateRequest = (lateFrame.params as Record<string, unknown>)["request"] as P3EffectRequest;
  late.flow.handle(effect(late.sent, p3EffectFailure(lateRequest, "ERROR"), 25));
  const lateResult = resultOf(last(late.sent));
  assert.equal(lateResult["candidateRequestId"], null);
  assert.equal(lateResult["status"], "unsolved");
  late.flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { ...COMMON } });
  assert.equal(late.stopped.length, 1);
  assert.throws(() => late.flow.handle({ jsonrpc: "2.0", id: "host-3", method: "session.stop", params: { ...COMMON } }));
});
