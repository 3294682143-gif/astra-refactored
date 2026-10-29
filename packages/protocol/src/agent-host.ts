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

export const AGENT_HOST_V14_VERSION = "1.4-unified-math-assets" as const;
export type AgentHostV14Version = typeof AGENT_HOST_V14_VERSION;

export const AGENT_HOST_VERSION = "1.3-agent-loop-preview";
export type AgentHostVersion = typeof AGENT_HOST_VERSION;

/** The frozen 1.2 preview version, kept for read-only legacy replay only. */
export const AGENT_HOST_LEGACY_VERSION = "1.2-agent-loop-preview" as const;

/** The nine methods of the 1.4 unified math assets Host slice, in fixed order. */
export const AGENT_HOST_V14_METHODS = Object.freeze([
  "runtime.initialize",
  "session.solve",
  "session.stop",
  "model.generate",
  "tool.execute",
  "method.catalog",
  "method.load",
  "asset.scoped",
  "math_asset.execute",
] as const);
export type AgentHostV14Method = (typeof AGENT_HOST_V14_METHODS)[number];

/** The eight methods of this local Host slice, in fixed order. */
export const AGENT_HOST_METHODS = Object.freeze([
  "runtime.initialize",
  "session.solve",
  "session.stop",
  "model.generate",
  "tool.execute",
  "method.catalog",
  "method.load",
  "asset.scoped",
] as const);
export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

/** The five methods of the frozen 1.2 preview, in fixed order. */
export const AGENT_HOST_LEGACY_METHODS = Object.freeze([
  "runtime.initialize",
  "session.solve",
  "session.stop",
  "model.generate",
  "tool.execute",
] as const);
export type AgentHostLegacyMethod = (typeof AGENT_HOST_LEGACY_METHODS)[number];

export interface AgentHostV14Manifest {
  readonly format: "astra-agent-host-manifest-v1";
  readonly schemaDialect: "astra-p0-schema-subset-v1";
  readonly protocolVersion: typeof AGENT_HOST_V14_VERSION;
  readonly limits: typeof LIMITS;
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<AgentHostV14Method, ManifestMethod>>;
}

export interface AgentHostManifest {
  readonly format: "astra-agent-host-manifest-v1";
  readonly schemaDialect: "astra-p0-schema-subset-v1";
  readonly protocolVersion: typeof AGENT_HOST_VERSION;
  readonly limits: typeof LIMITS;
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<AgentHostMethod, ManifestMethod>>;
}

/**
 * Frozen 1.2 legacy manifest shape. It is a distinct type so a legacy
 * document can never be mistaken for the active 1.3 manifest: the version is
 * the literal 1.2 string and only the five legacy methods exist.
 */
export interface AgentHostLegacyManifest {
  readonly format: "astra-agent-host-manifest-v1";
  readonly schemaDialect: "astra-p0-schema-subset-v1";
  readonly protocolVersion: typeof AGENT_HOST_LEGACY_VERSION;
  readonly limits: typeof LIMITS;
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<AgentHostLegacyMethod, ManifestMethod>>;
}

/** Either manifest profile; the shared validator returns this union. */
export type AgentHostAnyManifest = AgentHostV14Manifest | AgentHostManifest | AgentHostLegacyManifest;

const HOST_FORMAT = "astra-agent-host-manifest-v1";
const HOST_DIRECTION: Readonly<Record<string, "host-to-node" | "node-to-host">> = {
  "runtime.initialize": "host-to-node",
  "session.solve": "host-to-node",
  "session.stop": "host-to-node",
  "model.generate": "node-to-host",
  "tool.execute": "node-to-host",
  "method.catalog": "node-to-host",
  "method.load": "node-to-host",
  "asset.scoped": "node-to-host",
  "math_asset.execute": "node-to-host",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameLimits(raw: unknown, framesLimit: number | null = null): boolean {
  if (!isPlainObject(raw)) return false;
  const keys = Object.keys(raw);
  const expected = Object.keys(LIMITS);
  if (keys.length !== expected.length) return false;
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return false;
    const expectedValue =
      key === "maxFramesPerSession" && framesLimit !== null
        ? framesLimit
        : (LIMITS as Record<string, unknown>)[key];
    if (raw[key] !== expectedValue) return false;
  }
  return true;
}

/**
 * Shared manifest validator. `version` and `methods` are the only parameters:
 * the active 1.3 profile and the frozen 1.2 legacy profile use this one body
 * instead of two copied modules. Only the fixed codes `MANIFEST_INVALID` and
 * `VERSION_MISMATCH` escape; raw input is never echoed.
 */
function validateManifest(
  raw: unknown,
  version: string,
  expected: readonly string[],
  framesLimit: number | null = null,
): AgentHostAnyManifest {
  if (!isPlainObject(raw)) throw new Error("MANIFEST_INVALID");
  if (raw["protocolVersion"] !== version) throw new Error("VERSION_MISMATCH");
  if (raw["format"] !== HOST_FORMAT) throw new Error("MANIFEST_INVALID");
  if (raw["schemaDialect"] !== SCHEMA_DIALECT) throw new Error("MANIFEST_INVALID");
  if (MANIFEST_FORMAT !== "astra-p0-protocol-manifest-v1") throw new Error("MANIFEST_INVALID");
  if (!sameLimits(raw["limits"], framesLimit)) throw new Error("MANIFEST_INVALID");

  const envelopes = raw["envelopes"];
  if (!isPlainObject(envelopes)) throw new Error("MANIFEST_INVALID");
  const envelopeKeys = Object.keys(envelopes);
  if (envelopeKeys.length !== 3) throw new Error("MANIFEST_INVALID");
  for (const key of ["request", "success", "failure"]) {
    if (!Object.prototype.hasOwnProperty.call(envelopes, key)) throw new Error("MANIFEST_INVALID");
    const node = envelopes[key];
    if (!assertSupportedSchema(node).ok) throw new Error("MANIFEST_INVALID");
  }

  const declared = raw["methods"];
  if (!isPlainObject(declared)) throw new Error("MANIFEST_INVALID");
  if (Object.keys(declared).length !== expected.length) throw new Error("MANIFEST_INVALID");
  for (const method of expected) {
    if (!Object.prototype.hasOwnProperty.call(declared, method)) throw new Error("MANIFEST_INVALID");
    const entry = declared[method];
    if (!isPlainObject(entry)) throw new Error("MANIFEST_INVALID");
    if (entry["direction"] !== HOST_DIRECTION[method]) throw new Error("MANIFEST_INVALID");
    if (entry["kind"] !== "request") throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["params"]).ok) throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["result"]).ok) throw new Error("MANIFEST_INVALID");
  }

  return p2Snapshot(raw as unknown as AgentHostAnyManifest);
}

/**
 * Validate a loaded unified Agent Host manifest (1.4). This is the new unified entry point.
 */
export function validateAgentHostV14Manifest(raw: unknown): AgentHostV14Manifest {
  return validateManifest(raw, AGENT_HOST_V14_VERSION, AGENT_HOST_V14_METHODS) as AgentHostV14Manifest;
}

/**
 * Validate a loaded active Agent Host manifest (1.3).
 * A 1.2 or 1.4 document is refused here with `VERSION_MISMATCH`.
 */
export function validateAgentHostManifest(raw: unknown): AgentHostManifest {
  return validateManifest(raw, AGENT_HOST_VERSION, AGENT_HOST_METHODS) as AgentHostManifest;
}

/**
 * Validate a frozen 1.2 legacy manifest for read-only replay. The result is
 * never accepted by the live Node flow, which requires the active version.
 */
export function validateLegacyAgentHostManifest(raw: unknown): AgentHostLegacyManifest {
  return validateManifest(
    raw,
    AGENT_HOST_LEGACY_VERSION,
    AGENT_HOST_LEGACY_METHODS,
    // The frozen 1.2 document keeps its pinned 64-frame value; only the live
    // profiles use the larger full-capability ceiling.
    64,
  ) as AgentHostLegacyManifest;
}

/**
 * Validate one payload against the manifest node for `method`/`side`.
 *
 * The manifest is the only field specification. A failure throws the fixed
 * shared `code`; `sessionId`, when supplied, must match exactly (no trim).
 * The version check follows the manifest's own `protocolVersion`, so a legacy
 * manifest can only be replayed against legacy payloads.
 */
export function agentHostPayload(
  manifest: AgentHostAnyManifest,
  method: AgentHostMethod | AgentHostV14Method,
  side: "params" | "result",
  value: unknown,
  sessionId?: string,
): void {
  const declared = manifest.methods as Readonly<Record<string, ManifestMethod | undefined>>;
  if (!Object.prototype.hasOwnProperty.call(declared, method)) throw new Error("UNKNOWN_METHOD");
  const entry = declared[method];
  if (entry === undefined) throw new Error("UNKNOWN_METHOD");
  const node = side === "params" ? entry.params : entry.result;
  const checked = validateAgainstSchema(value, node);
  if (!checked.ok) throw new Error(checked.code);
  if (!isPlainObject(value)) throw new Error("FIELD_TYPE");
  if (value["protocolVersion"] !== manifest.protocolVersion) throw new Error("VERSION_MISMATCH");
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
