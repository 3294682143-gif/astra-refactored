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

import type { P2Artifact, P2Contract, P2Event, P2GoalSpec, P2TransportStatus } from "./p2.js";
import type { P3EffectReceipt, P3EffectRequest } from "./p3.js";
import type { P4DeliveryPolicy, P4FinalDecision, P4ReviewSnapshot } from "./p4.js";

/** Fixed phase of one model request. WORK and R2 share one root budget. */
export const AGENT_MODEL_PHASE = Object.freeze(["WORK", "R2"] as const);
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

/** The two injected ports of one AgentLoop run. */
export interface AgentPorts {
  readonly model: AgentModelPort;
  readonly effect: AgentEffectPort | null;
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
  readonly remainingMs: number;
  readonly policy?: P4DeliveryPolicy;
  readonly now?: () => number;
  readonly goalSpecs?: readonly P2GoalSpec[];
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
  "R2",
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
  readonly stopReason: AgentTraceCode;
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
}

/** Frozen result of one unified AgentLoop run. */
export interface AgentLoopResult {
  readonly summary: AgentLoopSummary;
  readonly privateState: AgentLoopPrivateState;
}
