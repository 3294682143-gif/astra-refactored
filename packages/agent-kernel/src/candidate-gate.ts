/**
 * @zygos/agent-kernel — Candidate Preservation & Repair Gating.
 *
 * Implements K07 and enforces Invariants I04, I07, I10, I11, I15.
 */

import type { Candidate, Challenge, AcceptanceReceipt } from "@zygos/domain-contract";
import { assertCandidateIntegrity } from "@zygos/domain-contract";

export class CandidateGate {
  private _activeCandidate?: Candidate | undefined;
  private readonly _candidateHistory: Candidate[] = [];
  private readonly _refutedCandidates = new Set<string>();
  private readonly _challenges = new Map<string, Challenge>();

  get activeCandidate(): Candidate | undefined {
    return this._activeCandidate;
  }

  get candidateHistory(): readonly Candidate[] {
    return this._candidateHistory;
  }

  get openChallenges(): readonly Challenge[] {
    return Array.from(this._challenges.values()).filter((c) => c.state === "OPEN");
  }

  /**
   * Register a new challenge identified during review or validation.
   */
  raiseChallenge(challenge: Challenge): void {
    // If identical target and issueKind already open, merge evidence
    const existing = Array.from(this._challenges.values()).find(
      (c) => c.targetRef === challenge.targetRef && c.issueKind === challenge.issueKind && c.state === "OPEN"
    );

    if (existing) {
      this._challenges.set(existing.challengeId, {
        ...existing,
        evidenceRefs: Array.from(new Set([...existing.evidenceRefs, ...challenge.evidenceRefs])),
      });
      return;
    }

    this._challenges.set(challenge.challengeId, challenge);
  }

  /**
   * I04, I10, I15: Submit candidate proposal.
   * If there is an active parent candidate, the new candidate is only accepted if
   * all open challenges against the parent are addressed. Partial fixes leave
   * the candidate unreplaced.
   */
  proposeCandidate(
    candidate: Candidate,
    resolvedChallengeIds: readonly string[],
    isTruncatedOrError: boolean = false
  ): { accepted: boolean; reason: string } {
    // Invariant I04: Truncated or error outputs cannot replace candidates
    if (isTruncatedOrError) {
      return { accepted: false, reason: "Invariant I04: Truncated or error response cannot trigger candidate replacement" };
    }

    // Invariant I15: candidateVerified must be false
    assertCandidateIntegrity(candidate);

    // If no prior candidate, register directly
    if (!this._activeCandidate) {
      this._activeCandidate = candidate;
      this._candidateHistory.push(candidate);
      return { accepted: true, reason: "Initial candidate registered" };
    }

    // Invariant I10: Check if new candidate addresses all open challenges
    const openChallenges = this.openChallenges;
    const unaddressed = openChallenges.filter((c) => !resolvedChallengeIds.includes(c.challengeId));

    if (unaddressed.length > 0) {
      // Invariant I10: Partial repair preserves parent candidate
      return {
        accepted: false,
        reason: `Invariant I10: Partial repair rejected. ${unaddressed.length} challenge(s) remain unresolved: ${unaddressed.map((u) => u.issueKind).join(", ")}`,
      };
    }

    // Mark challenges as resolved
    for (const chId of resolvedChallengeIds) {
      const ch = this._challenges.get(chId);
      if (ch) {
        this._challenges.set(chId, { ...ch, state: "RESOLVED" });
      }
    }

    this._activeCandidate = candidate;
    this._candidateHistory.push(candidate);
    return { accepted: true, reason: "Candidate replaced after passing repair gating" };
  }

  /**
   * Invariant I11: Record objective refutation by an acceptance receipt.
   * A refuted candidate can NEVER be delivered as an accepted result.
   */
  recordRefutation(candidateId: string, receipt: AcceptanceReceipt): void {
    if (receipt.outcome === "FAIL") {
      this._refutedCandidates.add(candidateId);
      if (this._activeCandidate && this._activeCandidate.candidateId === candidateId) {
        this._activeCandidate = undefined; // Nullify active deliverable candidate
      }
    }
  }

  isCandidateRefuted(candidateId: string): boolean {
    return this._refutedCandidates.has(candidateId);
  }
}
