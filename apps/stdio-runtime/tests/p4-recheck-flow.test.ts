/**
 * P4 S2 recheck fixture flow tests over real M1..M5 material. Pure in-process:
 * no client, no network, no tool execution, no mathematical evaluation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { P2Error, p4Hash, type P2Artifact, type P2Contract } from "@astra/protocol";
import { runP4RepairFixture } from "../src/p4-repair-fixture.js";
import { runP4RecheckFixture } from "../src/p4-recheck-fixture.js";
import type { P4FixtureReceipt } from "../src/p4-fixture.js";
import {
  RECHECK_PROBLEM,
  RECHECK_SESSION,
  buildRecheck,
  reportRecheck,
  type RecheckMaterial,
} from "./p4-recheck-fixtures.js";

const VERDICTS = ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const;

function receiptsFor(material: RecheckMaterial, verdict: (typeof VERDICTS)[number]): readonly P4FixtureReceipt[] {
  return [
    { transportStatus: "COMPLETE", text: material.parentRaw },
    { transportStatus: "COMPLETE", text: material.reviewRaw },
    { transportStatus: "COMPLETE", text: material.childRaw },
    { transportStatus: "COMPLETE", text: reportRecheck(material, verdict) },
  ];
}

function options(overrides: Record<string, unknown> = {}): {
  maxModelCalls?: number;
  maxRechecks?: number;
  maxRepairs: number;
  remainingMs: number;
  policy: "BEST_EFFORT" | "STRICT";
  now: () => number;
} {
  return {
    maxModelCalls: 4,
    maxRechecks: 1,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
    ...overrides,
  };
}

function privateOf(result: unknown): Record<string, unknown> {
  return (result as { privateState: Record<string, unknown> }).privateState;
}

test("all three verdicts keep four shared calls, the parent answer and the open challenge", () => {
  const material = buildRecheck();
  for (const verdict of VERDICTS) {
    const result = runP4RecheckFixture(
      RECHECK_PROBLEM,
      RECHECK_SESSION,
      receiptsFor(material, verdict),
      options(),
    );
    assert.equal(result.summary.modelCalls, 4);
    assert.equal(result.summary.reviewCalls, 1);
    assert.equal(result.summary.repairCalls, 1);
    assert.equal(result.summary.recheckCalls, 1);
    assert.equal(result.summary.recheckRecorded, true);
    assert.equal(result.summary.recheckConclusion, verdict);
    assert.equal(result.summary.stopReason, "RECHECK_RECORDED");
    assert.equal(result.summary.finalResponse, "x=1");
    assert.equal(result.summary.candidateVerified, false);
    assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
    assert.equal(result.summary.parentProtected, true);
    assert.equal(result.summary.unresolvedChallenges, 1);

    const privateState = privateOf(result);
    const gate = privateState.modelGate as readonly { requestId: string; ordinal: number }[];
    assert.deepEqual(
      gate.map((row) => row.requestId),
      ["model-1", "model-2", "model-3", "model-4"],
    );
    assert.deepEqual(
      gate.map((row) => row.ordinal),
      [1, 2, 3, 4],
    );
    const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
    assert.deepEqual(
      artifacts.map((row) => row.artifact.artifactId),
      ["artifact-1", "repair-1"],
    );
    for (const row of artifacts) {
      assert.equal(row.availability, "ACTIVE");
    }
    const decision = privateState.decision as {
      protectedCandidate: { artifactId: string } | null;
      targetHash: string | null;
      reason: string;
      submissionEligibility: string;
    };
    assert.equal(decision.protectedCandidate?.artifactId, "artifact-1");
    assert.equal(decision.targetHash, material.parent.targetHash);
    assert.equal(decision.reason, "BEST_EFFORT_CANDIDATE");
    assert.equal(decision.submissionEligibility, "BEST_EFFORT");
    const repair = privateState.repair as {
      record: { lineage: { requiresRecheck: boolean; canReplaceProtected: boolean; checkResult: string } | null } | null;
    };
    assert.equal(repair.record?.lineage?.requiresRecheck, true);
    assert.equal(repair.record?.lineage?.canReplaceProtected, false);
    assert.equal(repair.record?.lineage?.checkResult, "UNKNOWN");
    const recheck = privateState.recheck as {
      record: { level: string; checkResult: string; canSupportObligation: boolean; canReplaceProtected: boolean } | null;
    };
    assert.ok(recheck.record !== null);
    assert.equal(recheck.record?.checkResult, "UNKNOWN");
    assert.equal(recheck.record?.canSupportObligation, false);
    assert.equal(recheck.record?.canReplaceProtected, false);
    assert.equal(recheck.record?.level, verdict === "UNKNOWN" ? "PROVISIONAL" : "REVIEWED");
    const contract = privateState.contract as P2Contract;
    for (const obligation of contract.obligations) {
      assert.notEqual(obligation.status, "SATISFIED");
    }
    const review = privateState.review as { challenges: readonly { status: string; availability: string }[] };
    assert.equal(review.challenges[0]?.status, "CHALLENGED");
    assert.equal(review.challenges[0]?.availability, "ACTIVE");
    for (const request of privateState.requests as readonly Record<string, unknown>[]) {
      const messages = request.messages as readonly { role: string; content: string }[];
      const serialized = JSON.stringify(messages);
      assert.equal(request.contextHash, p4Hash(serialized));
      assert.equal(request.contextBytes, Buffer.byteLength(serialized, "utf8"));
      assert.equal((request.receipt as { text: string }).text.length > 0, true);
    }
    const publicText = JSON.stringify(result.summary);
    for (const forbidden of [
      RECHECK_PROBLEM,
      "x=0 or x=1",
      "Split the zero product",
      "division by a possibly zero factor",
      "model opinion for",
    ]) {
      assert.equal(publicText.includes(forbidden), false);
    }
    assert.equal(publicText.includes("x=1"), true);
  }
});

test("default options match the old three-step fixture and never open a fourth call", () => {
  const material = buildRecheck();
  const receipts = receiptsFor(material, "NO_ISSUE");
  const oldResult = runP4RepairFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts.slice(0, 3), {
    maxModelCalls: 3,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  });
  const newResult = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, {
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  });
  for (const key of [
    "mode",
    "targetEnvironment",
    "status",
    "finalResponse",
    "candidateVerified",
    "strictAcceptance",
    "policy",
    "modelCalls",
    "reviewCalls",
    "repairCalls",
    "repairRecorded",
    "parentProtected",
    "unresolvedChallenges",
    "stopReason",
  ] as const) {
    assert.deepEqual(newResult.summary[key], oldResult.summary[key]);
  }
  assert.equal(newResult.summary.modelCalls, 3);
  assert.equal(newResult.summary.recheckCalls, 0);
  assert.equal(newResult.summary.recheckRecorded, false);
  assert.equal(newResult.summary.recheckConclusion, "NONE");
  assert.equal(newResult.summary.stopReason, "REPAIR_RECORDED");
  const privateState = privateOf(newResult);
  assert.equal((privateState.modelGate as readonly unknown[]).length, 3);
  assert.equal(privateState.recheck, null);
  assert.equal((privateOf(oldResult).modelGate as readonly unknown[]).length, 3);

  const onlyCalls = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ maxRechecks: 0 }));
  assert.equal(onlyCalls.summary.modelCalls, 3);
  assert.equal(onlyCalls.summary.recheckCalls, 0);
  const onlyRechecks = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ maxModelCalls: 3 }));
  assert.equal(onlyRechecks.summary.modelCalls, 3);
  assert.equal(onlyRechecks.summary.recheckCalls, 0);
  assert.equal(onlyRechecks.summary.recheckConclusion, "NONE");
});

test("caps, missing fourth receipt and maxRepairs 0 never invent a new budget", () => {
  const material = buildRecheck();
  const receipts = receiptsFor(material, "NO_ISSUE");
  for (const cap of [0, 1, 2, 3, 4]) {
    const result = runP4RecheckFixture(
      RECHECK_PROBLEM,
      RECHECK_SESSION,
      receipts,
      options({ maxModelCalls: cap }),
    );
    assert.equal(result.summary.modelCalls, cap);
    assert.equal(result.summary.recheckCalls, cap >= 4 ? 1 : 0);
    assert.equal(result.summary.parentProtected, cap > 0);
  }
  const noRepair = runP4RecheckFixture(
    RECHECK_PROBLEM,
    RECHECK_SESSION,
    receipts,
    options({ maxRepairs: 0 }),
  );
  assert.equal(noRepair.summary.modelCalls, 2);
  assert.equal(noRepair.summary.repairCalls, 0);
  assert.equal(noRepair.summary.recheckCalls, 0);
  assert.equal(noRepair.summary.finalResponse, "x=1");
  const missing = runP4RecheckFixture(
    RECHECK_PROBLEM,
    RECHECK_SESSION,
    receipts.slice(0, 3),
    options(),
  );
  assert.equal(missing.summary.modelCalls, 3);
  assert.equal(missing.summary.recheckCalls, 0);
  assert.equal(missing.summary.recheckConclusion, "NONE");
  assert.equal(missing.summary.stopReason, "REPAIR_RECORDED");
  const strict = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ policy: "STRICT" }));
  assert.equal(strict.summary.status, "unsolved");
  assert.equal(strict.summary.parentProtected, true);
  assert.equal(strict.summary.candidateVerified, false);
});

test("a bad fourth report keeps the raw text, records no recheck and never retries", () => {
  const material = buildRecheck();
  const good = reportRecheck(material, "NO_ISSUE");
  const parsed = JSON.parse(good) as Record<string, unknown>;
  const bad: readonly string[] = [
    "{",
    JSON.stringify({ ...parsed, childHash: "0".repeat(64) }),
    JSON.stringify({ ...parsed, reviewCoverage: [] }),
    JSON.stringify({
      ...parsed,
      checks: (parsed.checks as readonly Record<string, unknown>[]).map((row, index) =>
        index === 0 ? { ...row, childStepLocator: { start: 0, end: 1, quote: "x" } } : row,
      ),
    }),
  ];
  for (const text of bad) {
    const result = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, [
      { transportStatus: "COMPLETE", text: material.parentRaw },
      { transportStatus: "COMPLETE", text: material.reviewRaw },
      { transportStatus: "COMPLETE", text: material.childRaw },
      { transportStatus: "COMPLETE", text },
    ], options());
    assert.equal(result.summary.modelCalls, 4);
    assert.equal(result.summary.recheckCalls, 1);
    assert.equal(result.summary.recheckRecorded, false);
    assert.equal(result.summary.recheckConclusion, "NONE");
    assert.equal(result.summary.stopReason, "RECHECK_STOP");
    assert.equal(result.summary.finalResponse, "x=1");
    assert.equal(result.summary.parentProtected, true);
    const privateState = privateOf(result);
    assert.equal((privateState.modelGate as readonly unknown[]).length, 4);
    const recheck = privateState.recheck as {
      record: { code: string; rawResponseText: string | null; report: unknown; state: string } | null;
    };
    assert.equal(recheck.record?.code, "INVALID_REPORT");
    assert.equal(recheck.record?.rawResponseText, text);
    assert.equal(recheck.record?.report, null);
    assert.equal(recheck.record?.state, "RETURNED");
    const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
    assert.equal(artifacts[0]!.availability, "ACTIVE");
    const review = privateState.review as { challenges: readonly { status: string }[] };
    assert.equal(review.challenges[0]?.status, "CHALLENGED");
  }
});

test("a non-COMPLETE or unknown fourth transport settles once and never retries", () => {
  const material = buildRecheck();
  const cases: readonly (readonly [string, string, string])[] = [
    ["UNKNOWN", "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
    ["ERROR", "RETURNED", "TRANSPORT_INCOMPLETE"],
    ["TRUNCATED", "RETURNED", "TRANSPORT_INCOMPLETE"],
  ];
  for (const [transport, state, code] of cases) {
    const result = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, [
      { transportStatus: "COMPLETE", text: material.parentRaw },
      { transportStatus: "COMPLETE", text: material.reviewRaw },
      { transportStatus: "COMPLETE", text: material.childRaw },
      { transportStatus: transport as never, text: reportRecheck(material, "NO_ISSUE") },
    ], options());
    assert.equal(result.summary.modelCalls, 4);
    assert.equal(result.summary.recheckCalls, 1);
    assert.equal(result.summary.recheckRecorded, false);
    assert.equal(result.summary.recheckConclusion, "NONE");
    assert.equal(result.summary.stopReason, "RECHECK_STOP");
    assert.equal(result.summary.finalResponse, "x=1");
    assert.equal(result.summary.parentProtected, true);
    const privateState = privateOf(result);
    assert.equal((privateState.modelGate as readonly unknown[]).length, 4);
    const recheck = privateState.recheck as {
      record: { code: string; state: string; transportStatus: string; report: unknown } | null;
    };
    assert.equal(recheck.record?.state, state);
    assert.equal(recheck.record?.code, code);
    assert.equal(recheck.record?.transportStatus, transport);
    assert.equal(recheck.record?.report, null);
  }
});

test("an upstream stop before the fourth call never opens a recheck", () => {
  const material = buildRecheck();
  const coverage = (JSON.parse(material.reviewRaw) as { reviewCoverage: readonly string[] }).reviewCoverage;
  const noIssueReview = JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: "model-2",
    target: material.parent.binding,
    targetHash: material.parent.targetHash,
    stage: "R2",
    conclusion: "NO_ISSUE",
    reviewCoverage: coverage,
    issues: [],
  });
  const noopChild = JSON.stringify({
    ...(JSON.parse(material.childRaw) as Record<string, unknown>),
    claim: "x=1 only",
    derivation: "😀 Divide by x. Then x=1.",
    candidateProposal: "x=1",
  });
  // A forged assumption is still a fixed rejection even though the eight
  // identity fields of a repair packet are rebound to the trusted request.
  const foreignAssumption = JSON.stringify({
    ...(JSON.parse(material.childRaw) as Record<string, unknown>),
    assumptions: ["undeclared"],
  });
  const goodFour = receiptsFor(material, "NO_ISSUE");
  const withSlot = (
    index: number,
    receipt: P4FixtureReceipt,
  ): readonly P4FixtureReceipt[] =>
    goodFour.map((row, position) => (position === index ? receipt : row));
  const cases: readonly (readonly [string, readonly P4FixtureReceipt[], number, number])[] = [
    ["work1-truncated", withSlot(0, { transportStatus: "TRUNCATED", text: material.parentRaw }), 1, 0],
    ["work1-malformed", withSlot(0, { transportStatus: "COMPLETE", text: "{" }), 1, 0],
    ["review2-error", withSlot(1, { transportStatus: "ERROR", text: material.reviewRaw }), 2, 0],
    ["review2-malformed", withSlot(1, { transportStatus: "COMPLETE", text: "{" }), 2, 0],
    ["review2-no-issue", withSlot(1, { transportStatus: "COMPLETE", text: noIssueReview }), 2, 0],
    ["repair3-truncated", withSlot(2, { transportStatus: "TRUNCATED", text: material.childRaw }), 3, 0],
    ["repair3-malformed", withSlot(2, { transportStatus: "COMPLETE", text: "{" }), 3, 0],
    ["repair3-noop", withSlot(2, { transportStatus: "COMPLETE", text: noopChild }), 3, 0],
    ["repair3-foreign-assumption", withSlot(2, { transportStatus: "COMPLETE", text: foreignAssumption }), 3, 0],
  ];
  for (const [label, receipts, calls, rechecks] of cases) {
    const result = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options());
    assert.equal(result.summary.modelCalls, calls);
    assert.equal(result.summary.recheckCalls, rechecks);
    assert.equal(result.summary.recheckRecorded, false);
    assert.equal(result.summary.recheckConclusion, "NONE");
    const privateState = privateOf(result);
    assert.equal((privateState.modelGate as readonly unknown[]).length, calls);
    assert.equal(privateState.recheck, null);
    const contract = privateState.contract as P2Contract;
    for (const obligation of contract.obligations) {
      assert.notEqual(obligation.status, "SATISFIED");
    }
    const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
    if (calls === 1) {
      // No candidate was ever accepted: no parent, no review, no repair. A
      // TRUNCATED or malformed first packet may still leave a PARTIAL artifact.
      assert.equal(result.summary.status, "unsolved");
      assert.equal(result.summary.parentProtected, false);
      assert.equal(privateState.review, null);
      assert.equal(privateState.repair, null);
      assert.ok(artifacts.length <= 1);
      if (artifacts.length === 1) {
        assert.equal(artifacts[0]!.artifact.artifactId, "artifact-1");
        // A PARTIAL first packet is still usable material, not a candidate:
        // the store keeps it ACTIVE while the packet stays non-COMPLETE.
        assert.equal(artifacts[0]!.availability, "ACTIVE");
        assert.notEqual(artifacts[0]!.artifact.deliveryStatus, "COMPLETE");
        assert.equal(artifacts[0]!.artifact.checkResult, "UNKNOWN");
        assert.equal(artifacts[0]!.artifact.level, "PROVISIONAL");
      }
      continue;
    }
    // calls >= 2: a valid parent exists and stays the protected answer.
    assert.equal(result.summary.finalResponse, "x=1");
    assert.equal(result.summary.parentProtected, true);
    assert.equal(artifacts[0]!.artifact.artifactId, "artifact-1");
    assert.equal(artifacts[0]!.availability, "ACTIVE");
    if (calls === 2) {
      // The R2 review never produced a CHALLENGED challenge.
      assert.equal(result.summary.repairCalls, 0);
      assert.equal(result.summary.recheckCalls, 0);
      const review = privateState.review as { challenges: readonly { status: string }[] } | null;
      assert.equal(review?.challenges.length ?? 0, 0);
      continue;
    }
    // calls === 3: the initial R2 review was ISSUES, so a challenge exists.
    assert.equal(result.summary.repairCalls, 1);
    assert.equal(result.summary.repairRecorded, false);
    const review = privateState.review as { challenges: readonly { status: string; availability: string }[] };
    assert.equal(review.challenges[0]?.status, "CHALLENGED");
    assert.equal(review.challenges[0]?.availability, "ACTIVE");
    if (label === "repair3-noop") {
      // A real M3-accepted no-op child exists and is invalidated by the repair.
      assert.equal(artifacts.length, 2);
      assert.equal(artifacts[1]!.artifact.artifactId, "repair-1");
      assert.equal(artifacts[1]!.availability, "STALE");
    } else {
      // No valid child was accepted, so no second artifact entry is required.
      assert.ok(artifacts.length <= 2);
      if (artifacts.length === 2) {
        assert.equal(artifacts[1]!.availability, "STALE");
      }
    }
  }
});
