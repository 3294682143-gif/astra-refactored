/**
 * @astra/protocol — unified AgentLoop DTO surface (declarations only).
 *
 * No I/O, no environment access, no network, no runtime business logic. These
 * shapes are the shared contract between the unified AgentLoop composition
 * root, the injected async model/effect ports and the root AgentSession. The
 * composition root is async and drives injected ports; the DTOs here stay
 * pure declarations. A receipt is a transport observation, never a
 * mathematical verification.
 */

import type {
  P2Artifact,
  P2ArtifactRef,
  P2Contract,
  P2Event,
  P2GoalSpec,
  P2RouteSpec,
  P2Task,
  P2TaskYieldReason,
  P2TransportStatus,
} from "./p2.js";
import type { P2MethodCatalog } from "./p2-methods.js";
import type { P3EffectReceipt, P3EffectRequest } from "./p3.js";
import type { P4DeliveryPolicy, P4FinalDecision, P4ReviewSnapshot } from "./p4.js";
import type { P4S1Assessment } from "./p4-repair.js";

/**
 * Fixed phase of one model request. WORK and R2 share one root budget; REPAIR
 * is the single G3/PR4 S2 evidence-triggered revision call that may follow one
 * R2 review of a protected candidate. It is not a new solver: it only re-states
 * the same answer obligation after a challenge. R0 is the bounded front-stage
 * planning review; R0_RECHECK is the single targeted recheck of the revised R0
 * plan and belongs to the same front stage, never to a second reviewer.
 */
export const AGENT_MODEL_PHASE = Object.freeze([
  "WORK",
  "CONSENSUS",
  "R2",
  "R4",
  "REPAIR",
  "R0",
  "R0_RECHECK",
] as const);
export type AgentModelPhase = (typeof AGENT_MODEL_PHASE)[number];

/** Fixed per-request output ceiling; the host enforces it, not the model. */
export const AGENT_MAX_OUTPUT_TOKENS = 8192 as const;

/** One model message. Roles are fixed; content is untrusted data. */
export interface AgentModelMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * One model request. `requestId` is the root ordinal (`model-N`), `taskId` and
 * `scopeId` are the trusted control binding of the current work unit, and
 * `remainingMs` is the single root deadline view. `contextHash`/`contextBytes`
 * identify the exact serialized messages, not their meaning.
 */
export interface AgentModelRequest {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly requestId: string;
  readonly phase: AgentModelPhase;
  readonly taskId: string;
  readonly scopeId: string;
  readonly messages: readonly AgentModelMessage[];
  readonly contextHash: string;
  readonly contextBytes: number;
  readonly remainingMs: number;
  readonly maxTokens: typeof AGENT_MAX_OUTPUT_TOKENS;
}

/**
 * One model receipt. `remainingMs` may only tighten the root deadline; a
 * missing value leaves it unchanged. `text` is raw model output and is never
 * a claim, a derivation or a verification.
 */
export interface AgentModelReceipt {
  readonly transportStatus: P2TransportStatus;
  readonly text: string;
  readonly remainingMs?: number;
}

/** Injected async model port. The only model entry point. */
export interface AgentModelPort {
  generate(request: AgentModelRequest): Promise<AgentModelReceipt>;
}

/**
 * Injected async effect port. `null` means no effect execution is available
 * and every tool action must be refused rather than simulated.
 */
export interface AgentEffectPort {
  execute(request: P3EffectRequest): Promise<P3EffectReceipt>;
}

/**
 * Injected async method-catalog port. `read` returns the trusted catalog view
 * for the current remaining window; an empty `entries` list is the explicit
 * "catalog unavailable" view. `null` means no catalog read is available and
 * every method action must be refused rather than simulated.
 */
export interface AgentCatalogPort {
  read(remainingMs: number): Promise<P2MethodCatalog>;
}

import type { MathAssetPort } from "./math-assets.js";

/** The two injected ports of one AgentLoop run. */
/** G7/PR7 Slice 7e: one scoped math-asset reference from the TS M2/M3/M5 side. */
export interface AgentAssetRequest {
  readonly group: "outputCheckers" | "mathFamilies" | "skills" | "prompts" | "methodCards";
  readonly assetId: string;
  readonly scopeId: string;
  readonly contractVersion: number;
}

/** Bounded integrity descriptor returned by the Host for a scoped asset call. */
export interface AgentAssetDescriptor {
  readonly group: string;
  readonly assetId: string;
  readonly scopeId: string;
  readonly contractVersion: number;
  readonly sha256: string;
}

/** Optional port: the loop resolves a registered math asset through the Host. */
export interface AgentAssetPort {
  readonly call: (request: AgentAssetRequest) => Promise<AgentAssetDescriptor>;
}

export interface AgentPorts {
  readonly model: AgentModelPort;
  readonly effect: AgentEffectPort | null;
  readonly catalog?: AgentCatalogPort | null;
  readonly asset?: AgentAssetPort | null;
  readonly mathAsset?: MathAssetPort | null;
}

/**
 * AgentLoop configuration. Every bound is validated by the composition root;
 * `remainingMs` is the single root budget and `now` is the injectable clock.
 */
export interface AgentLoopOptions {
  readonly maxModelCalls?: number;
  readonly maxWorkUnits?: number;
  readonly maxEffects?: number;
  readonly maxReviews?: number;
  readonly maxMethodLoads?: number;
  /** G3/PR4: at most one evidence-triggered S2 revision after the R2 review. */
  readonly maxRepairs?: number;
  /**
   * Bounded answer-consensus work: one blind independent re-solve and, on a
   * candidate disagreement, one adjudication. 0 disables the block entirely.
   */
  readonly maxConsensus?: number;
  /**
   * B1 (DECISION-0150): explicitly enable the bounded R0 planning review. With
   * the default 0 the R0 phase is dead and the run is byte-identical to before.
   * With 1 the loop runs one R0 review before any WORK, and on ISSUES at most
   * one `reviseGoals` contract revision (version 1 -> 2); if the single
   * revision still does not pass it falls back to the fixed deterministic
   * UNKNOWN template. Never a second bump and never extra planning budget.
   */
  readonly maxR0?: number;
  readonly remainingMs: number;
  readonly policy?: P4DeliveryPolicy;
  readonly now?: () => number;
  readonly goalSpecs?: readonly P2GoalSpec[];
  readonly domainId?: string;
  /** Derive the root budget from the compiled task graph instead of the caller. */
  readonly deriveBudget?: boolean;
  /**
   * G7/PR7 Slice 7d: an authenticated SessionLog prefix of an earlier run of
   * the same problem. When present the loop pre-seeds the log with these
   * already-settled events and continues from the breakpoint instead of
   * re-running the settled model/tool calls. Absent keeps the default path
   * byte-identical.
   */
  readonly resumeSessionLog?: readonly {
    readonly seq: number;
    readonly kind: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[];
  /** Declared contract version of the resume prefix (1 or 2). */
  readonly resumeContractVersion?: number | null;
  /**
   * Stage D+ controlled exploration: expose the single `explore` action to the
   * model only when the Host reported `capabilities.generatedPython ===
   * "AVAILABLE_BOUNDED"`. Absent or false is the default: the action word is
   * not offered, a parsed `explore` reply is treated exactly like an
   * unparseable one, and every existing run stays byte-identical.
   */
  readonly allowExploration?: boolean;
}

/** Fixed trace kinds. No free-form kind is accepted. */
export const AGENT_TRACE_KIND = Object.freeze(["MODEL", "EFFECT", "CONTROL"] as const);
export type AgentTraceKind = (typeof AGENT_TRACE_KIND)[number];

/** Fixed trace states. `RECORDED` is control-side only. */
export const AGENT_TRACE_STATE = Object.freeze([
  "DISPATCHED",
  "RETURNED",
  "OUTCOME_UNKNOWN",
  "RECORDED",
] as const);
export type AgentTraceState = (typeof AGENT_TRACE_STATE)[number];

/**
 * Fixed trace codes. Only these values may appear in a public trace; raw model
 * text, problem text and port error messages are never trace codes.
 */
export const AGENT_TRACE_CODE = Object.freeze([
  "WORK",
  "CONSENSUS",
  "R2",
  "R4",
  "REPAIR",
  "R0",
  "COMPLETE",
  "TRUNCATED",
  "ERROR",
  "UNKNOWN",
  "ADMITTED",
  "BUDGET_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "ILLEGAL_TRANSITION",
  "NO_CANDIDATE",
  "NO_REVIEW",
  "CONTROL_REJECTED",
  "PACKET_REJECTED",
  "CONTEXT_REJECTED",
  "REVIEW_STOP",
  "REVIEWS_COMPLETE",
  "WORK_UNITS_COMPLETE",
  "REVISED_CANDIDATE",
  "REVISE_REJECTED",
  "PORT_REJECTED",
  "STOPPED",
] as const);
export type AgentTraceCode = (typeof AGENT_TRACE_CODE)[number];

/** One append-only trace row. `seq` is assigned by the root, never by a caller. */
export interface AgentTraceEvent {
  readonly seq: number;
  readonly kind: AgentTraceKind;
  readonly id: string;
  readonly state: AgentTraceState;
  readonly code: AgentTraceCode;
}

/** Frozen public projection of one root session. Contains no raw text. */
export interface AgentSessionSnapshot {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly modelCalls: number;
  readonly effectCalls: number;
  readonly stopped: boolean;
  readonly pendingModel: string | null;
  readonly pendingEffect: string | null;
  readonly events: readonly AgentTraceEvent[];
}

/**
 * Public summary of one unified AgentLoop run. `candidateVerified` is always
 * false and strict acceptance is never performed; `stopReason` is a fixed
 * trace code, never raw model text.
 */
export interface AgentLoopSummary {
  readonly mode: "TS_PREVIEW";
  readonly targetEnvironment: "TARGET_UNVERIFIED";
  readonly sessionId: string;
  readonly status: "candidate" | "unsolved";
  readonly finalResponse: string;
  readonly candidateVerified: false;
  readonly strictAcceptance: "NOT_PERFORMED";
  readonly policy: P4DeliveryPolicy;
  readonly reason: string;
  readonly modelCalls: number;
  readonly effectCalls: number;
  readonly workUnits: number;
  readonly reviewCalls: number;
  readonly repairCalls: number;
  readonly catalogCalls: number;
  readonly methodLoads: number;
  readonly stopReason: AgentTraceCode;
  /**
   * B2 (DECISION-0150): the auxiliary obligations still unclosed when the
   * candidate is released — a proof's `PREMISES` (E05: un-discharged
   * provisional/contrapositive assumptions) and an optimization's `ATTAINMENT`
   * (E06: an attainment witness with no equality case). Their presence never
   * blocks the BEST_EFFORT candidate but keeps `candidateVerified` false and is
   * reported honestly instead of being silently dropped.
   */
  readonly unresolvedObligations: readonly string[];
}

/**
 * Private control-side state of one run. It is never sent on the wire and
 * carries no raw model text beyond the retained request/effect records.
 */
export interface AgentLoopPrivateState {
  readonly contract: P2Contract;
  readonly events: readonly P2Event[];
  readonly artifacts: readonly unknown[];
  readonly requests: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly modelGate: readonly unknown[];
  readonly review: P4ReviewSnapshot | null;
  readonly decision: P4FinalDecision;
  readonly session: AgentSessionSnapshot;
  readonly catalog?: P2MethodCatalog | null;
  readonly routes?: readonly P2RouteSpec[];
  readonly taskRoutes?: readonly AgentTaskRoute[];
  readonly routeAdmissions?: readonly AgentRouteAdmission[];
  readonly dependencyAdmissions?: readonly AgentRouteAdmission[];
  readonly revisions?: readonly AgentRevisionRecord[];
  readonly readyTasks?: readonly P2Task[];
  readonly progressEvents?: readonly AgentProgressEvent[];
  /** G3/PR4 Slice 3a: the M5 S1 mapping assessment of the last repair attempt. */
  readonly s1Assessment?: P4S1Assessment | null;
  /** G3/PR4 Slice 3a S2: the local repair transaction of the last revision. */
  readonly s2Transaction?: {
    readonly supersededObligationIds: readonly string[];
    readonly preservedObligationIds: readonly string[];
    readonly preservedParentArtifactId: string | null;
  } | null;  /** G4/PR5 Slice 4a: the immutable session log projection (private, not on the wire). */
  readonly sessionLog?: {
    readonly schemaVersion: string;
    readonly version: number;
    readonly events: readonly {
      readonly seq: number;
      readonly schemaVersion: string;
      readonly kind: string;
      readonly data: Readonly<Record<string, unknown>>;
    }[];
  } | null;
}

/** Fixed schema version of one private progress event record. */
export const AGENT_PROGRESS_EVENT_SCHEMA_VERSION = "agent-progress-event-v1" as const;
export type AgentProgressEventSchemaVersion = typeof AGENT_PROGRESS_EVENT_SCHEMA_VERSION;

/**
 * Private record of one task-level yield. It mirrors the real M1 TASK_YIELDED
 * event; it is never a mathematical claim and never a new model call.
 */
export interface AgentProgressEvent {
  readonly schemaVersion: AgentProgressEventSchemaVersion;
  readonly taskId: string;
  readonly sourceRequestId: string;
  readonly reason: P2TaskYieldReason;
}

/**
 * Control-side provenance of one dynamically admitted route. The four fields
 * are the declared identity of the source proposal; they are data identity,
 * never an independent mathematical proof.
 */
export interface AgentRouteProvenance {
  readonly sourceRequestId: string;
  readonly sourceArtifactRef: P2ArtifactRef;
  readonly obligationId: string;
  readonly routeSignature: string;
}

/**
 * Control-side provenance of one dynamically admitted dependent task. Same
 * four declared identity fields as a route provenance; it is data identity,
 * never an independent mathematical proof, and it never replaces the route
 * provenance of a NEW_ROUTE task.
 */
export type AgentDependencyProvenance = AgentRouteProvenance;

/** Private mapping of one task to the route it runs under. */
export interface AgentTaskRoute {
  readonly taskId: string;
  readonly routeId: string;
  readonly provenance: AgentRouteProvenance | null;
}

/** Private record of one admitted route; never sent on the wire. */
export interface AgentRouteAdmission {
  readonly taskId: string;
  readonly routeId: string;
  readonly provenance: AgentRouteProvenance;
}

/**
 * Control-side provenance of one artifact redo. The five declared fields are
 * the identity of the source proposal and of the target it names; `targetHash`
 * is the sha256 of the exact raw response text of the target artifact. It is
 * an integrity identity of the same bytes, never a mathematical proof and
 * never a statement about the target's correctness.
 */
export interface AgentRevisionProvenance {
  readonly sourceRequestId: string;
  readonly sourceArtifactRef: P2ArtifactRef;
  readonly targetArtifactRef: P2ArtifactRef;
  readonly targetSourceRequestId: string;
  readonly targetHash: string;
}

/** Fixed lifecycle of one redo record. No other state is accepted. */
export const AGENT_REVISION_STATUS = Object.freeze(["PENDING", "COMMITTED", "ABORTED"] as const);
export type AgentRevisionStatus = (typeof AGENT_REVISION_STATUS)[number];

/**
 * Private record of one artifact redo. It is never sent on the wire and
 * carries no raw model text. `newRef` is null until a real replacement is
 * committed; `staleRefs` is the exact invalidation closure of that commit.
 */
export interface AgentRevisionRecord {
  readonly provenance: AgentRevisionProvenance;
  readonly taskId: string;
  readonly status: AgentRevisionStatus;
  readonly newRef: P2ArtifactRef | null;
  readonly staleRefs: readonly P2ArtifactRef[];
}

/** Frozen result of one unified AgentLoop run. */
export interface AgentLoopResult {
  readonly summary: AgentLoopSummary;
  readonly privateState: AgentLoopPrivateState;
}
