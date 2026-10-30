import assert from "node:assert/strict";
import test from "node:test";
import { CandidateGate } from "../dist/src/candidate-gate.js";

test("I04: 截断输出与错误状态不触发候选替换", () => {
  const gate = new CandidateGate();

  // Initial candidate
  const initial = {
    candidateId: "cand_initial_v1",
    version: 1,
    claimRefs: ["claim_m_1.5"],
    supportRefs: ["art_calc_1"],
    deliverable: true,
    candidateVerified: false,
  };
  const initRes = gate.proposeCandidate(initial, []);
  assert.equal(initRes.accepted, true);
  assert.equal(gate.activeCandidate?.candidateId, "cand_initial_v1");

  // Attempt to propose candidate with isTruncatedOrError = true (e.g. truncated JSON or error response)
  const truncatedProposal = {
    candidateId: "cand_truncated_v2",
    version: 2,
    claimRefs: ["claim_incomplete"],
    supportRefs: [],
    deliverable: true,
    candidateVerified: false,
  };
  const truncRes = gate.proposeCandidate(truncatedProposal, [], true);

  // Invariant I04: Truncated proposals must be rejected and parent candidate preserved
  assert.equal(truncRes.accepted, false);
  assert.match(truncRes.reason, /Invariant I04: Truncated or error response cannot trigger candidate replacement/);
  assert.equal(gate.activeCandidate?.candidateId, "cand_initial_v1");
});

test("I07 & I10: 评审挑战去重合并；部分修复被拦截并保留父候选，全量修复才允许替换", () => {
  const gate = new CandidateGate();

  // 1. Initial accepted candidate
  const parent = {
    candidateId: "cand_parent_estimate",
    version: 1,
    claimRefs: ["m=1.5", "c=0.4", "k=2.8"],
    supportRefs: ["art_ls_1"],
    deliverable: true,
    candidateVerified: false,
  };
  gate.proposeCandidate(parent, []);
  assert.equal(gate.activeCandidate?.candidateId, "cand_parent_estimate");

  // 2. Review raises 2 distinct challenges (I07: challenges are structured opinions)
  gate.raiseChallenge({
    challengeId: "ch_positive_damping",
    targetRef: "cand_parent_estimate",
    issueKind: "UNCHECKED_DISSIPATION",
    evidenceRefs: ["ev_eigen_negative"],
    requiredResolution: "Prove damping matrix C is positive definite",
    state: "OPEN",
  });

  gate.raiseChallenge({
    challengeId: "ch_resonance_peak",
    targetRef: "cand_parent_estimate",
    issueKind: "UNMATCHED_RESONANCE_FREQ",
    evidenceRefs: ["ev_bode_mismatch"],
    requiredResolution: "Verify resonant frequency omega_n == sqrt(k/m)",
    state: "OPEN",
  });

  // Re-raising identical target + issueKind merges evidence refs
  gate.raiseChallenge({
    challengeId: "ch_damping_dup",
    targetRef: "cand_parent_estimate",
    issueKind: "UNCHECKED_DISSIPATION",
    evidenceRefs: ["ev_second_reviewer_log"],
    requiredResolution: "Prove damping matrix C is positive definite",
    state: "OPEN",
  });

  const challenges = gate.openChallenges;
  assert.equal(challenges.length, 2);
  const dampingCh = challenges.find((c) => c.issueKind === "UNCHECKED_DISSIPATION");
  assert.ok(dampingCh);
  assert.equal(dampingCh.evidenceRefs.length, 2);
  assert.ok(dampingCh.evidenceRefs.includes("ev_eigen_negative"));
  assert.ok(dampingCh.evidenceRefs.includes("ev_second_reviewer_log"));

  // 3. Invariant I10: Partial repair proposal (only resolves ch_positive_damping)
  const partialCandidate = {
    candidateId: "cand_partial_repair",
    version: 2,
    claimRefs: ["m=1.5", "c=0.45", "k=2.8"],
    supportRefs: ["art_ls_2"],
    deliverable: true,
    candidateVerified: false,
  };
  const partialRes = gate.proposeCandidate(partialCandidate, [dampingCh.challengeId]);

  // Partial repair MUST be rejected and parent candidate strictly preserved
  assert.equal(partialRes.accepted, false);
  assert.match(partialRes.reason, /Invariant I10: Partial repair rejected/);
  assert.equal(gate.activeCandidate?.candidateId, "cand_parent_estimate");

  // 4. Full repair proposal (resolves all open challenges)
  const fullCandidate = {
    candidateId: "cand_full_repair",
    version: 2,
    claimRefs: ["m=1.5", "c=0.45", "k=2.85"],
    supportRefs: ["art_ls_3", "art_lyapunov_check"],
    deliverable: true,
    candidateVerified: false,
  };
  const fullRes = gate.proposeCandidate(fullCandidate, [
    dampingCh.challengeId,
    "ch_resonance_peak",
  ]);

  assert.equal(fullRes.accepted, true);
  assert.equal(gate.activeCandidate?.candidateId, "cand_full_repair");
  assert.equal(gate.openChallenges.length, 0); // All challenges resolved
});

test("I11: 被客观验证否定的候选不得作为回退结果交付", () => {
  const gate = new CandidateGate();

  const flawedCandidate = {
    candidateId: "cand_flawed_parameters",
    version: 1,
    claimRefs: ["m=-1.0", "c=0.0"],
    supportRefs: [],
    deliverable: true,
    candidateVerified: false,
  };
  gate.proposeCandidate(flawedCandidate, []);
  assert.equal(gate.activeCandidate?.candidateId, "cand_flawed_parameters");

  // External validator issues failing receipt
  gate.recordRefutation("cand_flawed_parameters", {
    validatorId: "physical_admissibility_checker",
    validatorVersion: "2.1.0",
    subjectHash: "hash_param_matrix",
    scope: "positive_mass_cone",
    outcome: "FAIL",
    evidenceRefs: ["ev_mass_negative"],
    issuedAt: new Date().toISOString(),
  });

  // Invariant I11: candidate is refuted, and active deliverable candidate is nullified
  assert.equal(gate.isCandidateRefuted("cand_flawed_parameters"), true);
  assert.equal(gate.activeCandidate, undefined);
});

test("I15: 候选完整性校验强制要求 candidateVerified 恒为 false", () => {
  const gate = new CandidateGate();

  // Attempting to propose candidate with candidateVerified: true must violate Invariant I15
  assert.throws(
    () => {
      gate.proposeCandidate(
        {
          candidateId: "cand_fake_verified",
          version: 1,
          claimRefs: ["claim_1"],
          supportRefs: [],
          deliverable: true,
          candidateVerified: true,
        },
        []
      );
    },
    { message: /Invariant I15 violation: candidateVerified must strictly remain false/ }
  );
});
