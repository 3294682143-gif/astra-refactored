/**
 * @astra/protocol — P4 S1 diagnostic-evidence / S2 single-repair DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * business logic and no JSON schema. Every field is `readonly`. A structural
 * match is not a mathematical check, and no shape here can promote evidence to
 * CHECKED_SCOPE/FORMAL, produce a PASS or resolve a challenge.
 */

import type { Scope } from "./index.js";
import type { P2TransportStatus } from "./p2.js";
import type { P3EffectReceipt, P3EffectRequest } from "./p3.js";
import type {
  P4Binding,
  P4Challenge,
  P4ReviewContext,
  P4Target,
} from "./p4.js";

/** The two existing registered executors this phase may name. */
export type P4CheckedProperty =
  | "SUPPLIED_POLYNOMIAL_COEFFICIENTS"
  | "SUPPLIED_LINEAR_SOLUTION_SET";

/** Fixed tool-registry version of every S1 check plan. */
export const P4_CHECK_TOOL_VERSION = "tool-registry-v1" as const;
export type P4CheckToolVersion = typeof P4_CHECK_TOOL_VERSION;

/**
 * One S1 check plan. `request` is the trusted control-side effect request; the
 * model never supplies the binding, the scope or the version.
 */
export interface P4CheckPlan {
  readonly checkId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly scope: Scope;
  readonly assumptions: readonly string[];
  readonly checkedProperty: P4CheckedProperty;
  readonly methodOrToolVersion: P4CheckToolVersion;
  readonly obligationIds: readonly string[];
  readonly request: P3EffectRequest;
}

export const P4_S1_REASON = Object.freeze([
  "STRUCTURAL_MATCH_ONLY",
  "SCOPE_MISMATCH",
  "ASSUMPTIONS_MISMATCH",
  "STALE_TARGET",
  "UNSUPPORTED_CHECK",
] as const);
export type P4S1Reason = (typeof P4_S1_REASON)[number];

/**
 * S1 structural assessment. `semanticResult` is always UNKNOWN and
 * `canSupportObligation` is always false: no semantic checker exists yet.
 */
export interface P4S1Assessment {
  readonly stage: "S1";
  readonly checkId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly structuralMatch: boolean;
  readonly semanticResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly reason: P4S1Reason;
}

/**
 * One diagnostic evidence row. It is always PROGRAM_OBSERVATION/PROVISIONAL
 * with checkResult UNKNOWN; `semanticMapping` stays UNKNOWN and the row can
 * never support an obligation.
 */
export interface P4DiagnosticEvidence {
  readonly evidenceId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly scope: Scope;
  readonly assumptions: readonly string[];
  readonly checkedProperty: P4CheckedProperty;
  readonly methodOrToolVersion: P4CheckToolVersion;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly requestId: string;
  readonly effectId: string;
  readonly checkerCoverage: readonly string[];
  readonly source: "PROGRAM_OBSERVATION";
  readonly level: "PROVISIONAL";
  readonly availability: "ACTIVE" | "STALE";
  readonly checkResult: "UNKNOWN";
  readonly semanticMapping: "UNKNOWN";
  readonly canSupportObligation: false;
}

export const P4_CHECK_STATE = Object.freeze([
  "ADMITTED",
  "DISPATCHED",
  "OBSERVED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4CheckState = (typeof P4_CHECK_STATE)[number];

export const P4_CHECK_CODE = Object.freeze([
  "STRUCTURAL_ONLY",
  "OBSERVED",
  "ERROR",
  "OUTCOME_UNKNOWN",
  "DEADLINE_EXCEEDED",
] as const);
export type P4CheckCode = (typeof P4_CHECK_CODE)[number];

/** One S1 check record. A non-OBSERVED code keeps the receipt and the code. */
export interface P4CheckRecord {
  readonly plan: P4CheckPlan;
  readonly assessment: P4S1Assessment;
  readonly state: P4CheckState;
  readonly receipt: P3EffectReceipt | null;
  readonly evidence: P4DiagnosticEvidence | null;
  readonly code: P4CheckCode;
}

/** Fields a repair child may change relative to its parent candidate. */
export const P4_REPAIR_CHANGED_FIELDS = Object.freeze([
  "claim",
  "derivation",
  "candidateProposal",
] as const);
export type P4RepairChangedField = (typeof P4_REPAIR_CHANGED_FIELDS)[number];

/**
 * S2 parent/child lineage. The child is a new artifact id and never supersedes
 * the parent; `requiresRecheck` is always true and the child can never replace
 * a protected candidate.
 */
export interface P4RepairLineage {
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly child: P4Binding;
  readonly childHash: string;
  readonly challengeId: string;
  readonly requestId: "model-3";
  readonly stage: "S2";
  readonly checkResult: "UNKNOWN";
  readonly requiresRecheck: true;
  readonly canReplaceProtected: false;
  readonly changedFields: readonly P4RepairChangedField[];
}

export const P4_REPAIR_STATE = Object.freeze([
  "ADMITTED",
  "DISPATCHED",
  "RETURNED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4RepairState = (typeof P4_REPAIR_STATE)[number];

export const P4_REPAIR_CODE = Object.freeze([
  "NOT_DISPATCHED",
  "PROPOSAL_RECORDED",
  "INVALID_REPAIR",
  "TRANSPORT_INCOMPLETE",
  "OUTCOME_UNKNOWN",
  "DEADLINE_EXCEEDED",
] as const);
export type P4RepairCode = (typeof P4_REPAIR_CODE)[number];

/** One S2 repair call record. A recorded proposal is never a confirmed fix. */
export interface P4RepairRecord {
  readonly requestId: "model-3";
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly challenge: P4Challenge;
  readonly state: P4RepairState;
  readonly context: P4ReviewContext;
  readonly transportStatus: P2TransportStatus | null;
  readonly rawResponseText: string | null;
  readonly lineage: P4RepairLineage | null;
  readonly code: P4RepairCode;
}

/** Frozen view of one parent's repair state. `repairAttempts` is 0 or 1. */
export interface P4RepairSnapshot {
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4RepairRecord | null;
  readonly repairAttempts: number;
}

/** Structural view of one repair target; the parent stays the protected one. */
export interface P4RepairTarget {
  readonly parent: P4Target;
  readonly challenge: P4Challenge;
}

/**
 * Grounded, independent basis for replacing a protected candidate (G3/PR4
 * `CandidateManager.revise`). This is deliberately NOT a model opinion: the
 * only accepted levels are `CHECKED_SCOPE`/`PASS`, and the witness must be a
 * concrete counterexample or a proven coverage gap. A model review conclusion
 * (`REVIEWED`) and an `S1 MATCH` opinion can never appear here. This DTO is a
 * declaration only; the runtime validation lives in the M5 audit module.
 */
export const P4_REVISE_BASIS_SOURCE = Object.freeze([
  "CHECKER_COUNTEREXAMPLE",
  "PROVEN_COVERAGE_GAP",
] as const);
export type P4ReviseBasisSource = (typeof P4_REVISE_BASIS_SOURCE)[number];

export interface P4ReviseBasis {
  readonly source: P4ReviseBasisSource;
  readonly level: "CHECKED_SCOPE";
  readonly checkResult: "PASS";
  readonly scopeId: string;
  /** Concrete witness (a counterexample or the proven missing branch). */
  readonly witness: string;
  /** Obligation ids the grounded basis is scoped to. */
  readonly obligatedObligationIds: readonly string[];
  /** Obligation ids the revised child candidate covers. */
  readonly childCoverage: readonly string[];
}
