/**
 * P1 manifest and payload negative controls. The strict frame primitives are
 * already covered by the P0 tests; this file only checks that the P1 manifest
 * is really consumed by both the manifest check and the payload check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  P1_PROTOCOL_VERSION,
  parseP1Frame,
  validateP1Manifest,
  validateP1Payload,
  type P1Manifest,
} from "../src/index.js";

const RAW: unknown = JSON.parse(
  readFileSync(new URL(import.meta.resolve("@astra/protocol/schema/p1.schema.json")), "utf8"),
);

function manifest(): P1Manifest {
  const checked = validateP1Manifest(RAW);
  assert.equal(checked.ok, true);
  return (checked as { ok: true; value: P1Manifest }).value;
}

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(RAW)) as Record<string, unknown>;
}

function method(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  return (raw["methods"] as Record<string, Record<string, unknown>>)[name] as Record<string, unknown>;
}

test("the shipped P1 manifest validates", () => {
  const m = manifest();
  assert.equal(m.protocolVersion, P1_PROTOCOL_VERSION);
  assert.equal(m.methods["model.generate"]?.direction, "node-to-host");
});

test("manifest drift is rejected", () => {
  const bad = clone();
  method(bad, "runtime.initialize")["direction"] = "node-to-host";
  assert.equal(validateP1Manifest(bad).ok, false);
  const unknown = clone();
  (method(unknown, "session.solve")["params"] as Record<string, unknown>)["pattern"] = "^x$";
  assert.equal(validateP1Manifest(unknown).ok, false);
});

test("initialize params reject wrong mode, extra field and out-of-range budgets", () => {
  const m = manifest();
  const base = {
    protocolVersion: P1_PROTOCOL_VERSION,
    sessionId: "s-1",
    remainingMs: 1000,
    maxModelCalls: 1,
    maxTokens: 8192,
    mode: "MOCK_ONLY",
  };
  assert.equal(validateP1Payload("runtime.initialize", "params", base, m).ok, true);
  assert.equal(validateP1Payload("runtime.initialize", "params", { ...base, mode: "LIVE" }, m).ok, false);
  assert.equal(validateP1Payload("runtime.initialize", "params", { ...base, extra: 1 }, m).ok, false);
  assert.equal(validateP1Payload("runtime.initialize", "params", { ...base, maxModelCalls: 2 }, m).ok, false);
  assert.equal(validateP1Payload("runtime.initialize", "params", { ...base, maxTokens: 8193 }, m).ok, false);
});

test("solve result rejects a verified candidate and a performed acceptance", () => {
  const m = manifest();
  const base = {
    protocolVersion: P1_PROTOCOL_VERSION,
    sessionId: "s-1",
    status: "candidate",
    finalResponse: "4",
    candidateVerified: false,
    strictAcceptance: "NOT_PERFORMED",
    mode: "MOCK_ONLY",
    trace: [],
    modelCalls: 1,
  };
  assert.equal(validateP1Payload("session.solve", "result", base, m).ok, true);
  assert.equal(validateP1Payload("session.solve", "result", { ...base, candidateVerified: true }, m).ok, false);
  assert.equal(validateP1Payload("session.solve", "result", { ...base, strictAcceptance: "VERIFIED" }, m).ok, false);
});

test("a zero remainingMs receipt is syntactically valid", () => {
  const m = manifest();
  const receipt = {
    protocolVersion: P1_PROTOCOL_VERSION,
    sessionId: "s-1",
    requestId: "model-1",
    mode: "MOCK_ONLY",
    deliveryStatus: "COMPLETE",
    text: "4",
    remainingMs: 0,
  };
  assert.equal(validateP1Payload("model.generate", "result", receipt, m).ok, true);
});

test("parseP1Frame reuses the strict envelope checks", () => {
  const m = manifest();
  const frame = (text: string) => parseP1Frame(Buffer.from(text, "utf8"), m);
  assert.equal(frame('{"jsonrpc":"2.0","id":"host-1","error":{"code":1,"message":"x"}}').ok, true);
  assert.equal(frame('{"jsonrpc":"2.0","id":"host-1","id":"host-2","method":"session.stop","params":{}}').ok, false);
  assert.equal(parseP1Frame(Buffer.from([0xff, 0xfe]), m).ok, false);
});
