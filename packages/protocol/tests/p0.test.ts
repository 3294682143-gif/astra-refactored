import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
  assertSupportedSchema,
  checkBinding,
  classifyMethod,
  decodeFrame,
  parseFrame,
  validateAgainstSchema,
  validateManifest,
  type ProtocolManifest,
} from "../src/index.js";

const manifestUrl = new URL(
  import.meta.resolve("@astra/protocol/schema/p0.schema.json"),
);
const manifest = (() => {
  const checked = validateManifest(JSON.parse(readFileSync(manifestUrl, "utf8")));
  assert.equal(checked.ok, true);
  return (checked as { ok: true; value: ProtocolManifest }).value;
})();

const casesUrl = new URL("../../../../tests/protocol/p0-cases.json", import.meta.url);
const cases = JSON.parse(readFileSync(casesUrl, "utf8")) as Array<{
  name: string;
  raw: string;
  ok: boolean;
  code?: string;
}>;

function frame(raw: string): Uint8Array {
  return Buffer.from(raw, "utf8");
}

test("shared corpus: envelope parseFrame", () => {
  for (const item of cases) {
    const result = parseFrame(frame(item.raw), manifest);
    assert.equal(result.ok, item.ok, item.name);
    if (!result.ok) {
      assert.equal(result.code, item.code, item.name);
    }
  }
});

test("null const is a legal scalar literal", () => {
  assert.equal(assertSupportedSchema({ const: null }).ok, true);
  assert.equal(validateAgainstSchema(null, { const: null }).ok, true);
  const mismatch = validateAgainstSchema(false, { const: null });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.code, ERROR_CODES.FIELD_VALUE);
  }
});

test("invalid utf8 bytes rejected", () => {
  const result = decodeFrame(Uint8Array.from([0x7b, 0xff, 0x7d]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ERROR_CODES.INVALID_UTF8);
  }
});

test("frame byte boundary 65536 ok / 65537 too large", () => {
  const pad = "a".repeat(LIMITS.maxFrameBytes - 2);
  const exact = frame(`"${pad}"`);
  assert.equal(exact.byteLength, LIMITS.maxFrameBytes);
  assert.equal(decodeFrame(exact).ok, true);
  const over = frame(`"${pad}x"`);
  assert.equal(over.byteLength, LIMITS.maxFrameBytes + 1);
  const result = decodeFrame(over);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ERROR_CODES.FRAME_TOO_LARGE);
  }
});

test("depth 24 ok / 25 rejected inside a legal envelope", () => {
  // Envelope depth 2 (root object + result object) + 22 nested arrays = 24.
  const okRaw = `{"jsonrpc":"2.0","id":"a","result":{"v":${"[".repeat(22)}${"]".repeat(22)}}}`;
  assert.equal(parseFrame(frame(okRaw), manifest).ok, true);
  const deepRaw = `{"jsonrpc":"2.0","id":"a","result":{"v":${"[".repeat(23)}${"]".repeat(23)}}}`;
  const result = parseFrame(frame(deepRaw), manifest);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ERROR_CODES.DEPTH_EXCEEDED);
  }
});

test("astral id 128 ok / 129 rejected", () => {
  const id128 = "\u{1f600}".repeat(128);
  const okRaw = JSON.stringify({
    jsonrpc: "2.0",
    id: id128,
    method: "session.stop",
    params: {},
  });
  assert.equal(parseFrame(frame(okRaw), manifest).ok, true);
  const id129 = "\u{1f600}".repeat(129);
  const badRaw = JSON.stringify({
    jsonrpc: "2.0",
    id: id129,
    method: "session.stop",
    params: {},
  });
  const result = parseFrame(frame(badRaw), manifest);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ERROR_CODES.FIELD_VALUE);
  }
});

test("escaped duplicate key and prototype-named extra keys rejected", () => {
  const escaped = parseFrame(
    frame('{"jsonrpc":"2.0","id":"a","\\u0069d":"b","method":"session.stop","params":{}}'),
    manifest,
  );
  assert.equal(escaped.ok, false);
  if (!escaped.ok) {
    assert.equal(escaped.code, ERROR_CODES.DUPLICATE_KEY);
  }
  for (const name of ["__proto__", "toString"]) {
    const raw = `{"jsonrpc":"2.0","id":"a","method":"session.stop","params":{},"${name}":1}`;
    const result = parseFrame(frame(raw), manifest);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.code, ERROR_CODES.EXTRA_FIELD, name);
    }
  }
});

test("unsupported schema keyword is a hard failure", () => {
  const result = assertSupportedSchema({ type: "string", pattern: "^a$" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD);
  }
});

test("failure null id ok, request null id rejected", () => {
  const failure = parseFrame(
    frame('{"jsonrpc":"2.0","id":null,"error":{"code":-1,"message":"x"}}'),
    manifest,
  );
  assert.equal(failure.ok, true);
  const request = parseFrame(
    frame('{"jsonrpc":"2.0","id":null,"method":"session.stop","params":{}}'),
    manifest,
  );
  assert.equal(request.ok, false);
});

test("manifest wrong direction and limits rejected", () => {
  const raw = JSON.parse(readFileSync(manifestUrl, "utf8")) as Record<string, unknown>;
  const wrongDirection = structuredClone(raw);
  (wrongDirection["methods"] as Record<string, Record<string, unknown>>)["method.catalog"]![
    "direction"
  ] = "host-to-node";
  assert.equal(validateManifest(wrongDirection).ok, false);
  const wrongLimits = structuredClone(raw);
  (wrongLimits["limits"] as Record<string, unknown>)["maxDepth"] = 25;
  assert.equal(validateManifest(wrongLimits).ok, false);
});

test("maxTokens verified true rejected", () => {
  const spec = manifest.methods["runtime.initialize"]!.params;
  const params = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "s1",
    clientCapabilities: {
      modelGenerate: "UNAVAILABLE",
      toolExecute: "UNAVAILABLE",
      methodCatalog: "AVAILABLE",
      maxTokens: { configured: 8192, verified: true },
    },
  };
  const result = validateAgainstSchema(params, spec);
  assert.equal(result.ok, false);
});

test("payload extra field and session binding", () => {
  const spec = manifest.methods["runtime.probe"]!.params;
  const extra = validateAgainstSchema(
    { protocolVersion: PROTOCOL_VERSION, sessionId: "s1", nonce: "n", extra: 1 },
    spec,
  );
  assert.equal(extra.ok, false);
  if (!extra.ok) {
    assert.equal(extra.code, ERROR_CODES.EXTRA_FIELD);
  }
  const wrongSession = checkBinding(
    { protocolVersion: PROTOCOL_VERSION, sessionId: "other" },
    "s1",
  );
  assert.equal(wrongSession.ok, false);
  if (!wrongSession.ok) {
    assert.equal(wrongSession.code, ERROR_CODES.SESSION_MISMATCH);
  }
  const wrongVersion = checkBinding(
    { protocolVersion: "1.0-p1", sessionId: "s1" },
    "s1",
  );
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) {
    assert.equal(wrongVersion.code, ERROR_CODES.VERSION_MISMATCH);
  }
});

test("classifyMethod allowlist and rejected set", () => {
  assert.equal(classifyMethod("runtime.probe").ok, true);
  const rejected = classifyMethod("session.solve");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.code, ERROR_CODES.REJECTED_METHOD);
  }
  const unknown = classifyMethod("runtime.unknown");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.code, ERROR_CODES.UNKNOWN_METHOD);
  }
});

test("present-but-null schema keywords are rejected, not treated as absent", () => {
  for (const node of [
    { type: null },
    { items: null },
    { additionalProperties: null },
    { required: null },
    { properties: null },
    { title: null },
    { description: null },
    { minimum: null },
    { maxLength: null },
    { enum: null },
  ]) {
    const result = assertSupportedSchema(node);
    assert.equal(result.ok, false, JSON.stringify(node));
    if (!result.ok) {
      assert.equal(result.code, ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD);
    }
  }
});

test("invalid bounds and unsupported scalar forms are rejected", () => {
  for (const node of [
    { type: "string", maxLength: -1 },
    { type: "string", minLength: 5, maxLength: 2 },
    { type: "integer", minimum: 9, maximum: 1 },
    { enum: 1 },
    { enum: [] },
    { enum: [{ a: 1 }] },
    { const: { a: 1 } },
    { const: [1] },
    { type: "number" },
  ]) {
    const result = assertSupportedSchema(node);
    assert.equal(result.ok, false, JSON.stringify(node));
    if (!result.ok) {
      assert.equal(result.code, ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD);
    }
  }
});

test("integer type rejects unsafe value and bool never equals 0", () => {
  const unsafe = validateAgainstSchema(9007199254740992, { type: "integer" });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) {
    assert.equal(unsafe.code, ERROR_CODES.FIELD_TYPE);
  }
  const boolConst = validateAgainstSchema(false, { const: 0 });
  assert.equal(boolConst.ok, false);
  if (!boolConst.ok) {
    assert.equal(boolConst.code, ERROR_CODES.FIELD_VALUE);
  }
  const boolEnum = validateAgainstSchema(false, { enum: [0, 1] });
  assert.equal(boolEnum.ok, false);
  if (!boolEnum.ok) {
    assert.equal(boolEnum.code, ERROR_CODES.FIELD_VALUE);
  }
  assert.equal(validateAgainstSchema(0, { const: 0 }).ok, true);
  assert.equal(validateAgainstSchema(false, { const: false }).ok, true);
});
