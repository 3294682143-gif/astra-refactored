/**
 * @astra/protocol — P0 public surface.
 *
 * This package is the single normative definition of the P0 wire fields
 * (`schema/p0.schema.json`), the strict parser/validator both sides consume,
 * and the shared record/evidence type contracts. It performs no I/O, reads no
 * environment variable and issues no request.
 *
 * The type contracts below are declarations only. They do not implement any
 * mathematical decision, obligation transition or evidence promotion.
 */

export const PROTOCOL_VERSION = "1.0-p0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const LIMITS = {
  maxFrameBytes: 65536,
  maxFramesPerSession: 64,
  maxDepth: 24,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
  maxIdChars: 128,
  maxSessionIdChars: 128,
} as const;

/** Manifest format tag; the schema file is a protocol manifest, not a JSON Schema. */
export const MANIFEST_FORMAT = "astra-p0-protocol-manifest-v1" as const;
export const SCHEMA_DIALECT = "astra-p0-schema-subset-v1" as const;

/** Fixed rejection codes. Callers must not invent ad-hoc strings. */
export const ERROR_CODES = {
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  FRAME_LIMIT_EXCEEDED: "FRAME_LIMIT_EXCEEDED",
  INVALID_UTF8: "INVALID_UTF8",
  INVALID_JSON: "INVALID_JSON",
  DUPLICATE_KEY: "DUPLICATE_KEY",
  DEPTH_EXCEEDED: "DEPTH_EXCEEDED",
  UNSAFE_INTEGER: "UNSAFE_INTEGER",
  NON_FINITE_NUMBER: "NON_FINITE_NUMBER",
  FLOAT_TOKEN: "FLOAT_TOKEN",
  EXTRA_FIELD: "EXTRA_FIELD",
  MISSING_FIELD: "MISSING_FIELD",
  FIELD_TYPE: "FIELD_TYPE",
  FIELD_VALUE: "FIELD_VALUE",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  REJECTED_METHOD: "REJECTED_METHOD",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  ID_MISMATCH: "ID_MISMATCH",
  UNKNOWN_SCHEMA_KEYWORD: "UNKNOWN_SCHEMA_KEYWORD",
  MANIFEST_INVALID: "MANIFEST_INVALID",
  EOF: "EOF",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

/**
 * Public failure surface. `detail` may echo raw input and must never be
 * emitted on the wire; transports report the fixed `code` only.
 */
export function publicFailure(result: { readonly ok: false; readonly code: ErrorCode }): {
  readonly code: ErrorCode;
} {
  return { code: result.code };
}

/** P0 methods actually enabled on this probe. */
export const P0_METHODS = [
  "runtime.initialize",
  "runtime.probe",
  "method.catalog",
  "session.stop",
] as const;
export type P0Method = (typeof P0_METHODS)[number];

/** Production operations that this probe must explicitly refuse. */
export const REJECTED_METHODS = [
  "model.generate",
  "tool.execute",
  "session.solve",
  "method.load",
  "session.event",
] as const;

// ---------------------------------------------------------------------------
// Shared record envelope (final plan section 2.4). Type contract only.
// ---------------------------------------------------------------------------

export type SourceModule = "M1" | "M2" | "M3" | "M4" | "M5" | "HOST";

export interface RecordEnvelope {
  readonly recordId: string;
  readonly sessionId: string;
  readonly problemHash: string;
  readonly sourceModule: SourceModule;
  readonly taskId?: string;
  readonly contractVersion: number;
  readonly artifactId?: string;
  readonly artifactVersion?: number;
  readonly scopeId?: string;
  readonly causeEventId?: string;
  readonly eventSeq: number;
}

/** Explicit composition of a scope. A hash confirms identity, not equivalence. */
export interface Scope {
  readonly scopeId: string;
  readonly domain: string;
  readonly variableBindings: Readonly<Record<string, string>>;
  readonly quantifiers: readonly string[];
  readonly localAssumptions: readonly string[];
  readonly branchConditions: readonly string[];
  readonly referenceablePremises: readonly string[];
}

// ---------------------------------------------------------------------------
// Four orthogonal evidence dimensions (final plan section 7.3).
// ---------------------------------------------------------------------------

export const EVIDENCE_SOURCE = [
  "MODEL_DERIVATION",
  "MODEL_REVIEW",
  "PROGRAM_OBSERVATION",
  "NUMERIC_CHECK",
  "EXACT_INPUT_CHECK",
  "FORMAL_CHECK",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCE)[number];

export const EVIDENCE_LEVEL = [
  "PROVISIONAL",
  "REVIEWED",
  "CHECKED_SCOPE",
  "FORMAL",
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVEL)[number];

export const EVIDENCE_AVAILABILITY = [
  "ACTIVE",
  "SUSPENDED",
  "STALE",
  "REFUTED",
] as const;
export type EvidenceAvailability = (typeof EVIDENCE_AVAILABILITY)[number];

export const CHECK_RESULT = [
  "PASS",
  "FAIL",
  "UNKNOWN",
  "UNSUPPORTED",
  "ERROR",
] as const;
export type CheckResult = (typeof CHECK_RESULT)[number];

export const OBLIGATION_STATUS = [
  "OPEN",
  "IN_PROGRESS",
  "SATISFIED",
  "BLOCKED",
  "REOPENED",
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUS)[number];

export const REVIEW_STAGE = ["R0", "R1", "R2"] as const;
export type ReviewStage = (typeof REVIEW_STAGE)[number];

export const AUDIT_STAGE = ["S1", "S2", "S3"] as const;
export type AuditStage = (typeof AUDIT_STAGE)[number];

export const CHALLENGE_STATUS = [
  "OPEN",
  "CHALLENGED",
  "RESOLVED",
  "CONFIRMED",
  "UNKNOWN",
] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUS)[number];

export const DELIVERY_STATUS = [
  "COMPLETE",
  "INCOMPLETE",
  "TRUNCATED",
  "ERROR",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number];

export const EXTERNAL_CALL_STATE = [
  "ADMITTED_NOT_DISPATCHED",
  "DISPATCHED",
  "LOCALLY_RETURNED",
  "REMOTE_TERMINAL_CONFIRMED",
  "OUTCOME_UNKNOWN",
] as const;
export type ExternalCallState = (typeof EXTERNAL_CALL_STATE)[number];

// ---------------------------------------------------------------------------
// P0 message shapes.
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  readonly modelGenerate: "UNAVAILABLE" | "UNKNOWN";
  readonly toolExecute: "UNAVAILABLE" | "UNKNOWN";
  readonly methodCatalog: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  readonly maxTokens: { readonly configured: number; readonly verified: boolean };
}

export interface NodeCapabilities {
  readonly mathModelCalls: "UNAVAILABLE";
  readonly publicOutputLimit: "UNVERIFIED";
  readonly wasi: "DISABLED";
  readonly nativeToolCalls: "UNAVAILABLE";
}

export interface MethodCatalogEntry {
  readonly id: string;
  readonly title: string;
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: { readonly code: number; readonly message: string };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure;

// ---------------------------------------------------------------------------
// Protocol manifest (single normative field specification).
// ---------------------------------------------------------------------------

export interface ManifestMethod {
  readonly direction: "host-to-node" | "node-to-host";
  readonly kind: "request";
  readonly params: unknown;
  readonly result: unknown;
}

export interface ManifestEnvelopes {
  readonly request: unknown;
  readonly success: unknown;
  readonly failure: unknown;
}

export interface ProtocolManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly schemaDialect: typeof SCHEMA_DIALECT;
  readonly protocolVersion: ProtocolVersion;
  readonly limits: {
    readonly maxFrameBytes: number;
    readonly maxFramesPerSession: number;
    readonly maxDepth: number;
    readonly maxSafeInteger: number;
    readonly maxIdChars: number;
    readonly maxSessionIdChars: number;
  };
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<string, ManifestMethod>>;
  readonly rejectedMethods: readonly string[];
}

/**
 * Validate a loaded manifest against the compiled-in constants. The manifest
 * is the single field specification; the constants here are the startup
 * cross-check that the two have not drifted apart.
 */
export function validateManifest(raw: unknown): ParseResult<ProtocolManifest> {
  if (!isPlainObject(raw)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "root" };
  }
  if (raw["format"] !== MANIFEST_FORMAT) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "format" };
  }
  if (raw["schemaDialect"] !== SCHEMA_DIALECT) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "schemaDialect" };
  }
  if (raw["protocolVersion"] !== PROTOCOL_VERSION) {
    return { ok: false, code: ERROR_CODES.VERSION_MISMATCH, detail: "protocolVersion" };
  }
  const limits = raw["limits"];
  if (!isPlainObject(limits)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "limits" };
  }
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    if (limits[key] !== LIMITS[key]) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `limits.${key}` };
    }
  }
  const envelopes = raw["envelopes"];
  if (!isPlainObject(envelopes)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "envelopes" };
  }
  for (const key of ["request", "success", "failure"] as const) {
    const node = envelopes[key];
    if (!isPlainObject(node)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `envelopes.${key}` };
    }
    const supported = assertSupportedSchema(node);
    if (!supported.ok) {
      return supported;
    }
  }
  const methods = raw["methods"];
  if (!isPlainObject(methods)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "methods" };
  }
  for (const name of Object.keys(methods)) {
    if (!(P0_METHODS as readonly string[]).includes(name)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}` };
    }
  }
  for (const name of P0_METHODS) {
    const entry = methods[name];
    if (!isPlainObject(entry)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}` };
    }
    const expectedDirection = name === "method.catalog" ? "node-to-host" : "host-to-node";
    if (entry["direction"] !== expectedDirection) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}.direction` };
    }
    if (entry["kind"] !== "request") {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}.kind` };
    }
    for (const side of ["params", "result"] as const) {
      const node = entry[side];
      if (!isPlainObject(node)) {
        return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}.${side}` };
      }
      const supported = assertSupportedSchema(node);
      if (!supported.ok) {
        return supported;
      }
    }
  }
  const rejected = raw["rejectedMethods"];
  if (!Array.isArray(rejected)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "rejectedMethods" };
  }
  for (const name of REJECTED_METHODS) {
    if (!rejected.includes(name)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `rejectedMethods.${name}` };
    }
  }
  return { ok: true, value: raw as unknown as ProtocolManifest };
}

// ---------------------------------------------------------------------------
// Strict parsing primitives.
// ---------------------------------------------------------------------------

/**
 * Reject duplicate object keys before JSON.parse can silently collapse them.
 * Scans the raw text, tracking string/escape state, and records the key path
 * of the first duplicate found.
 */
export function detectDuplicateKeys(text: string): ParseResult<null> {
  const stack: Array<Set<string>> = [];
  let i = 0;
  let depth = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      if (depth > LIMITS.maxDepth) {
        return { ok: false, code: ERROR_CODES.DEPTH_EXCEEDED, detail: "object depth" };
      }
      stack.push(new Set<string>());
      i += 1;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      if (depth > LIMITS.maxDepth) {
        return { ok: false, code: ERROR_CODES.DEPTH_EXCEEDED, detail: "array depth" };
      }
      i += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch !== '"') {
      i += 1;
      continue;
    }
    // Read one JSON string literal.
    const start = i;
    i += 1;
    let escaped = false;
    while (i < n) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        i += 1;
        continue;
      }
      if (c === '"') {
        break;
      }
      i += 1;
    }
    if (i >= n) {
      return { ok: false, code: ERROR_CODES.INVALID_JSON, detail: "unterminated string" };
    }
    const literal = text.slice(start, i + 1);
    i += 1;
    // A string is a key only if the next non-space char is ':'.
    let j = i;
    while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) {
      j += 1;
    }
    if (text[j] !== ":") {
      continue;
    }
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      continue;
    }
    let key: string;
    try {
      key = JSON.parse(literal) as string;
    } catch {
      return { ok: false, code: ERROR_CODES.INVALID_JSON, detail: "bad key literal" };
    }
    if (frame.has(key)) {
      return { ok: false, code: ERROR_CODES.DUPLICATE_KEY, detail: key };
    }
    frame.add(key);
  }
  return { ok: true, value: null };
}

/** Reject numeric literals that are not safe integers (no floats, no NaN/Infinity). */
export function detectUnsafeNumbers(text: string): ParseResult<null> {
  const n = text.length;
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < n) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < n) {
        const c = text[j] as string;
        if ((c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-") {
          j += 1;
          continue;
        }
        break;
      }
      const token = text.slice(i, j);
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(token)) {
        return { ok: false, code: ERROR_CODES.FLOAT_TOKEN, detail: token };
      }
      const value = Number(token);
      if (!Number.isSafeInteger(value)) {
        return { ok: false, code: ERROR_CODES.UNSAFE_INTEGER, detail: token };
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { ok: true, value: null };
}

/**
 * Reject the JSON-invalid bare tokens `NaN`, `Infinity` and `-Infinity`.
 *
 * `JSON.parse` refuses them, but the fixed code must be `NON_FINITE_NUMBER`
 * rather than the generic `INVALID_JSON`, and the scan must not match the same
 * letters inside a string literal. Only a token that starts a value position
 * (after `:`, `,`, `[` or the frame start) and is followed by a value
 * terminator counts.
 */
export function detectNonFiniteTokens(text: string): ParseResult<null> {
  const n = text.length;
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < n) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "N" || ch === "I" || ch === "-") {
      const rest = text.slice(i);
      const match = /^-?(?:NaN|Infinity)/.exec(rest);
      if (match !== null) {
        const after = text[i + match[0].length];
        if (after === undefined || after === "," || after === "]" || after === "}" || after === " " || after === "\t" || after === "\n" || after === "\r") {
          return { ok: false, code: ERROR_CODES.NON_FINITE_NUMBER, detail: match[0] };
        }
      }
    }
    i += 1;
  }
  return { ok: true, value: null };
}

/** Decode one NDJSON frame from raw bytes with strict UTF-8 and size checks. */
export function decodeFrame(bytes: Uint8Array): ParseResult<string> {
  if (bytes.byteLength > LIMITS.maxFrameBytes) {
    return { ok: false, code: ERROR_CODES.FRAME_TOO_LARGE, detail: String(bytes.byteLength) };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_UTF8, detail: "decode" };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, code: ERROR_CODES.INVALID_UTF8, detail: "bom" };
  }
  return { ok: true, value: text };
}

/** Full strict parse of one frame: UTF-8, size, duplicate keys, numbers, JSON. */
export function parseFrame(
  bytes: Uint8Array,
  manifest: Pick<ProtocolManifest, "envelopes">,
): ParseResult<JsonRpcMessage> {
  const decoded = decodeFrame(bytes);
  if (!decoded.ok) {
    return decoded;
  }
  const text = decoded.value;
  const dup = detectDuplicateKeys(text);
  if (!dup.ok) {
    return dup;
  }
  const nonFinite = detectNonFiniteTokens(text);
  if (!nonFinite.ok) {
    return nonFinite;
  }
  const nums = detectUnsafeNumbers(text);
  if (!nums.ok) {
    return nums;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_JSON, detail: "parse" };
  }
  const surrogates = detectLoneSurrogates(raw);
  if (!surrogates.ok) {
    return surrogates;
  }
  return validateMessage(raw, manifest);
}

/**
 * Reject a lone surrogate anywhere in the parsed tree, including keys and
 * unknown fields that no schema node declares. A well-formed pair is allowed.
 */
export function detectLoneSurrogates(value: unknown): ParseResult<null> {
  if (typeof value === "string") {
    return codePointLength(value) === null
      ? { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "surrogate" }
      : { ok: true, value: null };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = detectLoneSurrogates(item);
      if (!r.ok) {
        return r;
      }
    }
    return { ok: true, value: null };
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (codePointLength(key) === null) {
        return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "surrogate" };
      }
      const r = detectLoneSurrogates(value[key]);
      if (!r.ok) {
        return r;
      }
    }
  }
  return { ok: true, value: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an already-parsed value against the P0 envelope shape.
 *
 * The manifest is mandatory: its `envelopes` nodes are the normative field
 * specification and both sides must pass the same manifest. There is no
 * compiled-in fallback shape check.
 */
export function validateMessage(
  raw: unknown,
  manifest: Pick<ProtocolManifest, "envelopes">,
): ParseResult<JsonRpcMessage> {
  if (!isPlainObject(raw)) {
    return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "envelope" };
  }
  if (raw["jsonrpc"] !== "2.0") {
    return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "jsonrpc" };
  }
  const hasMethod = "method" in raw;
  const hasResult = "result" in raw;
  const hasError = "error" in raw;
  const shape = hasMethod ? "request" : hasResult && !hasError ? "success" : hasError && !hasResult ? "failure" : null;
  if (shape === null) {
    return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "envelope shape" };
  }
  const node = manifest.envelopes[shape];
  const checked = validateAgainstSchema(raw, node);
  if (!checked.ok) {
    return checked;
  }
  if (hasMethod) {
    if (!isValidId(raw["id"])) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "id" };
    }
    if (typeof raw["method"] !== "string" || raw["method"].length === 0) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "method" };
    }
    if (!isPlainObject(raw["params"])) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "params" };
    }
    return {
      ok: true,
      value: {
        jsonrpc: "2.0",
        id: raw["id"],
        method: raw["method"],
        params: raw["params"],
      },
    };
  }
  if (hasResult && !hasError) {
    if (!isValidId(raw["id"])) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "id" };
    }
    if (!isPlainObject(raw["result"])) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "result" };
    }
    return { ok: true, value: { jsonrpc: "2.0", id: raw["id"], result: raw["result"] } };
  }
  if (hasError && !hasResult) {
    const id = raw["id"];
    if (id !== null && !isValidId(id)) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "id" };
    }
    const error = raw["error"];
    if (!isPlainObject(error)) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "error" };
    }
    for (const key of Object.keys(error)) {
      if (key !== "code" && key !== "message") {
        return { ok: false, code: ERROR_CODES.EXTRA_FIELD, detail: "error" };
      }
    }
    if (!Object.hasOwn(error, "code")) {
      return { ok: false, code: ERROR_CODES.MISSING_FIELD, detail: "error.code" };
    }
    if (!Object.hasOwn(error, "message")) {
      return { ok: false, code: ERROR_CODES.MISSING_FIELD, detail: "error.message" };
    }
    if (typeof error["code"] !== "number" || !Number.isSafeInteger(error["code"])) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "error.code" };
    }
    if (typeof error["message"] !== "string") {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "error.message" };
    }
    return {
      ok: true,
      value: {
        jsonrpc: "2.0",
        id,
        error: { code: error["code"], message: error["message"] },
      },
    };
  }
  return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "envelope shape" };
}

/** A valid id is a non-empty string of at most maxIdChars code points. */
function isValidId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const length = codePointLength(value);
  return length !== null && length >= 1 && length <= LIMITS.maxIdChars;
}

/** Classify a method name against the P0 allowlist and the rejected set. */
export function classifyMethod(method: string): ParseResult<P0Method> {
  if ((REJECTED_METHODS as readonly string[]).includes(method)) {
    return { ok: false, code: ERROR_CODES.REJECTED_METHOD, detail: method };
  }
  if ((P0_METHODS as readonly string[]).includes(method)) {
    return { ok: true, value: method as P0Method };
  }
  return { ok: false, code: ERROR_CODES.UNKNOWN_METHOD, detail: method };
}

/** Check protocolVersion and sessionId binding for one request. */
export function checkBinding(
  params: Record<string, unknown>,
  expectedSessionId: string,
): ParseResult<null> {
  if (params["protocolVersion"] !== PROTOCOL_VERSION) {
    return { ok: false, code: ERROR_CODES.VERSION_MISMATCH, detail: "protocolVersion" };
  }
  if (params["sessionId"] !== expectedSessionId) {
    return { ok: false, code: ERROR_CODES.SESSION_MISMATCH, detail: "sessionId" };
  }
  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------
// Minimal generic schema-subset validator.
// ---------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = new Set([
  "title",
  "description",
  "type",
  "additionalProperties",
  "required",
  "properties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "maxItems",
]);

/**
 * Supported `type` names. `number` is deliberately absent: the P0 manifest
 * never uses it, and admitting it would let a float through a channel whose
 * only numeric type is a safe integer. A schema that asks for `number` is an
 * unsupported keyword, not a silently widened check.
 */
const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "boolean",
  "integer",
  "null",
]);

const BOUND_KEYWORDS = ["minimum", "maximum", "minLength", "maxLength", "maxItems"] as const;

/** A JSON scalar admissible in `enum`/`const`: null, string, bool, safe int. */
function isScalarLiteral(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isSafeInteger(value);
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

/**
 * Compare a value against a scalar `const`/`enum` literal.
 *
 * `true === 1` and `false === 0` are false in JS, but Python's `True == 1`
 * is true, so a bare `===`/`==` would make the two sides disagree. Booleans
 * therefore only ever equal booleans, and numbers only ever equal numbers.
 */
function scalarEquals(value: unknown, literal: unknown): boolean {
  if (typeof literal === "boolean") {
    return typeof value === "boolean" && value === literal;
  }
  if (typeof literal === "number") {
    return typeof value === "number" && value === literal;
  }
  if (typeof literal === "string") {
    return typeof value === "string" && value === literal;
  }
  if (literal === null) {
    return value === null;
  }
  return false;
}

/**
 * Reject a schema node that uses keywords this validator does not implement.
 *
 * Only genuine schema nodes are inspected. The keys of a `properties` object
 * are field names, not keywords, so each value is recursed instead; `items`
 * is recursed as a schema; `enum` and `required` are value arrays and are not
 * part of the schema tree. Unknown keywords are never silently ignored.
 */
export function assertSupportedSchema(schema: unknown): ParseResult<null> {
  if (!isPlainObject(schema)) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "schema node" };
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: key };
    }
  }
  // A keyword that is present must carry a well-typed value. `null` is a
  // present-but-invalid value, never an absent keyword.
  if (Object.hasOwn(schema, "title") && typeof schema["title"] !== "string") {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "title" };
  }
  if (Object.hasOwn(schema, "description") && typeof schema["description"] !== "string") {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "description" };
  }
  if (Object.hasOwn(schema, "type")) {
    const type = schema["type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "type" };
    }
    for (const entry of types) {
      if (typeof entry !== "string" || !SUPPORTED_TYPES.has(entry)) {
        return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "type" };
      }
    }
  }
  if (Object.hasOwn(schema, "additionalProperties") && typeof schema["additionalProperties"] !== "boolean") {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "additionalProperties" };
  }
  if (Object.hasOwn(schema, "required")) {
    const required = schema["required"];
    if (!Array.isArray(required)) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "required" };
    }
    for (const entry of required) {
      if (typeof entry !== "string") {
        return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "required" };
      }
    }
  }
  for (const key of BOUND_KEYWORDS) {
    if (!Object.hasOwn(schema, key)) {
      continue;
    }
    const bound = schema[key];
    if (typeof bound !== "number" || !Number.isSafeInteger(bound)) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: key };
    }
    if (key === "minLength" || key === "maxLength" || key === "maxItems") {
      if (bound < 0) {
        return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: key };
      }
    }
  }
  const minimum = schema["minimum"];
  const maximum = schema["maximum"];
  if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "minimum" };
  }
  const minLength = schema["minLength"];
  const maxLength = schema["maxLength"];
  if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "minLength" };
  }
  if (Object.hasOwn(schema, "enum")) {
    const enumValues = schema["enum"];
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "enum" };
    }
    for (const entry of enumValues) {
      if (!isScalarLiteral(entry)) {
        return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "enum" };
      }
    }
  }
  if (Object.hasOwn(schema, "const") && !isScalarLiteral(schema["const"])) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "const" };
  }
  if (Object.hasOwn(schema, "properties")) {
    const properties = schema["properties"];
    if (!isPlainObject(properties)) {
      return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "properties" };
    }
    for (const name of Object.keys(properties)) {
      const r = assertSupportedSchema(properties[name]);
      if (!r.ok) {
        return r;
      }
    }
  }
  if (Object.hasOwn(schema, "items")) {
    const r = assertSupportedSchema(schema["items"]);
    if (!r.ok) {
      return r;
    }
  }
  return { ok: true, value: null };
}

/**
 * Validate a value against one schema node of the supported subset.
 *
 * The node is checked for unsupported keywords first, so an unimplemented
 * keyword such as `pattern` is a hard failure rather than a silent pass.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
): ParseResult<null> {
  if (!isPlainObject(schema)) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_SCHEMA_KEYWORD, detail: "schema node" };
  }
  const supported = assertSupportedSchema(schema);
  if (!supported.ok) {
    return supported;
  }
  const type = schema["type"];
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    let matched = false;
    for (const entry of types) {
      if (
        (entry === "object" && isPlainObject(value)) ||
        (entry === "array" && Array.isArray(value)) ||
        (entry === "string" && typeof value === "string") ||
        (entry === "boolean" && typeof value === "boolean") ||
        (entry === "null" && value === null) ||
        (entry === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
        (entry === "number" && typeof value === "number" && Number.isFinite(value))
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { ok: false, code: ERROR_CODES.FIELD_TYPE, detail: "type" };
    }
  }
  const constValue = schema["const"];
  if (Object.hasOwn(schema, "const") && !scalarEquals(value, constValue)) {
    return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "const" };
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((entry) => scalarEquals(value, entry))) {
    return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "enum" };
  }
  if (typeof value === "string") {
    const length = codePointLength(value);
    if (length === null) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "surrogate" };
    }
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && length < minLength) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "minLength" };
    }
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && length > maxLength) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "maxLength" };
    }
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "minimum" };
    }
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "maximum" };
    }
  }
  if (Array.isArray(value)) {
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      return { ok: false, code: ERROR_CODES.FIELD_VALUE, detail: "maxItems" };
    }
    const items = schema["items"];
    if (items !== undefined) {
      for (const item of value) {
        const r = validateAgainstSchema(item, items);
        if (!r.ok) {
          return r;
        }
      }
    }
  }
  if (isPlainObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return { ok: false, code: ERROR_CODES.MISSING_FIELD, detail: key };
        }
      }
    }
    const properties = schema["properties"];
    const props = isPlainObject(properties) ? properties : {};
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) {
          return { ok: false, code: ERROR_CODES.EXTRA_FIELD, detail: key };
        }
      }
    }
    for (const key of Object.keys(props)) {
      if (Object.hasOwn(value, key)) {
        const r = validateAgainstSchema(value[key], props[key]);
        if (!r.ok) {
          return r;
        }
      }
    }
  }
  return { ok: true, value: null };
}

export * from "./p1.js";
export * from "./p2.js";
export * from "./p2-methods.js";
export * from "./p2-a2.js";
export * from "./p2-host.js";
export * from "./p3.js";
export * from "./p3-host.js";
export * from "./p4.js";
export * from "./p4-binding.js";
export * from "./p4-repair.js";
export * from "./p4-mapping.js";
export * from "./p4-recheck.js";
export * from "./p4-r0.js";
