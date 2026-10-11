/**
 * @astra/runtime-core — a2 short-path data validation (pure data only).
 *
 * No I/O, no filesystem, no network, no client, no method dispatch and no
 * tool execution. A hash here is data integrity, not authentication and not
 * a mathematical proof.
 */

import { createHash } from "node:crypto";

import {
  P2_ERROR_CODES,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  type A2Profile,
  type A2Request,
} from "@astra/protocol";

const MAX_BYTES = 262144;
const MAX_INPUT_CHARS = 60000;
const MAX_METHOD_CHARS = 12000;
const MAX_PROMPT_CHARS = 24000;
const MAX_NOTE_CHARS = 1024;
const MAX_TITLE_CHARS = 256;
const MAX_MESSAGES = 16;
const MAX_TOKENS_MAX = 8192;

const TEMPERATURES = ["0", "0.2", "1"] as const;
const ROLES = ["system", "user", "assistant"] as const;
const SOURCE_NAMES = [
  "mathagent/__init__.py",
  "mathagent/lite/runtime.py",
  "mathagent/lite/protocol.py",
  "mathagent/lite/methods.py",
  "mathagent/runtime/platform_adapter.py",
  "mathagent/runtime/platform_coordinator.py",
  "mathagent/runtime/config.py",
  "mathagent/resources/general_v11/SOURCE.json",
] as const;
const PROFILE_KEYS = [
  "schemaVersion",
  "baselineVersion",
  "sources",
  "maxSteps",
  "maxMethods",
  "maxMethodChars",
  "maxInputChars",
  "temperature",
  "maxTokens",
  "systemPrompt",
  "catalogBlock",
  "turnNotes",
  "closeoutNotes",
  "forceCloseoutNote",
  "methodAsset",
  "loadedFeedback",
  "repeatedFeedback",
] as const;
const ASSET_KEYS = ["id", "title", "version", "body", "bodySha256", "bodyChars"] as const;
const REQUEST_KEYS = ["messages", "temperature", "maxTokens"] as const;
const MESSAGE_KEYS = ["role", "content"] as const;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(code: keyof typeof P2_ERROR_CODES): never {
  throw new P2Error(P2_ERROR_CODES[code]);
}

/** Count Unicode code points; a lone surrogate is rejected, not counted. */
function codePointLength(value: string): number | null {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return null;
      }
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
    count += 1;
  }
  return count;
}

/** Exact own-key check: every listed key present, no other key allowed. */
export function a2Keys(node: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    fail("PACKET_SCHEMA");
  }
  const record = node as Record<string, unknown>;
  const own = Object.keys(record);
  if (own.length !== keys.length) {
    fail("PACKET_SCHEMA");
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      fail("PACKET_SCHEMA");
    }
  }
  return record;
}

/** Bounded non-empty string with no lone surrogate. */
export function a2String(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("PACKET_SCHEMA");
  }
  const length = codePointLength(value);
  if (length === null || length > max) {
    fail("PACKET_SCHEMA");
  }
  return value;
}

/**
 * Compare two keys by Unicode code point, not UTF-16 code unit.
 *
 * `Array.prototype.sort` compares UTF-16 units, so an emoji key (surrogate
 * pair, 0xD83D…) would sort before U+E000 while Python's `sort_keys` compares
 * code points and puts U+E000 first. A shorter prefix sorts first.
 */
function compareKeys(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = (left[i] as string).codePointAt(0) as number;
    const y = (right[i] as string).codePointAt(0) as number;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/** Recursive canonical JSON: object keys sorted, array order preserved. */
function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("PACKET_SCHEMA");
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (!detectLoneSurrogates(value).ok) {
      fail("PACKET_SCHEMA");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort(compareKeys)) {
      if (!detectLoneSurrogates(key).ok) {
        fail("PACKET_SCHEMA");
      }
      parts.push(`${JSON.stringify(key)}:${serialize(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  fail("PACKET_SCHEMA");
}

/** SHA256 of canonical JSON; data integrity, not authentication. */
export function a2Hash(value: unknown): string {
  const snapshot = p2Snapshot(value);
  const text = serialize(snapshot);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_BYTES) {
    fail("BOUND_EXCEEDED");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** Strict a2 request: exact 3 keys, string temperature, bounded messages. */
export function a2Request(value: unknown): A2Request {
  const snapshot = p2Snapshot(value);
  const record = a2Keys(snapshot, REQUEST_KEYS);
  const temperature = record["temperature"];
  if (typeof temperature !== "string" || !(TEMPERATURES as readonly string[]).includes(temperature)) {
    fail("PACKET_SCHEMA");
  }
  const maxTokens = record["maxTokens"];
  if (
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_TOKENS_MAX
  ) {
    fail("PACKET_SCHEMA");
  }
  const rawMessages = record["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length < 1 || rawMessages.length > MAX_MESSAGES) {
    fail("PACKET_SCHEMA");
  }
  let totalChars = 0;
  const messages = rawMessages.map((item) => {
    const message = a2Keys(item, MESSAGE_KEYS);
    const role = message["role"];
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      fail("PACKET_SCHEMA");
    }
    const content = a2String(message["content"], MAX_INPUT_CHARS);
    totalChars += codePointLength(content) ?? 0;
    return { role: role as A2Request["messages"][number]["role"], content };
  });
  if (totalChars > MAX_INPUT_CHARS) {
    fail("BOUND_EXCEEDED");
  }
  const request: A2Request = { messages, temperature, maxTokens };
  if (Buffer.byteLength(serialize(request), "utf8") > MAX_BYTES) {
    fail("BOUND_EXCEEDED");
  }
  return p2Snapshot(request);
}

function a2Notes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("PACKET_SCHEMA");
  }
  return Object.freeze(value.map((item) => a2String(item, MAX_NOTE_CHARS)));
}

function a2Sources(value: unknown, trusted: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const record = a2Keys(value, SOURCE_NAMES);
  const trustedKeys = Object.keys(trusted);
  if (trustedKeys.length !== SOURCE_NAMES.length) {
    fail("VERSION_MISMATCH");
  }
  const out: Record<string, string> = {};
  for (const name of SOURCE_NAMES) {
    const digest = record[name];
    if (typeof digest !== "string" || !HEX64.test(digest)) {
      fail("PACKET_SCHEMA");
    }
    if (trusted[name] !== digest) {
      fail("VERSION_MISMATCH");
    }
    out[name] = digest;
  }
  return Object.freeze(out);
}

function a2MethodAsset(value: unknown): A2Profile["methodAsset"] {
  const record = a2Keys(value, ASSET_KEYS);
  if (record["id"] !== "linearization-spectral") {
    fail("PACKET_SCHEMA");
  }
  const title = a2String(record["title"], MAX_TITLE_CHARS);
  if (record["version"] !== "1.1.0") {
    fail("VERSION_MISMATCH");
  }
  const body = a2String(record["body"], MAX_METHOD_CHARS);
  const bodyChars = record["bodyChars"];
  if (typeof bodyChars !== "number" || !Number.isSafeInteger(bodyChars) || bodyChars !== codePointLength(body)) {
    fail("PACKET_SCHEMA");
  }
  const bodySha256 = record["bodySha256"];
  if (typeof bodySha256 !== "string" || !HEX64.test(bodySha256)) {
    fail("PACKET_SCHEMA");
  }
  if (createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex") !== bodySha256) {
    fail("PACKET_BINDING");
  }
  return Object.freeze({
    id: "linearization-spectral",
    title,
    version: "1.1.0",
    body,
    bodySha256,
    bodyChars,
  });
}

/** Strict a2 profile bound to a trusted source lock. */
export function a2Profile(
  value: unknown,
  trustedSources: Readonly<Record<string, string>>,
): A2Profile {
  const snapshot = p2Snapshot(value);
  const record = a2Keys(snapshot, PROFILE_KEYS);
  if (record["schemaVersion"] !== "a2-shortpath-profile-v1") {
    fail("PACKET_SCHEMA");
  }
  if (record["baselineVersion"] !== "0.10.0a2") {
    fail("VERSION_MISMATCH");
  }
  const sources = a2Sources(record["sources"], trustedSources);
  const maxSteps = record["maxSteps"];
  if (maxSteps !== 1 && maxSteps !== 3) {
    fail("PACKET_SCHEMA");
  }
  if (record["maxMethods"] !== 2 || record["maxMethodChars"] !== MAX_METHOD_CHARS || record["maxInputChars"] !== MAX_INPUT_CHARS) {
    fail("PACKET_SCHEMA");
  }
  if (record["temperature"] !== "0.2" || record["maxTokens"] !== 8192) {
    fail("PACKET_SCHEMA");
  }
  const systemPrompt = a2String(record["systemPrompt"], MAX_PROMPT_CHARS);
  const catalogBlock = a2String(record["catalogBlock"], MAX_PROMPT_CHARS);
  const forceCloseoutNote = a2String(record["forceCloseoutNote"], MAX_PROMPT_CHARS);
  const loadedFeedback = a2String(record["loadedFeedback"], MAX_PROMPT_CHARS);
  const repeatedFeedback = a2String(record["repeatedFeedback"], MAX_PROMPT_CHARS);
  const turnNotes = a2Notes(record["turnNotes"]);
  const closeoutNotes = a2Notes(record["closeoutNotes"]);
  const methodAsset = a2MethodAsset(record["methodAsset"]);
  if (!loadedFeedback.endsWith(methodAsset.body)) {
    fail("PACKET_BINDING");
  }
  if (!loadedFeedback.includes(methodAsset.id) || !loadedFeedback.includes(methodAsset.title)) {
    fail("PACKET_BINDING");
  }
  const profile: A2Profile = {
    schemaVersion: "a2-shortpath-profile-v1",
    baselineVersion: "0.10.0a2",
    sources,
    maxSteps,
    maxMethods: 2,
    maxMethodChars: MAX_METHOD_CHARS,
    maxInputChars: MAX_INPUT_CHARS,
    temperature: "0.2",
    maxTokens: 8192,
    systemPrompt,
    catalogBlock,
    turnNotes,
    closeoutNotes,
    forceCloseoutNote,
    methodAsset,
    loadedFeedback,
    repeatedFeedback,
  };
  if (Buffer.byteLength(serialize(profile), "utf8") > MAX_BYTES) {
    fail("BOUND_EXCEEDED");
  }
  return Object.freeze(profile);
}
