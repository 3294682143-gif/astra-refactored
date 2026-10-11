import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ContractLedger, compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { validateP4R0Input } from "@astra/math-review";
import { P2Error, p4Hash, type P2GoalKind, type P4R0Preparation } from "@astra/protocol";

import { makeR0, makeR0Default, r0Report, type Mutable } from "./p4-r0-fixtures.js";

const ALL_PROBLEM = "😀 Find all real solutions x(x-1)=0";
const VALUE_PROBLEM = "😀 Compute 1+1";
const ZERO_PROBLEM = "求x(x−1)=0的全部实数解";

function rejects(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof P2Error && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

const GOOD_OPTIONS = {
  enabled: true,
  planningModelCalls: 1,
  remainingRootCalls: 3,
  remainingMs: 1000,
} as const;

function rehash(prep: Mutable<P4R0Preparation>): Mutable<P4R0Preparation> {
  const next = clone(prep);
  const contract = next.target.contract;
  const planText = JSON.stringify({
    goals: contract.goals,
    obligations: contract.obligations,
    tasks: contract.tasks,
    riskHints: contract.riskHints,
  });
  const planHash = p4Hash(JSON.stringify(contract));
  return {
    ...next,
    target: { ...next.target, planText, binding: { ...next.target.binding, planHash } },
  };
}

test("group 1: goal kinds, risk codes and M1 policy", () => {
  const expected: readonly (readonly [P2GoalKind, readonly string[]])[] = [
    ["VALUE", []],
    ["ALL_SOLUTIONS", ["BRANCH_COVERAGE", "EXPLICIT_RISK_HINT"]],
    ["COUNT", ["COUNT_COVERAGE", "EXPLICIT_RISK_HINT"]],
    ["OPTIMIZATION", ["BOUND_ATTAINMENT", "EXPLICIT_RISK_HINT"]],
    ["PROOF", ["PROOF_PREMISES", "EXPLICIT_RISK_HINT"]],
    ["MULTIPART", ["MULTIPART_COVERAGE", "EXPLICIT_RISK_HINT"]],
    ["UNKNOWN", ["UNKNOWN_GOAL", "EXPLICIT_RISK_HINT"]],
  ];
  for (const [kind, codes] of expected) {
    const prep = makeR0(kind);
    assert.deepEqual(prep.riskCodes, codes);
    assert.equal(prep.structuralMatch, true);
    assert.equal(prep.semanticResult, "UNKNOWN");
    assert.equal(prep.canSupportObligation, false);
    assert.equal(prep.action, codes.length === 0 ? "SKIPPED_BY_POLICY" : "REQUEST_REVIEW");
  }
  const disabled = makeR0("ALL_SOLUTIONS", { enabled: false });
  assert.equal(disabled.action, "SKIPPED_BY_POLICY");
  const defaulted = makeR0Default("ALL_SOLUTIONS");
  assert.equal(defaulted.action, "SKIPPED_BY_POLICY");
  assert.equal(defaulted.planningModelCalls, 0);
  const value = makeR0("VALUE");
  assert.equal(value.action, "SKIPPED_BY_POLICY");
  const hinted = prepareP4R0(compileP2Contract(ZERO_PROBLEM, "r0"), {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 3,
    remainingMs: 1000,
  });
  assert.deepEqual(hinted.riskCodes, ["BRANCH_COVERAGE", "EXPLICIT_RISK_HINT"]);
  assert.equal(hinted.target.contract.riskHints.length > 0, true);
  for (const goal of hinted.target.contract.goals) {
    assert.deepEqual(goal.scope.localAssumptions, []);
  }
});

test("group 2: budget policy and option rejection", () => {
  const insufficient: readonly Partial<Parameters<typeof makeR0>[1]>[] = [
    { planningModelCalls: 0 },
    { remainingRootCalls: 0 },
    { remainingRootCalls: 1 },
    { remainingMs: 0 },
    { remainingMs: 25 },
  ];
  for (const override of insufficient) {
    assert.equal(makeR0("ALL_SOLUTIONS", override).action, "INSUFFICIENT_BUDGET");
  }
  assert.equal(makeR0("ALL_SOLUTIONS", { remainingMs: 26, remainingRootCalls: 2 }).action, "REQUEST_REVIEW");
  const contract = compileP2Contract(ALL_PROBLEM, "r0");
  const bad: readonly unknown[] = [
    { enabled: true, planningModelCalls: 1, remainingMs: 1000 },
    { enabled: true, planningModelCalls: 1, remainingRootCalls: 3 },
    { enabled: "yes", planningModelCalls: 1, remainingRootCalls: 3, remainingMs: 1000 },
    { enabled: true, planningModelCalls: Number.NaN, remainingRootCalls: 3, remainingMs: 1000 },
    { enabled: true, planningModelCalls: 1, remainingRootCalls: 3, remainingMs: null },
    { enabled: true, planningModelCalls: 1, remainingRootCalls: 5, remainingMs: 1000 },
    { enabled: true, planningModelCalls: 2, remainingRootCalls: 3, remainingMs: 1000 },
    { enabled: true, planningModelCalls: 1, remainingRootCalls: 3, remainingMs: 1000, extra: 1 },
  ];
  const before = JSON.stringify(contract);
  for (const options of bad) {
    rejects(() => prepareP4R0(contract, options as never), "PACKET_SCHEMA");
  }
  assert.equal(JSON.stringify(contract), before);
  const skipped = makeR0("ALL_SOLUTIONS", { enabled: false });
  assert.equal(skipped.action, "SKIPPED_BY_POLICY");
  assert.equal(validateP4R0Input(skipped).action, "SKIPPED_BY_POLICY");
  assert.equal(skipped.semanticResult, "UNKNOWN");
  assert.equal(skipped.canSupportObligation, false);
});

test("group 3: tampered M1 material is rejected, not repaired", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const variants: readonly ((value: Mutable<P4R0Preparation>) => void)[] = [
    (value) => {
      value.target.contract.obligations.pop();
    },
    (value) => {
      value.target.contract.tasks.pop();
    },
    (value) => {
      value.target.contract.problemHash = "0".repeat(64);
    },
    (value) => {
      value.target.contract.goals[0]!.scope.domain = "R";
    },
    (value) => {
      value.target.contract.tasks[0]!.expectedResult = "changed";
    },
    (value) => {
      value.target.contract.tasks[0]!.dependencyTaskIds = [value.target.contract.tasks[0]!.taskId];
    },
    (value) => {
      value.target.contract.tasks[0]!.dependencyTaskIds = ["ghost"];
    },
    (value) => {
      value.target.contract.obligations[0]!.acceptance = {
        mode: "MOCK_ONLY",
        sourceModule: "M5",
        sessionId: "r0",
        problemHash: value.target.contract.problemHash,
        contractVersion: 1,
        goalId: value.target.contract.obligations[0]!.goalId,
        scopeId: value.target.contract.obligations[0]!.envelope.scopeId!,
        policy: "mock",
        evidenceRefs: [],
      };
    },
    (value) => {
      value.target.contract.riskHints = ["injected"];
    },
    (value) => {
      value.target.contract.envelope.sourceModule = "M4";
    },
  ];
  for (const mutate of variants) {
    const broken = clone(prep);
    mutate(broken);
    rejects(() => prepareP4R0(broken.target.contract, GOOD_OPTIONS), "PACKET_BINDING");
  }
  const ledger = new ContractLedger(compileP2Contract(ALL_PROBLEM, "r0"));
  ledger.startTask(ledger.readyTasks()[0]!.taskId);
  const running = clone(prep);
  running.target.contract.tasks = ledger.snapshot().tasks as never;
  rejects(() => prepareP4R0(running.target.contract, GOOD_OPTIONS), "PACKET_BINDING");

  const reordered = clone(prep);
  const first = reordered.target.contract.tasks[0]!;
  reordered.target.contract.tasks[0] = {
    delivery: first.delivery,
    acceptanceCriteria: first.acceptanceCriteria,
    expectedResult: first.expectedResult,
    dependencyTaskIds: first.dependencyTaskIds,
    inputArtifactRefs: first.inputArtifactRefs,
    scopeId: first.scopeId,
    obligationId: first.obligationId,
    goalId: first.goalId,
    taskId: first.taskId,
    envelope: first.envelope,
  } as never;
  const accepted = prepareP4R0(reordered.target.contract, GOOD_OPTIONS);
  assert.equal(accepted.target.binding.planHash, p4Hash(JSON.stringify(reordered.target.contract)));
  assert.notEqual(accepted.target.binding.planHash, prep.target.binding.planHash);

  const swapped = clone(prep);
  swapped.target.contract.tasks = [...swapped.target.contract.tasks].reverse() as never;
  rejects(() => prepareP4R0(swapped.target.contract, GOOD_OPTIONS), "PACKET_BINDING");

  const versioned = compileP2Contract(ALL_PROBLEM, "r0", undefined, 2, 2);
  const versionedPrep = prepareP4R0(versioned, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 3,
    remainingMs: 1000,
  });
  assert.equal(validateP4R0Input(versionedPrep).target.binding.contractVersion, 2);
});

test("group 4: M4 input re-derives bindings instead of trusting hashes", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const variants: readonly ((value: Mutable<P4R0Preparation>) => void)[] = [
    (value) => {
      value.target.contract.goals[0]!.goalId = "goal-2";
    },
    (value) => {
      value.target.contract.tasks[0]!.obligationId = "ghost";
    },
    (value) => {
      value.target.contract.envelope.eventSeq = 9;
    },
    (value) => {
      value.target.contract.envelope.sourceModule = "M4";
    },
    (value) => {
      value.target.contract.obligations[0]!.status = "SATISFIED";
    },
    (value) => {
      value.target.contract.obligations[0]!.kind = "NOT_AN_OBLIGATION" as never;
    },
    (value) => {
      value.remainingRootCalls = 5;
    },
    (value) => {
      value.action = "BAD" as never;
    },
    (value) => {
      value.action = "REQUEST_REVIEW";
      value.planningModelCalls = 0;
    },
    (value) => {
      value.structuralMatch = false as never;
    },
    (value) => {
      value.canSupportObligation = true as never;
    },
  ];
  for (const mutate of variants) {
    const broken = clone(prep);
    mutate(broken);
    rejects(() => validateP4R0Input(rehash(broken) as P4R0Preparation), "PACKET_BINDING");
  }
  const planTampered = clone(prep);
  planTampered.target.planText = "{}";
  rejects(() => validateP4R0Input(planTampered as P4R0Preparation), "PACKET_BINDING");
  const consistent = rehash(clone(prep));
  assert.equal(validateP4R0Input(consistent).target.binding.planHash, consistent.target.binding.planHash);
  const report = JSON.parse(r0Report(prep)) as Record<string, unknown>;
  assert.equal(report.conclusion, "NO_ISSUE");
  assert.equal(report.requestId, "model-1");
  assert.equal(report.stage, "R0");
  assert.equal((report.checks as readonly unknown[]).length, 3);
  assert.equal(prep.semanticResult, "UNKNOWN");
  assert.equal(prep.canSupportObligation, false);
  assert.equal(VALUE_PROBLEM.length > 0, true);
});

test("group 5: risk-hint bound is enforced by M1 before M4 sees it", () => {
  const problem = "Find all real solutions " + "x(x-1)=0 ".repeat(33);
  const contract = compileP2Contract(problem, "r0");
  assert.equal(contract.riskHints.length, 33);
  rejects(() => prepareP4R0(contract, GOOD_OPTIONS), "BOUND_EXCEEDED");

  const bounded = compileP2Contract("Find all real solutions " + "x(x-1)=0 ".repeat(32), "r0");
  assert.equal(bounded.riskHints.length, 32);
  const prep = prepareP4R0(bounded, GOOD_OPTIONS);
  assert.equal(prep.action, "REQUEST_REVIEW");
  assert.equal(validateP4R0Input(prep).target.binding.planHash, prep.target.binding.planHash);
});
