/**
 * @astra/runtime-core — P3 method catalog/observation validators (pure, no I/O).
 *
 * Reuses the existing P2 catalog/asset readers instead of a second JSON
 * reader. `p3MethodCatalog` accepts only the exact trusted catalog shape: an
 * empty entry list is a valid "catalog unavailable" view, exactly 20 entries
 * go through the shared `readCatalog`, and anything else is refused. The
 * observation helper re-checks one already-validated METHOD_REFERENCE receipt
 * against the request it answers and the trusted catalog title; it never
 * promotes the text to a proof and never echoes raw input.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  p2Snapshot,
  type P2MethodCatalog,
  type P2MethodEntry,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { readAsset, readCatalog } from "./p2-methods.js";

const VERSION = "1.1.0";
const MAX_CATALOG = 20;
const MAX_OBSERVATION_BYTES = 16000;
const INTERPRETATION = "ADVISORY_NOT_PROOF";

function fail(): never {
  throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
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

/**
 * Validate one trusted catalog snapshot. An empty `entries` list is the
 * explicit "catalog unavailable" view and is returned frozen; exactly 20
 * entries must pass the shared `readCatalog`; every other count is refused.
 */
export function p3MethodCatalog(raw: unknown): P2MethodCatalog {
  const snapshot = p2Snapshot(raw);
  if (!isPlainObject(snapshot)) {
    fail();
  }
  if (!exactKeys(snapshot, ["version", "entries"])) {
    fail();
  }
  if (snapshot.version !== VERSION) {
    fail();
  }
  const entries = snapshot.entries;
  if (!Array.isArray(entries)) {
    fail();
  }
  if (entries.length === 0) {
    return p2Snapshot({ version: VERSION, entries: [] }) as P2MethodCatalog;
  }
  if (entries.length !== MAX_CATALOG) {
    fail();
  }
  return readCatalog(snapshot);
}

function titleOf(catalog: P2MethodCatalog, id: string): string {
  for (const entry of catalog.entries) {
    if (entry.id === id) {
      return entry.title;
    }
  }
  fail();
}

/**
 * Re-check one METHOD_REFERENCE receipt against its request and the trusted
 * catalog. The caller must already have validated the binding, hash and source
 * through `p3EffectReceipt`; this helper only re-checks the method identity and
 * the exact observation shape. A non-COMPLETE receipt returns without parsing.
 */
export function p3MethodObservation(
  receipt: P3EffectReceipt,
  request: P3EffectRequest,
  catalog: P2MethodCatalog,
): void {
  const action = request.action;
  if (!isPlainObject(action) || action.action !== "method" || typeof action.id !== "string") {
    fail();
  }
  if (receipt.status !== "COMPLETE") {
    return;
  }
  if (receipt.source !== "METHOD_REFERENCE") {
    fail();
  }
  const observation = receipt.observation;
  if (typeof observation !== "string" || observation.length === 0) {
    fail();
  }
  if (Buffer.byteLength(observation, "utf8") > MAX_OBSERVATION_BYTES) {
    fail();
  }
  if (!detectLoneSurrogates(observation).ok) {
    fail();
  }
  const decoded = decodeFrame(Buffer.from(observation, "utf8"));
  if (!decoded.ok) {
    fail();
  }
  const raw = decoded.value;
  if (!detectDuplicateKeys(raw).ok) {
    fail();
  }
  if (!detectNonFiniteTokens(raw).ok) {
    fail();
  }
  if (!detectUnsafeNumbers(raw).ok) {
    fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!detectLoneSurrogates(parsed).ok) {
    fail();
  }
  if (!isPlainObject(parsed)) {
    fail();
  }
  if (!exactKeys(parsed, ["method", "asset", "interpretation"])) {
    fail();
  }
  if (parsed.method !== action.id) {
    fail();
  }
  if (parsed.interpretation !== INTERPRETATION) {
    fail();
  }
  const title = titleOf(catalog, action.id);
  readAsset(parsed.asset, action.id, title);
}

export type { P2MethodEntry };
