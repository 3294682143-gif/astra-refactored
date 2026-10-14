/**
 * @astra/math-audit — G3/PR4 S3 evidence-gated candidate revision.
 *
 * The `CandidateManager.revise` of the v4 design (§4.4): a protected candidate
 * is not frozen forever. When an M4 challenge targets the goal's *answer*
 * obligation (its global claim) AND a grounded, independent basis exists (a
 * checker counterexample or a proven coverage gap, never a model opinion), one
 * revised child candidate may replace the protected one. Every other case is
 * fail-closed: the parent stays the candidate and the refusal is recorded as
 * `REVISE_REJECTED`.
 *
 * This module is pure: no I/O, no model call, no clock, no store write. The
 * caller supplies the already-built parent/child targets, the challenge and the
 * basis. Only structural relationships are checked; no mathematical claim is
 * made and no evidence is promoted above `CHECKED_SCOPE`.
 */

import {
  P2_ERROR_CODES,
  P2Error,
  p2AnswerObligationForGoal,
  p2Snapshot,
  p4SameBinding,
  p4Target,
  type P2Contract,
  type P2GoalKind,
  type P2Obligation,
  type P4Challenge,
  type P4CoverageRow,
  type P4FinalDecision,
  type P4FinalReason,
  type P4ReviseBasis,
  type P4Target,
} from "@astra/protocol";

const MAX_REMAINING_MS = 5000;
const HASH = /^[0-9a-f]{64}$/u;
const CHALLENGE_ID = /^challenge-(?:[1-9]|1[0-6])$/u;
const BASIS_SOURCES: readonly P4ReviseBasis["source"][] = [
  "CHECKER_COUNTEREXAMPLE",
  "PROVEN_COVERAGE_GAP",
];

export interface P4CandidateRevisionInput {
  /** The currently protected candidate whose global claim is challenged. */
  readonly parent: P4Target;
  /** The evidence-based revised child candidate (an ACTIVE new artifact). */
  readonly child: P4Target;
  /** The M4 challenge on the parent's answer obligation. */
  readonly challenge: P4Challenge;
  /** The grounded, independent replacement basis. */
  readonly basis: P4ReviseBasis;
}

export interface P4CandidateRevisionResult {
  readonly accepted: boolean;
  readonly reason: P4FinalReason;
  readonly decision: P4FinalDecision;
}

function fail(code: (typeof P2_ERROR_CODES)[keyof typeof P2_ERROR_CODES]): never {
  throw new P2Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface FlatGoal {
  readonly goalId: string;
  readonly kind: P2GoalKind;
}

function flattenGoals(
  goals: readonly { readonly goalId: string; readonly kind: P2GoalKind; readonly subgoals: readonly unknown[] }[],
): readonly FlatGoal[] {
  const out: FlatGoal[] = [];
  for (const goal of goals) {
    out.push({ goalId: goal.goalId, kind: goal.kind });
    for (const nested of flattenGoals(goal.subgoals as typeof goals)) {
      out.push(nested);
    }
  }
  return out;
}

/** The goal's single answer obligation, or null when the contract has none. */
function answerObligationOf(contract: P2Contract, goalId: string): P2Obligation | null {
  const goal = flattenGoals(contract.goals as never).find((row) => row.goalId === goalId);
  if (goal === undefined) {
    return null;
  }
  const kind = p2AnswerObligationForGoal(goal.kind);
  return (
    contract.obligations.find((row) => row.goalId === goalId && row.kind === kind) ?? null
  );
}

/**
 * Multi-counterexample coverage (Slice 3c). When the basis lists the challenged
 * gaps (`requiredGaps`), every one of them must be covered by the revised child
 * (`coveredGaps`). A partial repair that leaves an active proven gap fails
 * closed. When `requiredGaps` is absent the single-obligation rule applies.
 */
function gapsCovered(basis: P4ReviseBasis): boolean {
  const required = basis.requiredGaps;
  if (required === undefined) {
    return true;
  }
  if (!Array.isArray(required) || required.length === 0 || required.length > 8) {
    return false;
  }
  const covered = basis.coveredGaps;
  if (!Array.isArray(covered) || covered.length > 16) {
    return false;
  }
  const seen = new Set<string>();
  for (const gap of required) {
    if (typeof gap !== "string" || gap.trim().length === 0 || [...gap].length > 128) {
      return false;
    }
    if (seen.has(gap)) {
      return false;
    }
    seen.add(gap);
    if (!(covered as readonly string[]).includes(gap)) {
      return false;
    }
  }
  return true;
}

/**
 * Attempt one evidence-gated replacement. A structurally invalid input throws a
 * fixed `P2Error`; a well-formed attempt that does not meet the replacement
 * conditions returns `accepted:false` with a `REVISE_REJECTED` parent decision.
 */
export function reviseCandidate(
  contract: P2Contract,
  input: P4CandidateRevisionInput,
  remainingMs: number,
): P4CandidateRevisionResult {
  const frozenContract = p2Snapshot(contract);
  if (!isPlainObject(frozenContract) || !isPlainObject(input)) {
    fail(P2_ERROR_CODES.PACKET_BINDING);
  }
  if (
    typeof remainingMs !== "number" ||
    !Number.isSafeInteger(remainingMs) ||
    remainingMs < 0 ||
    remainingMs > MAX_REMAINING_MS
  ) {
    fail(P2_ERROR_CODES.BOUND_EXCEEDED);
  }
  const { sessionId, problemHash, contractVersion } = frozenContract.envelope;
  const parent = input.parent;
  const child = input.child;
  const challenge = input.challenge;
  const basis = input.basis;
  const answerObligation = answerObligationOf(frozenContract, parent.binding.goalId);
  const requiredId = answerObligation?.obligationId ?? "";

  const parentIsProtected = (() => {
    try {
      const rebuilt = p4Target(frozenContract, parent.artifact, parent.availability);
      return (
        p4SameBinding(rebuilt.binding, parent.binding) &&
        rebuilt.targetHash === parent.targetHash &&
        parent.binding.sessionId === sessionId &&
        parent.binding.problemHash === problemHash &&
        parent.binding.contractVersion === contractVersion
      );
    } catch {
      return false;
    }
  })();

  const challengeIsGlobal = (() => {
    if (
      challenge.status !== "CHALLENGED" ||
      challenge.availability !== "ACTIVE" ||
      typeof challenge.challengeId !== "string" ||
      !CHALLENGE_ID.test(challenge.challengeId) ||
      !p4SameBinding(challenge.target, parent.binding) ||
      challenge.targetHash !== parent.targetHash ||
      !isPlainObject(challenge.issue) ||
      !Array.isArray(challenge.issue.obligationIds)
    ) {
      return false;
    }
    return (challenge.issue.obligationIds as readonly string[]).includes(requiredId);
  })();

  const basisIsGrounded = (() => {
    if (!isPlainObject(basis)) {
      return false;
    }
    return (
      (BASIS_SOURCES as readonly string[]).includes(basis.source) &&
      basis.level === "CHECKED_SCOPE" &&
      basis.checkResult === "PASS" &&
      typeof basis.scopeId === "string" &&
      basis.scopeId === parent.binding.scopeId &&
      typeof basis.witness === "string" &&
      basis.witness.trim().length > 0 &&
      [...basis.witness].length <= 2048 &&
      Array.isArray(basis.obligatedObligationIds) &&
      (basis.obligatedObligationIds as readonly string[]).includes(requiredId) &&
      Array.isArray(basis.childCoverage) &&
      (basis.childCoverage as readonly string[]).includes(requiredId) &&
      gapsCovered(basis)
    );
  })();

  const childIsRevision = (() => {
    if (
      child.availability !== "ACTIVE" ||
      child.binding.sessionId !== sessionId ||
      child.binding.problemHash !== problemHash ||
      child.binding.contractVersion !== contractVersion ||
      child.binding.goalId !== parent.binding.goalId ||
      child.binding.scopeId !== parent.binding.scopeId ||
      typeof child.targetHash !== "string" ||
      !HASH.test(child.targetHash) ||
      child.artifact.packet === null
    ) {
      return false;
    }
    const proposal = child.artifact.packet.candidateProposal;
    if (typeof proposal !== "string" || proposal.trim().length === 0) {
      return false;
    }
    if (proposal === parent.artifact.packet?.candidateProposal) {
      return false;
    }
    try {
      const rebuilt = p4Target(frozenContract, child.artifact, "ACTIVE");
      return p4SameBinding(rebuilt.binding, child.binding) && rebuilt.targetHash === child.targetHash;
    } catch {
      return false;
    }
  })();

  const accepted =
    remainingMs > 0 &&
    answerObligation !== null &&
    parentIsProtected &&
    challengeIsGlobal &&
    basisIsGrounded &&
    childIsRevision;

  return finalizeRevision(frozenContract, parent, child, challenge, accepted);
}

function finalizeRevision(
  contract: P2Contract,
  parent: P4Target,
  child: P4Target,
  challenge: P4Challenge,
  accepted: boolean,
): P4CandidateRevisionResult {
  // On acceptance the revised child replaces the protected candidate; on any
  // refusal the parent stays the candidate and the challenge stays unresolved.
  const winner = accepted ? child : parent;
  const finalResponse = String(winner.artifact.packet?.candidateProposal ?? "");
  const answerObligation = answerObligationOf(contract, parent.binding.goalId);
  const coveredId = answerObligation?.obligationId ?? "";
  const mentioned = new Set(challenge.issue.obligationIds);
  const coverage: readonly P4CoverageRow[] = Object.freeze(
    contract.obligations.map((obligation) =>
      Object.freeze({
        obligationId: obligation.obligationId,
        kind: obligation.kind,
        deliveryCovered: obligation.obligationId === coveredId,
        reviewMentioned: mentioned.has(obligation.obligationId),
        checkResult: "UNKNOWN" as const,
      }),
    ),
  );
  const reason: P4FinalReason = accepted ? "REVISED_CANDIDATE" : "REVISE_REJECTED";
  const decision = p2Snapshot({
    mode: "MOCK_ONLY" as const,
    targetEnvironment: "TARGET_UNVERIFIED" as const,
    stage: "S3" as const,
    policy: "BEST_EFFORT" as const,
    status: "candidate" as const,
    finalResponse,
    candidateVerified: false as const,
    strictAcceptance: "NOT_PERFORMED" as const,
    submissionEligibility: "BEST_EFFORT" as const,
    protectedCandidate: winner.binding,
    targetHash: winner.targetHash,
    unresolvedChallenges: accepted ? 0 : 1,
    openObligations: contract.obligations.length,
    coverage,
    reason,
  }) as P4FinalDecision;
  return Object.freeze({ accepted, reason, decision });
}
