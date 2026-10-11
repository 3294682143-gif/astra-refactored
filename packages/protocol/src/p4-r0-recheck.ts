/**
 * @astra/protocol — P4 R0 revised-plan recheck DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * validation and no mathematical decision. A recheck preparation is a frozen
 * view of a caller-supplied budget, never a resource authority; `UNKNOWN`
 * stays the only semantic result this surface can express and nothing here is
 * acceptance.
 */

import type { P2Contract, P2TransportStatus } from "./p2.js";
import type { P4ReviewCode, P4ReviewContext, P4ReviewState } from "./p4.js";
import type { P4R0Binding, P4R0Check, P4R0Conclusion } from "./p4-r0.js";
import type { P4R0RevisionSnapshot } from "./p4-r0-revision.js";

/**
 * One revised-plan recheck target. `binding` is the actual child binding and
 * `contract` the actual revised contract; a real `REOPENED` obligation status
 * is allowed here and must never be normalized back to `OPEN`.
 */
export interface P4R0RecheckTarget {
  readonly binding: P4R0Binding;
  readonly contract: P2Contract;
  readonly planText: string;
}

/**
 * Trusted caller-supplied budget view. All three fields are mandatory; they
 * are a frozen view of remaining resources, not a global authority and not an
 * authorization to spend anything.
 */
export interface P4R0RecheckOptions {
  readonly planningModelCalls: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
}

/** Fixed M1 disposition of one revised-plan recheck preparation. */
export const P4_R0_RECHECK_ACTION = Object.freeze([
  "REQUEST_REVIEW",
  "INSUFFICIENT_BUDGET",
] as const);
export type P4R0RecheckAction = (typeof P4_R0_RECHECK_ACTION)[number];

/**
 * M1 recheck preparation. `revision` is the full replayed revision snapshot
 * that the target was derived from; `semanticResult` stays `UNKNOWN` and
 * `canSupportObligation` stays false.
 */
export interface P4R0RecheckPreparation {
  readonly target: P4R0RecheckTarget;
  readonly parent: P4R0Binding;
  readonly reviewHash: string;
  readonly revisionHash: string;
  readonly revision: P4R0RevisionSnapshot;
  readonly action: P4R0RecheckAction;
  readonly planningModelCalls: number;
  readonly remainingRootCalls: number;
  readonly remainingMs: number;
  readonly semanticResult: "UNKNOWN";
  readonly canSupportObligation: false;
}

export const P4_R0_RECHECK_SCHEMA_VERSION = "p4-r0-recheck-v1" as const;
export type P4R0RecheckSchemaVersion = typeof P4_R0_RECHECK_SCHEMA_VERSION;

/**
 * Strict model-3 recheck report. `NO_ISSUE` is not a proof of correctness and
 * `reviewCoverage` lists only obligations the report claims to have covered.
 */
export interface P4R0RecheckReport {
  readonly schemaVersion: P4R0RecheckSchemaVersion;
  readonly requestId: "model-3";
  readonly stage: "R0_RECHECK";
  readonly parent: P4R0Binding;
  readonly target: P4R0Binding;
  readonly reviewHash: string;
  readonly revisionHash: string;
  readonly conclusion: P4R0Conclusion;
  readonly reviewCoverage: readonly string[];
  readonly checks: readonly P4R0Check[];
}

/**
 * One recheck call record. It is a model opinion only: `checkResult` stays
 * `UNKNOWN`, `canSupportObligation` and `canActivate` stay false, and a
 * non-OK code keeps the raw text and the code.
 */
export interface P4R0RecheckRecord {
  readonly requestId: "model-3";
  readonly parent: P4R0Binding;
  readonly target: P4R0Binding;
  readonly reviewHash: string;
  readonly revisionHash: string;
  readonly context: P4ReviewContext;
  readonly state: P4ReviewState;
  readonly transportStatus: P2TransportStatus | null;
  readonly rawResponseText: string | null;
  readonly report: P4R0RecheckReport | null;
  readonly code: P4ReviewCode;
  readonly availability: "ACTIVE" | "STALE";
  readonly source: "MODEL_REVIEW";
  readonly level: "PROVISIONAL" | "REVIEWED";
  readonly checkResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly canActivate: false;
}

/** Frozen view of one revised-plan recheck attempt. */
export interface P4R0RecheckSnapshot {
  readonly parent: P4R0Binding;
  readonly target: P4R0Binding;
  readonly reviewHash: string;
  readonly revisionHash: string;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4R0RecheckRecord | null;
}
