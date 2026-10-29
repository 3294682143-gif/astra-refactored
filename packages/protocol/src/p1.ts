/**
 * @astra/protocol — P1 offline local protocol surface.
 *
 * Declarations plus the strict P1 manifest check and payload helpers. No I/O,
 * no environment access, no network. The P1 manifest is a separate file
 * (`schema/p1.schema.json`) consumed by both sides; the constants here are the
 * startup cross-check that the two have not drifted apart.
 */

import {
  ERROR_CODES,
  LIMITS,
  assertSupportedSchema,
  parseFrame,
  validateAgainstSchema,
  type ErrorCode,
  type JsonRpcMessage,
  type ManifestEnvelopes,
  type ParseResult,
  type RecordEnvelope,
} from "./index.js";

export const P1_PROTOCOL_VERSION = "1.0-p1-local" as const;
export type P1ProtocolVersion = typeof P1_PROTOCOL_VERSION;

export const P1_MANIFEST_FORMAT = "astra-p1-local-manifest-v1" as const;

/**
 * P1 reuses the P0 schema dialect verbatim. The literal is repeated rather
 * than aliased to `SCHEMA_DIALECT`: this module is re-exported from
 * `index.ts`, so a top-level read of an `index.ts` binding would be a
 * temporal-dead-zone read that breaks P0 as well.
 */
export const P1_SCHEMA_DIALECT = "astra-p0-schema-subset-v1" as const;

export const P1_METHODS = [
  "runtime.initialize",
  "session.solve",
  "model.generate",
  "session.stop",
] as const;
export type P1Method = (typeof P1_METHODS)[number];

export const P1_METHOD_DIRECTION: Readonly<Record<P1Method, "host-to-node" | "node-to-host">> = {
  "runtime.initialize": "host-to-node",
  "session.solve": "host-to-node",
  "model.generate": "node-to-host",
  "session.stop": "host-to-node",
};

export const P1_MODE = "MOCK_ONLY" as const;
export type P1Mode = typeof P1_MODE;

export const P1_TARGET_ENVIRONMENT = "TARGET_UNVERIFIED" as const;
export type P1TargetEnvironment = typeof P1_TARGET_ENVIRONMENT;

export const P1_MAX_TOKENS = 8192 as const;
export const P1_MAX_MODEL_CALLS = 1 as const;
export const P1_MAX_TRACE_EVENTS = 24 as const;
export const P1_MAX_PROBLEM_CHARS = 8192 as const;
export const P1_MAX_RESPONSE_CHARS = 12000 as const;
export const P1_MAX_MESSAGE_CHARS = 8192 as const;
export const P1_MAX_REMAINING_MS = 5000 as const;
export const P1_MODEL_REQUEST_ID = "model-1" as const;

/**
 * The fixed system template. It lives in the protocol package so the manifest
 * can carry it and the Python Host can compare the exact text it receives
 * instead of keeping a second copy of the string.
 */
export const P1_SYSTEM_PROMPT =
  "You are a mathematical assistant in an offline local prototype. Answer the user's problem directly and completely. Do not emit protocol frames, tool calls or metadata." as const;

/** Admission decision shape shared by the runtime core and the gateway. */
export interface P1AdmissionDecision {
  readonly admitted: boolean;
  readonly reason: "ADMITTED" | "BUDGET_EXHAUSTED";
}

/** P1 delivery status union. P0 `DELIVERY_STATUS` is left untouched. */
export const P1_DELIVERY_STATUS = ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const;
export type P1DeliveryStatus = (typeof P1_DELIVERY_STATUS)[number];

export const P1_SOLVE_STATUS = ["candidate", "unsolved"] as const;
export type P1SolveStatus = (typeof P1_SOLVE_STATUS)[number];

export const P1_STRICT_ACCEPTANCE = "NOT_PERFORMED" as const;
export type P1StrictAcceptance = typeof P1_STRICT_ACCEPTANCE;

export const P1_REVIEW_STATUS = ["SKIPPED_BY_POLICY", "UNKNOWN"] as const;
export type P1ReviewStatus = (typeof P1_REVIEW_STATUS)[number];

/** Fixed trace event types. Arbitrary source text is never an event type. */
export const P1_EVENT_TYPE = [
  "SESSION_INITIALIZED",
  "CONTRACT_CREATED",
  "MODEL_ADMITTED",
  "MODEL_BUDGET_EXHAUSTED",
  "MODEL_RETURNED",
  "MODEL_TRUNCATED",
  "MODEL_ERROR",
  "MODEL_UNKNOWN",
  "EMPTY_OUTPUT",
  "REVIEW_SKIPPED",
  "BEST_EFFORT",
  "NO_CANDIDATE",
  "FINALIZED",
  "STOPPED",
] as const;
export type P1EventType = (typeof P1_EVENT_TYPE)[number];

/** Fixed reason codes. Arbitrary source text is never a reason. */
export const P1_REASON = [
  "START",
  "CONTRACT_CREATED",
  "ADMITTED",
  "BUDGET_EXHAUSTED",
  "MODEL_RETURNED",
  "MODEL_TRUNCATED",
  "MODEL_ERROR",
  "MODEL_UNKNOWN",
  "EMPTY_OUTPUT",
  "REVIEW_SKIPPED",
  "BEST_EFFORT",
  "NO_CANDIDATE",
  "FINALIZED",
  "STOPPED",
] as const;
export type P1Reason = (typeof P1_REASON)[number];

export const P1_MESSAGE_ROLE = ["system", "user"] as const;
export type P1MessageRole = (typeof P1_MESSAGE_ROLE)[number];

// ---------------------------------------------------------------------------
// P1 domain types (declarations only; no module behaviour here).
// ---------------------------------------------------------------------------

/** M1 contract: original problem text plus one still-open ANSWER_REQUEST. */
export interface P1Contract {
  readonly envelope: RecordEnvelope;
  readonly problemFullText: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly obligations: readonly P1Obligation[];
}

export interface P1Obligation {
  readonly obligationId: string;
  readonly kind: "ANSWER_REQUEST";
  readonly status: "OPEN";
}

/** M3 work result derived from one model receipt. */
export interface P1WorkResult {
  readonly envelope: RecordEnvelope;
  readonly deliveryStatus: P1DeliveryStatus;
  readonly text: string;
  readonly sourceRequestId: string;
  readonly provisional: true;
}

/** M4 review outcome for this phase: no semantic review is performed. */
export interface P1ReviewResult {
  readonly envelope: RecordEnvelope;
  readonly status: P1ReviewStatus;
  readonly candidateVerified: false;
  readonly strictAcceptance: P1StrictAcceptance;
}

/** M5 lowest final selection. A candidate is never a verified answer. */
export interface P1FinalDecision {
  readonly envelope: RecordEnvelope;
  readonly status: P1SolveStatus;
  readonly finalResponse: string;
  readonly candidateVerified: false;
  readonly strictAcceptance: P1StrictAcceptance;
}

export interface P1TraceEvent {
  readonly seq: number;
  readonly eventType: P1EventType;
  readonly sourceModule: RecordEnvelope["sourceModule"];
  readonly reason: P1Reason;
}

export interface P1ModelMessage {
  readonly role: P1MessageRole;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// P1 manifest.
// ---------------------------------------------------------------------------

export interface P1ManifestMethod {
  readonly direction: "host-to-node" | "node-to-host";
  readonly kind: "request";
  readonly params: unknown;
  readonly result: unknown;
}

export interface P1Manifest {
  readonly format: typeof P1_MANIFEST_FORMAT;
  readonly schemaDialect: typeof P1_SCHEMA_DIALECT;
  readonly protocolVersion: P1ProtocolVersion;
  readonly systemPrompt: typeof P1_SYSTEM_PROMPT;
  readonly limits: {
    readonly maxFrameBytes: number;
    readonly maxFramesPerSession: number;
    readonly maxDepth: number;
    readonly maxSafeInteger: number;
    readonly maxIdChars: number;
    readonly maxSessionIdChars: number;
  };
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<string, P1ManifestMethod>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a loaded P1 manifest against the compiled-in constants. Every
 * schema node must pass `assertSupportedSchema`, so an unimplemented keyword
 * is a hard failure rather than a silently widened check.
 */
export function validateP1Manifest(raw: unknown): ParseResult<P1Manifest> {
  if (!isPlainObject(raw)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "root" };
  }
  if (raw["format"] !== P1_MANIFEST_FORMAT) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "format" };
  }
  if (raw["schemaDialect"] !== P1_SCHEMA_DIALECT) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "schemaDialect" };
  }
  if (raw["protocolVersion"] !== P1_PROTOCOL_VERSION) {
    return { ok: false, code: ERROR_CODES.VERSION_MISMATCH, detail: "protocolVersion" };
  }
  if (raw["systemPrompt"] !== P1_SYSTEM_PROMPT) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "systemPrompt" };
  }
  const limits = raw["limits"];
  if (!isPlainObject(limits)) {
    return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: "limits" };
  }
  // `LIMITS` is read inside the function body, after `index.ts` finished
  // evaluating, so the cycle is safe here.
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
    if (!(P1_METHODS as readonly string[]).includes(name)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}` };
    }
  }
  for (const name of P1_METHODS) {
    const entry = methods[name];
    if (!isPlainObject(entry)) {
      return { ok: false, code: ERROR_CODES.MANIFEST_INVALID, detail: `methods.${name}` };
    }
    if (entry["direction"] !== P1_METHOD_DIRECTION[name]) {
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
  return { ok: true, value: raw as unknown as P1Manifest };
}

/** Classify a method name against the P1 allowlist. */
export function classifyP1Method(method: string): ParseResult<P1Method> {
  if ((P1_METHODS as readonly string[]).includes(method)) {
    return { ok: true, value: method as P1Method };
  }
  return { ok: false, code: ERROR_CODES.UNKNOWN_METHOD, detail: method };
}

/**
 * Rebuild the event identity of one trace event. A record id
 * (`session:mN:1`) is not an event id: the public trace carries only
 * `sessionId` + `seq`, so the event id is derived from those two values and
 * never stored as a second, possibly divergent field.
 */
export function p1EventId(sessionId: string, eventSeq: number): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new RangeError("sessionId");
  }
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 1) {
    throw new RangeError("eventSeq");
  }
  return `${sessionId}:event:${eventSeq}`;
}

/** Check protocolVersion and sessionId binding for one P1 request. */
export function checkP1Binding(
  params: Record<string, unknown>,
  expectedSessionId: string,
): ParseResult<null> {
  if (params["protocolVersion"] !== P1_PROTOCOL_VERSION) {
    return { ok: false, code: ERROR_CODES.VERSION_MISMATCH, detail: "protocolVersion" };
  }
  if (params["sessionId"] !== expectedSessionId) {
    return { ok: false, code: ERROR_CODES.SESSION_MISMATCH, detail: "sessionId" };
  }
  return { ok: true, value: null };
}

/**
 * Validate one P1 payload against the manifest node for that method side.
 * The manifest is mandatory; there is no compiled-in fallback shape check.
 */
export function validateP1Payload(
  method: string,
  side: "params" | "result",
  value: unknown,
  manifest: P1Manifest,
): ParseResult<null> {
  const entry = manifest.methods[method];
  if (entry === undefined) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_METHOD, detail: method };
  }
  return validateAgainstSchema(value, entry[side]);
}

/**
 * Strict parse of one P1 frame. Calls the P0 `parseFrame` directly with only
 * the `envelopes` node, so the P1 manifest can never be cast into a P0
 * manifest, no caller can inject a looser parser, and no second parser exists.
 */
export function parseP1Frame(
  bytes: Uint8Array,
  manifest: P1Manifest,
): ParseResult<JsonRpcMessage> {
  return parseFrame(bytes, { envelopes: manifest.envelopes });
}

export type { ErrorCode };
