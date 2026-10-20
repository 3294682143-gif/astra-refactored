import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4ReviewSession } from "@astra/math-review";
import { P4CandidateGate } from "@astra/math-audit";
import {
  P2Error,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  p4Target,
  type P2Artifact,
  type P2Contract,
  type P4Binding,
  type P4ReviewReport,
  type P4ReviewSnapshot,
  type P4Target,
} from "@astra/protocol";
import { runP4Fixture } from "../src/p4-fixture.js";
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
const DERIVATION = "😀 Divide by x. Then x=1.";
const CLAIM = "x=1 only";

interface Built {
  readonly contract: P2Contract;
  readonly artifact: P2Artifact;
  readonly target: P4Target;
  readonly binding: P4Binding;
  readonly obligationIds: readonly string[];
}

function build(patch: Record<string, unknown> = {}, artifactPatch: Record<string, unknown> = {}): Built {
  const contract = compileP2Contract(PROBLEM, SESSION);
  const ledger = new ContractLedger(contract);
  const task = ledger
    .readyTasks()
    .find((row) => {
      const obligation = contract.obligations.find((item) => item.obligationId === row.obligationId);
      return obligation !== undefined && obligation.kind === "CANDIDATE_VALIDITY";
    });
  assert.ok(task !== undefined);
  const running = ledger.startTask(task.taskId);
  const store = new P2WorkunitStore(ledger.snapshot());
  store.registerRoute(ROUTE);
  const packet = {
    schemaVersion: "p2a-work-v1",
    sessionId: contract.envelope.sessionId,
    problemHash: contract.problemHash,
    contractVersion: contract.contractVersion,
    taskId: running.taskId,
    goalId: running.goalId,
    scopeId: running.scopeId,
    routeId: "route-1",
    sourceRequestId: "model-1",
    claim: CLAIM,
    derivation: DERIVATION,
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: ["PRIVATE_SELF_ASSESSMENT"],
    deliveryStatus: "COMPLETE",
    candidateProposal: "x=1",
    ...patch,
  };
  const artifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-1",
    transportStatus: "COMPLETE",
    text: JSON.stringify(packet),
    eventSeq: ledger.nextEventSeq(),
    supersedes: null,
    ...artifactPatch,
  });
  const target = p4Target(ledger.snapshot(), artifact, "ACTIVE");
  const obligationIds = contract.obligations
    .filter(
      (item) =>
        item.goalId === target.binding.goalId && item.envelope.scopeId === target.binding.scopeId,
    )
    .map((item) => item.obligationId);
  return { contract, artifact, target, binding: target.binding, obligationIds };
}

function locatorOf(quote: string): { start: number; end: number; quote: string } {
  const chars = [...DERIVATION];
  const start = chars.findIndex((_, index) => chars.slice(index, index + [...quote].length).join("") === quote);
  assert.ok(start >= 0, "quote must exist in the derivation");
  return { start, end: start + [...quote].length, quote };
}

function issue(quote: string, obligationIds: readonly string[], patch: Record<string, unknown> = {}) {
  return {
    stepLocator: locatorOf(quote),
    suspectedIssue: "ZERO_DIVISOR",
    rationale: "division by a possibly zero factor",
    requestedCheck: "check the zero branch",
    obligationIds,
    ...patch,
  };
}

function report(
  built: Built,
  requestId: string,
  conclusion: "NO_ISSUE" | "ISSUES" | "UNKNOWN",
  coverage: readonly string[],
  issues: readonly unknown[],
  patch: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: "p4-review-v1",
    requestId,
    target: built.binding,
    targetHash: built.target.targetHash,
    stage: "R2",
    conclusion,
    reviewCoverage: coverage,
    issues,
    ...patch,
  });
}

function issuesReport(built: Built, requestId: string, quote = "Divide by x."): string {
  return report(built, requestId, "ISSUES", built.obligationIds, [issue(quote, built.obligationIds)]);
}

function noIssueReport(built: Built, requestId: string): string {
  return report(built, requestId, "NO_ISSUE", built.obligationIds, []);
}

function unknownReport(built: Built, requestId: string): string {
  return report(built, requestId, "UNKNOWN", [], []);
}

function settle(
  session: P4ReviewSession,
  requestId: string,
  text: string,
  transport: "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN" = "COMPLETE",
  remainingMs = 1000,
) {
  session.admit(requestId, 1000);
  session.markDispatched(requestId);
  return session.settle(requestId, transport, text, remainingMs);
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (error: unknown) => error instanceof P2Error && error.code === code,
  );
}

test("p4Target guards reject malformed inputs without mutating the artifact", () => {
  const built = build();
  assert.equal(Object.isFrozen(built.target), true);
  assert.equal(Object.isFrozen(built.target.binding), true);
  assert.equal(p4JsonEqual(built.target.binding, { ...built.target.binding }), true);
  assert.equal(p4JsonEqual(built.target.binding, { ...built.target.binding, taskId: "other" }), false);
  const before = p2Snapshot(built.artifact);
  const cases: readonly [string, () => unknown][] = [
    ["PACKET_BINDING", () => p4Target(built.contract, { ...built.artifact, level: "REVIEWED" } as unknown as P2Artifact)],
    ["PACKET_BINDING", () => p4Target(built.contract, { ...built.artifact, checkResult: "PASS" } as unknown as P2Artifact)],
    ["PACKET_DELIVERY", () => p4Target(built.contract, { ...built.artifact, deliveryStatus: "INCOMPLETE" } as unknown as P2Artifact)],
    ["PACKET_BINDING", () => p4Target(built.contract, { ...built.artifact, rawResponseHash: "0".repeat(64) } as unknown as P2Artifact)],
    ["PACKET_BINDING", () => p4Target(built.contract, { ...built.artifact, rawResponseText: "{}" } as unknown as P2Artifact)],
    ["UNKNOWN_DEPENDENCY", () => p4Target(built.contract, { ...built.artifact, dependencies: [{ artifactId: "x", artifactVersion: 1 }] } as unknown as P2Artifact)],
    ["SCOPE_MISMATCH", () => p4Target(built.contract, { ...built.artifact, scope: { ...built.artifact.scope, scopeId: "other" } } as unknown as P2Artifact)],
    ["VERSION_MISMATCH", () => p4Target({ ...built.contract, contractVersion: built.contract.contractVersion + 1 }, built.artifact)],
    ["PACKET_BINDING", () => p4Target({ ...built.contract, envelope: { ...built.contract.envelope, sourceModule: "M3" } } as P2Contract, built.artifact)],
    ["PACKET_BINDING", () => {
      const clone = { ...built.artifact, envelope: { ...built.artifact.envelope } } as unknown as Record<string, unknown>;
      delete (clone.envelope as Record<string, unknown>).taskId;
      return p4Target(built.contract, clone as unknown as P2Artifact);
    }],
    ["PACKET_BINDING", () => p4Target(built.contract, { ...built.artifact, envelope: { ...built.artifact.envelope, artifactId: "other" } } as unknown as P2Artifact)],
  ];
  for (const [code, fn] of cases) {
    expectCode(fn, code);
  }
  assert.equal(p4JsonEqual(p2Snapshot(built.artifact), before), true);
});

test("p4Target rejects a self-added scope assumption and a boolean version", () => {
  const built = build();
  const scope = { ...built.artifact.scope, localAssumptions: [...built.artifact.scope.localAssumptions, "x!=0"] };
  expectCode(() => p4Target(built.contract, { ...built.artifact, scope } as unknown as P2Artifact), "SCOPE_MISMATCH");
  expectCode(
    () => p4Target(built.contract, { ...built.artifact, envelope: { ...built.artifact.envelope, artifactVersion: true } } as unknown as P2Artifact),
    "VERSION_MISMATCH",
  );
});

test("a real multi-codepoint quote is accepted while malformed reports are rejected", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 2);
  const emoji = settle(session, "model-2", issuesReport(built, "model-2", "😀 Divide by x."));
  assert.equal(emoji.code, "OK");
  assert.equal(emoji.report?.issues[0]?.stepLocator.quote, "😀 Divide by x.");
  assert.equal(emoji.report?.issues[0]?.stepLocator.start, 0);

  // Real models often copy the exact quote but miscount code-point offsets.
  // A unique quote is re-anchored to its one real occurrence; an absent or
  // ambiguous quote remains fail-closed.
  const recovered = settle(
    new P4ReviewSession(built.contract, built.target, 2),
    "model-2",
    report(built, "model-2", "ISSUES", built.obligationIds, [
      issue("Divide by x.", built.obligationIds, {
        stepLocator: { start: 1, end: 2, quote: "Divide by x." },
      }),
    ]),
  );
  assert.equal(recovered.code, "OK");
  assert.equal(recovered.report?.issues[0]?.stepLocator.start, 2);
  assert.equal(recovered.report?.issues[0]?.stepLocator.end, 14);

  const bad: readonly [string, string][] = [
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", built.obligationIds, [issue("x", built.obligationIds, { stepLocator: { start: 0, end: 1, quote: "x" } })])],
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds, { stepLocator: { start: 0, end: 3, quote: "zzz" } })])],
    ["PACKET_BINDING", report(built, "model-9", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds)])],
    ["PACKET_BINDING", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds)], { targetHash: "0".repeat(64) })],
    ["PACKET_BINDING", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds)], { target: { ...built.binding, artifactVersion: 2 } })],
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", ["missing"], [issue("Divide by x.", built.obligationIds)])],
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds)], { verified: true })],
    ["PACKET_SCHEMA", report(built, "model-2", "NO_ISSUE", [], [])],
    ["PACKET_SCHEMA", report(built, "model-2", "UNKNOWN", [], [issue("Divide by x.", built.obligationIds)])],
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", built.obligationIds, { suspectedIssue: "MADE_UP" })])],
    ["PACKET_SCHEMA", report(built, "model-2", "ISSUES", built.obligationIds, [issue("Divide by x.", ["missing"])])],
  ];
  for (const [code, text] of bad) {
    const fresh = new P4ReviewSession(built.contract, built.target, 1);
    const record = settle(fresh, "model-2", text);
    assert.equal(record.code, "INVALID_REPORT");
    assert.equal(record.report, null);
    assert.equal(record.rawResponseText, text);
    assert.equal(record.state, "RETURNED");
    assert.equal(code.length > 0, true);
  }
});

test("strict JSON guards reject duplicate keys, floats, unsafe numbers, lone surrogates and depth", () => {
  const built = build();
  const base = issuesReport(built, "model-2");
  const duplicate = base.replace('"stage":"R2"', '"stage":"R2","stage":"R2"');
  const float = base.replace('"start":2', '"start":2.5');
  const unsafe = base.replace('"start":2', '"start":9007199254740993');
  const lone = base.replace("Divide by x.", "Divide by \\ud800x.");
  const deep = `{"a":${"[".repeat(40)}0${"]".repeat(40)}}`;
  assert.notEqual(float, base);
  assert.notEqual(unsafe, base);
  assert.notEqual(lone, base);
  for (const text of [duplicate, float, unsafe, lone, deep, "", "   "]) {
    const fresh = new P4ReviewSession(built.contract, built.target, 1);
    const record = settle(fresh, "model-2", text);
    assert.equal(record.code, "INVALID_REPORT");
    assert.equal(record.report, null);
  }
});

test("review session enforces the cap, the 26/25ms boundary and atomic replay rejection", () => {
  const built = build();
  const zero = new P4ReviewSession(built.contract, built.target, 0);
  expectCode(() => zero.admit("model-2", 1000), "BUDGET_EXHAUSTED");
  const session = new P4ReviewSession(built.contract, built.target, 2);
  expectCode(() => session.admit("model-2", 25), "BOUND_EXCEEDED");
  expectCode(() => session.admit("model-2", 3600001), "BOUND_EXCEEDED");
  const admitted = session.admit("model-2", 26);
  assert.equal(admitted.state, "ADMITTED");
  assert.equal(admitted.code, "NOT_DISPATCHED");
  const before = p2Snapshot(session.snapshot());
  expectCode(() => session.markDispatched("model-3"), "ILLEGAL_TRANSITION");
  expectCode(() => session.settle("model-2", "COMPLETE", "{}", 1000), "ILLEGAL_TRANSITION");
  assert.equal(p4JsonEqual(p2Snapshot(session.snapshot()), before), true);
  session.markDispatched("model-2");
  const settled = session.settle("model-2", "COMPLETE", issuesReport(built, "model-2"), 1000);
  assert.equal(settled.code, "OK");
  const after = p2Snapshot(session.snapshot());
  expectCode(() => session.markDispatched("model-2"), "ILLEGAL_TRANSITION");
  expectCode(() => session.settle("model-2", "COMPLETE", "{}", 1000), "ILLEGAL_TRANSITION");
  assert.equal(p4JsonEqual(p2Snapshot(session.snapshot()), after), true);
});

test("two reports with the same step and kind but different rationale merge into one challenge", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 2);
  const first = settle(session, "model-2", issuesReport(built, "model-2"));
  assert.equal(first.code, "OK");
  const second = settle(
    session,
    "model-3",
    report(built, "model-3", "ISSUES", built.obligationIds, [
      issue("Divide by x.", built.obligationIds, { rationale: "a different wording" }),
    ]),
  );
  assert.equal(second.code, "OK");
  const snapshot = session.snapshot();
  assert.equal(snapshot.challenges.length, 1);
  assert.deepEqual([...snapshot.challenges[0]!.requestIds], ["model-2", "model-3"]);
  assert.equal(snapshot.challenges[0]!.status, "CHALLENGED");
  assert.equal(snapshot.challenges[0]!.availability, "ACTIVE");
  assert.equal(snapshot.evidence.length, 2);
  for (const row of snapshot.evidence) {
    assert.equal(row.source, "MODEL_REVIEW");
    assert.equal(row.level, "REVIEWED");
    assert.equal(row.checkResult, "UNKNOWN");
  }
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.challenges), true);
  assert.equal(Object.isFrozen(snapshot.challenges[0]), true);
  assert.equal(Object.isFrozen(snapshot.challenges[0]!.issue), true);
});

test("a duplicated issue inside one report is deduplicated and the context excludes private fields", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 1);
  const duplicated = report(built, "model-2", "ISSUES", built.obligationIds, [
    issue("Divide by x.", built.obligationIds),
    issue("Divide by x.", built.obligationIds, { rationale: "second wording" }),
  ]);
  const record = settle(session, "model-2", duplicated);
  assert.equal(record.code, "OK");
  assert.equal(session.snapshot().challenges.length, 1);
  const serialized = JSON.stringify(record.context.messages);
  assert.equal(record.context.contextBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(record.context.contextHash, p4Hash(serialized));
  assert.equal(record.context.messages.length, 2);
  assert.equal(record.context.messages[0]!.role, "system");
  assert.equal(record.context.messages[1]!.role, "user");
  const user = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(user.problemFullText, PROBLEM);
  assert.equal(user.claim, CLAIM);
  assert.equal(user.derivation, DERIVATION);
  assert.equal(user.targetHash, built.target.targetHash);
  for (const forbidden of ["PRIVATE_SELF_ASSESSMENT", "candidateProposal", "rawResponseText", "suggestedChecks", "second wording"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("invalid, unknown, truncated, error, blank and late settlements keep the raw text and block new admits", () => {
  const built = build();
  const cases: readonly [string, "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN", number][] = [
    ["not json", "COMPLETE", 1000],
    [unknownReport(built, "model-2"), "COMPLETE", 1000],
    [issuesReport(built, "model-2"), "TRUNCATED", 1000],
    [issuesReport(built, "model-2"), "ERROR", 1000],
    ["   ", "COMPLETE", 1000],
    [issuesReport(built, "model-2"), "COMPLETE", 25],
  ];
  for (const [text, transport, remaining] of cases) {
    const session = new P4ReviewSession(built.contract, built.target, 2);
    const record = settle(session, "model-2", text, transport, remaining);
    if (text === unknownReport(built, "model-2")) {
      assert.equal(record.report?.conclusion, "UNKNOWN");
    } else {
      assert.equal(record.report, null);
    }
    assert.equal(record.rawResponseText, text);
    assert.equal(session.snapshot().evidence[0]!.level, "PROVISIONAL");
    assert.equal(session.snapshot().evidence[0]!.checkResult, "UNKNOWN");
    expectCode(() => session.admit("model-3", 1000), "ILLEGAL_TRANSITION");
  }
  const unknownLate = new P4ReviewSession(built.contract, built.target, 1);
  const late = settle(unknownLate, "model-2", "raw", "UNKNOWN", 25);
  assert.equal(late.state, "OUTCOME_UNKNOWN");
  assert.equal(late.code, "OUTCOME_UNKNOWN");
  assert.equal(late.report, null);
});

test("a legal UNKNOWN report stays PROVISIONAL and markStale never refutes", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 2);
  const record = settle(session, "model-2", unknownReport(built, "model-2"));
  assert.equal(record.code, "OK");
  assert.equal(record.report?.conclusion, "UNKNOWN");
  assert.equal(session.snapshot().evidence[0]!.level, "PROVISIONAL");
  assert.equal(session.snapshot().evidence[0]!.checkResult, "UNKNOWN");
  assert.equal(session.snapshot().challenges.length, 0);
  const pending = new P4ReviewSession(built.contract, built.target, 1);
  pending.admit("model-2", 1000);
  expectCode(() => pending.markStale(), "ILLEGAL_TRANSITION");
  session.markStale();
  const stale = session.snapshot();
  assert.equal(stale.availability, "STALE");
  assert.equal(stale.evidence[0]!.availability, "STALE");
  assert.equal(stale.evidence[0]!.checkResult, "UNKNOWN");
  expectCode(() => session.admit("model-3", 1000), "ILLEGAL_TRANSITION");
  const clean = new P4ReviewSession(built.contract, built.target, 2);
  assert.equal(settle(clean, "model-2", noIssueReport(built, "model-2")).code, "OK");
  clean.markStale();
  expectCode(() => clean.admit("model-3", 1000), "STALE_DEPENDENCY");
});

test("the candidate gate protects the first candidate and never replaces it", () => {
  const built = build();
  const gate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  assert.equal(gate.protect(built.target), true);
  assert.equal(gate.protect(built.target), true);
  const other = build({}, { artifactId: "artifact-2" });
  assert.equal(gate.protect(other.target), false);
  const decision = gate.finalize(built.contract, built.target, null, 1000);
  assert.equal(decision.status, "candidate");
  assert.equal(decision.finalResponse, "x=1");
  assert.equal(decision.candidateVerified, false);
  assert.equal(decision.strictAcceptance, "NOT_PERFORMED");
  assert.equal(decision.submissionEligibility, "BEST_EFFORT");
  assert.equal(decision.reason, "BEST_EFFORT_CANDIDATE");
  assert.equal(decision.protectedCandidate?.artifactId, "artifact-1");
  assert.equal(decision.openObligations, built.contract.obligations.length);
  for (const row of decision.coverage) {
    assert.equal(row.checkResult, "UNKNOWN");
  }
});

test("two NO_ISSUE reviews never verify, PASS or satisfy anything", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 2);
  assert.equal(settle(session, "model-2", noIssueReport(built, "model-2")).code, "OK");
  assert.equal(settle(session, "model-3", noIssueReport(built, "model-3")).code, "OK");
  const gate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  gate.protect(built.target);
  const decision = gate.finalize(built.contract, built.target, session.snapshot(), 1000);
  assert.equal(decision.status, "candidate");
  assert.equal(decision.finalResponse, "x=1");
  assert.equal(decision.candidateVerified, false);
  assert.equal(decision.strictAcceptance, "NOT_PERFORMED");
  assert.equal(decision.unresolvedChallenges, 0);
  for (const row of decision.coverage) {
    assert.equal(row.checkResult, "UNKNOWN");
    assert.notEqual(row.checkResult, "PASS");
  }
  for (const obligation of built.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
});

test("S3 strict, stale and forged review cannot upgrade", () => {
  const built = build();
  const session = new P4ReviewSession(built.contract, built.target, 2);
  assert.equal(settle(session, "model-2", noIssueReport(built, "model-2")).code, "OK");
  assert.equal(settle(session, "model-3", noIssueReport(built, "model-3")).code, "OK");
  const strict = new P4CandidateGate(built.contract, "STRICT");
  strict.protect(built.target);
  const strictDecision = strict.finalize(built.contract, built.target, session.snapshot(), 1000);
  assert.equal(strictDecision.status, "unsolved");
  assert.equal(strictDecision.candidateVerified, false);
  assert.equal(strictDecision.submissionEligibility, "WITHHELD");
  assert.equal(strictDecision.reason, "STRICT_NOT_VERIFIED");
  for (const row of strictDecision.coverage) {
    assert.equal(row.checkResult, "UNKNOWN");
  }

  const staleGate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  staleGate.protect(built.target);
  const staleTarget = { ...built.target, availability: "STALE" } as unknown as P4Target;
  const staleDecision = staleGate.finalize(built.contract, staleTarget, session.snapshot(), 1000);
  assert.equal(staleDecision.status, "unsolved");
  assert.equal(staleDecision.submissionEligibility, "WITHHELD");
  assert.equal(staleDecision.reason, "STALE_CANDIDATE");

  const bumped = {
    ...built.contract,
    contractVersion: built.contract.contractVersion + 1,
    envelope: { ...built.contract.envelope, contractVersion: built.contract.contractVersion + 1 },
  } as P2Contract;
  const bumpedDecision = staleGate.finalize(bumped, built.target, session.snapshot(), 1000);
  assert.equal(bumpedDecision.status, "unsolved");
  assert.equal(bumpedDecision.reason, "STALE_CANDIDATE");

  const zeroGate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  zeroGate.protect(built.target);
  const zeroDecision = zeroGate.finalize(built.contract, built.target, session.snapshot(), 0);
  assert.equal(zeroDecision.status, "unsolved");
  assert.equal(zeroDecision.submissionEligibility, "WITHHELD");
  assert.equal(zeroDecision.reason, "DEADLINE_EXCEEDED");
  const lateDecision = zeroGate.finalize(built.contract, built.target, session.snapshot(), 25);
  assert.equal(lateDecision.status, "candidate");
  assert.equal(lateDecision.reason, "BEST_EFFORT_CANDIDATE");

  const forged = structuredClone(session.snapshot()) as unknown as Record<string, unknown>;
  const forgedEvidence = (forged.evidence as Record<string, unknown>[])[0]!;
  forgedEvidence.level = "CHECKED_SCOPE";
  expectCode(() => zeroGate.finalize(built.contract, built.target, forged as unknown as P4ReviewSnapshot, 1000), "PACKET_SCHEMA");
  const forgedPass = structuredClone(session.snapshot()) as unknown as Record<string, unknown>;
  (forgedPass.evidence as Record<string, unknown>[])[0]!.checkResult = "PASS";
  expectCode(() => zeroGate.finalize(built.contract, built.target, forgedPass as unknown as P4ReviewSnapshot, 1000), "PACKET_BINDING");

  const issueSession = new P4ReviewSession(built.contract, built.target, 2);
  assert.equal(settle(issueSession, "model-2", issuesReport(built, "model-2")).code, "OK");
  const forgedStatus = structuredClone(issueSession.snapshot()) as unknown as Record<string, unknown>;
  (forgedStatus.challenges as Record<string, unknown>[])[0]!.status = "CONFIRMED";
  expectCode(() => zeroGate.finalize(built.contract, built.target, forgedStatus as unknown as P4ReviewSnapshot, 1000), "PACKET_SCHEMA");
  const dropped = structuredClone(issueSession.snapshot()) as unknown as Record<string, unknown>;
  dropped.challenges = [];
  expectCode(() => zeroGate.finalize(built.contract, built.target, dropped as unknown as P4ReviewSnapshot, 1000), "PACKET_BINDING");
  const before = p2Snapshot(zeroGate.snapshot());
  expectCode(() => zeroGate.finalize(built.contract, built.target, dropped as unknown as P4ReviewSnapshot, 1000), "PACKET_BINDING");
  assert.equal(p4JsonEqual(p2Snapshot(zeroGate.snapshot()), before), true);

  const merged = new P4ReviewSession(built.contract, built.target, 1);
  const duplicated = report(built, "model-2", "ISSUES", built.obligationIds, [
    issue("Divide by x.", built.obligationIds),
    issue("Divide by x.", built.obligationIds, { rationale: "second wording" }),
  ]);
  assert.equal(settle(merged, "model-2", duplicated).code, "OK");
  const mergedGate = new P4CandidateGate(built.contract, "BEST_EFFORT");
  mergedGate.protect(built.target);
  const mergedDecision = mergedGate.finalize(built.contract, built.target, merged.snapshot(), 1000);
  assert.equal(mergedDecision.status, "candidate");
  assert.equal(mergedDecision.unresolvedChallenges, 1);
});

test("P4 fixture composes five modules under one budget", () => {
  const built = build();
  const receipts: readonly P4FixtureReceipt[] = [
    { transportStatus: "COMPLETE", text: built.artifact.rawResponseText },
    { transportStatus: "COMPLETE", text: issuesReport(built, "model-2") },
    { transportStatus: "COMPLETE", text: issuesReport(built, "model-3") },
  ];
  const options = {
    maxModelCalls: 3,
    maxReviews: 2,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
  };
  const result = runP4Fixture(PROBLEM, SESSION, receipts, options);
  assert.equal(result.summary.modelCalls, 3);
  assert.equal(result.summary.reviewCalls, 2);
  assert.equal(result.summary.unresolvedChallenges, 1);
  assert.equal(result.summary.finalResponse, "x=1");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
  const privateState = result.privateState as unknown as Record<string, unknown>;
  for (const obligation of (privateState.contract as P2Contract).obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  for (const request of privateState.requests as readonly Record<string, unknown>[]) {
    const messages = request.messages as readonly { role: string; content: string }[];
    const serialized = JSON.stringify(messages);
    assert.equal(request.contextHash, p4Hash(serialized));
    assert.equal(request.contextBytes, Buffer.byteLength(serialized, "utf8"));
  }
  const publicText = JSON.stringify(result.summary);
  assert.equal(publicText.includes(DERIVATION), false);
  assert.equal(publicText.includes("PRIVATE_SELF_ASSESSMENT"), false);

  const strictResult = runP4Fixture(PROBLEM, SESSION, receipts, { ...options, policy: "STRICT" });
  assert.equal(strictResult.summary.status, "unsolved");
  assert.equal(strictResult.summary.candidateVerified, false);

  for (const cap of [0, 1, 2]) {
    const capped = runP4Fixture(PROBLEM, SESSION, receipts, { ...options, maxModelCalls: cap });
    assert.ok(capped.summary.modelCalls <= cap);
  }

  const unknownReview = runP4Fixture(PROBLEM, SESSION, [
    receipts[0]!,
    { transportStatus: "COMPLETE", text: unknownReport(built, "model-2") },
  ], options);
  assert.equal(unknownReview.summary.modelCalls, 2);
  assert.equal(unknownReview.summary.status, "candidate");
  assert.equal(unknownReview.summary.finalResponse, "x=1");

  const ticks = [0, 10, 5];
  let tick = 0;
  const rewound = runP4Fixture(PROBLEM, SESSION, receipts, {
    ...options,
    now: () => ticks[Math.min(tick++, ticks.length - 1)]!,
  });
  assert.equal(rewound.summary.status, "unsolved");
  assert.ok(rewound.summary.modelCalls <= 3);

  const noReview = runP4Fixture(PROBLEM, SESSION, receipts, { ...options, maxReviews: 0 });
  assert.equal(noReview.summary.modelCalls, 1);
  assert.equal(noReview.summary.reviewCalls, 0);

  const invalidWork = runP4Fixture(PROBLEM, SESSION, [
    { transportStatus: "COMPLETE", text: "not json" },
  ], options);
  assert.equal(invalidWork.summary.status, "unsolved");
});
