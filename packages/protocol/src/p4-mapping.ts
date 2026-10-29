/**
 * @astra/protocol — P4 S1 model semantic-correspondence review DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * business logic and no JSON schema. Every field is `readonly`. A structural
 * match, a hash or a model opinion is not a mathematical equivalence proof:
 * nothing here can promote evidence to CHECKED_SCOPE/FORMAL, produce a PASS,
 * satisfy an obligation or replace a protected candidate.
 */

import type { P4Binding, P4ReviewContext } from "./p4.js";
import type { P2TransportStatus } from "./p2.js";

/** The five fixed correspondence dimensions, each reported exactly once. */
export const P4_MAPPING_DIMENSIONS = Object.freeze([
  "VARIABLES",
  "DOMAIN",
  "QUANTIFIERS",
  "CONDITIONS",
  "COVERAGE",
] as const);
export type P4MappingDimension = (typeof P4_MAPPING_DIMENSIONS)[number];

/** Per-dimension opinion. UNKNOWN is never a refutation and never a pass. */
export const P4_MAPPING_VERDICT = Object.freeze([
  "MATCH",
  "MISMATCH",
  "UNKNOWN",
] as const);
export type P4MappingVerdict = (typeof P4_MAPPING_VERDICT)[number];

/**
 * Half-open Unicode-codepoint span of one quoted slice. `start` is inclusive,
 * `end` is exclusive, and `quote` must equal that exact slice of the source it
 * refers to. A span is an identity of the quoted text, not a semantic proof.
 */
export interface P4MappingSpan {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/**
 * One dimension row. MATCH/MISMATCH require both spans to be present and
 * non-empty; UNKNOWN may carry `null` spans. `rationale` is always required.
 */
export interface P4MappingDimensionRow {
  readonly dimension: P4MappingDimension;
  readonly verdict: P4MappingVerdict;
  readonly rationale: string;
  readonly problemSpan: P4MappingSpan | null;
  readonly representationSpan: P4MappingSpan | null;
}

export const P4_MAPPING_REVIEW_SCHEMA_VERSION = "p4-mapping-review-v1" as const;
export type P4MappingReviewSchemaVersion = typeof P4_MAPPING_REVIEW_SCHEMA_VERSION;

/** Fixed request id of the single S1 mapping review call. */
export const P4_MAPPING_REQUEST_ID = "model-2" as const;
export type P4MappingRequestId = typeof P4_MAPPING_REQUEST_ID;

/**
 * Overall conclusion. `MATCH` is allowed only when all five dimensions are
 * MATCH; any MISMATCH forces MISMATCH; every other combination is UNKNOWN.
 * A conclusion is a model opinion, not a verification.
 */
export const P4_MAPPING_CONCLUSION = Object.freeze([
  "MATCH",
  "MISMATCH",
  "UNKNOWN",
] as const);
export type P4MappingConclusion = (typeof P4_MAPPING_CONCLUSION)[number];

/**
 * Strict model mapping report. `dimensions` holds each of the five dimensions
 * exactly once. The report is bound to the target, the target hash and the
 * check-plan hash; it proves nothing and refutes nothing.
 */
export interface P4MappingReviewReport {
  readonly schemaVersion: P4MappingReviewSchemaVersion;
  readonly requestId: P4MappingRequestId;
  readonly stage: "S1";
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly planHash: string;
  readonly conclusion: P4MappingConclusion;
  readonly dimensions: readonly P4MappingDimensionRow[];
}

export const P4_MAPPING_STATE = Object.freeze([
  "ADMITTED",
  "DISPATCHED",
  "RETURNED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4MappingState = (typeof P4_MAPPING_STATE)[number];

export const P4_MAPPING_CODE = Object.freeze([
  "OK",
  "INVALID_REPORT",
  "TRANSPORT_INCOMPLETE",
  "DEADLINE_EXCEEDED",
  "NOT_DISPATCHED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4MappingCode = (typeof P4_MAPPING_CODE)[number];

/**
 * One mapping review call record. A non-OK code keeps the raw text and the
 * code. The record is model-review evidence only: `checkResult` is always
 * UNKNOWN and `canSupportObligation` is always false.
 */
export interface P4MappingRecord {
  readonly requestId: P4MappingRequestId;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly planHash: string;
  readonly state: P4MappingState;
  readonly transportStatus: P2TransportStatus | null;
  readonly context: P4ReviewContext;
  readonly rawResponseText: string | null;
  readonly report: P4MappingReviewReport | null;
  readonly code: P4MappingCode;
  readonly source: "MODEL_REVIEW";
  readonly level: "PROVISIONAL" | "REVIEWED";
  readonly checkResult: "UNKNOWN";
  readonly canSupportObligation: false;
  readonly availability: "ACTIVE" | "STALE";
}

/**
 * Frozen view of one target's mapping review state. `representationText` is
 * the exact fixed check representation the review was asked about; it is
 * untrusted data and authorizes no operation.
 */
export interface P4MappingSnapshot {
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly planHash: string;
  readonly representationText: string;
  readonly record: P4MappingRecord | null;
  readonly availability: "ACTIVE" | "STALE";
}
