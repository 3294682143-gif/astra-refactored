/**
 * @astra/protocol — P4 offline review/audit shared DTO surface.
 *
 * Declarations only: no I/O, no environment access, no network, no runtime
 * business logic and no JSON schema. Every field is `readonly`; the shapes
 * here are frozen so the M4 review and M5 audit modules can depend on them
 * independently. A hash or a binding confirms identity of the same data, not
 * mathematical equivalence, and nothing in this file is acceptance.
 */

import type {
  P2Artifact,
  P2ArtifactAvailability,
  P2ObligationKind,
  P2TransportStatus,
} from "./p2.js";

/**
 * Identity binding of one review target. `sourceRequestId` is the original M3
 * work request id, not a review request id.
 */
export interface P4Binding {
  readonly sessionId: string;
  readonly problemHash: string;
  readonly contractVersion: number;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly taskId: string;
  readonly goalId: string;
  readonly scopeId: string;
  readonly sourceRequestId: string;
}

/**
 * One review target: the binding, the fixed target hash and the artifact under
 * review. `availability` is a separate axis and never changes the identity.
 */
export interface P4Target {
  readonly binding: P4Binding;
  readonly targetHash: string;
  readonly artifact: P2Artifact;
  readonly availability: P2ArtifactAvailability;
}

/**
 * Half-open Unicode-codepoint span of the reviewed derivation. `start` is
 * inclusive, `end` is exclusive, and `quote` must equal that exact slice.
 */
export interface P4StepLocator {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/** Fixed suspected-issue vocabulary. No free-form kind is accepted. */
export const P4_ISSUE_KINDS = Object.freeze([
  "ZERO_DIVISOR",
  "NON_EQUIVALENT",
  "QUANTIFIER_SHIFT",
  "MISSING_CASE",
  "UNPROVED_PREMISE",
  "UNSUPPORTED_CONCLUSION",
  "OTHER",
] as const);
export type P4IssueKind = (typeof P4_ISSUE_KINDS)[number];

/** One suspected issue. A suspicion is never a refutation. */
export interface P4ReviewIssue {
  readonly stepLocator: P4StepLocator;
  readonly suspectedIssue: P4IssueKind;
  readonly rationale: string;
  readonly requestedCheck: string;
  readonly obligationIds: readonly string[];
}

export const P4_REVIEW_SCHEMA_VERSION = "p4-review-v1" as const;
export type P4ReviewSchemaVersion = typeof P4_REVIEW_SCHEMA_VERSION;

export const P4_REVIEW_CONCLUSION = Object.freeze([
  "NO_ISSUE",
  "ISSUES",
  "UNKNOWN",
] as const);
export type P4ReviewConclusion = (typeof P4_REVIEW_CONCLUSION)[number];

/**
 * Strict model review report. `NO_ISSUE` is not a proof of correctness and
 * `reviewCoverage` lists only obligations the report claims to have covered.
 */
export interface P4ReviewReport {
  readonly schemaVersion: P4ReviewSchemaVersion;
  readonly requestId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly stage: "R2" | "R4";
  readonly conclusion: P4ReviewConclusion;
  readonly reviewCoverage: readonly string[];
  readonly issues: readonly P4ReviewIssue[];
}

/** The two fixed review messages plus their identity and byte size. */
export interface P4ReviewContext {
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
  readonly contextHash: string;
  readonly contextBytes: number;
}

export const P4_REVIEW_STATE = Object.freeze([
  "ADMITTED",
  "DISPATCHED",
  "RETURNED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4ReviewState = (typeof P4_REVIEW_STATE)[number];

export const P4_REVIEW_CODE = Object.freeze([
  "OK",
  "INVALID_REPORT",
  "TRANSPORT_INCOMPLETE",
  "DEADLINE_EXCEEDED",
  "NOT_DISPATCHED",
  "OUTCOME_UNKNOWN",
] as const);
export type P4ReviewCode = (typeof P4_REVIEW_CODE)[number];

/** One review call record. A non-OK code keeps the raw text and the code. */
export interface P4ReviewRecord {
  readonly requestId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly state: P4ReviewState;
  readonly transportStatus: P2TransportStatus | null;
  readonly context: P4ReviewContext;
  readonly rawResponseText: string | null;
  readonly report: P4ReviewReport | null;
  readonly code: P4ReviewCode;
}

export const P4_CHALLENGE_STATUS = Object.freeze(["CHALLENGED", "UNKNOWN"] as const);
export type P4ChallengeStatus = (typeof P4_CHALLENGE_STATUS)[number];

export const P4_EVIDENCE_AVAILABILITY = Object.freeze(["ACTIVE", "STALE"] as const);
export type P4EvidenceAvailability = (typeof P4_EVIDENCE_AVAILABILITY)[number];

/**
 * One deduplicated challenge. `requestIds` lists every report that raised the
 * same deduplicated suspicion; a changed rationale does not create a new one.
 */
export interface P4Challenge {
  readonly challengeId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly issue: P4ReviewIssue;
  readonly requestIds: readonly string[];
  readonly status: P4ChallengeStatus;
  readonly availability: P4EvidenceAvailability;
}

/** Model review evidence: at most REVIEWED, always checkResult UNKNOWN. */
export interface P4ReviewEvidence {
  readonly requestId: string;
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly source: "MODEL_REVIEW";
  readonly level: "PROVISIONAL" | "REVIEWED";
  readonly availability: P4EvidenceAvailability;
  readonly checkResult: "UNKNOWN";
}

/** Frozen view of one target's review state. */
export interface P4ReviewSnapshot {
  readonly target: P4Binding;
  readonly targetHash: string;
  readonly availability: P4EvidenceAvailability;
  readonly records: readonly P4ReviewRecord[];
  readonly challenges: readonly P4Challenge[];
  readonly evidence: readonly P4ReviewEvidence[];
}

export const P4_DELIVERY_POLICY = Object.freeze(["BEST_EFFORT", "STRICT"] as const);
export type P4DeliveryPolicy = (typeof P4_DELIVERY_POLICY)[number];

/** One obligation coverage row. `checkResult` is always UNKNOWN here. */
export interface P4CoverageRow {
  readonly obligationId: string;
  readonly kind: P2ObligationKind;
  readonly deliveryCovered: boolean;
  readonly reviewMentioned: boolean;
  readonly checkResult: "UNKNOWN";
}

export const P4_FINAL_REASON = Object.freeze([
  "BEST_EFFORT_CANDIDATE",
  "STRICT_NOT_VERIFIED",
  "NO_CANDIDATE",
  "STALE_CANDIDATE",
  "DEADLINE_EXCEEDED",
  // G3/PR4: an evidence-gated replacement of a protected candidate. The
  // `REVISED_CANDIDATE` reason is only ever produced when a grounded,
  // independent basis replaces an under-supported global claim; the
  // `REVISE_REJECTED` reason records a refused replacement attempt so a failed
  // revision never silently looks like an ordinary best-effort candidate.
  "REVISED_CANDIDATE",
  "REVISE_REJECTED",
] as const);
export type P4FinalReason = (typeof P4_FINAL_REASON)[number];

/**
 * S3 final decision. `candidateVerified` is always false and strict acceptance
 * is never performed; `SUBMITTED` would not mean `ACCEPTED`.
 */
export interface P4FinalDecision {
  readonly mode: "MOCK_ONLY";
  readonly targetEnvironment: "TARGET_UNVERIFIED";
  readonly stage: "S3";
  readonly policy: P4DeliveryPolicy;
  readonly status: "candidate" | "unsolved";
  readonly finalResponse: string;
  readonly candidateVerified: false;
  readonly strictAcceptance: "NOT_PERFORMED";
  readonly submissionEligibility: "BEST_EFFORT" | "WITHHELD";
  readonly protectedCandidate: P4Binding | null;
  readonly targetHash: string | null;
  readonly unresolvedChallenges: number;
  readonly openObligations: number;
  readonly coverage: readonly P4CoverageRow[];
  readonly reason: P4FinalReason;
}
