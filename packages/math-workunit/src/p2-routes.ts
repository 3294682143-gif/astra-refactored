/**
 * @astra/math-workunit — P2-A route identity registry.
 *
 * A route is identified by its four mathematical-mechanism fields
 * (representation, operation, lemmas, construction). The signature is a
 * canonical identity of that declared data, not a claim of mathematical
 * equivalence between two routes. `routeId` and any title are never part of
 * the signature, so two differently named routes with the same mechanism are
 * the same route.
 */

import {
  P2_ERROR_CODES,
  P2_LIMITS,
  P2Error,
  detectLoneSurrogates,
  p2Snapshot,
  type P2RouteSpec,
} from "@astra/protocol";
import { createHash } from "node:crypto";

/** A route declaration before its signature is computed. */
export type P2RouteInput = Omit<P2RouteSpec, "signature">;

/** Exact own-key set of a route input; `signature`/`title` are rejected. */
const ROUTE_INPUT_FIELDS = ["routeId", "representation", "operation", "lemmas", "construction"] as const;

const MAX_SHORT = P2_LIMITS.maxShortStringChars;
const MAX_LEMMAS = P2_LIMITS.maxArrayItems;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Non-empty, at most 256 Unicode chars, no lone surrogate. A value that is
 * empty or whitespace-only after trimming is rejected, so two routes cannot
 * differ only by surrounding whitespace.
 */
function requireShortString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  if ([...value].length > MAX_SHORT) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (!detectLoneSurrogates(value).ok) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  if (value.trim().length === 0) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  return value;
}

/** Trim, then collapse internal whitespace runs to a single space. */
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function requireNormalizedText(value: unknown): string {
  const text = normalizeText(requireShortString(value));
  if (text.length === 0) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  return text;
}

function requireLemmaList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LEMMAS) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
    normalized.push(requireNormalizedText(value[index]));
  }
  normalized.sort();
  const unique: string[] = [];
  for (const lemma of normalized) {
    if (unique.length === 0 || unique[unique.length - 1] !== lemma) {
      unique.push(lemma);
    }
  }
  return unique;
}

/**
 * Validate one route declaration and return its normalized mechanism fields.
 * Exactly the declared keys are allowed; a `signature` or `title` field is a
 * hard rejection rather than a silently ignored extra.
 */
function normalizeRouteInput(input: unknown): {
  readonly routeId: string;
  readonly representation: string;
  readonly operation: string;
  readonly lemmas: readonly string[];
  readonly construction: string;
} {
  if (!isPlainObject(input)) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  const keys = Object.keys(input);
  if (keys.length !== ROUTE_INPUT_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
  }
  for (const field of ROUTE_INPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
  }
  return {
    routeId: requireShortString(input.routeId),
    representation: requireNormalizedText(input.representation),
    operation: requireNormalizedText(input.operation),
    lemmas: requireLemmaList(input.lemmas),
    construction: requireNormalizedText(input.construction),
  };
}

/**
 * Canonical signature of a route mechanism: sha256 over the fixed field
 * sequence `[representation, operation, lemmas, construction]` of the
 * normalized fields. `routeId` is deliberately excluded. The result is an
 * identity of the same declared data, not a mathematical equivalence proof.
 */
export function p2RouteSignature(input: P2RouteInput): string {
  const normalized = normalizeRouteInput(input);
  const canonical = JSON.stringify([
    normalized.representation,
    normalized.operation,
    normalized.lemmas,
    normalized.construction,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Bounded route registry. Registration validates the whole input, checks the
 * route limit, the duplicate id and the duplicate signature before any map is
 * touched, so a rejected call leaves the registry unchanged.
 */
export class P2RouteRegistry {
  private readonly byId = new Map<string, P2RouteSpec>();
  private readonly bySignature = new Map<string, string>();

  /** Register one route and return the frozen spec with its signature. */
  register(input: P2RouteInput): P2RouteSpec {
    const normalized = normalizeRouteInput(input);
    if (this.byId.has(normalized.routeId)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    const signature = p2RouteSignature(input);
    if (this.bySignature.has(signature)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ROUTE_SIGNATURE);
    }
    if (this.byId.size >= P2_LIMITS.maxRoutes) {
      throw new P2Error(P2_ERROR_CODES.ROUTE_LIMIT);
    }
    const spec = p2Snapshot({
      routeId: normalized.routeId,
      representation: normalized.representation,
      operation: normalized.operation,
      lemmas: normalized.lemmas,
      construction: normalized.construction,
      signature,
    }) as P2RouteSpec;
    this.byId.set(spec.routeId, spec);
    this.bySignature.set(signature, spec.routeId);
    return spec;
  }

  /** Deep-frozen snapshot of the registered routes in registration order. */
  snapshot(): readonly P2RouteSpec[] {
    return p2Snapshot([...this.byId.values()]) as readonly P2RouteSpec[];
  }

  /** Look up one registered route; an unknown id is a fixed rejection. */
  get(routeId: string): P2RouteSpec {
    const spec = this.byId.get(routeId);
    if (spec === undefined) {
      throw new P2Error(P2_ERROR_CODES.ROUTE_MISMATCH);
    }
    return spec;
  }
}
