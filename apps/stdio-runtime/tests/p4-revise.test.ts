/**
 * G3/PR4 S3 evidence-gated candidate revision.
 *
 * The flagship: a protected `{1}` candidate for `x(x-1)=0` is replaced by an
 * evidence-grounded `{0,1}` revision. Every refusal leaves the parent candidate
 * in place (fail-closed) and records `REVISE_REJECTED`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4CandidateGate, reviseCandidate } from "@astra/math-audit";
import {
  p2Snapshot,
  p4JsonEqual,
  p4Target,
  type P2Contract,
  type P2Task,
  type P4Challenge,
  type P4ReviseBasis,
  type P4Target,
} from "@astra/protocol";

const PROBLEM = "Find all real solutions x(x-1)=0";
const SESSION = "s";
const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;
const PARENT_DERIVATION = "Take the root x=1.";
const CHILD_DERIVATION = "Split the zero product: x=0 or x=1.";
const ANSWER_TASK = "goal-1:EXHAUSTIVENESS";

interface Built {
  readonly contract: P2Contract;
  readonly task: P2Task;
  readonly store: P2WorkunitStore;
  readonly parent: P4Target;
  readonly child: P4Target;
  readonly challenge: P4Challenge;
  readonly answerObligationId: string;
  readonly nextSeq: () => number;
}

function packetOf(
  contract: P2Contract,
  task: P2Task,
  sourceRequestId: string,
  derivation: string,
  candidate: string | null,
): string {
  return JSON.stringify({
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: task.taskId,
    goalId: task.goalId,
    scopeId: task.scopeId,
    routeId: "route-1",
    sourceRequestId,
    claim: candidate ?? "no candidate",
    derivation,
    assumptions: [],
    dependencies: task.inputArtifactRefs,
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: candidate,
  });
}

function build(): Built {
  const contract: P2Contract = compileP2Contract(PROBLEM, SESSION);
  const ledger = new ContractLedger(contract);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(ROUTE);
  // Every accepted artifact needs an event sequence strictly above the highest
  // task envelope sequence and strictly increasing across accepts.
  const seed = ledger.snapshot();
  let seq = Math.max(seed.envelope.eventSeq, ...seed.tasks.map((row) => row.envelope.eventSeq)) + 1;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };
  // Deliver the dependency-free prerequisite tasks so the ALL_SOLUTIONS answer
  // obligation (EXHAUSTIVENESS) becomes READY.
  let ordinal = 0;
  for (const task of ledger.readyTasks()) {
    ordinal += 1;
    const source = `model-${ordinal}`;
    const running = ledger.startTask(task.taskId);
    const artifact = store.accept(running, {
      artifactId: `dep-${ordinal}`,
      routeId: "route-1",
      sourceRequestId: source,
      transportStatus: "COMPLETE",
      text: packetOf(ledger.snapshot(), running, source, "prerequisite", null),
      eventSeq: nextSeq(),
      supersedes: null,
    });
    ledger.recordDelivery(
      task.taskId,
      { artifactId: artifact.artifactId, artifactVersion: 1 },
      artifact.deliveryStatus === "COMPLETE" ? "DELIVERED" : "PARTIAL",
      ledger.nextEventSeq(),
    );
  }
  const task = ledger.readyTasks().find((row) => row.taskId === ANSWER_TASK);
  assert.ok(task !== undefined, "the ALL_SOLUTIONS answer task must be ready");
  const running = ledger.startTask(task.taskId);
  const live = ledger.snapshot();
  const parentArtifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-10",
    transportStatus: "COMPLETE",
    text: packetOf(live, running, "model-10", PARENT_DERIVATION, "x=1"),
    eventSeq: nextSeq(),
    supersedes: null,
  });
  const parent = p4Target(live, parentArtifact, "ACTIVE");
  const answerObligation = live.obligations.find(
    (row) => row.obligationId === `${parent.binding.goalId}:EXHAUSTIVENESS`,
  );
  assert.ok(answerObligation !== undefined, "the answer obligation must exist");
  const childArtifact = store.accept(running, {
    artifactId: "repair-1",
    routeId: "route-1",
    sourceRequestId: "model-11",
    transportStatus: "COMPLETE",
    text: packetOf(live, running, "model-11", CHILD_DERIVATION, "{0,1}"),
    eventSeq: nextSeq(),
    supersedes: null,
  });
  const child = p4Target(live, childArtifact, "ACTIVE");
  const challenge: P4Challenge = {
    challengeId: "challenge-1",
    target: parent.binding,
    targetHash: parent.targetHash,
    issue: {
      stepLocator: { start: 0, end: 1, quote: "T" },
      suspectedIssue: "MISSING_CASE",
      rationale: "x=0 satisfies the zero product and was not reported",
      requestedCheck: "substitute x=0 into the original equation",
      obligationIds: [answerObligation.obligationId],
    },
    requestIds: ["model-12"],
    status: "CHALLENGED",
    availability: "ACTIVE",
  };
  return {
    contract: live,
    task: running,
    store,
    parent,
    child,
    challenge,
    answerObligationId: answerObligation.obligationId,
    nextSeq,
  };
}

function grounded(built: Built, overrides: Partial<P4ReviseBasis> = {}): P4ReviseBasis {
  return {
    source: "CHECKER_COUNTEREXAMPLE",
    level: "CHECKED_SCOPE",
    checkResult: "PASS",
    scopeId: built.parent.binding.scopeId,
    witness: "x=0 gives 0*(0-1)=0",
    obligatedObligationIds: [built.answerObligationId],
    childCoverage: [built.answerObligationId],
    ...overrides,
  };
}

/** Accept one more child variant into the same store; returns its target. */
function childVariant(built: Built, candidate: string, ordinal: number): P4Target {
  const source = `model-${20 + ordinal}`;
  const artifact = built.store.accept(built.task, {
    artifactId: `repair-${30 + ordinal}`,
    routeId: "route-1",
    sourceRequestId: source,
    transportStatus: "COMPLETE",
    text: packetOf(built.contract, built.task, source, CHILD_DERIVATION, candidate),
    eventSeq: built.nextSeq(),
    supersedes: null,
  });
  return p4Target(built.contract, artifact, "ACTIVE");
}

test("flagship: a grounded {1} -> {0,1} revision replaces the protected candidate", () => {
  const built = build();
  const result = reviseCandidate(
    built.contract,
    { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built) },
    1000,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "REVISED_CANDIDATE");
  assert.equal(result.decision.finalResponse, "{0,1}");
  assert.equal(result.decision.status, "candidate");
  assert.equal(result.decision.reason, "REVISED_CANDIDATE");
  assert.equal(result.decision.unresolvedChallenges, 0);
  assert.equal(result.decision.protectedCandidate?.artifactId, "repair-1");
  assert.equal(result.decision.candidateVerified, false);
  assert.equal(result.decision.strictAcceptance, "NOT_PERFORMED");
  // The valid local `x=1` candidate value stays retained on the parent.
  assert.equal(built.parent.artifact.packet?.candidateProposal, "x=1");
  const row = result.decision.coverage.find((item) => item.obligationId === built.answerObligationId);
  assert.equal(row?.deliveryCovered, true);
  assert.equal(Object.isFrozen(result.decision), true);
});

test("refusal keeps the parent candidate and records REVISE_REJECTED", () => {
  const built = build();
  const cases: readonly (() => ReturnType<typeof reviseCandidate>)[] = [
    // A model review opinion is not a grounded basis.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { level: "REVIEWED" as never }) }, 1000),
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { checkResult: "UNKNOWN" as never }) }, 1000),
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { source: "MODEL_REVIEW" as never }) }, 1000),
    // No concrete witness.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { witness: "   " }) }, 1000),
    // Basis scoped to another scope.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { scopeId: "other-scope" }) }, 1000),
    // The basis does not cover the challenged answer obligation.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, { childCoverage: ["other"] }) }, 1000),
    // The challenge targets a local (non-answer) obligation only.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: { ...built.challenge, issue: { ...built.challenge.issue, obligationIds: ["some-local"] } }, basis: grounded(built) }, 1000),
    // The revised child does not change the candidate.
    () => reviseCandidate(built.contract, { parent: built.parent, child: childVariant(built, "x=1", 1), challenge: built.challenge, basis: grounded(built) }, 1000),
    // No budget left.
    () => reviseCandidate(built.contract, { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built) }, 0),
  ];
  for (const fn of cases) {
    const result = fn();
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "REVISE_REJECTED");
    assert.equal(result.decision.finalResponse, "x=1");
    assert.equal(result.decision.reason, "REVISE_REJECTED");
    assert.equal(result.decision.protectedCandidate?.artifactId, "artifact-1");
    assert.equal(result.decision.unresolvedChallenges, 1);
  }
});

test("a stale challenge or a forged child binding is refused", () => {
  const built = build();
  const stale = reviseCandidate(
    built.contract,
    { parent: built.parent, child: built.child, challenge: { ...built.challenge, availability: "STALE" }, basis: grounded(built) },
    1000,
  );
  assert.equal(stale.accepted, false);
  assert.equal(stale.decision.finalResponse, "x=1");
  const forged: P4Target = {
    ...built.child,
    binding: { ...built.child.binding, goalId: "not-a-goal" },
  };
  const forgedResult = reviseCandidate(
    built.contract,
    { parent: built.parent, child: forged, challenge: built.challenge, basis: grounded(built) },
    1000,
  );
  assert.equal(forgedResult.accepted, false);
});

test("the revision path is the only sanctioned replacement of a protected candidate", () => {
  const built = build();
  const gate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  assert.equal(gate.protect(built.parent), true);
  // The legacy gate refuses a second different candidate.
  assert.equal(gate.protect(built.child), false);
  const before = p2Snapshot(built.parent);
  const result = reviseCandidate(
    built.contract,
    { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built) },
    1000,
  );
  assert.equal(result.accepted, true);
  // Revising never mutates the parent target object.
  assert.equal(p4JsonEqual(p2Snapshot(built.parent), before), true);
});

test("multi-counterexample: a revision covering every challenged gap is accepted", () => {
  const built = build();
  const result = reviseCandidate(
    built.contract,
    {
      parent: built.parent,
      child: built.child,
      challenge: built.challenge,
      basis: grounded(built, {
        requiredGaps: ["x=0", "x=2"],
        coveredGaps: ["x=0", "x=1", "x=2"],
      }),
    },
    1000,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "REVISED_CANDIDATE");
  assert.equal(result.decision.finalResponse, "{0,1}");
});

test("multi-counterexample: a partial repair that leaves a proven gap fails closed", () => {
  const built = build();
  const partial = reviseCandidate(
    built.contract,
    {
      parent: built.parent,
      child: built.child,
      challenge: built.challenge,
      basis: grounded(built, { requiredGaps: ["x=0", "x=2"], coveredGaps: ["x=0"] }),
    },
    1000,
  );
  assert.equal(partial.accepted, false);
  assert.equal(partial.reason, "REVISE_REJECTED");
  assert.equal(partial.decision.finalResponse, "x=1");
  assert.equal(partial.decision.protectedCandidate?.artifactId, "artifact-1");

  // An empty, duplicated or over-broad required-gap set is also refused.
  for (const bad of [
    { requiredGaps: [], coveredGaps: [] },
    { requiredGaps: ["x=0", "x=0"], coveredGaps: ["x=0"] },
    { requiredGaps: ["x=0"], coveredGaps: undefined as unknown as readonly string[] },
  ]) {
    const result = reviseCandidate(
      built.contract,
      { parent: built.parent, child: built.child, challenge: built.challenge, basis: grounded(built, bad) },
      1000,
    );
    assert.equal(result.accepted, false);
  }
});
