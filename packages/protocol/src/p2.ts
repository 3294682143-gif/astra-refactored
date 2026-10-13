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

/** Second WorkPacket schema version: adds one untrusted route proposal. */
export const P2_WORK_PACKET_SCHEMA_VERSION_V2 = "p2a-work-v2" as const;
export type P2WorkPacketSchemaVersionV2 = typeof P2_WORK_PACKET_SCHEMA_VERSION_V2;

/** Third WorkPacket schema version: adds one untrusted dependent-task proposal. */
export const P2_WORK_PACKET_SCHEMA_VERSION_V3 = "p2a-work-v3" as const;
export type P2WorkPacketSchemaVersionV3 = typeof P2_WORK_PACKET_SCHEMA_VERSION_V3;

/** Fourth WorkPacket schema version: adds one untrusted artifact-redo proposal. */
export const P2_WORK_PACKET_SCHEMA_VERSION_V4 = "p2a-work-v4" as const;
export type P2WorkPacketSchemaVersionV4 = typeof P2_WORK_PACKET_SCHEMA_VERSION_V4;

/** Fifth WorkPacket schema version: adds one untrusted scope-refinement proposal. */
export const P2_WORK_PACKET_SCHEMA_VERSION_V5 = "p2a-work-v5" as const;
export type P2WorkPacketSchemaVersionV5 = typeof P2_WORK_PACKET_SCHEMA_VERSION_V5;

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
  "PARAMETER",
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
 * The single control-side authority for which obligation kinds carry a goal's
 * final answer: the image of the goal-kind -> answer-obligation map
 * (`VALUE->CANDIDATE_VALIDITY`, `ALL_SOLUTIONS->EXHAUSTIVENESS`,
 * `COUNT->COUNT_OBJECTS`, `OPTIMIZATION->GLOBAL_BOUND`, `PROOF->PROOF_GOAL`,
 * `PARAMETER->BOUNDARY_EXCEPTIONS`, `MULTIPART->SUBGOAL_COVERAGE`,
 * `UNKNOWN->ANSWER_REQUEST`). A COMPLETE packet for any other obligation (a
 * premise, a local lemma, a feasible point, a boundary exception of another
 * goal kind, a coverage statement) is never a whole-problem candidate. The
 * AgentLoop candidate admission and the P4 candidate gate use this one
 * predicate; the Python Host mirrors it read-only so its projection cannot
 * independently widen or narrow the control-side decision.
 *
 * @deprecated The global set is a projection of the pairing map below and is
 * kept only for the not-yet-migrated callers. New code must use
 * `p2IsAnswerObligationKindForGoal(goalKind, obligationKind)`, because a
 * local obligation of one goal kind (e.g. `CANDIDATE_VALIDITY` under
 * `ALL_SOLUTIONS`, `EXHAUSTIVENESS` under `COUNT`) is not the whole-problem
 * answer of that goal.
 */
export const P2_ANSWER_OBLIGATION_KINDS: readonly P2ObligationKind[] = [
  "CANDIDATE_VALIDITY",
  "EXHAUSTIVENESS",
  "COUNT_OBJECTS",
  "GLOBAL_BOUND",
  "PROOF_GOAL",
  "BOUNDARY_EXCEPTIONS",
  "SUBGOAL_COVERAGE",
  "ANSWER_REQUEST",
];

/**
 * @deprecated True iff `kind` is the answer obligation of *some* goal kind.
 * Use `p2IsAnswerObligationKindForGoal` for a real goal-scoped decision.
 */
export function p2IsAnswerObligationKind(kind: P2ObligationKind): boolean {
  return (P2_ANSWER_OBLIGATION_KINDS as readonly string[]).includes(kind);
}

/**
 * The single control-side authority for which obligation kind carries the
 * final answer of one goal kind. This is a total map over `P2GoalKind`, so
 * every goal kind has exactly one answer obligation and no goal kind can fall
 * through a default branch.
 */
export const P2_ANSWER_OBLIGATION_BY_GOAL: Readonly<Record<P2GoalKind, P2ObligationKind>> = {
  VALUE: "CANDIDATE_VALIDITY",
  ALL_SOLUTIONS: "EXHAUSTIVENESS",
  COUNT: "COUNT_OBJECTS",
  OPTIMIZATION: "GLOBAL_BOUND",
  PROOF: "PROOF_GOAL",
  PARAMETER: "BOUNDARY_EXCEPTIONS",
  MULTIPART: "SUBGOAL_COVERAGE",
  UNKNOWN: "ANSWER_REQUEST",
};

/** The answer obligation kind of one goal kind; total over `P2GoalKind`. */
export function p2AnswerObligationForGoal(goalKind: P2GoalKind): P2ObligationKind {
  return P2_ANSWER_OBLIGATION_BY_GOAL[goalKind];
}

/**
 * True iff `obligationKind` is the answer obligation of exactly this
 * `goalKind`. A COMPLETE packet for any other obligation of the same goal (a
 * premise, a local lemma, a feasible point, a boundary exception, a coverage
 * statement) is never a whole-problem candidate.
 */
export function p2IsAnswerObligationKindForGoal(
  goalKind: P2GoalKind,
  obligationKind: P2ObligationKind,
): boolean {
  return p2AnswerObligationForGoal(goalKind) === obligationKind;
}

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

/**
 * One untrusted route suggestion carried by a v2 WorkPacket. It is model
 * data only: no routeId, taskId, scope, dependency or budget field exists
 * here, and the control side derives all of those itself.
 */
export interface P2WorkflowProposal {
  readonly kind: "NEW_ROUTE";
  readonly obligationId: string;
  readonly mechanism: P2WorkflowMechanism;
  readonly rationale: string;
}

/** The four mathematical-mechanism fields of a proposed route. */
export interface P2WorkflowMechanism {
  readonly representation: string;
  readonly operation: string;
  readonly lemmas: readonly string[];
  readonly construction: string;
}

/**
 * One untrusted dependent-task suggestion carried by a v3 WorkPacket. It is
 * model data only: no taskId, refs, route, scope, checkpoint or budget field
 * exists here, and the control side derives all of those itself.
 */
export interface P2DependentTaskProposal {
  readonly kind: "DEPENDENT_TASK";
  readonly obligationId: string;
  readonly rationale: string;
}

/**
 * One untrusted artifact-redo suggestion carried by a v4 WorkPacket. It is
 * model data only: no taskId, route, scope, version, budget or supersedes
 * field exists here, and the control side derives all of those itself. A
 * `null` target asks to redo the work that just delivered this packet; a
 * non-null target must be a real input ref of the current accepted work.
 */
export interface P2ArtifactRedoProposal {
  readonly kind: "REDO_ARTIFACT";
  readonly targetArtifactRef: P2ArtifactRef | null;
  readonly rationale: string;
}

/**
 * One untrusted scope-refinement suggestion carried by a v5 WorkPacket. It is
 * model data only: no taskId, route, scopeId, obligationId, budget or
 * authority field exists here, and the control side derives all of those
 * itself. Every list is a declaration of data, never a proof of coverage.
 */
export interface P2ScopeProposal {
  readonly kind: "SCOPE_REFINEMENT";
  readonly quantifiers: readonly string[];
  readonly branchConditions: readonly string[];
  readonly boundaryCases: readonly string[];
  readonly goalExhaustion: readonly string[];
  readonly rationale: string;
}

/**
 * Strict v2 WorkPacket: every v1 field with the same meaning, plus a required
 * `workflowProposal` that is either `null` or one NEW_ROUTE suggestion.
 */
export interface P2WorkPacketV2 extends Omit<P2WorkPacket, "schemaVersion"> {
  readonly schemaVersion: P2WorkPacketSchemaVersionV2;
  readonly workflowProposal: P2WorkflowProposal | null;
}

/**
 * Strict v3 WorkPacket: every v1 field with the same meaning, plus a required
 * `workflowProposal` that is either `null` or one DEPENDENT_TASK suggestion.
 */
export interface P2WorkPacketV3 extends Omit<P2WorkPacket, "schemaVersion"> {
  readonly schemaVersion: P2WorkPacketSchemaVersionV3;
  readonly workflowProposal: P2DependentTaskProposal | null;
}

/**
 * Strict v4 WorkPacket: every v1 field with the same meaning, plus a required
 * `workflowProposal` that is either `null` or one REDO_ARTIFACT suggestion.
 */
export interface P2WorkPacketV4 extends Omit<P2WorkPacket, "schemaVersion"> {
  readonly schemaVersion: P2WorkPacketSchemaVersionV4;
  readonly workflowProposal: P2ArtifactRedoProposal | null;
}

/**
 * Strict v5 WorkPacket: every v4 field with the same meaning, plus a required
 * `scopeProposal` that is either `null` or one SCOPE_REFINEMENT suggestion.
 */
export interface P2WorkPacketV5 extends Omit<P2WorkPacketV4, "schemaVersion"> {
  readonly schemaVersion: P2WorkPacketSchemaVersionV5;
  readonly scopeProposal: P2ScopeProposal | null;
}

/** Any accepted WorkPacket version. Each keeps its own raw identity. */
export type P2AcceptedWorkPacket =
  | P2WorkPacket
  | P2WorkPacketV2
  | P2WorkPacketV3
  | P2WorkPacketV4
  | P2WorkPacketV5;

export const P2_ARTIFACT_AVAILABILITY = ["ACTIVE", "STALE"] as const;
export type P2ArtifactAvailability = (typeof P2_ARTIFACT_AVAILABILITY)[number];

export interface P2Artifact {
  readonly envelope: RecordEnvelope;
  readonly artifactId: string;
  readonly routeId: string;
  readonly scope: Scope;
  readonly dependencies: readonly P2ArtifactRef[];
  readonly sourceRequestId: string;
  readonly rawResponseHash: string;
  readonly rawResponseRef: string;
  readonly rawResponseText: string;
  readonly packet: P2AcceptedWorkPacket | null;
  readonly transportStatus: P2TransportStatus;
  readonly deliveryStatus: P2PacketDelivery;
  readonly level: "PROVISIONAL";
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
  "TASK_YIELDED",
] as const;
export type P2EventType = (typeof P2_EVENT_TYPE)[number];

/** Fixed reason of one task-level yield. No free-form reason is accepted. */
export const P2_TASK_YIELD_REASON = ["UNSOLVED", "PARTIAL", "REPEATED_EFFECT"] as const;
export type P2TaskYieldReason = (typeof P2_TASK_YIELD_REASON)[number];

/** Schema version carried only by a TASK_YIELDED event. */
export const P2_TASK_PROGRESS_EVENT_SCHEMA_VERSION = "p2-task-progress-v1" as const;
export type P2TaskProgressEventSchemaVersion = typeof P2_TASK_PROGRESS_EVENT_SCHEMA_VERSION;

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
  /** Present only on a TASK_YIELDED event; older events keep their exact bytes. */
  readonly eventSchemaVersion?: P2TaskProgressEventSchemaVersion;
  readonly sourceRequestId?: string;
  readonly yieldReason?: P2TaskYieldReason;
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

const PROPOSAL_MECHANISM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["representation", "operation", "lemmas", "construction"],
  properties: {
    representation: SHORT,
    operation: SHORT,
    lemmas: SHORT_LIST,
    construction: SHORT,
  },
} as const;

const WORKFLOW_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "obligationId", "mechanism", "rationale"],
  properties: {
    kind: { const: "NEW_ROUTE" },
    obligationId: SHORT,
    mechanism: PROPOSAL_MECHANISM_SCHEMA,
    rationale: TEXT,
  },
} as const;

/**
 * v2 schema: a shallow copy of the v1 property set with `schemaVersion`
 * replaced and `workflowProposal` added. Built lazily so no top-level read of
 * a re-exported `index` binding can hit a TDZ hazard.
 */
function buildWorkPacketSchemaV2(): unknown {
  const properties: Record<string, unknown> = { ...WORK_PACKET_SCHEMA.properties };
  properties.schemaVersion = { const: P2_WORK_PACKET_SCHEMA_VERSION_V2 };
  properties.workflowProposal = {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["kind", "obligationId", "mechanism", "rationale"],
    properties: WORKFLOW_PROPOSAL_SCHEMA.properties,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [...WORK_PACKET_SCHEMA.required, "workflowProposal"],
    properties,
  };
}

let cachedWorkPacketSchemaV2: unknown = null;

/** The normative v2 WorkPacket schema, deep-frozen on first use. */
export function p2WorkPacketSchemaV2(): unknown {
  if (cachedWorkPacketSchemaV2 === null) {
    cachedWorkPacketSchemaV2 = p2Snapshot(buildWorkPacketSchemaV2());
  }
  return cachedWorkPacketSchemaV2;
}

const DEPENDENT_TASK_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "obligationId", "rationale"],
  properties: {
    kind: { const: "DEPENDENT_TASK" },
    obligationId: SHORT,
    rationale: TEXT,
  },
} as const;

/**
 * v3 schema: a shallow copy of the v1 property set with `schemaVersion`
 * replaced and `workflowProposal` added as a nullable DEPENDENT_TASK object.
 * Built lazily so no top-level read of a re-exported `index` binding can hit a
 * TDZ hazard.
 */
function buildWorkPacketSchemaV3(): unknown {
  const properties: Record<string, unknown> = { ...WORK_PACKET_SCHEMA.properties };
  properties.schemaVersion = { const: P2_WORK_PACKET_SCHEMA_VERSION_V3 };
  properties.workflowProposal = {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["kind", "obligationId", "rationale"],
    properties: DEPENDENT_TASK_PROPOSAL_SCHEMA.properties,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [...WORK_PACKET_SCHEMA.required, "workflowProposal"],
    properties,
  };
}

let cachedWorkPacketSchemaV3: unknown = null;

/** The normative v3 WorkPacket schema, deep-frozen on first use. */
export function p2WorkPacketSchemaV3(): unknown {
  if (cachedWorkPacketSchemaV3 === null) {
    cachedWorkPacketSchemaV3 = p2Snapshot(buildWorkPacketSchemaV3());
  }
  return cachedWorkPacketSchemaV3;
}

const ARTIFACT_REDO_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "targetArtifactRef", "rationale"],
  properties: {
    kind: { const: "REDO_ARTIFACT" },
    targetArtifactRef: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["artifactId", "artifactVersion"],
      properties: {
        artifactId: SHORT,
        artifactVersion: { type: "integer", minimum: 1, maximum: MAX_SAFE },
      },
    },
    rationale: TEXT,
  },
} as const;

/**
 * v4 schema: a shallow copy of the v1 property set with `schemaVersion`
 * replaced and `workflowProposal` added as a nullable REDO_ARTIFACT object.
 * Built lazily so no top-level read of a re-exported `index` binding can hit a
 * TDZ hazard.
 */
function buildWorkPacketSchemaV4(): unknown {
  const properties: Record<string, unknown> = { ...WORK_PACKET_SCHEMA.properties };
  properties.schemaVersion = { const: P2_WORK_PACKET_SCHEMA_VERSION_V4 };
  properties.workflowProposal = {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["kind", "targetArtifactRef", "rationale"],
    properties: ARTIFACT_REDO_PROPOSAL_SCHEMA.properties,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [...WORK_PACKET_SCHEMA.required, "workflowProposal"],
    properties,
  };
}

let cachedWorkPacketSchemaV4: unknown = null;

/** The normative v4 WorkPacket schema, deep-frozen on first use. */
export function p2WorkPacketSchemaV4(): unknown {
  if (cachedWorkPacketSchemaV4 === null) {
    cachedWorkPacketSchemaV4 = p2Snapshot(buildWorkPacketSchemaV4());
  }
  return cachedWorkPacketSchemaV4;
}

const SCOPE_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "quantifiers",
    "branchConditions",
    "boundaryCases",
    "goalExhaustion",
    "rationale",
  ],
  properties: {
    kind: { const: "SCOPE_REFINEMENT" },
    quantifiers: SHORT_LIST,
    branchConditions: SHORT_LIST,
    boundaryCases: SHORT_LIST,
    goalExhaustion: SHORT_LIST,
    rationale: TEXT,
  },
} as const;

/**
 * v5 schema: a shallow copy of the v4 property set with `schemaVersion`
 * replaced and `scopeProposal` added as a nullable SCOPE_REFINEMENT object.
 * Built lazily so no top-level read of a re-exported `index` binding can hit a
 * TDZ hazard.
 */
function buildWorkPacketSchemaV5(): unknown {
  const properties: Record<string, unknown> = { ...WORK_PACKET_SCHEMA.properties };
  properties.schemaVersion = { const: P2_WORK_PACKET_SCHEMA_VERSION_V5 };
  properties.workflowProposal = {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["kind", "targetArtifactRef", "rationale"],
    properties: ARTIFACT_REDO_PROPOSAL_SCHEMA.properties,
  };
  properties.scopeProposal = {
    type: ["object", "null"],
    additionalProperties: false,
    required: [
      "kind",
      "quantifiers",
      "branchConditions",
      "boundaryCases",
      "goalExhaustion",
      "rationale",
    ],
    properties: SCOPE_PROPOSAL_SCHEMA.properties,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [...WORK_PACKET_SCHEMA.required, "workflowProposal", "scopeProposal"],
    properties,
  };
}

let cachedWorkPacketSchemaV5: unknown = null;

/** The normative v5 WorkPacket schema, deep-frozen on first use. */
export function p2WorkPacketSchemaV5(): unknown {
  if (cachedWorkPacketSchemaV5 === null) {
    cachedWorkPacketSchemaV5 = p2Snapshot(buildWorkPacketSchemaV5());
  }
  return cachedWorkPacketSchemaV5;
}

/**
 * Shared strict parse core: surrogate scan, UTF-8 decode, duplicate keys,
 * non-finite tokens, unsafe numbers, JSON.parse, parsed-surrogate scan, then
 * one schema check. Only a fixed `P2Error.code` escapes.
 */
function parseStrictJson(
  text: string,
  schema: unknown | ((parsed: unknown) => unknown),
): unknown {
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
  const resolved = typeof schema === "function" ? schema(parsed) : schema;
  const checked = validateAgainstSchema(parsed, resolved);
  if (!checked.ok) {
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  }
  return parsed;
}

/**
 * Strict parse of one WorkPacket from raw text.
 *
 * Order: lone-surrogate scan of the input string, UTF-8 decode with the shared
 * frame bound, duplicate keys, non-finite tokens, unsafe numbers, JSON.parse,
 * then the single normative schema. Only a fixed `P2Error.code` escapes; raw
 * input and JSON exception messages are never exposed.
 */
export function parseP2WorkPacket(text: string): P2WorkPacket {
  const parsed = parseStrictJson(text, P2_WORK_PACKET_SCHEMA);
  return p2Snapshot(parsed as P2WorkPacket);
}

/**
 * Strict parse of one WorkPacket of either accepted version. The raw text is
 * parsed once with the shared core; a v2 packet keeps its full proposal and
 * is never rewritten into a v1 shape.
 */
export function parseP2WorkPacketAny(text: string): P2AcceptedWorkPacket {
  const parsed = parseStrictJson(text, (candidate: unknown): unknown => {
    const version =
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).schemaVersion
        : undefined;
    if (version === P2_WORK_PACKET_SCHEMA_VERSION) {
      return P2_WORK_PACKET_SCHEMA;
    }
    if (version === P2_WORK_PACKET_SCHEMA_VERSION_V2) {
      return p2WorkPacketSchemaV2();
    }
    if (version === P2_WORK_PACKET_SCHEMA_VERSION_V3) {
      return p2WorkPacketSchemaV3();
    }
    if (version === P2_WORK_PACKET_SCHEMA_VERSION_V4) {
      return p2WorkPacketSchemaV4();
    }
    if (version === P2_WORK_PACKET_SCHEMA_VERSION_V5) {
      return p2WorkPacketSchemaV5();
    }
    throw new P2Error(P2_ERROR_CODES.PACKET_SCHEMA);
  });
  return p2Snapshot(parsed as P2AcceptedWorkPacket);
}

/** Map a shared parse failure onto a fixed P2 code without echoing detail. */
export function p2CodeOf(result: { readonly ok: false; readonly code: ErrorCode }): P2ErrorCode {
  return result.code === ERROR_CODES.VERSION_MISMATCH
    ? P2_ERROR_CODES.VERSION_MISMATCH
    : P2_ERROR_CODES.PACKET_SCHEMA;
}

export type { ParseResult };
