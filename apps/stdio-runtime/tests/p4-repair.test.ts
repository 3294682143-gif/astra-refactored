import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate, P4RepairSession } from "@astra/math-audit";
import {
  P2Error,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  p4Target,
  type P2Artifact,
  type P2Contract,
  type P2Task,
  type P4Challenge,
  type P4RepairRecord,
  type P4Target,
} from "@astra/protocol";
import { runP4RepairFixture } from "../src/p4-repair-fixture.js";
import type { P4FixtureReceipt } from "../src/p4-fixture.js";

const PROBLEM = "Find all real solutions x(x-1)=0";
const SESSION = "s";
const ROUTE = {
  routeId: "route-1",
  representation: "equation",
  operation: "derive",
  lemmas: [],
  construction: "offline",
} as const;
const PARENT_DERIVATION = "😀 Divide by x. Then x=1.";
const CHILD_DERIVATION = "😀 Split the zero product: x=0 or x=1.";

interface Built {
  readonly contract: P2Contract;
  readonly task: P2Task;
  readonly parent: P4Target;
  readonly challenge: P4Challenge;
  readonly child: P4Target;
  readonly parentRaw: string;
  readonly reviewRaw: string;
  readonly childRaw: string;
}

function packetOf(
  contract: P2Contract,
  task: P2Task,
  sourceRequestId: string,
  claim: string,
  derivation: string,
  candidate: string,
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
    claim,
    derivation,
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: candidate,
  });
}

function build(declaredAssumptions: readonly string[] = []): Built {
  const base = compileP2Contract(PROBLEM, SESSION);
  const contract =
    declaredAssumptions.length === 0
      ? base
      : compileP2Contract(PROBLEM, SESSION, [
          {
            ...base.goals[0]!,
            scope: { ...base.goals[0]!.scope, localAssumptions: declaredAssumptions },
          },
        ]);
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
    const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
    return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
  });
  assert.ok(task !== undefined);
  const running = ledger.startTask(task.taskId);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(ROUTE);
  const parentRaw = packetOf(contract, running, "model-1", "x=1 only", PARENT_DERIVATION, "x=1");
  const parentArtifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-1",
    transportStatus: "COMPLETE",
    text: parentRaw,
    eventSeq: ledger.nextEventSeq(),
    supersedes: null,
  });
  const parent = p4Target(ledger.snapshot(), parentArtifact, "ACTIVE");
  const obligationIds = contract.obligations
    .filter(
      (item) => item.goalId === parent.binding.goalId && item.envelope.scopeId === parent.binding.scopeId,
    )
    .map((item) => item.obligationId);
  const chars = [...PARENT_DERIVATION];
  const quote = "Divide by x.";
  const start = chars.findIndex((_, index) => chars.slice(index, index + [...quote].length).join("") === quote);
  assert.ok(start >= 0);
  const reviewRaw = JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: "model-2",
    target: parent.binding,
    targetHash: parent.targetHash,
    stage: "R2",
    conclusion: "ISSUES",
    reviewCoverage: obligationIds,
    issues: [
      {
        stepLocator: { start, end: start + [...quote].length, quote },
        suspectedIssue: "ZERO_DIVISOR",
        rationale: "division by a possibly zero factor",
        requestedCheck: "check the zero branch",
        obligationIds,
      },
    ],
  });
  const review = new P4ReviewSession(contract, parent, 2);
  review.admit("model-2", 1000);
  review.markDispatched("model-2");
  assert.equal(review.settle("model-2", "COMPLETE", reviewRaw, 1000).code, "OK");
  const challenge = review.snapshot().challenges[0];
  assert.ok(challenge !== undefined);
  const childRaw = packetOf(contract, running, "model-3", "x=0 or x=1", CHILD_DERIVATION, "x=0 or x=1");
  const childArtifact = store.accept(running, {
    artifactId: "repair-1",
    routeId: "route-1",
    sourceRequestId: "model-3",
    transportStatus: "COMPLETE",
    text: childRaw,
    eventSeq: (parentArtifact.envelope.eventSeq ?? 0) + 1,
    supersedes: null,
  });
  const child = p4Target(ledger.snapshot(), childArtifact, "ACTIVE");
  return { contract, task: running, parent, challenge, child, parentRaw, reviewRaw, childRaw };
}

function acceptedVariant(
  built: Built,
  changes: Record<string, unknown>,
): { readonly child: P4Target; readonly raw: string } {
  const store = new P2WorkunitStore(built.contract);
  store.registerRoute(ROUTE);
  const raw = JSON.stringify({ ...(JSON.parse(built.childRaw) as Record<string, unknown>), ...changes });
  const artifact = store.accept(built.task, {
    artifactId: "repair-1",
    routeId: "route-1",
    sourceRequestId: "model-3",
    transportStatus: "COMPLETE",
    text: raw,
    eventSeq: (built.parent.artifact.envelope.eventSeq ?? 0) + 1,
    supersedes: null,
  });
  return { child: p4Target(built.contract, artifact, "ACTIVE"), raw };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function settleRepair(
  session: P4RepairSession,
  transport: "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN",
  text: string,
  child: P4Target | null,
  remainingMs = 1000,
): P4RepairRecord {
  session.admit(1000);
  session.markDispatched();
  return session.settle(transport, text, child, remainingMs);
}

test("S2 records one repair lineage without replacing the protected parent", () => {
  const built = build();
  const session = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  const record = settleRepair(session, "COMPLETE", built.childRaw, built.child);
  assert.equal(record.code, "PROPOSAL_RECORDED");
  assert.equal(record.state, "RETURNED");
  const lineage = record.lineage;
  assert.ok(lineage !== null);
  assert.equal(lineage.parentHash, built.parent.targetHash);
  assert.equal(lineage.childHash, built.child.targetHash);
  assert.equal(lineage.challengeId, built.challenge.challengeId);
  assert.equal(lineage.requestId, "model-3");
  assert.equal(lineage.stage, "S2");
  assert.equal(lineage.checkResult, "UNKNOWN");
  assert.equal(lineage.requiresRecheck, true);
  assert.equal(lineage.canReplaceProtected, false);
  assert.deepEqual([...lineage.changedFields], ["claim", "derivation", "candidateProposal"]);
  assert.equal(p4JsonEqual(lineage.parent, built.parent.binding), true);
  assert.equal(p4JsonEqual(lineage.child, built.child.binding), true);
  assert.equal(built.child.binding.artifactId, "repair-1");
  assert.equal(built.child.binding.artifactVersion, 1);
  assert.notEqual(built.child.binding.artifactId, built.parent.binding.artifactId);
  assert.equal(built.parent.availability, "ACTIVE");
  assert.equal(built.challenge.status, "CHALLENGED");
  assert.equal(built.challenge.availability, "ACTIVE");
  const gate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  assert.equal(gate.protect(built.parent), true);
  assert.equal(gate.protect(built.child), false);
  const decision = gate.finalize(built.contract, built.parent, null, 1000);
  assert.equal(decision.finalResponse, "x=1");
  assert.equal(decision.candidateVerified, false);
  const snapshot = session.snapshot();
  assert.equal(snapshot.repairAttempts, 1);
  assert.equal(snapshot.availability, "ACTIVE");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.record), true);
  assert.equal(Object.isFrozen(snapshot.record?.lineage), true);
  const context = record.context;
  const serialized = JSON.stringify(context.messages);
  assert.equal(context.contextBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(context.contextHash, p4Hash(serialized));
  assert.equal(context.messages.length, 2);
  assert.equal(context.messages[0]!.role, "system");
  const payload = JSON.parse(context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.problemFullText, PROBLEM);
  assert.equal(payload.parentClaim, "x=1 only");
  assert.equal(payload.parentDerivation, PARENT_DERIVATION);
  assert.equal(payload.parentCandidate, "x=1");
  assert.deepEqual(payload.parentAssumptions, []);
  assert.equal(payload.routeId, "route-1");
  assert.equal(payload.parentHash, built.parent.targetHash);
  assert.equal((payload.challenge as Record<string, unknown>).challengeId, built.challenge.challengeId);
  assert.equal(serialized.includes("x=0 or x=1"), false);
  assert.equal(context.messages[0]!.content.includes("cannot declare anything verified"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "verified"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "resolved"), false);
  assert.equal(lineage.checkResult, "UNKNOWN");
  assert.equal(lineage.canReplaceProtected, false);
  expectCode(() => session.admit(1000), "BUDGET_EXHAUSTED");
});

test("S2 constructor rejects forged challenges and leaves the source record intact", () => {
  const built = build();
  const before = p2Snapshot(built.challenge);
  const cases: readonly (() => unknown)[] = [
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, status: "CONFIRMED" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, availability: "STALE" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, target: { ...built.challenge.target, taskId: "other" } } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, targetHash: "0".repeat(64) } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, challengeId: "challenge-0" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, challengeId: "challenge-01" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, challengeId: "challenge-17" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, challengeId: "challenge-999" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, challengeId: "challenge-1\n" } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, requestIds: ["model-3"] } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, issue: { ...built.challenge.issue, stepLocator: { start: 1, end: 2, quote: "Divide by x." } } } as unknown as P4Challenge, 1),
    () => new P4RepairSession(built.contract, built.parent, { ...built.challenge, issue: { ...built.challenge.issue, obligationIds: ["missing"] } } as unknown as P4Challenge, 1),
  ];
  for (const fn of cases) {
    assert.throws(fn, (error: unknown) => error instanceof P2Error);
  }
  assert.equal(p4JsonEqual(p2Snapshot(built.challenge), before), true);
  const frozen = structuredClone(built.challenge) as unknown as Record<string, unknown>;
  frozen.status = "CONFIRMED";
  expectCode(() => new P4RepairSession(built.contract, built.parent, frozen as unknown as P4Challenge, 1), "PACKET_BINDING");
  assert.equal(built.challenge.status, "CHALLENGED");
});

test("S2 settle rejects foreign, stale and no-op children without retrying", () => {
  const built = build();
  const cases: readonly (() => P4RepairRecord)[] = [
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.childRaw, { ...built.child, binding: { ...built.child.binding, taskId: "other" } } as unknown as P4Target),
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.childRaw, { ...built.child, targetHash: "0".repeat(64) } as unknown as P4Target),
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.parentRaw, built.child),
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.childRaw, { ...built.child, binding: { ...built.child.binding, sourceRequestId: "model-1" } } as unknown as P4Target),
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.childRaw, { ...built.child, binding: { ...built.child.binding, artifactId: "artifact-1" } } as unknown as P4Target),
    () => settleRepair(new P4RepairSession(built.contract, built.parent, built.challenge, 1), "COMPLETE", built.childRaw, { ...built.child, binding: { ...built.child.binding, artifactVersion: 2 } } as unknown as P4Target),
  ];
  for (const [index, fn] of cases.entries()) {
    const record = fn();
    assert.equal(record.code, "INVALID_REPAIR");
    assert.equal(record.lineage, null);
    assert.equal(record.rawResponseText, index === 2 ? built.parentRaw : built.childRaw);
  }
  const session = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  const record = settleRepair(session, "COMPLETE", built.childRaw, { ...built.child, availability: "STALE" } as unknown as P4Target);
  assert.equal(record.code, "INVALID_REPAIR");
  assert.equal(record.lineage, null);
  expectCode(() => session.admit(1000), "BUDGET_EXHAUSTED");
});

test("S2 rejects a real M3-accepted no-op child and a newly used declared assumption", () => {
  const built = build();
  const noop = acceptedVariant(built, {
    claim: "x=1 only",
    derivation: PARENT_DERIVATION,
    candidateProposal: "x=1",
  });
  assert.equal(noop.child.binding.artifactId, "repair-1");
  assert.equal(noop.child.binding.sourceRequestId, "model-3");
  const noopSession = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  const noopRecord = settleRepair(noopSession, "COMPLETE", noop.raw, noop.child);
  assert.equal(noopRecord.code, "INVALID_REPAIR");
  assert.equal(noopRecord.lineage, null);
  assert.equal(noopRecord.rawResponseText, noop.raw);
  expectCode(() => noopSession.admit(1000), "BUDGET_EXHAUSTED");
  const gate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  assert.equal(gate.protect(built.parent), true);
  assert.equal(gate.protect(noop.child), false);
  assert.equal(gate.finalize(built.contract, built.parent, null, 1000).finalResponse, "x=1");

  const declared = build(["x>=0"]);
  assert.deepEqual([...declared.contract.goals[0]!.scope.localAssumptions], ["x>=0"]);
  assert.deepEqual([...declared.parent.artifact.packet!.assumptions], []);
  const positive = settleRepair(
    new P4RepairSession(declared.contract, declared.parent, declared.challenge, 1),
    "COMPLETE",
    declared.childRaw,
    declared.child,
  );
  assert.equal(positive.code, "PROPOSAL_RECORDED");
  const reused = acceptedVariant(declared, { assumptions: ["x>=0"] });
  assert.deepEqual([...reused.child.artifact.packet!.assumptions], ["x>=0"]);
  const reusedRecord = settleRepair(
    new P4RepairSession(declared.contract, declared.parent, declared.challenge, 1),
    "COMPLETE",
    reused.raw,
    reused.child,
  );
  assert.equal(reusedRecord.code, "INVALID_REPAIR");
  assert.equal(reusedRecord.lineage, null);
  assert.equal(declared.challenge.status, "CHALLENGED");
  assert.equal(declared.challenge.availability, "ACTIVE");
  assert.deepEqual([...declared.parent.artifact.scope.localAssumptions], ["x>=0"]);
  assert.deepEqual([...declared.parent.artifact.packet!.assumptions], []);
});

test("P4 repair fixture rejects a real no-op third packet and keeps the parent protected", () => {
  const built = build();
  const noopRaw = JSON.stringify({
    ...(JSON.parse(built.childRaw) as Record<string, unknown>),
    claim: "x=1 only",
    derivation: PARENT_DERIVATION,
    candidateProposal: "x=1",
  });
  const result = runP4RepairFixture(PROBLEM, SESSION, [
    { transportStatus: "COMPLETE", text: built.parentRaw },
    { transportStatus: "COMPLETE", text: built.reviewRaw },
    { transportStatus: "COMPLETE", text: noopRaw },
  ], {
    maxModelCalls: 3,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  });
  assert.equal(result.summary.modelCalls, 3);
  assert.equal(result.summary.repairCalls, 1);
  assert.equal(result.summary.repairRecorded, false);
  assert.equal(result.summary.stopReason, "REPAIR_STOP");
  assert.equal(result.summary.finalResponse, "x=1");
  assert.equal(result.summary.parentProtected, true);
  const privateState = result.privateState as unknown as Record<string, unknown>;
  const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
  assert.deepEqual(artifacts.map((row) => row.artifact.artifactId), ["artifact-1", "repair-1"]);
  assert.equal(artifacts[0]!.availability, "ACTIVE");
  assert.equal(artifacts[1]!.availability, "STALE");
  const decision = privateState.decision as { protectedCandidate: { artifactId: string } | null };
  assert.equal(decision.protectedCandidate?.artifactId, "artifact-1");
  const repair = privateState.repair as { record: P4RepairRecord | null; repairAttempts: number };
  assert.equal(repair.repairAttempts, 1);
  assert.equal(repair.record?.code, "INVALID_REPAIR");
  assert.equal(repair.record?.lineage, null);
  assert.equal(repair.record?.rawResponseText, noopRaw);
  assert.equal(repair.record?.state, "RETURNED");
  assert.equal(Object.isFrozen(repair.record), true);
  const contract = privateState.contract as P2Contract;
  for (const obligation of contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  const delivered = contract.tasks.filter((row) => row.delivery === "DELIVERED");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.inputArtifactRefs.length, 0);
});

test("P4 repair fixture never widens the root budget from a clock callback", () => {
  const built = build();
  const receipts: readonly P4FixtureReceipt[] = [
    { transportStatus: "COMPLETE", text: built.parentRaw },
    { transportStatus: "COMPLETE", text: built.reviewRaw },
    { transportStatus: "COMPLETE", text: built.childRaw },
  ];
  const options: {
    maxModelCalls: number;
    maxRepairs: number;
    remainingMs: number;
    policy: "BEST_EFFORT";
    now: () => number;
  } = {
    maxModelCalls: 1,
    maxRepairs: 0,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  };
  options.now = () => {
    options.maxModelCalls = 3;
    options.maxRepairs = 1;
    options.remainingMs = 5000;
    return 0;
  };
  const widened = runP4RepairFixture(PROBLEM, SESSION, receipts, options);
  assert.equal(widened.summary.modelCalls, 1);
  assert.equal(widened.summary.repairCalls, 0);
  assert.equal(widened.summary.repairRecorded, false);
  assert.equal(widened.summary.finalResponse, "x=1");

  const initial: readonly (() => number)[] = [
    () => {
      throw new Error("PRIVATE_CLOCK_ERROR");
    },
    () => Number.NaN,
  ];
  for (const now of initial) {
    assert.throws(
      () => runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, maxModelCalls: 3, now }),
      (error: unknown) =>
        error instanceof P2Error &&
        error.code === "DEADLINE_EXCEEDED" &&
        !error.message.includes("PRIVATE_CLOCK_ERROR"),
    );
  }

  const later: readonly (() => number)[] = [
    () => {
      if (laterTick++ === 0) {
        return 0;
      }
      throw new Error("PRIVATE_CLOCK_ERROR");
    },
    () => {
      if (laterTick++ === 0) {
        return 0;
      }
      return Number.NaN;
    },
    () => {
      const ticks = [0, 10, 5];
      return ticks[Math.min(laterTick++, ticks.length - 1)]!;
    },
  ];
  let laterTick = 0;
  for (const now of later) {
    laterTick = 0;
    const stopped = runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, maxModelCalls: 3, now });
    assert.equal(stopped.summary.status, "unsolved");
    assert.equal(stopped.summary.repairCalls, 0);
    assert.equal(stopped.summary.repairRecorded, false);
    assert.equal(JSON.stringify(stopped.summary).includes("PRIVATE_CLOCK_ERROR"), false);
  }
});

test("S2 non-COMPLETE, late and unknown outcomes keep the raw text and never refute", () => {
  const built = build();
  const cases: readonly ["COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN", number, string][] = [
    ["TRUNCATED", 1000, "TRANSPORT_INCOMPLETE"],
    ["ERROR", 1000, "TRANSPORT_INCOMPLETE"],
    ["COMPLETE", 25, "DEADLINE_EXCEEDED"],
    ["UNKNOWN", 25, "OUTCOME_UNKNOWN"],
  ];
  for (const [transport, remaining, code] of cases) {
    const session = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
    const record = settleRepair(session, transport, built.childRaw, built.child, remaining);
    assert.equal(record.code, code);
    assert.equal(record.lineage, null);
    assert.equal(record.rawResponseText, built.childRaw);
    assert.equal(record.transportStatus, transport);
    expectCode(() => session.admit(1000), "BUDGET_EXHAUSTED");
  }
  const pending = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  pending.admit(1000);
  expectCode(() => pending.markStale(), "ILLEGAL_TRANSITION");
  const stale = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  assert.equal(settleRepair(stale, "COMPLETE", built.childRaw, built.child).code, "PROPOSAL_RECORDED");
  stale.markStale();
  assert.equal(stale.snapshot().availability, "STALE");
  assert.equal(stale.snapshot().record?.lineage?.checkResult, "UNKNOWN");
  expectCode(() => stale.admit(1000), "NOT_REUSABLE");
  const zero = new P4RepairSession(built.contract, built.parent, built.challenge, 0);
  expectCode(() => zero.admit(1000), "BUDGET_EXHAUSTED");
  const bounds = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  expectCode(() => bounds.admit(25), "BOUND_EXCEEDED");
  assert.equal(bounds.admit(26).state, "ADMITTED");
  const raw = new P4RepairSession(built.contract, built.parent, built.challenge, 1);
  raw.admit(1000);
  raw.markDispatched();
  expectCode(() => raw.settle("COMPLETE", "\ud800", built.child, 1000), "PACKET_BINDING");
  expectCode(() => raw.settle("COMPLETE", "x".repeat(65537), built.child, 1000), "BOUND_EXCEEDED");
  assert.equal(raw.snapshot().record?.state, "DISPATCHED");
  assert.equal(raw.snapshot().record?.lineage, null);
});

test("P4 repair fixture composes M1..M5 under one root budget and keeps the parent protected", () => {
  const built = build();
  const receipts: readonly P4FixtureReceipt[] = [
    { transportStatus: "COMPLETE", text: built.parentRaw },
    { transportStatus: "COMPLETE", text: built.reviewRaw },
    { transportStatus: "COMPLETE", text: built.childRaw },
  ];
  const options = {
    maxModelCalls: 3,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  };
  const result = runP4RepairFixture(PROBLEM, SESSION, receipts, options);
  assert.equal(result.summary.modelCalls, 3);
  assert.equal(result.summary.reviewCalls, 1);
  assert.equal(result.summary.repairCalls, 1);
  assert.equal(result.summary.repairRecorded, true);
  assert.equal(result.summary.finalResponse, "x=1");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  assert.equal(result.summary.parentProtected, true);
  assert.equal(result.summary.unresolvedChallenges, 1);
  assert.equal(result.summary.stopReason, "REPAIR_RECORDED");

  const privateState = result.privateState as unknown as Record<string, unknown>;
  const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
  assert.deepEqual(artifacts.map((row) => row.artifact.artifactId), ["artifact-1", "repair-1"]);
  for (const row of artifacts) {
    assert.equal(row.availability, "ACTIVE");
  }
  const decision = privateState.decision as { protectedCandidate: { artifactId: string } | null };
  assert.equal(decision.protectedCandidate?.artifactId, "artifact-1");
  const repair = privateState.repair as { record: P4RepairRecord | null; repairAttempts: number };
  assert.equal(repair.repairAttempts, 1);
  const lineage = repair.record?.lineage;
  assert.ok(lineage !== null && lineage !== undefined);
  assert.equal(lineage.parentHash, built.parent.targetHash);
  assert.equal(lineage.childHash, built.child.targetHash);
  assert.equal(lineage.canReplaceProtected, false);
  assert.equal(lineage.checkResult, "UNKNOWN");
  const contract = privateState.contract as P2Contract;
  for (const obligation of contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  const delivered = contract.tasks.filter((row) => row.delivery === "DELIVERED");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.inputArtifactRefs.length, 0);
  for (const request of privateState.requests as readonly Record<string, unknown>[]) {
    const messages = request.messages as readonly { role: string; content: string }[];
    const serialized = JSON.stringify(messages);
    assert.equal(request.contextHash, p4Hash(serialized));
    assert.equal(request.contextBytes, Buffer.byteLength(serialized, "utf8"));
    assert.equal((request.receipt as { text: string }).text.length > 0, true);
  }
  const publicText = JSON.stringify(result.summary);
  for (const forbidden of ["x=0 or x=1", PROBLEM, "division by a possibly zero factor", CHILD_DERIVATION]) {
    assert.equal(publicText.includes(forbidden), false);
  }
  const strict = runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, policy: "STRICT" });
  assert.equal(strict.summary.status, "unsolved");
  assert.equal(strict.summary.candidateVerified, false);
});

test("P4 repair fixture caps, review outcomes and a rewound clock never retry or replace the parent", () => {
  const built = build();
  const receipts: readonly P4FixtureReceipt[] = [
    { transportStatus: "COMPLETE", text: built.parentRaw },
    { transportStatus: "COMPLETE", text: built.reviewRaw },
    { transportStatus: "COMPLETE", text: built.childRaw },
  ];
  const options = {
    maxModelCalls: 3,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  };
  for (const cap of [0, 1, 2]) {
    const capped = runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, maxModelCalls: cap });
    assert.ok(capped.summary.modelCalls <= cap);
    assert.equal(capped.summary.repairCalls, 0);
    assert.equal(capped.summary.repairRecorded, false);
    assert.equal(capped.summary.parentProtected, cap > 0);
  }
  const invalidFirst = runP4RepairFixture(PROBLEM, SESSION, [
    { transportStatus: "COMPLETE", text: "{" },
  ], options);
  assert.equal(invalidFirst.summary.status, "unsolved");
  assert.equal(invalidFirst.summary.parentProtected, false);
  const strictProtected = runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, policy: "STRICT" });
  assert.equal(strictProtected.summary.status, "unsolved");
  assert.equal(strictProtected.summary.parentProtected, true);
  const noRepair = runP4RepairFixture(PROBLEM, SESSION, receipts, { ...options, maxRepairs: 0 });
  assert.equal(noRepair.summary.repairCalls, 0);
  assert.equal(noRepair.summary.finalResponse, "x=1");
  assert.equal(noRepair.summary.parentProtected, true);

  const coverage = (JSON.parse(built.reviewRaw) as { reviewCoverage: readonly string[] }).reviewCoverage;
  const noIssue = JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: "model-2",
    target: built.parent.binding,
    targetHash: built.parent.targetHash,
    stage: "R2",
    conclusion: "NO_ISSUE",
    reviewCoverage: coverage,
    issues: [],
  });
  const unknown = JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId: "model-2",
    target: built.parent.binding,
    targetHash: built.parent.targetHash,
    stage: "R2",
    conclusion: "UNKNOWN",
    reviewCoverage: [],
    issues: [],
  });
  for (const text of [noIssue, unknown, "not json"]) {
    const stopped = runP4RepairFixture(PROBLEM, SESSION, [
      receipts[0]!,
      { transportStatus: "COMPLETE", text },
      receipts[2]!,
    ], options);
    assert.equal(stopped.summary.repairCalls, 0);
    assert.equal(stopped.summary.repairRecorded, false);
    assert.equal(stopped.summary.finalResponse, "x=1");
  }

  for (const transport of ["TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    const third = runP4RepairFixture(PROBLEM, SESSION, [
      receipts[0]!,
      receipts[1]!,
      { transportStatus: transport, text: built.childRaw },
    ], options);
    assert.equal(third.summary.repairCalls, 1);
    assert.equal(third.summary.repairRecorded, false);
    assert.equal(third.summary.finalResponse, "x=1");
    assert.equal(third.summary.modelCalls, 3);
  }
  const malformed = runP4RepairFixture(PROBLEM, SESSION, [
    receipts[0]!,
    receipts[1]!,
    { transportStatus: "COMPLETE", text: "not json" },
  ], options);
  assert.equal(malformed.summary.repairRecorded, false);
  assert.equal(malformed.summary.finalResponse, "x=1");
  assert.equal(malformed.summary.modelCalls, 3);

  const ticks = [0, 10, 5];
  let tick = 0;
  const rewound = runP4RepairFixture(PROBLEM, SESSION, receipts, {
    ...options,
    now: () => ticks[Math.min(tick++, ticks.length - 1)]!,
  });
  assert.equal(rewound.summary.status, "unsolved");
  assert.ok(rewound.summary.modelCalls <= 3);
  assert.equal(rewound.summary.repairRecorded, false);
});
