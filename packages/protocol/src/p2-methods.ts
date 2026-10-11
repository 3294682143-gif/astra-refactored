/**
 * @astra/protocol — P2-A method-port DTOs (types only).
 *
 * These are shared data shapes for the on-demand method catalog/load port.
 * They carry no I/O, no environment access and no authorization: a
 * `P2MethodPort` is injected by a trusted host, and a model payload can never
 * construct a `loaded` asset by itself. `bodySha256` is an integrity check of
 * the exact bytes, not a mathematical proof of the method text.
 */

/** One catalog row: a short canonical id and its title. No path, no body. */
export interface P2MethodEntry {
  readonly id: string;
  readonly title: string;
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
