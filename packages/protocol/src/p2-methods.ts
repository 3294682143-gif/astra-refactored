/**
 * @astra/protocol — P2-A method-port DTOs and the pure routing-metadata reader.
 *
 * These are shared data shapes for the on-demand method catalog/load port.
 * They carry no I/O, no environment access and no authorization: a
 * `P2MethodPort` is injected by a trusted host, and a model payload can never
 * construct a `loaded` asset by itself. `bodySha256` is an integrity check of
 * the exact bytes, not a mathematical proof of the method text.
 */

/** The closed advisory role set carried by a method card. */
export type P2MethodRole = "method" | "decision";

/** Runtime role values; the JSON schema carries the same closed set. */
export const P2_METHOD_ROLE_VALUES = Object.freeze(["method", "decision"] as const);

/** Routing lists are bounded exactly like the live `method.catalog` schema. */
export const P2_METHOD_ROUTING_MAX_ITEMS = 6;
export const P2_METHOD_ROUTING_MAX_CHARS = 24;
export const P2_METHOD_ROUTING_TOKEN = /^[a-z0-9_]{1,24}$/u;
export const P2_METHOD_ROUTING_FIELDS = Object.freeze([
  "tasks",
  "objects",
  "structures",
] as const);

/** Optional routing metadata exposed before any explicit method-body load. */
export interface P2MethodRoutingMetadata {
  readonly tasks?: readonly string[];
  readonly objects?: readonly string[];
  readonly structures?: readonly string[];
  readonly role?: P2MethodRole;
}

/** One catalog row: a short canonical id, its title and optional metadata. */
export interface P2MethodEntry extends P2MethodRoutingMetadata {
  readonly id: string;
  readonly title: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Strictly read the optional routing fields of one catalog row. A present but
 * out-of-shape list or role returns `null` (the caller refuses it); absent
 * fields stay absent and are never invented.
 */
export function checkedP2MethodRoutingMetadata(
  value: unknown,
): P2MethodRoutingMetadata | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const out: {
    tasks?: readonly string[];
    objects?: readonly string[];
    structures?: readonly string[];
    role?: P2MethodRole;
  } = {};
  for (const field of P2_METHOD_ROUTING_FIELDS) {
    if (!hasOwn(value, field)) {
      continue;
    }
    const raw = value[field];
    if (!Array.isArray(raw) || raw.length > P2_METHOD_ROUTING_MAX_ITEMS) {
      return null;
    }
    const tokens: string[] = [];
    for (const item of raw) {
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > P2_METHOD_ROUTING_MAX_CHARS ||
        !P2_METHOD_ROUTING_TOKEN.test(item)
      ) {
        return null;
      }
      tokens.push(item);
    }
    out[field] = Object.freeze(tokens);
  }
  if (hasOwn(value, "role")) {
    const role = value["role"];
    if (role !== "method" && role !== "decision") {
      return null;
    }
    out.role = role;
  }
  return Object.freeze(out);
}

/** Read-only catalog view. `entries` is empty when the catalog is unavailable. */
export interface P2MethodCatalog {
  readonly version: "1.1.0";
  readonly entries: readonly P2MethodEntry[];
}

/** One fully loaded method body after a successful integrity check. */
export interface P2MethodAsset {
  readonly id: string;
  readonly title: string;
  readonly version: "1.1.0";
  readonly body: string;
  readonly bodySha256: string;
  readonly bodyChars: number;
}

/**
 * Result of one explicit load attempt. `asset` is non-null only for `loaded`;
 * every other status keeps `asset: null` instead of a partial body.
 */
export interface P2MethodLoad {
  readonly status: "loaded" | "not_found" | "disabled" | "integrity_failed";
  readonly asset: P2MethodAsset | null;
}

/**
 * Trusted host-injected method port. `catalog()` and `load(id)` are the only
 * entry points; the model may name an id but never supplies a path or root.
 */
export interface P2MethodPort {
  catalog(): P2MethodCatalog;
  load(id: string): P2MethodLoad;
}

/**
 * Session-side record of one method use. `already_loaded` means the id was
 * served from the session without a second read; `refused` carries a fixed
 * `code` and never a body.
 */
export interface P2MethodUse {
  readonly id: string;
  readonly status: "loaded" | "already_loaded" | "refused";
  readonly code:
    | "OK"
    | "NOT_FOUND"
    | "DISABLED"
    | "BUDGET_EXHAUSTED"
    | "CONTEXT_FULL"
    | "INTEGRITY_FAILED";
}
