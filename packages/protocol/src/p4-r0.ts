/**
 * @astra/protocol — P4 R0 initial-template planning precheck DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * validation and no mathematical decision. A hash or a binding confirms
 * identity of the same data, not mathematical equivalence. `UNKNOWN` is the
 * only semantic result this surface can express, and nothing here is
 * acceptance.
 */

import type { P2Contract, P2TransportStatus } from "./p2.js";
import type {
  P4ReviewCode,
  P4ReviewContext,
  P4ReviewState,
  P4StepLocator,
} from "./p4.js";

/** Identity binding of one R0 planning target. */
export interface P4R0Binding {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly planHash: string;
}

/**
 * One R0 planning target: the binding, the pristine initial contract and the
 * template plan text. `planText` is a work view of the contract, never a claim
 * that the template is semantically equivalent to the problem.
 */
export interface P4R0Target {
  readonly binding: P4R0Binding;
  readonly contract: P2Contract;
  readonly planText: string;
}

/** Fixed non-assumptive risk codes. No free-form code is accepted. */
export const P4_R0_RISK_CODES = Object.freeze([
  "BRANCH_COVERAGE",
  "COUNT_COVERAGE",
  "BOUND_ATTAINMENT",
  "PROOF_PREMISES",
  "MULTIPART_COVERAGE",
  "UNKNOWN_GOAL",
  "EXPLICIT_RISK_HINT",
] as const);
export type P4R0RiskCode = (typeof P4_R0_RISK_CODES)[number];

/**
 * Fixed M1 disposition of one initial-template precheck. `SKIPPED_BY_POLICY`
 * and `INSUFFICIENT_BUDGET` are not failures and not acceptance; an illegal
 * input is a thrown error, never an `INVALID` action value.
 */
export const P4_R0_ACTION = Object.freeze([
  "SKIPPED_BY_POLICY",
  "INSUFFICIENT_BUDGET",
  "REQUEST_REVIEW",
] as const);
export type P4R0Action = (typeof P4_R0_ACTION)[number];

/**
 * M1 precheck result. `structuralMatch` is always true because M1 rebuilds the
 * whole template and compares it structurally; `semanticResult` stays
 * `UNKNOWN` and `canSupportObligation` stays false. The three budget fields are
 * a frozen view supplied by a trusted controller, not a global resource
 * authority.
 */
export interface P4R0Preparation {
  readonly target: P4R0Target;
  readonly action: P4R0Action;
  readonly riskCodes: readonly P4R0RiskCode[];
  readonly structuralMatch: true;
  readonly semanticResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly planningModelCalls: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
}

/**
 * Trusted M1 precheck options. `enabled` defaults to false, so model-style R0
 * is disabled unless a caller explicitly turns it on.
 */
export interface P4R0Options {
  readonly enabled?: boolean;
  readonly planningModelCalls?: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
}

/** The three fixed R0 review dimensions. */
export const P4_R0_DIMENSION = Object.freeze([
  "PROBLEM_ALIGNMENT",
  "SCOPE",
  "TASK_COVERAGE",
] as const);
export type P4R0Dimension = (typeof P4_R0_DIMENSION)[number];

/** Fixed per-dimension verdict. `UNKNOWN` is not a refutation. */
export const P4_R0_VERDICT = Object.freeze(["NO_ISSUE", "ISSUES", "UNKNOWN"] as const);
export type P4R0Verdict = (typeof P4_R0_VERDICT)[number];

/**
 * One dimension check. `problemSpan` locates the exact codepoint slice of
 * `contract.problemFullText` and `planSpan` the exact slice of
 * `target.planText`; both may be null only for an `UNKNOWN` verdict.
 */
export interface P4R0Check {
  readonly dimension: P4R0Dimension;
  readonly verdict: P4R0Verdict;
  readonly rationale: string;
  readonly problemSpan: P4StepLocator | null;
  readonly planSpan: P4StepLocator | null;
}

export const P4_R0_REVIEW_SCHEMA_VERSION = "p4-r0-review-v1" as const;
export type P4R0ReviewSchemaVersion = typeof P4_R0_REVIEW_SCHEMA_VERSION;

export const P4_R0_CONCLUSION = Object.freeze(["NO_ISSUE", "ISSUES", "UNKNOWN"] as const);
export type P4R0Conclusion = (typeof P4_R0_CONCLUSION)[number];

/**
 * Strict model R0 report. `NO_ISSUE` is not a proof of correctness and
 * `reviewCoverage` lists only obligations the report claims to have covered.
 */
export interface P4R0ReviewReport {
  readonly schemaVersion: P4R0ReviewSchemaVersion;
  readonly requestId: "model-1";
  readonly stage: "R0";
  readonly target: P4R0Binding;
  readonly planHash: string;
  readonly conclusion: P4R0Conclusion;
  readonly reviewCoverage: readonly string[];
  readonly checks: readonly P4R0Check[];
}

/** Model R0 evidence: at most REVIEWED, always checkResult UNKNOWN. */
export interface P4R0ReviewEvidence {
  readonly requestId: "model-1";
  readonly target: P4R0Binding;
  readonly planHash: string;
  readonly source: "MODEL_REVIEW";
  readonly level: "PROVISIONAL" | "REVIEWED";
  readonly checkResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly canReviseContract: false;
}

/**
 * One R0 review call record. It extends the evidence flags so a record and its
 * evidence cannot drift apart; `availability` is the separate evidence axis and
 * a non-OK code keeps the raw text and the code.
 */
export interface P4R0ReviewRecord extends P4R0ReviewEvidence {
  readonly availability: "ACTIVE" | "STALE";
  readonly state: P4ReviewState;
  readonly transportStatus: P2TransportStatus | null;
  readonly context: P4ReviewContext;
  readonly rawResponseText: string | null;
  readonly report: P4R0ReviewReport | null;
  readonly code: P4ReviewCode;
}

/** Frozen view of one R0 target's review state. */
export interface P4R0ReviewSnapshot {
  readonly target: P4R0Binding;
  readonly planHash: string;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4R0ReviewRecord | null;
}
