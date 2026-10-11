/**
 * @astra/protocol — P2 local Host<->Node manifest surface.
 *
 * The single normative field specification is `schema/p2-host.schema.json`;
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

export const P2_HOST_VERSION = "1.0-p2-host-local";
export type P2HostVersion = typeof P2_HOST_VERSION;

/** The six methods of this local Host slice, in fixed order. */
export const P2_HOST_METHODS = [
  "runtime.initialize",
  "session.solve",
  "session.stop",
  "method.catalog",
  "method.load",
  "model.generate",
] as const;
export type P2HostMethod = (typeof P2_HOST_METHODS)[number];

export interface P2HostManifest {
  readonly format: "astra-p2-host-manifest-v1";
  readonly schemaDialect: "astra-p0-schema-subset-v1";
  readonly protocolVersion: typeof P2_HOST_VERSION;
  readonly limits: typeof LIMITS;
  readonly envelopes: ManifestEnvelopes;
  readonly methods: Readonly<Record<P2HostMethod, ManifestMethod>>;
}

const HOST_FORMAT = "astra-p2-host-manifest-v1";
const HOST_DIRECTION: Readonly<Record<P2HostMethod, "host-to-node" | "node-to-host">> = {
  "runtime.initialize": "host-to-node",
  "session.solve": "host-to-node",
  "session.stop": "host-to-node",
  "method.catalog": "node-to-host",
  "method.load": "node-to-host",
  "model.generate": "node-to-host",
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
 * Validate a loaded P2 Host manifest against the compiled-in constants.
 *
 * Only the fixed codes `MANIFEST_INVALID` and `VERSION_MISMATCH` escape; raw
 * input is never echoed. An empty or widened `methods` map is invalid, and
 * every envelope/params/result node must pass the shared schema subset check.
 */
export function validateP2HostManifest(raw: unknown): P2HostManifest {
  if (!isPlainObject(raw)) throw new Error("MANIFEST_INVALID");
  if (raw["protocolVersion"] !== P2_HOST_VERSION) throw new Error("VERSION_MISMATCH");
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
  if (Object.keys(methods).length !== P2_HOST_METHODS.length) throw new Error("MANIFEST_INVALID");
  for (const method of P2_HOST_METHODS) {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new Error("MANIFEST_INVALID");
    const entry = methods[method];
    if (!isPlainObject(entry)) throw new Error("MANIFEST_INVALID");
    if (entry["direction"] !== HOST_DIRECTION[method]) throw new Error("MANIFEST_INVALID");
    if (entry["kind"] !== "request") throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["params"]).ok) throw new Error("MANIFEST_INVALID");
    if (!assertSupportedSchema(entry["result"]).ok) throw new Error("MANIFEST_INVALID");
  }

  return p2Snapshot(raw as unknown as P2HostManifest);
}

/**
 * Validate one payload against the manifest node for `method`/`side`.
 *
 * The manifest is the only field specification. A failure throws the fixed
 * shared `code`; `sessionId`, when supplied, must match exactly (no trim).
 */
export function p2HostPayload(
  manifest: P2HostManifest,
  method: P2HostMethod,
  side: "params" | "result",
  value: unknown,
  sessionId?: string,
): void {
  if (!P2_HOST_METHODS.includes(method)) throw new Error("UNKNOWN_METHOD");
  const entry = manifest.methods[method];
  const node = side === "params" ? entry.params : entry.result;
  const checked = validateAgainstSchema(value, node);
  if (!checked.ok) throw new Error(checked.code);
  if (!isPlainObject(value)) throw new Error("FIELD_TYPE");
  if (value["protocolVersion"] !== P2_HOST_VERSION) throw new Error("VERSION_MISMATCH");
  if (sessionId !== undefined && value["sessionId"] !== sessionId) {
    throw new Error("SESSION_MISMATCH");
  }
}

/** Strict parse of one NDJSON frame via the shared P0 parser. */
export function parseP2HostFrame(
  bytes: Uint8Array,
  manifest: Pick<P2HostManifest, "envelopes">,
): JsonRpcMessage {
  const result = parseFrame(bytes, manifest);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
