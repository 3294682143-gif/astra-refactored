/**
 * @astra/math-gateway — P3 strict action parser (pure, no I/O).
 *
 * Reuses the shared protocol scanners instead of a second JSON reader. Every
 * rejection is a fixed `P2Error` code; raw input and JSON exception messages
 * are never exposed. A parsed action is data, not an admission and not a
 * mathematical claim.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  P3_TOOL_NAMES,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  type P3Action,
  type P3ToolName,
} from "@astra/protocol";

export { P3_TOOL_NAMES };

const MAX_TEXT_CHARS = 20000;
const MAX_ARGS_BYTES = 10000;
const MAX_SCOPE_CHARS = 256;
/** Stage D+ exploration: model-authored source bound, in UTF-8 bytes. */
const MAX_CODE_BYTES = 65536;
const MAX_ANSWER_CHARS = 4096;
const MAX_REASON_CHARS = 256;
const MAX_UNRESOLVED = 32;
const MAX_METHOD_ID_CHARS = 64;
const METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (value.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...value].length > maxChars) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function parseTool(value: Record<string, unknown>): P3Action {
  if (!exactKeys(value, ["action", "name", "args", "scope"])) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (typeof value.name !== "string" || !(P3_TOOL_NAMES as readonly string[]).includes(value.name)) {
    fail(P2_ERROR_CODES.NOT_REUSABLE);
  }
  if (!isPlainObject(value.args)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const argsBytes = Buffer.byteLength(JSON.stringify(value.args), "utf8");
  if (argsBytes > MAX_ARGS_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const scope = boundedString(value.scope, MAX_SCOPE_CHARS);
  return p2Snapshot({
    action: "tool",
    name: value.name as P3ToolName,
    args: value.args,
    scope,
  }) as P3Action;
}

function parseMathAsset(value: Record<string, unknown>): P3Action {
  const allowed = ["action", "assetId", "input"];
  const optional = ["target", "scope"];
  const keys = Object.keys(value);
  const hasRequired = allowed.every((k) => keys.includes(k));
  const allAllowed = keys.every((k) => allowed.includes(k) || optional.includes(k));
  if (!hasRequired || !allAllowed) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (typeof value.assetId !== "string" || value.assetId.trim().length === 0 || value.assetId.length > 64) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (
    value.target !== undefined &&
    (typeof value.target !== "string" || value.target.trim().length === 0 || value.target.length > 64)
  ) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!isPlainObject(value.input)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(value.input), "utf8");
  if (inputBytes > MAX_ARGS_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const target = typeof value.target === "string" ? boundedString(value.target, 64) : undefined;
  const scope = typeof value.scope === "string" ? boundedString(value.scope, MAX_SCOPE_CHARS) : undefined;
  return p2Snapshot({
    action: "math_asset",
    assetId: value.assetId,
    ...(target !== undefined ? { target } : {}),
    input: value.input,
    ...(scope !== undefined ? { scope } : {}),
  }) as P3Action;
}

function parseMethod(value: Record<string, unknown>): P3Action {
  if (!exactKeys(value, ["action", "id"])) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > MAX_METHOD_ID_CHARS || !METHOD_ID.test(value.id)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return p2Snapshot({ action: "method", id: value.id }) as P3Action;
}

/**
 * Stage D+ controlled exploration: `{action:"explore", code, scope}`.
 *
 * Strict like every other shape: the exact three keys, `code` a non-empty
 * string of at most 65536 UTF-8 bytes, `scope` a non-blank string of at most
 * 256 code points. A parse is only a request: no admission, no execution and
 * no evidence claim lives here.
 */
function parseExplore(value: Record<string, unknown>): P3Action {
  if (!exactKeys(value, ["action", "code", "scope"])) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const code = value.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const scope = boundedString(value.scope, MAX_SCOPE_CHARS);
  return p2Snapshot({ action: "explore", code, scope }) as P3Action;
}

function parseFinal(value: Record<string, unknown>): P3Action {
  if (!exactKeys(value, ["action", "answer", "complete", "unresolved"])) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const answer = boundedString(value.answer, MAX_ANSWER_CHARS);
  if (typeof value.complete !== "boolean") {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!Array.isArray(value.unresolved) || value.unresolved.length > MAX_UNRESOLVED) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const unresolved: string[] = [];
  for (const item of value.unresolved) {
    unresolved.push(boundedString(item, MAX_REASON_CHARS));
  }
  return p2Snapshot({
    action: "final",
    answer,
    complete: value.complete,
    unresolved,
  }) as P3Action;
}

function parseUnsolved(value: Record<string, unknown>): P3Action {
  if (!exactKeys(value, ["action", "reason"])) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const reason = boundedString(value.reason, MAX_REASON_CHARS);
  return p2Snapshot({ action: "unsolved", reason }) as P3Action;
}

/**
 * Strict parse of one model action from raw text.
 *
 * Order: lone-surrogate scan of the input string, shared frame decode (UTF-8
 * and byte bound), duplicate keys, non-finite tokens, unsafe numbers, JSON
 * parse, plain-object check, then the exact per-action shape. Depth is bounded
 * by the shared scanners and `p2Snapshot`; nothing is evaluated.
 */
export function parseP3Action(text: string): P3Action {
  if (typeof text !== "string") {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if ([...text].length > MAX_TEXT_CHARS) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (!detectLoneSurrogates(text).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const decoded = decodeFrame(Buffer.from(text, "utf8"));
  if (!decoded.ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const raw = decoded.value;
  if (!detectDuplicateKeys(raw).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!detectNonFiniteTokens(raw).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!detectUnsafeNumbers(raw).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!detectLoneSurrogates(parsed).ok) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  if (!isPlainObject(parsed)) {
    fail(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const action = parsed.action;
  if (action === "math_asset") {
    return parseMathAsset(parsed);
  }
  if (action === "tool") {
    return parseTool(parsed);
  }
  if (action === "method") {
    return parseMethod(parsed);
  }
  if (action === "explore") {
    return parseExplore(parsed);
  }
  if (action === "final") {
    return parseFinal(parsed);
  }
  if (action === "unsolved") {
    return parseUnsolved(parsed);
  }
  fail(P2_ERROR_CODES.NOT_REUSABLE);
}
