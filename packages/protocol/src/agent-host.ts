/**
 * @astra/protocol — unified AgentLoop local Host<->Node manifest surface.
 *
 * The single normative field specification is `schema/agent-host.schema.json`;
 * this module only cross-checks a loaded manifest against the compiled-in
 * constants and re-exports the shared P0 parser. No I/O, no environment
 * access, no network, no second copy of any field shape.
 */
import {
  LIMITS,
  MANIFEST_FORMAT,
  SCHEMA_DIALECT,
  assertSupportedSchema,
  parseFrame,
  p2Snapshot,
  validateAgainstSchema,
  type JsonRpcMessage,
  type ManifestEnvelopes,
  type ManifestMethod,
} from "./index.js";

export const AGENT_HOST_VERSION = "1.2-agent-loop-preview";
export type AgentHostVersion = typeof AGENT_HOST_VERSION;

/** The five methods of this local Host slice, in fixed order. */
export const AGENT_HOST_METHODS = Object.freeze([
  "runtime.initialize",
  "session.solve",
  "session.stop",
  "model.generate",
  "tool.execute",
] as const);
export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

export interface AgentHostManifest {
  readonly format: "astra-agent-host-manifest-v1";
  readonly schemaDialect: "astra-p0-schema-subset-v1";
  readonly protocolVersion: typeof AGENT_HOST_VERSION;
  readonly limits: typeof LIMITS;
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<AgentHostMethod, ManifestMethod>>;
}

const HOST_FORMAT = "astra-agent-host-manifest-v1";
const HOST_DIRECTION: Readonly<Record<AgentHostMethod, "host-to-node" | "node-to-host">> = {
  "runtime.initialize": "host-to-node",
  "session.solve": "host-to-node",
  "session.stop": "host-to-node",
  "model.generate": "node-to-host",
  "tool.execute": "node-to-host",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameLimits(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const keys = Object.keys(raw);
  const expected = Object.keys(LIMITS);
  if (keys.length !== expected.length) return false;
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return false;
    if (raw[key] !== (LIMITS as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/**
 * Validate a loaded Agent Host manifest against the compiled-in constants.
 *
 * Only the fixed codes `MANIFEST_INVALID` and `VERSION_MISMATCH` escape; raw
 * input is never echoed. An empty or widened `methods` map is invalid, and
 * every envelope/params/result node must pass the shared schema subset check.
 */
export function validateAgentHostManifest(raw: unknown): AgentHostManifest {
  if (!isPlainObject(raw)) throw new Error("MANIFEST_INVALID");
  if (raw["protocolVersion"] !== AGENT_HOST_VERSION) throw new Error("VERSION_MISMATCH");
  if (raw["format"] !== HOST_FORMAT) throw new Error("MANIFEST_INVALID");
  if (raw["schemaDialect"] !== SCHEMA_DIALECT) throw new Error("MANIFEST_INVALID");
  if (MANIFEST_FORMAT !== "astra-p0-protocol-manifest-v1") throw new Error("MANIFEST_INVALID");
  if (!sameLimits(raw["limits"])) throw new Error("MANIFEST_INVALID");

  const envelopes = raw["envelopes"];
  if (!isPlainObject(envelopes)) throw new Error("MANIFEST_INVALID");
  const envelopeKeys = Object.keys(envelopes);
  if (envelopeKeys.length !== 3) throw new Error("MANIFEST_INVALID");
  for (const key of ["request", "success", "failure"]) {
    if (!Object.prototype.hasOwnProperty.call(envelopes, key)) throw new Error("MANIFEST_INVALID");
    const node = envelopes[key];
    if (!assertSupportedSchema(node).ok) throw new Error("MANIFEST_INVALID");
  }

  const methods = raw["methods"];
  if (!isPlainObject(methods)) throw new Error("MANIFEST_INVALID");
  if (Object.keys(methods).length !== AGENT_HOST_METHODS.length) throw new Error("MANIFEST_INVALID");
  for (const method of AGENT_HOST_METHODS) {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new Error("MANIFEST_INVALID");
    const entry = methods[method];
    if (!isPlainObject(entry)) throw new Error("MANIFEST_INVALID");
    if (entry["direction"] !== HOST_DIRECTION[method]) throw new Error("MANIFEST_INVALID");
    if (entry["kind"] !== "request") throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["params"]).ok) throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["result"]).ok) throw new Error("MANIFEST_INVALID");
  }

  return p2Snapshot(raw as unknown as AgentHostManifest);
}

/**
 * Validate one payload against the manifest node for `method`/`side`.
 *
 * The manifest is the only field specification. A failure throws the fixed
 * shared `code`; `sessionId`, when supplied, must match exactly (no trim).
 */
export function agentHostPayload(
  manifest: AgentHostManifest,
  method: AgentHostMethod,
  side: "params" | "result",
  value: unknown,
  sessionId?: string,
): void {
  if (!AGENT_HOST_METHODS.includes(method)) throw new Error("UNKNOWN_METHOD");
  const entry = manifest.methods[method];
  const node = side === "params" ? entry.params : entry.result;
  const checked = validateAgainstSchema(value, node);
  if (!checked.ok) throw new Error(checked.code);
  if (!isPlainObject(value)) throw new Error("FIELD_TYPE");
  if (value["protocolVersion"] !== AGENT_HOST_VERSION) throw new Error("VERSION_MISMATCH");
  if (sessionId !== undefined && value["sessionId"] !== sessionId) {
    throw new Error("SESSION_MISMATCH");
  }
}

/** Strict parse of one NDJSON frame via the shared P0 parser. */
export function parseAgentHostFrame(
  bytes: Uint8Array,
  manifest: Pick<AgentHostManifest, "envelopes">,
): JsonRpcMessage {
  const result = parseFrame(bytes, manifest);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
