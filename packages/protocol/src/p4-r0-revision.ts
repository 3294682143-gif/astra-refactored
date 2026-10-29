/**
 * @astra/protocol — P4 R0 bounded goal-kind revision proposal DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * validation and no mathematical decision. A revision proposal is a record of
 * a proposed change, never an acceptance, never a verification and never a
 * claim that the revised plan is equivalent to the problem. `UNKNOWN` stays
 * the only semantic result this surface can express.
 */

import type { P2Contract, P2Event, P2GoalKind, P2TransportStatus } from "./p2.js";
import type { P4ReviewContext, P4ReviewState, P4StepLocator } from "./p4.js";
import type { P4R0Binding, P4R0Dimension, P4R0ReviewSnapshot } from "./p4-r0.js";

/**
 * Version-bound revision trigger. It is produced by replaying one already
 * recorded R0 review session, so it binds a proposal trigger to exactly that
 * parent plan; caller policy and budgets must authorize actual dispatch.
 * `issueDimensions` lists the dimensions whose recorded verdict was `ISSUES`;
 * it is not a severity ranking and grants no mathematical permission.
 */
export interface P4R0RevisionTrigger {
  readonly parent: P4R0Binding;
  readonly reviewHash: string;
  readonly issueDimensions: readonly P4R0Dimension[];
  readonly review: P4R0ReviewSnapshot;
}

export const P4_R0_REVISION_SCHEMA_VERSION = "p4-r0-plan-revision-v1" as const;
export type P4R0RevisionSchemaVersion = typeof P4_R0_REVISION_SCHEMA_VERSION;

/**
 * One proposed leaf goal-kind change. `fromKind` must equal the recorded kind
 * of the existing leaf goal and `toKind` must differ from it; `problemSpan`
 * and `planSpan` locate the exact codepoint slices that justify the change.
 * A row is a proposal, not a proof that the new kind is correct.
 */
export interface P4R0RevisionChange {
  readonly goalId: string;
  readonly fromKind: P2GoalKind;
  readonly toKind: P2GoalKind;
  readonly issueDimension: P4R0Dimension;
  readonly rationale: string;
  readonly problemSpan: P4StepLocator;
  readonly planSpan: P4StepLocator;
}

/**
 * Strict model revision report. `changes` is bounded and non-empty; the report
 * may only retype existing leaf goals and can never add goals, scopes,
 * assumptions or metadata.
 */
export interface P4R0RevisionReport {
  readonly schemaVersion: P4R0RevisionSchemaVersion;
  readonly requestId: "model-2";
  readonly parent: P4R0Binding;
  readonly reviewHash: string;
  readonly changes: readonly P4R0RevisionChange[];
}

/**
 * Structural delta of one applied revision. It mirrors the M1 ledger delta
 * shape without importing that module; the version pair is the contract
 * version before and after the single `reviseGoals` call.
 */
export interface P4R0RevisionDelta {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changedGoalIds: readonly string[];
  readonly affectedTaskIds: readonly string[];
  readonly preservedTaskIds: readonly string[];
  readonly removedTaskIds: readonly string[];
}

/**
 * Version lineage of one recorded proposal. Every strong flag lives here and
 * none of them is a semantic acceptance: `requiresRecheck` is true,
 * `checkResult` stays `UNKNOWN`, `canSupport` and `canActivate` stay false.
 */
export interface P4R0RevisionLineage {
  readonly parent: P4R0Binding;
  readonly child: P4R0Binding;
  readonly reviewHash: string;
  readonly sourceRequestId: "model-2";
  readonly changedGoalIds: readonly string[];
  readonly requiresRecheck: true;
  readonly canActivate: false;
  readonly checkResult: "UNKNOWN";
  readonly canSupport: false;
}

export const P4_R0_REVISION_CODE = Object.freeze([
  "NOT_DISPATCHED",
  "PROPOSAL_RECORDED",
  "INVALID_REVISION",
  "TRANSPORT_INCOMPLETE",
  "DEADLINE_EXCEEDED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4R0RevisionCode = (typeof P4_R0_REVISION_CODE)[number];

/**
 * One revision call record. A non-OK code keeps the raw text and the code;
 * `lineage` is present only when a proposal was actually recorded.
 */
export interface P4R0RevisionRecord {
  readonly requestId: "model-2";
  readonly parent: P4R0Binding;
  readonly reviewHash: string;
  readonly context: P4ReviewContext;
  readonly state: P4ReviewState;
  readonly transportStatus: P2TransportStatus | null;
  readonly rawResponseText: string | null;
  readonly report: P4R0RevisionReport | null;
  readonly code: P4R0RevisionCode;
  readonly lineage: P4R0RevisionLineage | null;
  readonly availability: "ACTIVE" | "STALE";
}

/**
 * Frozen view of one revision attempt. `parentContract` is the untouched
 * original contract and `revisedContract` the private-ledger result; the
 * original review stays bound to the parent binding.
 */
export interface P4R0RevisionSnapshot {
  readonly parent: P4R0Binding;
  readonly reviewHash: string;
  readonly availability: "ACTIVE" | "STALE";
  readonly record: P4R0RevisionRecord | null;
  readonly parentContract: P2Contract;
  readonly revisedContract: P2Contract | null;
  readonly delta: P4R0RevisionDelta | null;
  readonly events: readonly P2Event[];
}
