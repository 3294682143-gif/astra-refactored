/**
 * @astra/protocol — P2-A offline domain surface (types + strict WorkPacket
 * schema/parse helper only). No I/O, no environment access, no network.
 *
 * The single normative WorkPacket schema is the static JS object
 * `P2_WORK_PACKET_SCHEMA` below; every consumer imports that same object, so
 * there is no second hand-written copy and no JSON file to load.
 */

import {
  ERROR_CODES,
  decodeFrame,
  detectDuplicateKeys,
  detectLoneSurrogates,
  detectNonFiniteTokens,
  detectUnsafeNumbers,
  validateAgainstSchema,
  type ErrorCode,
  type EvidenceLevel,
  type ObligationStatus,
  type ParseResult,
  type RecordEnvelope,
  type Scope,
} from "./index.js";

/**
 * Local primitive bounds. The top-level schema literal must not read any
 * imported binding at module-evaluation time: `./index.js` re-exports this
 * module, so a top-level read of an `index` constant is a TDZ hazard that
 * would break the P0 surface. Only literals and `Number.*` are used here.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 24;

export const P2_PROTOCOL_VERSION = "1.0-p2a-local" as const;
export type P2ProtocolVersion = typeof P2_PROTOCOL_VERSION;

export const P2_MODE = "MOCK_ONLY" as const;
export type P2Mode = typeof P2_MODE;

export const P2_STRICT_ACCEPTANCE = "NOT_PERFORMED" as const;
export type P2StrictAcceptance = typeof P2_STRICT_ACCEPTANCE;

export const P2_WORK_PACKET_SCHEMA_VERSION = "p2a-work-v1" as const;
export type P2WorkPacketSchemaVersion = typeof P2_WORK_PACKET_SCHEMA_VERSION;

/** Bounds for this phase. All are safe integers. */
export const P2_LIMITS = {
  maxGoals: 8,
  maxObligations: 16,
  maxTasks: 32,
  maxArtifacts: 32,
  maxRoutes: 2,
  maxFixtureWorkUnits: 3,
  maxStringChars: 4096,
  maxShortStringChars: 256,
  maxArrayItems: 32,
  maxProblemChars: 8192,
  maxGoalIdChars: 64,
  maxLedgerEvents: 128,
} as const;

/** Fixed rejection codes for the P2-A surface. */
export const P2_ERROR_CODES = {
  PACKET_SCHEMA: "PACKET_SCHEMA",
  PACKET_BINDING: "PACKET_BINDING",
  PACKET_FORBIDDEN_FIELD: "PACKET_FORBIDDEN_FIELD",
  PACKET_SCOPE_VIOLATION: "PACKET_SCOPE_VIOLATION",
  PACKET_DELIVERY: "PACKET_DELIVERY",
  DUPLICATE_REQUEST_ID: "DUPLICATE_REQUEST_ID",
  UNKNOWN_DEPENDENCY: "UNKNOWN_DEPENDENCY",
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
  DUPLICATE_ID: "DUPLICATE_ID",
  DANGLING_REFERENCE: "DANGLING_REFERENCE",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  UNTRUSTED_ACCEPTANCE: "UNTRUSTED_ACCEPTANCE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  SCOPE_MISMATCH: "SCOPE_MISMATCH",
  ROUTE_MISMATCH: "ROUTE_MISMATCH",
  CROSS_ROUTE_REVIEW_REQUIRED: "CROSS_ROUTE_REVIEW_REQUIRED",
  STALE_DEPENDENCY: "STALE_DEPENDENCY",
  NOT_REUSABLE: "NOT_REUSABLE",
  ROUTE_LIMIT: "ROUTE_LIMIT",
  DUPLICATE_ROUTE_SIGNATURE: "DUPLICATE_ROUTE_SIGNATURE",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  FIXTURE_EXHAUSTED: "FIXTURE_EXHAUSTED",
  BOUND_EXCEEDED: "BOUND_EXCEEDED",
} as const;
export type P2ErrorCode = (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES];

/**
 * Fixed P2 error. Only the fixed `code` is public; raw input and JSON
 * exception messages are never carried on this object.
 */
export class P2Error extends Error {
  readonly code: P2ErrorCode;
  constructor(code: P2ErrorCode) {
    const known = (Object.values(P2_ERROR_CODES) as readonly string[]).includes(code);
    const fixed = known ? code : P2_ERROR_CODES.PACKET_SCHEMA;
    super(fixed);
    this.name = "P2Error";
    this.code = fixed;
  }
}

// ---------------------------------------------------------------------------
// Goal / scope / contract / obligation / task.
// ---------------------------------------------------------------------------

export const P2_GOAL_KIND = [
  "VALUE",
  "ALL_SOLUTIONS",
  "COUNT",
  "OPTIMIZATION",
  "PROOF",
  "MULTIPART",
  "UNKNOWN",
] as const;
export type P2GoalKind = (typeof P2_GOAL_KIND)[number];

export const P2_SEMANTIC_STATUS = ["UNKNOWN"] as const;
export type P2SemanticStatus = (typeof P2_SEMANTIC_STATUS)[number];

/** A trusted work configuration. A template is a work view, not the problem. */
export interface P2GoalSpec {
  readonly goalId: string;
  readonly kind: P2GoalKind;
  readonly scope: Scope;
  readonly subgoals: readonly P2GoalSpec[];
}

/** Exact own-key set of a goal spec node; extra fields are rejected. */
const GOAL_SPEC_FIELDS = ["goalId", "kind", "scope", "subgoals"] as const;

export const P2_OBLIGATION_KIND = [
  "DOMAIN_VALIDITY",
  "CANDIDATE_VALIDITY",
  "BOUNDARY_EXCEPTIONS",
  "EXHAUSTIVENESS",
  "COUNT_OBJECTS",
  "NO_DUPLICATES",
  "FEASIBILITY",
  "GLOBAL_BOUND",
  "ATTAINMENT",
  "PREMISES",
  "QUANTIFIERS",
  "PROOF_GOAL",
  "SUBGOAL_COVERAGE",
  "OUTPUT_COVERAGE",
  "ANSWER_REQUEST",
] as const;
export type P2ObligationKind = (typeof P2_OBLIGATION_KIND)[number];

/**
 * Mock-only control-side acceptance receipt. It is never a legal WorkPacket
 * field and no model payload can produce one.
 */
export interface P2AcceptanceReceipt {
  readonly mode: P2Mode;
  readonly sourceModule: "M5";
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly goalId: string;
  readonly scopeId: string;
  readonly policy: string;
  readonly evidenceRefs: readonly string[];
}

export interface P2Obligation {
  readonly envelope: RecordEnvelope;
  readonly obligationId: string;
  readonly goalId: string;
  readonly kind: P2ObligationKind;
  readonly status: ObligationStatus;
  readonly acceptance: P2AcceptanceReceipt | null;
}

export const P2_TASK_DELIVERY = [
  "READY",
  "RUNNING",
  "DELIVERED",
  "PARTIAL",
  "BLOCKED",
] as const;
export type P2TaskDelivery = (typeof P2_TASK_DELIVERY)[number];

export interface P2Task {
  readonly envelope: RecordEnvelope;
  readonly taskId: string;
  readonly goalId: string;
  readonly obligationId: string;
  readonly scopeId: string;
  readonly inputArtifactRefs: readonly P2ArtifactRef[];
  readonly dependencyTaskIds: readonly string[];
  readonly expectedResult: string;
  readonly acceptanceCriteria: string;
  readonly delivery: P2TaskDelivery;
}

export interface P2Contract {
  readonly envelope: RecordEnvelope;
  readonly problemFullText: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly semanticStatus: P2SemanticStatus;
  /** Non-assumptive risk hints (e.g. a factor that may need a zero check). */
  readonly riskHints: readonly string[];
  readonly goals: readonly P2GoalSpec[];
  readonly obligations: readonly P2Obligation[];
  readonly tasks: readonly P2Task[];
}

// ---------------------------------------------------------------------------
// Artifacts, routes, work packets.
// ---------------------------------------------------------------------------

export interface P2ArtifactRef {
  readonly artifactId: string;
  readonly artifactVersion: number;
}

export const P2_PACKET_DELIVERY = [
  "COMPLETE",
  "INCOMPLETE",
  "TRUNCATED",
  "ERROR",
] as const;
export type P2PacketDelivery = (typeof P2_PACKET_DELIVERY)[number];

/** Transport status of one receipt. `UNKNOWN` is not a packet field. */
export const P2_TRANSPORT_STATUS = [
  "COMPLETE",
  "TRUNCATED",
  "ERROR",
  "UNKNOWN",
] as const;
export type P2TransportStatus = (typeof P2_TRANSPORT_STATUS)[number];

/**
 * Strict model-supplied JSON data. The domain/quantifiers come from the
 * trusted task/contract scope; this packet may only carry `scopeId`.
 */
export interface P2WorkPacket {
  readonly schemaVersion: P2WorkPacketSchemaVersion;
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly taskId: string;
  readonly goalId: string;
  readonly scopeId: string;
  readonly routeId: string;
  readonly sourceRequestId: string;
  readonly claim: string;
  readonly derivation: string;
  readonly assumptions: readonly string[];
  readonly dependencies: readonly P2ArtifactRef[];
  readonly pendingObligations: readonly string[];
  readonly suggestedChecks: readonly string[];
  readonly deliveryStatus: P2PacketDelivery;
  readonly candidateProposal: string | null;
}

export const P2_ARTIFACT_AVAILABILITY = ["ACTIVE", "STALE"] as const;
export type P2ArtifactAvailability = (typeof P2_ARTIFACT_AVAILABILITY)[number];

export interface P2Artifact {
  readonly envelope: RecordEnvelope;
  readonly routeId: string;
  readonly sourceRequestId: string;
  readonly rawResponseHash: string;
  readonly rawResponseRef: string;
  readonly packet: P2WorkPacket;
  readonly level: EvidenceLevel;
  readonly checkResult: "UNKNOWN";
  readonly provisionalDependency: boolean;
}

/** Route identity is the four mathematical-mechanism fields only. */
export interface P2RouteSpec {
  readonly routeId: string;
  readonly representation: string;
  readonly operation: string;
  readonly lemmas: readonly string[];
  readonly construction: string;
  readonly signature: string;
}

// ---------------------------------------------------------------------------
// Fixed P2 events.
// ---------------------------------------------------------------------------

export const P2_EVENT_TYPE = [
  "CONTRACT_COMPILED",
  "GOALS_REVISED",
  "TASK_ADDED",
  "TASK_STARTED",
  "DELIVERY_RECORDED",
  "OBLIGATION_SATISFIED",
  "OBLIGATION_BLOCKED",
  "OBLIGATION_REOPENED",
  "ARTIFACT_ACCEPTED",
  "ARTIFACT_INVALIDATED",
  "ROUTE_REGISTERED",
  "FIXTURE_EXHAUSTED",
] as const;
export type P2EventType = (typeof P2_EVENT_TYPE)[number];

export interface P2Event {
  readonly eventId: string;
  readonly sessionId: string;
  readonly eventSeq: number;
  readonly eventType: P2EventType;
  readonly sourceModule: RecordEnvelope["sourceModule"];
  readonly contractVersion: number;
  readonly taskId?: string;
  readonly obligationId?: string;
  readonly artifactId?: string;
  readonly artifactVersion?: number;
}

// ---------------------------------------------------------------------------
// Canonical scope identity and deep-frozen snapshots.
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical JSON of a scope. `variableBindings` keys are sorted;
 * quantifier/assumption/branch/premise arrays keep their declared order. The
 * result is an identity of the same data, not a mathematical equivalence.
 */
export function canonicalScope(scope: Scope): string {
  const checked = validateP2Scope(scope);
  const bindings = Object.keys(checked.variableBindings).sort();
  const parts: string[] = [];
  parts.push(JSON.stringify(checked.domain));
  parts.push(
    `{${bindings
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(checked.variableBindings[key])}`)
      .join(",")}}`,
  );
  parts.push(JSON.stringify(checked.quantifiers));
  parts.push(JSON.stringify(checked.localAssumptions));
  parts.push(JSON.stringify(checked.branchConditions));
  parts.push(JSON.stringify(checked.referenceablePremises));
  return `[${parts.join(",")}]`;
}

/**
 * Deep-frozen structural clone of JSON-shaped data.
 *
 * Own enumerable properties are copied with `Object.defineProperty`, so a
 * `__proto__` key stays an own data property instead of mutating the
 * prototype. Cycles and depth beyond `MAX_DEPTH` are rejected with a fixed
 * `P2Error` rather than overflowing the stack. A shared (non-cyclic) object
 * is cloned per occurrence. Values outside JSON primitives — functions,
 * `Date`, non-finite or unsafe numbers — are rejected.
 */
export function p2Snapshot<T>(value: T): T {
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null) {
      return null;
    }
    const kind = typeof node;
    if (kind === "string" || kind === "boolean") {
      return node;
    }
    if (kind === "number") {
      if (!Number.isFinite(node) || !Number.isSafeInteger(node)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      return node;
    }
    if (kind !== "object") {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (depth > MAX_DEPTH) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const container = node as object;
    if (seen.has(container)) {
      throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
    }
    seen.add(container);
    try {
      if (Array.isArray(container)) {
        const items = container.map((item) => walk(item, depth + 1));
        return Object.freeze(items);
      }
      const proto = Object.getPrototypeOf(container);
      if (proto !== Object.prototype && proto !== null) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      const source = container as Record<string, unknown>;
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        Object.defineProperty(copy, key, {
          value: walk(source[key], depth + 1),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return Object.freeze(copy);
    } finally {
      seen.delete(container);
    }
  };
  return walk(value, 0) as T;
}

// ---------------------------------------------------------------------------
// Scope / goal-spec validation.
// ---------------------------------------------------------------------------

const SCOPE_FIELDS = [
  "scopeId",
  "domain",
  "variableBindings",
  "quantifiers",
  "localAssumptions",
  "branchConditions",
  "referenceablePremises",
] as const;

function isBoundedString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= maxChars &&
    detectLoneSurrogates(value).ok
  );
}

/** Goal ids are short ASCII identifiers so composed record ids stay bounded. */
const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isGoalId(value: unknown): value is string {
  return typeof value === "string" && GOAL_ID_PATTERN.test(value);
}

function isBoundedStringList(value: unknown, maxChars: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= P2_LIMITS.maxArrayItems &&
    value.every((item) => isBoundedString(item, maxChars))
  );
}

/**
 * Runtime validation of a `Scope`. Exactly the declared fields are allowed;
 * `domain` and `scopeId` must be non-empty, `variableBindings` must be a plain
 * object of at most 32 bounded strings, and the four arrays must be bounded
 * string lists. A hash confirms identity of this data, not equivalence.
 */
export function validateP2Scope(scope: unknown): Scope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  const source = scope as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== SCOPE_FIELDS.length) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  for (const field of SCOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
  }
  if (!isBoundedString(source.scopeId, P2_LIMITS.maxShortStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (!isBoundedString(source.domain, P2_LIMITS.maxStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  const bindings = source.variableBindings;
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  const bindingKeys = Object.keys(bindings);
  if (bindingKeys.length > P2_LIMITS.maxArrayItems) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  for (const key of bindingKeys) {
    if (!isBoundedString(key, P2_LIMITS.maxShortStringChars)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
    if (!isBoundedString((bindings as Record<string, unknown>)[key], P2_LIMITS.maxStringChars)) {
      throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
    }
  }
  if (!isBoundedStringList(source.quantifiers, P2_LIMITS.maxStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (!isBoundedStringList(source.localAssumptions, P2_LIMITS.maxStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (!isBoundedStringList(source.branchConditions, P2_LIMITS.maxStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  if (!isBoundedStringList(source.referenceablePremises, P2_LIMITS.maxStringChars)) {
    throw new P2Error(P2_ERROR_CODES.SCOPE_MISMATCH);
  }
  return scope as Scope;
}

/**
 * Validate a goal-spec tree. The whole tree is bounded by `maxGoals`, must be
 * acyclic, must not repeat a `goalId`, and only `MULTIPART` may carry
 * subgoals (strictly depth 2: a MULTIPART root with leaf children). Every
 * other kind must have an empty `subgoals` array, so an illegal kind can
 * never fall through a default branch.
 */
export function validateP2GoalSpecs(specs: unknown): readonly P2GoalSpec[] {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > P2_LIMITS.maxGoals) {
    throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  if (Object.getPrototypeOf(specs) !== Array.prototype) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const seenIds = new Set<string>();
  const seenNodes = new Set<object>();
  let total = 0;
  const walk = (node: unknown, depth: number): P2GoalSpec => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const container = node as object;
    const proto = Object.getPrototypeOf(container);
    if (proto !== Object.prototype && proto !== null) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (seenNodes.has(container)) {
      throw new P2Error(P2_ERROR_CODES.DEPENDENCY_CYCLE);
    }
    seenNodes.add(container);
    total += 1;
    if (total > P2_LIMITS.maxGoals || depth > 2) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    const source = node as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length !== GOAL_SPEC_FIELDS.length) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    for (const field of GOAL_SPEC_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }
    if (!isGoalId(source.goalId)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (seenIds.has(source.goalId)) {
      throw new P2Error(P2_ERROR_CODES.DUPLICATE_ID);
    }
    seenIds.add(source.goalId);
    if (!(P2_GOAL_KIND as readonly string[]).includes(source.kind as string)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    const kind = source.kind as P2GoalKind;
    validateP2Scope(source.scope);
    const subgoals = source.subgoals;
    if (!Array.isArray(subgoals)) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    if (Object.getPrototypeOf(subgoals) !== Array.prototype) {
      throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
    }
    for (let index = 0; index < subgoals.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(subgoals, index)) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
    }
    if (kind !== "MULTIPART") {
      if (subgoals.length !== 0) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      return node as P2GoalSpec;
    }
    if (subgoals.length === 0 || subgoals.length > P2_LIMITS.maxGoals) {
      throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
    }
    for (const child of subgoals) {
      const childSource = child as Record<string, unknown> | null;
      if (typeof childSource !== "object" || childSource === null) {
        throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
      }
      if (childSource.kind === "MULTIPART") {
        throw new P2Error(P2_ERROR_CODES.BOUND_EXCEEDED);
      }
      walk(child, depth + 1);
    }
    return node as P2GoalSpec;
  };
  for (const spec of specs) {
    walk(spec, 1);
  }
  return specs as readonly P2GoalSpec[];
}

// ---------------------------------------------------------------------------
// The single normative WorkPacket schema (static JS object).
// ---------------------------------------------------------------------------

const SHORT = { type: "string", minLength: 1, maxLength: 256 } as const;
const TEXT = { type: "string", maxLength: 4096 } as const;
const SHORT_LIST = {
  type: "array",
  maxItems: 32,
  items: SHORT,
} as const;
const REF = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId", "artifactVersion"],
  properties: {
    artifactId: SHORT,
    artifactVersion: { type: "integer", minimum: 1, maximum: MAX_SAFE },
  },
} as const;

const WORK_PACKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "sessionId",
    "problemHash",
    "contractVersion",
    "taskId",
    "goalId",
    "scopeId",
    "routeId",
    "sourceRequestId",
    "claim",
    "derivation",
    "assumptions",
    "dependencies",
    "pendingObligations",
    "suggestedChecks",
    "deliveryStatus",
    "candidateProposal",
  ],
  properties: {
    schemaVersion: { const: P2_WORK_PACKET_SCHEMA_VERSION },
    sessionId: SHORT,
    problemHash: { type: "string", minLength: 64, maxLength: 64 },
    contractVersion: { type: "integer", minimum: 1, maximum: MAX_SAFE },
    taskId: SHORT,
    goalId: SHORT,
    scopeId: SHORT,
    routeId: SHORT,
    sourceRequestId: SHORT,
    claim: TEXT,
    derivation: TEXT,
    assumptions: SHORT_LIST,
    dependencies: {
      type: "array",
      maxItems: 32,
      items: REF,
    },
    pendingObligations: SHORT_LIST,
    suggestedChecks: SHORT_LIST,
    deliveryStatus: { enum: P2_PACKET_DELIVERY },
    candidateProposal: { type: ["string", "null"], maxLength: 4096 },
  },
} as const;

/**
 * The single normative WorkPacket schema, deep-frozen so an importer cannot
 * widen `additionalProperties` or add fields after the fact.
 */
export const P2_WORK_PACKET_SCHEMA = p2Snapshot(WORK_PACKET_SCHEMA);

/**
 * Strict parse of one WorkPacket from raw text.
 *
 * Order: lone-surrogate scan of the input string, UTF-8 decode with the shared
 * frame bound, duplicate keys, non-finite tokens, unsafe numbers, JSON.parse,
 * then the single normative schema. Only a fixed `P2Error.code` escapes; raw
 * input and JSON exception messages are never exposed.
 */
export function parseP2WorkPacket(text: string): P2WorkPacket {
  if (typeof text !== "string") {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const surrogates = detectLoneSurrogates(text);
  if (!surrogates.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const decoded = decodeFrame(Buffer.from(text, "utf8"));
  if (!decoded.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const raw = decoded.value;
  const dup = detectDuplicateKeys(raw);
  if (!dup.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const nonFinite = detectNonFiniteTokens(raw);
  if (!nonFinite.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const nums = detectUnsafeNumbers(raw);
  if (!nums.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const parsedSurrogates = detectLoneSurrogates(parsed);
  if (!parsedSurrogates.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  const checked = validateAgainstSchema(parsed, P2_WORK_PACKET_SCHEMA);
  if (!checked.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return p2Snapshot(parsed as P2WorkPacket);
}

/** Map a shared parse failure onto a fixed P2 code without echoing detail. */
export function p2CodeOf(result: { readonly ok: false; readonly code: ErrorCode }): P2ErrorCode {
  return result.code === ERROR_CODES.VERSION_MISMATCH
    ? P2_ERROR_CODES.VERSION_MISMATCH
    : P2_ERROR_CODES.PACKET_SCHEMA;
}

export type { ParseResult };
