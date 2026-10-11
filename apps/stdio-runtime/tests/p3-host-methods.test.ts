import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  p3HostPayload,
  validateP3HostManifest,
  type JsonRpcMessage,
  type P3EffectRequest,
  type P3HostManifest,
  type P3HostMethod,
} from "@astra/protocol";
import { p3EffectFailure, p3EffectReceipt } from "@astra/math-gateway";
import { p3MethodCatalog, p3MethodObservation } from "@astra/runtime-core";
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
const BODY = "PRIVATE_METHOD_BODY";
const BODY_SHA = sha(BODY);
const FIRST = "linearization-spectral";

function catalogEntries(): { id: string; title: string }[] {
  const rows = [{ id: FIRST, title: "Linearization spectral" }];
  for (let i = 1; i < 20; i += 1) rows.push({ id: `m-${i}`, title: `Method ${i}` });
  return rows;
}

function catalog(): { version: string; entries: { id: string; title: string }[] } {
  return { version: "1.1.0", entries: catalogEntries() };
}

function titleOf(id: string): string {
  const row = catalogEntries().find((entry) => entry.id === id);
  assert.ok(row !== undefined);
  return row.title;
}

function observation(id: string): string {
  return JSON.stringify({
    method: id,
    asset: { id, title: titleOf(id), version: "1.1.0", body: BODY, bodySha256: BODY_SHA, bodyChars: BODY.length },
    interpretation: "ADVISORY_NOT_PROOF",
  });
}

function resultOf(message: JsonRpcMessage): Record<string, unknown> {
  assert.ok("result" in message);
  return message.result;
}

function last(sent: JsonRpcMessage[]): JsonRpcMessage {
  const frame = sent.at(-1);
  assert.ok(frame !== undefined);
  return frame;
}

function setup(maxCalls = 3, maxEffects = 2, maxMethodLoads = 1) {
  const sent: JsonRpcMessage[] = [];
  const stopped: JsonRpcMessage[] = [];
  let left = 5000;
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
    params: { ...COMMON, remainingMs: 5000, maxModelCalls: maxCalls, maxEffects, maxMethodLoads, maxTokens: 8192, mode: "MOCK_ONLY" },
  });
  flow.handle({
    jsonrpc: "2.0",
    id: "host-2",
    method: "session.solve",
    params: { ...COMMON, problem: PROBLEM, problemHash: sha(PROBLEM) },
  });
  return { flow, sent, stopped, io };
}

function catalogFrame(sent: JsonRpcMessage[], remainingMs = 4000): JsonRpcMessage {
  const frame = last(sent);
  assert.ok("method" in frame && frame.method === "method.catalog");
  return { jsonrpc: "2.0", id: frame.id, result: { ...COMMON, remainingMs, catalog: catalog() } };
}

function model(sent: JsonRpcMessage[], n: number, text: string, status = "COMPLETE"): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: `node-model-${n}`,
    result: { ...COMMON, requestId: `model-${n}`, mode: "MOCK_ONLY", deliveryStatus: status, text, remainingMs: 4000 },
  };
}

function methodText(id: string): string {
  return JSON.stringify({ action: "method", id });
}

function toolText(name: string, args: Record<string, unknown>, scope: string): string {
  return JSON.stringify({ action: "tool", name, args, scope });
}

function effect(sent: JsonRpcMessage[], receipt: unknown, remainingMs = 4000): JsonRpcMessage {
  const frame = last(sent);
  assert.ok("method" in frame && (frame.method === "method.load" || frame.method === "tool.execute"));
  return { jsonrpc: "2.0", id: frame.id, result: { ...COMMON, receipt, remainingMs } };
}

function requestOf(sent: JsonRpcMessage[]): P3EffectRequest {
  const frame = last(sent);
  assert.ok("method" in frame && (frame.method === "method.load" || frame.method === "tool.execute"));
  return (frame.params as Record<string, unknown>)["request"] as P3EffectRequest;
}

function methodReceipt(request: P3EffectRequest, id: string, status = "COMPLETE"): unknown {
  const base = p3EffectFailure(request, status === "COMPLETE" ? "ERROR" : "UNKNOWN");
  if (status !== "COMPLETE") return base;
  const text = observation(id);
  return { ...base, status: "COMPLETE", source: "METHOD_REFERENCE", observation: text, observationHash: sha(text) };
}

const POLY = { expression: "(x+1)**2", variables: ["x"], parameters: [] };
const FINAL = JSON.stringify({ action: "final", answer: "x=1", complete: true, unresolved: [] });

test("catalog and observation validators", () => {
  const good = p3MethodCatalog(catalog());
  assert.equal(good.entries.length, 20);
  assert.ok(Object.isFrozen(good));
  assert.equal(p3MethodCatalog({ version: "1.1.0", entries: [] }).entries.length, 0);
  const partial = catalog();
  partial.entries = partial.entries.slice(0, 3);
  assert.throws(() => p3MethodCatalog(partial));
  const dup = catalog();
  dup.entries[1]!.id = FIRST;
  assert.throws(() => p3MethodCatalog(dup));
  const extra = catalog();
  (extra.entries[0] as Record<string, unknown>)["path"] = "references/x.md";
  assert.throws(() => p3MethodCatalog(extra));
  const body = catalog();
  (body.entries[0] as Record<string, unknown>)["body"] = BODY;
  assert.throws(() => p3MethodCatalog(body));
  const blank = catalog();
  blank.entries[0]!.title = "   ";
  assert.throws(() => p3MethodCatalog(blank));
  const badId = catalog();
  badId.entries[0]!.id = "../SOURCE.json";
  assert.throws(() => p3MethodCatalog(badId));

  const request: P3EffectRequest = {
    effectId: "effect-1",
    binding: { sessionId: SID, problemHash: sha(PROBLEM), contractVersion: 1, taskId: "t", scopeId: "a".repeat(64), sourceRequestId: "model-1" },
    action: { action: "method", id: FIRST },
    remainingMs: 1000,
  };
  const trusted = p3MethodCatalog(catalog());
  const goodReceipt = methodReceipt(request, FIRST) as Record<string, unknown>;
  p3MethodObservation(p3EffectReceipt(goodReceipt, request), request, trusted);
  const errorReceipt = p3EffectFailure(request, "ERROR");
  p3MethodObservation(errorReceipt, request, trusted);
  assert.equal(errorReceipt.level, "PROVISIONAL");
  assert.equal(errorReceipt.checkResult, "UNKNOWN");
  const cases: Record<string, unknown>[] = [];
  cases.push({ ...goodReceipt, observationHash: sha("forged") });
  cases.push({ ...goodReceipt, source: "PROGRAM_OBSERVATION" });
  const wrongId = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  wrongId["method"] = "m-1";
  cases.push({ ...goodReceipt, observation: JSON.stringify(wrongId), observationHash: sha(JSON.stringify(wrongId)) });
  const wrongTitle = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  (wrongTitle["asset"] as Record<string, unknown>)["title"] = "Other";
  cases.push({ ...goodReceipt, observation: JSON.stringify(wrongTitle), observationHash: sha(JSON.stringify(wrongTitle)) });
  const wrongVersion = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  (wrongVersion["asset"] as Record<string, unknown>)["version"] = "1.0.0";
  cases.push({ ...goodReceipt, observation: JSON.stringify(wrongVersion), observationHash: sha(JSON.stringify(wrongVersion)) });
  const wrongChars = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  (wrongChars["asset"] as Record<string, unknown>)["bodyChars"] = BODY.length + 1;
  cases.push({ ...goodReceipt, observation: JSON.stringify(wrongChars), observationHash: sha(JSON.stringify(wrongChars)) });
  const extraKey = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  extraKey["extra"] = 1;
  cases.push({ ...goodReceipt, observation: JSON.stringify(extraKey), observationHash: sha(JSON.stringify(extraKey)) });
  const floatChars = JSON.parse(observation(FIRST)) as Record<string, unknown>;
  (floatChars["asset"] as Record<string, unknown>)["bodyChars"] = 1.5;
  cases.push({ ...goodReceipt, observation: JSON.stringify(floatChars), observationHash: sha(JSON.stringify(floatChars)) });
  const dupKey = `{"method":"${FIRST}","method":"${FIRST}","asset":${JSON.stringify((JSON.parse(observation(FIRST)) as Record<string, unknown>)["asset"])},"interpretation":"ADVISORY_NOT_PROOF"}`;
  cases.push({ ...goodReceipt, observation: dupKey, observationHash: sha(dupKey) });
  const lone = `{"method":"${FIRST}","asset":{"id":"${FIRST}","title":"${titleOf(FIRST)}","version":"1.1.0","body":"\\ud800","bodySha256":"${BODY_SHA}","bodyChars":1},"interpretation":"ADVISORY_NOT_PROOF"}`;
  cases.push({ ...goodReceipt, observation: lone, observationHash: sha(lone) });
  for (const bad of cases) {
    assert.throws(() => p3MethodObservation(p3EffectReceipt(bad, request), request, trusted));
  }
});

test("catalog then method load then cache then final", () => {
  const h = setup();
  const catalogFrameSent = last(h.sent);
  assert.ok("method" in catalogFrameSent && catalogFrameSent.method === "method.catalog");
  const params = catalogFrameSent.params as Record<string, unknown>;
  assert.deepEqual(Object.keys(params).sort(), ["protocolVersion", "sessionId"]);
  h.flow.handle(catalogFrame(h.sent));
  const modelParams = (last(h.sent) as { params: Record<string, unknown> }).params;
  const inner = JSON.parse((modelParams["messages"] as { content: string }[])[1]!.content) as Record<string, unknown>;
  assert.equal((inner["methodCatalog"] as unknown[]).length, 20);
  assert.deepEqual(Object.keys((inner["methodCatalog"] as Record<string, unknown>[])[0]!).sort(), ["id", "title"]);
  assert.ok(!JSON.stringify(modelParams).includes(BODY));
  h.flow.handle(model(h.sent, 1, methodText(FIRST)));
  const request = requestOf(h.sent);
  assert.equal(request.action.action, "method");
  assert.equal(request.binding.sourceRequestId, "model-1");
  h.flow.handle(effect(h.sent, methodReceipt(request, FIRST)));
  h.flow.handle(model(h.sent, 2, methodText(FIRST)));
  assert.equal(h.sent.filter((m) => "method" in m && m.method === "method.load").length, 1);
  h.flow.handle(model(h.sent, 3, FINAL));
  const result = resultOf(last(h.sent));
  assert.equal(result["status"], "candidate");
  assert.equal(result["catalogCalls"], 1);
  assert.equal(result["methodLoads"], 1);
  assert.equal(result["effectCalls"], 1);
  assert.equal(result["cachedEffects"], 1);
  assert.equal(result["modelCalls"], 3);
  assert.equal(result["candidateVerified"], false);
  assert.equal(result["strictAcceptance"], "NOT_PERFORMED");
  const publicJson = JSON.stringify(result);
  assert.ok(!publicJson.includes(BODY));
  assert.ok(!publicJson.includes(PROBLEM));
  assert.ok(!publicJson.includes(titleOf(FIRST)));
  const snapshot = h.flow.snapshot();
  const effects = snapshot["effects"] as Record<string, unknown>[];
  assert.equal(effects.length, 1);
  assert.equal(effects[0]!["source"], "METHOD_REFERENCE");
  assert.equal(effects[0]!["observation"], observation(FIRST));
  const second = (h.flow.snapshot()["privateRequests"] as Record<string, unknown>[])[1]!;
  const secondParams = second["params"] as Record<string, unknown>;
  assert.equal(secondParams["contextHash"], sha(JSON.stringify(secondParams["messages"])));
  const secondInner = JSON.parse((secondParams["messages"] as { content: string }[])[1]!.content) as Record<string, unknown>;
  assert.equal((secondInner["effects"] as unknown[]).length, 1);
  assert.equal((secondInner["history"] as unknown[]).length, 1);
});

test("empty catalog, unknown id and budget stops", () => {
  const empty = setup();
  const emptyFrame = catalogFrame(empty.sent);
  assert.ok("result" in emptyFrame);
  (emptyFrame.result as Record<string, unknown>)["catalog"] = { version: "1.1.0", entries: [] };
  empty.flow.handle(emptyFrame);
  empty.flow.handle(model(empty.sent, 1, FINAL));
  assert.equal(resultOf(last(empty.sent))["status"], "candidate");
  assert.equal(resultOf(last(empty.sent))["catalogCalls"], 1);

  const unknown = setup();
  unknown.flow.handle(catalogFrame(unknown.sent));
  unknown.flow.handle(model(unknown.sent, 1, methodText("m-99")));
  const unknownResult = resultOf(last(unknown.sent));
  assert.equal(unknownResult["stopReason"], "EFFECT_UNAVAILABLE");
  assert.equal(unknown.sent.filter((m) => "method" in m && m.method === "method.load").length, 0);

  const second = setup();
  second.flow.handle(catalogFrame(second.sent));
  second.flow.handle(model(second.sent, 1, methodText(FIRST)));
  const firstRequest = requestOf(second.sent);
  second.flow.handle(effect(second.sent, methodReceipt(firstRequest, FIRST)));
  second.flow.handle(model(second.sent, 2, methodText("m-1")));
  assert.equal(resultOf(last(second.sent))["stopReason"], "BUDGET_EXHAUSTED");

  const lastTurn = setup(2, 2, 1);
  lastTurn.flow.handle(catalogFrame(lastTurn.sent));
  lastTurn.flow.handle(model(lastTurn.sent, 1, methodText(FIRST)));
  const lastRequest = requestOf(lastTurn.sent);
  lastTurn.flow.handle(effect(lastTurn.sent, methodReceipt(lastRequest, FIRST)));
  lastTurn.flow.handle(model(lastTurn.sent, 2, methodText(FIRST)));
  assert.equal(resultOf(last(lastTurn.sent))["stopReason"], "BUDGET_EXHAUSTED");
  assert.equal(lastTurn.sent.filter((m) => "method" in m && m.method === "method.load").length, 1);

  const off = setup(3, 2, 0);
  assert.equal(off.sent.filter((m) => "method" in m && m.method === "method.catalog").length, 0);
  off.flow.handle(model(off.sent, 1, FINAL));
  assert.equal(resultOf(last(off.sent))["status"], "candidate");
  assert.equal(resultOf(last(off.sent))["catalogCalls"], 0);

  const noEffects = setup(3, 0, 1);
  assert.equal(noEffects.sent.filter((m) => "method" in m && m.method === "method.catalog").length, 0);
  noEffects.flow.handle(model(noEffects.sent, 1, methodText(FIRST)));
  assert.equal(resultOf(last(noEffects.sent))["stopReason"], "EFFECT_UNAVAILABLE");
  assert.equal(noEffects.sent.filter((m) => "method" in m && m.method === "method.load").length, 0);
});

test("method and tool share the effect budget", () => {
  const h = setup();
  h.flow.handle(catalogFrame(h.sent));
  h.flow.handle(model(h.sent, 1, methodText(FIRST)));
  const methodRequest = requestOf(h.sent);
  h.flow.handle(effect(h.sent, methodReceipt(methodRequest, FIRST)));
  h.flow.handle(model(h.sent, 2, toolText("polynomial_expand_coefficients", POLY, "expand")));
  const toolRequest = requestOf(h.sent);
  assert.equal(toolRequest.effectId, "effect-2");
  h.flow.handle(effect(h.sent, p3EffectFailure(toolRequest, "ERROR")));
  h.flow.handle(model(h.sent, 3, FINAL));
  const result = resultOf(last(h.sent));
  assert.equal(result["status"], "candidate");
  assert.equal(result["effectCalls"], 2);
  assert.equal(result["methodLoads"], 1);
  assert.equal(result["modelCalls"], 3);
  const snapshot = h.flow.snapshot();
  const effects = snapshot["effects"] as Record<string, unknown>[];
  assert.deepEqual(effects.map((entry) => entry["source"]), ["METHOD_REFERENCE", "PROGRAM_OBSERVATION"]);
  assert.equal(effects[1]!["status"], "ERROR");
});

test("method host rejects replay, forged asset and late receipts", () => {
  const h = setup();
  const ack = catalogFrame(h.sent);
  assert.ok("result" in ack);
  const before = h.flow.snapshot();
  const badAcks: Record<string, unknown>[] = [];
  badAcks.push({ ...ack, id: "node-catalog-9" });
  badAcks.push({ ...ack, result: { ...(ack.result as Record<string, unknown>), extra: 1 } });
  badAcks.push({ ...ack, result: { ...(ack.result as Record<string, unknown>), sessionId: "other" } });
  const partial = catalog();
  partial.entries = partial.entries.slice(0, 3);
  badAcks.push({ ...ack, result: { ...(ack.result as Record<string, unknown>), catalog: partial } });
  for (const bad of badAcks) {
    assert.throws(() => h.flow.handle(bad as never));
    assert.deepEqual(h.flow.snapshot(), before);
  }
  h.flow.handle(ack);
  const afterCatalog = h.flow.snapshot();
  assert.throws(() => h.flow.handle(ack));
  assert.deepEqual(h.flow.snapshot(), afterCatalog);
  h.flow.handle(model(h.sent, 1, methodText(FIRST)));
  const request = requestOf(h.sent);
  const forged: Record<string, unknown>[] = [];
  for (const mutate of [
    (asset: Record<string, unknown>) => { asset["bodySha256"] = "0".repeat(64); },
    (asset: Record<string, unknown>) => { asset["bodyChars"] = true; },
  ]) {
    const parsed = JSON.parse(observation(FIRST)) as Record<string, unknown>;
    mutate(parsed["asset"] as Record<string, unknown>);
    const text = JSON.stringify(parsed);
    forged.push({ ...(methodReceipt(request, FIRST) as Record<string, unknown>), observation: text, observationHash: sha(text) });
  }
  forged.push(p3EffectFailure(request, "UNKNOWN") as unknown as Record<string, unknown>);
  for (const receipt of forged) {
    const run = setup();
    run.flow.handle(catalogFrame(run.sent));
    run.flow.handle(model(run.sent, 1, methodText(FIRST)));
    run.flow.handle(effect(run.sent, receipt));
    const result = resultOf(last(run.sent));
    assert.equal(result["stopReason"], "EFFECT_UNKNOWN");
    assert.equal(result["candidateRequestId"], null);
    assert.equal(run.sent.filter((m) => "method" in m && m.method === "model.generate").length, 1);
    const gate = run.flow.snapshot()["effectGate"] as Record<string, unknown>[];
    assert.equal(gate.at(-1)!["state"], "OUTCOME_UNKNOWN");
  }
  const late = setup();
  late.flow.handle(catalogFrame(late.sent));
  late.flow.handle(model(late.sent, 1, methodText(FIRST)));
  const lateRequest = requestOf(late.sent);
  late.flow.handle(effect(late.sent, methodReceipt(lateRequest, FIRST), 25));
  const lateResult = resultOf(last(late.sent));
  assert.equal(lateResult["candidateRequestId"], null);
  assert.equal(lateResult["stopReason"], "DEADLINE_EXCEEDED");
  assert.equal(late.sent.filter((m) => "method" in m && m.method === "model.generate").length, 1);
  const lateCatalog = setup();
  const lateAck = catalogFrame(lateCatalog.sent);
  assert.ok("result" in lateAck);
  (lateAck.result as Record<string, unknown>)["remainingMs"] = 25;
  lateCatalog.flow.handle(lateAck);
  assert.equal(resultOf(last(lateCatalog.sent))["stopReason"], "DEADLINE_EXCEEDED");
  assert.equal(lateCatalog.sent.filter((m) => "method" in m && m.method === "model.generate").length, 0);
});
