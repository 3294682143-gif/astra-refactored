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
  /**
   * Explicit opt-in to the bounded R0 stage for a run whose template has no
   * intrinsic risk code. The full-capability profile sets this together with
   * `enabled`; it is never inferred from the problem text and never widens the
   * fixed five-call stage bound.
   */
  readonly force?: boolean;
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
 * Fixed, closed reviewer-role vocabulary of the R0 three-review stage. Each
 * role is one independent reviewer bound to exactly one review dimension, so
 * the three reviews never share a prompt, a payload or a model call.
 */
export const P4_R0_ROLE = Object.freeze(["MEANING", "METHOD", "TASK_TOOL"] as const);
export type P4R0Role = (typeof P4_R0_ROLE)[number];

/** The single review dimension each role owns. The binding is never a rank. */
export const P4_R0_ROLE_DIMENSION: Readonly<Record<P4R0Role, P4R0Dimension>> = Object.freeze({
  MEANING: "PROBLEM_ALIGNMENT",
  METHOD: "SCOPE",
  TASK_TOOL: "TASK_COVERAGE",
});

/**
 * Number of independent role reviews one R0 stage performs: exactly one per
 * role. It bounds the review records of one `P4R0ReviewSession`.
 */
export const P4_R0_MAX_REVIEWS = 3 as const;

/**
 * Root model calls the whole R0 stage may spend: three role reviews, one
 * targeted recheck and at most one plan revision. The stage is refused with
 * `INSUFFICIENT_BUDGET` when the root cannot cover this fixed design; the
 * public `maxR0` switch stays a 0/1 on/off flag and is never a call count.
 */
export const P4_R0_MAX_ROOT_CALLS = 5 as const;

/**
 * The `model-<n>` request-id shape used everywhere else in this codebase
 * (`^model-([1-9][0-9]{0,2})$`): a bounded root ordinal, never free text.
 */
export const P4_R0_REQUEST_ID = /^model-[1-9][0-9]{0,2}$/u;

/** True for a bounded root-ordinal request id, false for anything else. */
export function isP4R0RequestId(value: unknown): value is string {
  return typeof value === "string" && P4_R0_REQUEST_ID.test(value);
}

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
 * Strict model R0 review report — one *role-scoped* reply of the three review
 * stage. `requestId` is the real root ordinal the call was dispatched under
 * (any `model-<n>`, never free text) and `role` is the closed reviewer role;
 * `checks` holds exactly that role's single dimension. `NO_ISSUE` is not a
 * proof of correctness and `reviewCoverage` lists only obligations the report
 * claims to have covered.
 */
export interface P4R0ReviewReport {
  readonly schemaVersion: P4R0ReviewSchemaVersion;
  readonly requestId: string;
  readonly stage: "R0";
  readonly role: P4R0Role;
  readonly target: P4R0Binding;
  readonly planHash: string;
  readonly conclusion: P4R0Conclusion;
  readonly reviewCoverage: readonly string[];
  readonly checks: readonly P4R0Check[];
}

/** Model R0 evidence: at most REVIEWED, always checkResult UNKNOWN. */
export interface P4R0ReviewEvidence {
  readonly requestId: string;
  readonly role: P4R0Role;
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

/** Frozen view of one R0 target's review state for exactly one role. */
export interface P4R0ReviewSnapshot {
  readonly target: P4R0Binding;
  readonly planHash: string;
  readonly role: P4R0Role;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4R0ReviewRecord | null;
}

/**
 * One role whose recorded verdict differs from the aggregate conclusion. The
 * row carries only enum verdicts, the role and its bound dimension: no model
 * text, no rationale and no severity ranking may ever appear here.
 */
export interface P4R0Dissent {
  readonly role: P4R0Role;
  readonly dimension: P4R0Dimension;
  readonly verdict: P4R0Verdict;
}

/**
 * Which roles the aggregate actually saw. A role that never settled is listed
 * in `missing` (never silently dropped) and appears in no dissent row.
 */
export interface P4R0AggregateCoverage {
  readonly roles: readonly P4R0Role[];
  readonly missing: readonly P4R0Role[];
  readonly dimensions: readonly P4R0Dimension[];
}

/**
 * Pure controller aggregation of the three independent role reviews. It is a
 * bounded summary of enum verdicts only: never a proof, never a verification
 * and never acceptance. A missing role, an unusable reply and an `UNKNOWN`
 * verdict all keep the aggregate inconclusive.
 */
export interface P4R0Aggregate {
  readonly conclusion: P4R0Conclusion;
  readonly issueDimensions: readonly P4R0Dimension[];
  readonly dissents: readonly P4R0Dissent[];
  readonly coverage: P4R0AggregateCoverage;
}
