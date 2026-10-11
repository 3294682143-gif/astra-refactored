/**
 * @astra/protocol — P4 S2 post-repair model re-review DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * business logic and no JSON schema. Every field is `readonly`. A model
 * `NO_ISSUE` verdict is an opinion, not a proof: nothing here can promote
 * evidence above REVIEWED, resolve a challenge, supersede a parent or replace
 * a protected candidate.
 */

import type { P2TransportStatus } from "./p2.js";
import type {
  P4Binding,
  P4ReviewCode,
  P4ReviewContext,
  P4ReviewState,
  P4StepLocator,
} from "./p4.js";

/** The three fixed re-review dimensions. No free-form dimension is accepted. */
export const P4_RECHECK_DIMENSION = Object.freeze([
  "ISSUE_RESPONSE",
  "PREMISES",
  "DEPENDENCIES",
] as const);
export type P4RecheckDimension = (typeof P4_RECHECK_DIMENSION)[number];

/** Fixed verdict vocabulary. `NO_ISSUE` is a model opinion, never a check. */
export const P4_RECHECK_VERDICT = Object.freeze([
  "NO_ISSUE",
  "ISSUES",
  "UNKNOWN",
] as const);
export type P4RecheckVerdict = (typeof P4_RECHECK_VERDICT)[number];

/**
 * One re-review row. `childStepLocator` is required for a non-UNKNOWN verdict
 * and may be null only for UNKNOWN; it locates the exact child derivation span.
 */
export interface P4RecheckCheck {
  readonly dimension: P4RecheckDimension;
  readonly verdict: P4RecheckVerdict;
  readonly rationale: string;
  readonly childStepLocator: P4StepLocator | null;
}

export const P4_RECHECK_SCHEMA_VERSION = "p4-recheck-v1" as const;
export type P4RecheckSchemaVersion = typeof P4_RECHECK_SCHEMA_VERSION;

/** Fixed request id of every S2 re-review call. */
export const P4_RECHECK_REQUEST_ID = "model-4" as const;
export type P4RecheckRequestId = typeof P4_RECHECK_REQUEST_ID;

/**
 * Strict model re-review report. `conclusion` is the aggregate of the three
 * rows; `reviewCoverage` must equal the triggering challenge's obligation ids.
 */
export interface P4RecheckReport {
  readonly schemaVersion: P4RecheckSchemaVersion;
  readonly requestId: P4RecheckRequestId;
  readonly stage: "S2";
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly child: P4Binding;
  readonly childHash: string;
  readonly challengeId: string;
  readonly repairHash: string;
  readonly conclusion: P4RecheckVerdict;
  readonly reviewCoverage: readonly string[];
  readonly checks: readonly P4RecheckCheck[];
}

/**
 * One re-review call record. A non-OK code keeps the raw text and the code.
 * The evidence fields are fixed: a model re-review is at most REVIEWED, its
 * check result stays UNKNOWN, it cannot support an obligation, cannot replace
 * a protected candidate and always requires a semantic recheck.
 */
export interface P4RecheckRecord {
  readonly requestId: P4RecheckRequestId;
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly child: P4Binding;
  readonly childHash: string;
  readonly challengeId: string;
  readonly repairHash: string;
  readonly state: P4ReviewState;
  readonly transportStatus: P2TransportStatus | null;
  readonly context: P4ReviewContext;
  readonly rawResponseText: string | null;
  readonly report: P4RecheckReport | null;
  readonly code: P4ReviewCode;
  readonly availability: "ACTIVE" | "STALE";
  readonly source: "MODEL_REVIEW";
  readonly level: "PROVISIONAL" | "REVIEWED";
  readonly checkResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly canReplaceProtected: false;
  readonly requiresSemanticRecheck: true;
}

/** Frozen view of one child's re-review state. */
export interface P4RecheckSnapshot {
  readonly parent: P4Binding;
  readonly parentHash: string;
  readonly child: P4Binding;
  readonly childHash: string;
  readonly challengeId: string;
  readonly repairHash: string;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4RecheckRecord | null;
}
