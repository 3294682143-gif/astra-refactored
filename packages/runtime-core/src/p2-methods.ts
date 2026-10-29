import {
  P2_ERROR_CODES,
  P2Error,
  checkedP2MethodRoutingMetadata,
  detectLoneSurrogates,
  p2Snapshot,
  type P2MethodAsset,
  type P2MethodCatalog,
  type P2MethodEntry,
  type P2MethodLoad,
  type P2MethodPort,
  type P2MethodUse,
} from "@astra/protocol";
import { createHash } from "node:crypto";

const VERSION = "1.1.0";
const MAX_ID = 64;
const MAX_TITLE = 256;
const MAX_BODY = 24000;
const MAX_BUDGET = 65536;
const MAX_CATALOG = 20;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function keys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const own = Object.keys(value);
  if (own.length !== expected.length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  for (const name of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
  }
  return value as Record<string, unknown>;
}

function bound(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < low || value > high) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  return value;
}

function text(value: unknown, low: number, high: number): string {
  if (typeof value !== "string" || !detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const chars = [...value].length;
  if (chars < low || chars > high) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function methodId(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ID || !ID_RE.test(value)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return value;
}

function sha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function readCatalog(raw: unknown): P2MethodCatalog {
  const node = keys(raw, ["version", "entries"]);
  if (node.version !== VERSION) {
    throw new P2Error(P2_ERROR_CODES.VERSION_MISMATCH);
  }
  if (!Array.isArray(node.entries) || node.entries.length !== MAX_CATALOG) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const seen = new Set<string>();
  const entries: P2MethodEntry[] = [];
  const allowed = new Set(["id", "title", "tasks", "objects", "structures", "role"]);
  for (const row of node.entries) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const own = Object.keys(row);
    if (
      !own.includes("id") ||
      !own.includes("title") ||
      own.some((key) => !allowed.has(key))
    ) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    const item = row as Record<string, unknown>;
    const id = methodId(item.id);
    const title = text(item.title, 1, MAX_TITLE);
    const metadata = checkedP2MethodRoutingMetadata(item);
    if (metadata === null) {
      throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
    }
    if (seen.has(id)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    seen.add(id);
    entries.push({ id, title, ...metadata });
  }
  return p2Snapshot({ version: VERSION, entries }) as P2MethodCatalog;
}

export function readAsset(raw: unknown, id: string, title: string): P2MethodAsset {
  const node = keys(raw, ["id", "title", "version", "body", "bodySha256", "bodyChars"]);
  if (node.id !== id || node.title !== title || node.version !== VERSION) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  const body = text(node.body, 1, MAX_BODY);
  if (node.bodyChars !== [...body].length) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (typeof node.bodySha256 !== "string" || node.bodySha256 !== sha256(body)) {
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }
  return p2Snapshot({
    id,
    title,
    version: VERSION,
    body,
    bodySha256: node.bodySha256,
    bodyChars: node.bodyChars,
  }) as P2MethodAsset;
}

export class P2MethodSession {
  private readonly port: P2MethodPort | null;
  private readonly maxMethods: number;
  private readonly maxChars: number;
  private catalogValue: P2MethodCatalog | null = null;
  private readonly cache = new Map<string, P2MethodAsset>();
  private readonly known = new Set<string>();
  private readonly outcomes = new Map<string, P2MethodUse>();
  private attempts = 0;
  private chars = 0;

  constructor(port: P2MethodPort | null, maxMethods = 2, maxChars = 12000) {
    this.port = port;
    this.maxMethods = bound(maxMethods, 0, 2);
    this.maxChars = bound(maxChars, 1, MAX_BODY);
    if (port !== null) {
      try {
        const snapshot = p2Snapshot(port.catalog());
        this.catalogValue = readCatalog(snapshot);
        for (const entry of this.catalogValue.entries) {
          this.known.add(entry.id);
        }
      } catch {
        this.catalogValue = null;
        this.known.clear();
      }
    }
  }

  catalog(): P2MethodCatalog {
    if (this.catalogValue === null) {
      return p2Snapshot({ version: VERSION, entries: [] }) as P2MethodCatalog;
    }
    return this.catalogValue;
  }

  loadAttempts(): number {
    return this.attempts;
  }

  assetsSnapshot(): readonly P2MethodAsset[] {
    return p2Snapshot([...this.cache.values()]) as readonly P2MethodAsset[];
  }

  load(id: string, maxAdditionalBytes: number): P2MethodUse {
    const budget = bound(maxAdditionalBytes, 0, MAX_BUDGET);
    if (typeof id !== "string" || id.length > MAX_ID || !ID_RE.test(id)) {
      return this.record({ id: "", status: "refused", code: "NOT_FOUND" });
    }
    if (this.port === null || this.catalogValue === null || this.maxMethods === 0) {
      return this.record({ id, status: "refused", code: "DISABLED" });
    }
    const cached = this.cache.get(id);
    if (cached !== undefined) {
      return this.record({ id, status: "already_loaded", code: "OK" });
    }
    if (!this.known.has(id)) {
      return this.record({ id, status: "refused", code: "NOT_FOUND" });
    }
    const failed = this.outcomes.get(id);
    if (failed !== undefined) {
      return this.record(failed);
    }
    if (this.attempts >= this.maxMethods) {
      return this.record({ id, status: "refused", code: "BUDGET_EXHAUSTED" });
    }
    this.attempts += 1;
    let result: P2MethodLoad;
    try {
      result = p2Snapshot(this.port.load(id)) as P2MethodLoad;
    } catch {
      return this.record({ id, status: "refused", code: "INTEGRITY_FAILED" });
    }
    let node: Record<string, unknown>;
    try {
      node = keys(result, ["status", "asset"]);
    } catch {
      return this.record({ id, status: "refused", code: "INTEGRITY_FAILED" });
    }
    if (node.status !== "loaded") {
      if (node.asset !== null) {
        return this.record({ id, status: "refused", code: "INTEGRITY_FAILED" });
      }
      if (node.status === "not_found") {
        return this.record({ id, status: "refused", code: "NOT_FOUND" });
      }
      if (node.status === "disabled") {
        return this.record({ id, status: "refused", code: "DISABLED" });
      }
      return this.record({ id, status: "refused", code: "INTEGRITY_FAILED" });
    }
    const title = this.titleOf(id);
    let asset: P2MethodAsset;
    try {
      asset = readAsset(node.asset, id, title);
    } catch {
      return this.record({ id, status: "refused", code: "INTEGRITY_FAILED" });
    }
    const bytes = Buffer.byteLength(JSON.stringify(asset), "utf8") + 1;
    if (this.chars + asset.bodyChars > this.maxChars) {
      return this.record({ id, status: "refused", code: "BUDGET_EXHAUSTED" });
    }
    if (bytes > budget) {
      return this.record({ id, status: "refused", code: "CONTEXT_FULL" });
    }
    this.chars += asset.bodyChars;
    this.cache.set(id, asset);
    return this.record({ id, status: "loaded", code: "OK" });
  }

  private titleOf(id: string): string {
    const catalog = this.catalogValue;
    if (catalog !== null) {
      for (const entry of catalog.entries) {
        if (entry.id === id) {
          return entry.title;
        }
      }
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_BINDING);
  }

  private record(use: P2MethodUse): P2MethodUse {
    const frozen = p2Snapshot(use) as P2MethodUse;
    if (this.known.has(frozen.id) && frozen.status === "refused") {
      this.outcomes.set(frozen.id, frozen);
    }
    return frozen;
  }
}
