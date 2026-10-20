import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContractLedger, compileP2Contract } from "@astra/math-contract";
import { P2WorkunitStore } from "@astra/math-workunit";
import { P4DiagnosticLedger } from "@astra/math-audit";
import { p3EffectFailure } from "@astra/math-gateway";
import {
  P2Error,
  canonicalScope,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  p4Target,
  type P2Artifact,
  type P2Contract,
  type P2Task,
  type P3EffectReceipt,
  type P3EffectRequest,
  type P4Binding,
  type P4CheckPlan,
  type P4CheckedProperty,
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
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface Built {
  readonly contract: P2Contract;
  readonly artifact: P2Artifact;
  readonly target: P4Target;
  readonly binding: P4Binding;
  readonly task: P2Task;
}

function build(): Built {
  const contract = compileP2Contract(PROBLEM, SESSION);
  const ledger = new ContractLedger(contract);
  const task = ledger.readyTasks().find((row) => {
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
    claim: "x=1 only",
    derivation: "Divide by x. Then x=1.",
    assumptions: [],
    dependencies: [],
    pendingObligations: [],
    suggestedChecks: [],
    deliveryStatus: "COMPLETE",
    candidateProposal: "x=1",
  };
  const artifact = store.accept(running, {
    artifactId: "artifact-1",
    routeId: "route-1",
    sourceRequestId: "model-1",
    transportStatus: "COMPLETE",
    text: JSON.stringify(packet),
    eventSeq: ledger.nextEventSeq(),
    supersedes: null,
  });
  const target = p4Target(ledger.snapshot(), artifact, "ACTIVE");
  return { contract, artifact, target, binding: target.binding, task: running };
}

function plan(
  built: Built,
  patch: Record<string, unknown> = {},
  requestPatch: Record<string, unknown> = {},
): P4CheckPlan {
  const request: P3EffectRequest = {
    effectId: "effect-1",
    binding: {
      sessionId: built.binding.sessionId,
      problemHash: built.binding.problemHash,
      contractVersion: built.binding.contractVersion,
      taskId: built.binding.taskId,
      scopeId: built.binding.scopeId,
      sourceRequestId: "model-2",
    },
    action: {
      action: "tool",
      name: "polynomial_expand_coefficients",
      args: { expression: "x*(x-1)", variables: ["x"], parameters: [] },
      scope: "expand",
    },
    remainingMs: 5000,
    ...requestPatch,
  };
  return {
    checkId: "check-1",
    target: built.binding,
    targetHash: built.target.targetHash,
    scope: built.target.artifact.scope,
    assumptions: [],
    checkedProperty: "SUPPLIED_POLYNOMIAL_COEFFICIENTS",
    methodOrToolVersion: "tool-registry-v1",
    obligationIds: [built.task.obligationId],
    request,
    ...patch,
  } as P4CheckPlan;
}

function linearPlan(built: Built, patch: Record<string, unknown> = {}): P4CheckPlan {
  return plan(
    built,
    {
      checkedProperty: "SUPPLIED_LINEAR_SOLUTION_SET",
      ...patch,
    },
    {
      action: {
        action: "tool",
        name: "linear_system_solution_set",
        args: {
          matrix: [["1", "1"], ["1", "-1"]],
          rhs: ["3", "1"],
          variables: ["x", "y"],
          domain: "RATIONAL",
        },
        scope: "solve",
      },
    },
  );
}

function realReceipt(request: P3EffectRequest): P3EffectReceipt {
  const result = spawnSync("python", ["-m", "python.astra_bridge.p3_effects"], {
    input: JSON.stringify(request),
    cwd: REPO_ROOT,
    timeout: 5000,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0);
  const receipt = JSON.parse(result.stdout.toString("utf8")) as P3EffectReceipt;
  assert.equal(receipt.status, "COMPLETE");
  assert.equal(receipt.level, "PROVISIONAL");
  assert.equal(receipt.checkResult, "UNKNOWN");
  assert.equal(receipt.source, "PROGRAM_OBSERVATION");
  assert.equal(receipt.observationHash, p4Hash(receipt.observation));
  return receipt;
}

function goodReceipt(request: P3EffectRequest, observation: string): P3EffectReceipt {
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  } as P3EffectReceipt;
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function expectReject(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error);
}

function settle(
  ledger: P4DiagnosticLedger,
  checkId: string,
  receipt: P3EffectReceipt,
  remainingMs = 1000,
) {
  ledger.markDispatched(checkId);
  return ledger.settle(checkId, receipt, remainingMs);
}

test("real registered operators produce diagnostic evidence that never supports an obligation", () => {
  const built = build();
  const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
  const poly = ledger.admit(plan(built, {}, {
    action: {
      action: "tool",
      name: "polynomial_expand_coefficients",
      args: { expression: "(x+1)**2", variables: ["x"], parameters: [] },
      scope: "expand",
    },
  }), 5000);
  assert.equal(poly.state, "ADMITTED");
  ledger.markDispatched("check-1");
  const polyReceipt = realReceipt(poly.plan.request);
  const polyRecord = ledger.settle("check-1", polyReceipt, 1000);
  assert.equal(polyRecord.code, "OBSERVED");
  const polyEvidence = polyRecord.evidence;
  assert.ok(polyEvidence !== null);
  assert.equal(polyEvidence.source, "PROGRAM_OBSERVATION");
  assert.equal(polyEvidence.level, "PROVISIONAL");
  assert.equal(polyEvidence.checkResult, "UNKNOWN");
  assert.equal(polyEvidence.semanticMapping, "UNKNOWN");
  assert.equal(polyEvidence.canSupportObligation, false);
  assert.equal(polyEvidence.availability, "ACTIVE");
  assert.equal(polyEvidence.outputHash, polyReceipt.observationHash);
  assert.equal(polyEvidence.inputHash, p4Hash(JSON.stringify(["polynomial_expand_coefficients", poly.plan.request.action.action === "tool" ? poly.plan.request.action.args : {}])));
  assert.deepEqual([...polyEvidence.checkerCoverage], [built.task.obligationId]);
  assert.equal(polyEvidence.requestId, "model-2");
  assert.equal(polyEvidence.effectId, "effect-1");
  assert.equal(polyEvidence.methodOrToolVersion, "tool-registry-v1");
  assert.equal(polyEvidence.checkedProperty, "SUPPLIED_POLYNOMIAL_COEFFICIENTS");
  assert.equal(polyEvidence.targetHash, built.target.targetHash);
  assert.equal(p4JsonEqual(polyEvidence.scope, built.target.artifact.scope), true);
  assert.equal(polyEvidence.assumptions.length, 0);
  const polyObservation = JSON.parse(polyReceipt.observation) as Record<string, unknown>;
  assert.equal(polyObservation.interpretation, "OBSERVATION_NOT_PROOF");
  const polyTerms = (polyObservation.result as Record<string, unknown>).terms as readonly Record<string, unknown>[];
  assert.deepEqual(polyTerms.map((term) => term.powers), [[0], [1], [2]]);
  assert.deepEqual(
    polyTerms.map((term) => {
      const coefficient = (term.coefficient as readonly Record<string, unknown>[])[0]!;
      return coefficient.coefficient;
    }),
    ["1", "2", "1"],
  );

  const linear = ledger.admit(
    linearPlan(built, {
      checkId: "check-2",
      request: {
        ...linearPlan(built).request,
        effectId: "effect-2",
        binding: { ...linearPlan(built).request.binding, sourceRequestId: "model-3" },
      },
    }),
    5000,
  );
  assert.equal(linear.state, "ADMITTED");
  ledger.markDispatched("check-2");
  const linearReceipt = realReceipt(linear.plan.request);
  const linearRecord = ledger.settle("check-2", linearReceipt, 1000);
  assert.equal(linearRecord.code, "OBSERVED");
  assert.ok(linearRecord.evidence !== null);
  assert.equal(linearRecord.evidence.checkedProperty, "SUPPLIED_LINEAR_SOLUTION_SET");
  assert.equal(linearRecord.evidence.checkResult, "UNKNOWN");
  assert.equal(linearRecord.evidence.canSupportObligation, false);
  const linearObservation = JSON.parse(linearReceipt.observation) as Record<string, unknown>;
  assert.equal(linearObservation.interpretation, "OBSERVATION_NOT_PROOF");
  assert.deepEqual((linearObservation.result as Record<string, unknown>).particular, ["2", "1"]);

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.length, 2);
  for (const record of snapshot) {
    assert.equal(record.assessment.semanticResult, "UNKNOWN");
    assert.equal(record.assessment.canSupportObligation, false);
    assert.equal(record.assessment.structuralMatch, true);
    assert.equal(record.assessment.reason, "STRUCTURAL_MATCH_ONLY");
    assert.equal(record.assessment.stage, "S1");
  }
  for (const obligation of built.contract.obligations) {
    assert.notEqual(obligation.status, "SATISFIED");
  }
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.equal(Object.isFrozen(snapshot[0]!.evidence), true);
});

test("error, unknown and late outcomes never produce evidence and never retry", () => {
  const built = build();
  const cases: readonly [string, "COMPLETE" | "ERROR" | "UNKNOWN", number, boolean][] = [
    ["ERROR", "ERROR", 1000, true],
    ["UNKNOWN", "UNKNOWN", 1000, false],
    ["COMPLETE", "COMPLETE", 25, false],
    ["UNKNOWN_LATE", "UNKNOWN", 25, false],
  ];
  for (const [label, status, remaining, canContinue] of cases) {
    const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
    const admitted = ledger.admit(plan(built), 5000);
    ledger.markDispatched("check-1");
    const receipt = goodReceipt(admitted.plan.request, JSON.stringify({ tool: "polynomial_expand_coefficients", result: {}, interpretation: "OBSERVATION_NOT_PROOF" }));
    const settled = ledger.settle("check-1", { ...receipt, status } as P3EffectReceipt, remaining);
    assert.equal(settled.evidence, null, label);
    assert.equal(settled.receipt?.status, status, label);
    if (canContinue) {
      assert.equal(settled.code, "ERROR", label);
      const second = ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2", binding: { ...admitted.plan.request.binding, sourceRequestId: "model-3" } }), 5000);
      assert.equal(settle(ledger, "check-2", goodReceipt(second.plan.request, "{}")).code, "OBSERVED", label);
    } else {
      assert.equal(settled.code, status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "DEADLINE_EXCEEDED", label);
      expectCode(() => ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2", binding: { ...admitted.plan.request.binding, sourceRequestId: "model-3" } }), 5000), "ILLEGAL_TRANSITION");
    }
  }

  const stale = new P4DiagnosticLedger(built.contract, built.target, 2);
  const admitted = stale.admit(plan(built), 5000);
  stale.markDispatched("check-1");
  assert.equal(stale.settle("check-1", goodReceipt(admitted.plan.request, "{}"), 1000).code, "OBSERVED");
  stale.markStale();
  const snapshot = stale.snapshot();
  assert.equal(snapshot[0]!.evidence?.availability, "STALE");
  assert.equal(snapshot[0]!.evidence?.checkResult, "UNKNOWN");
  assert.notEqual(snapshot[0]!.evidence?.availability, "REFUTED");
  assert.equal(stale.precheck(plan(built)).reason, "STALE_TARGET");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]!.evidence), true);

  const pending = new P4DiagnosticLedger(built.contract, built.target, 1);
  pending.admit(plan(built), 5000);
  expectCode(() => pending.markStale(), "ILLEGAL_TRANSITION");
});

test("precheck accepts S1 evidence produced on a deep model ordinal", () => {
  const built = build();
  const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
  for (const sourceRequestId of ["model-4", "model-256"]) {
    const deep = plan(built, {}, {
      binding: { ...plan(built).request.binding, sourceRequestId },
    });
    const assessed = ledger.precheck(deep);
    assert.equal(assessed.structuralMatch, true);
    assert.equal(assessed.reason, "STRUCTURAL_MATCH_ONLY");
  }
});

test("precheck reports structural reasons without promoting anything", () => {
  const built = build();
  const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
  const ok = ledger.precheck(plan(built));
  assert.equal(ok.structuralMatch, true);
  assert.equal(ok.reason, "STRUCTURAL_MATCH_ONLY");
  assert.equal(ok.semanticResult, "UNKNOWN");
  assert.equal(ok.canSupportObligation, false);

  const scope = { ...built.target.artifact.scope, domain: "INTEGER" };
  const rescoped = { ...scope, scopeId: p4Hash(canonicalScope(scope)) };
  const scopePlan = plan(built, { scope: rescoped });
  assert.equal(ledger.precheck(scopePlan).reason, "SCOPE_MISMATCH");
  assert.equal(ledger.precheck(scopePlan).structuralMatch, false);

  const assumptionPlan = plan(built, { assumptions: ["x!=0"] });
  assert.equal(ledger.precheck(assumptionPlan).reason, "ASSUMPTIONS_MISMATCH");

  const crossPlan = plan(built, { checkedProperty: "SUPPLIED_LINEAR_SOLUTION_SET" });
  assert.equal(ledger.precheck(crossPlan).reason, "UNSUPPORTED_CHECK");

  const before = p2Snapshot(ledger.snapshot());
  const bad: readonly (() => unknown)[] = [
    () => ledger.precheck(plan(built, { target: { ...built.binding, taskId: "other" } })),
    () => ledger.precheck(plan(built, { targetHash: "0".repeat(64) })),
    () => ledger.precheck(plan(built, { methodOrToolVersion: "tool-registry-v2" })),
    () => ledger.precheck(plan(built, {}, { action: { action: "tool", name: "polynomial_expand_coefficients", args: { expression: 1.5 }, scope: "expand" } })),
    () => ledger.precheck(plan(built, {}, { action: { action: "tool", name: "polynomial_expand_coefficients", args: { expression: "\ud800" }, scope: "expand" } })),
    () => ledger.precheck(plan(built, {}, { action: { action: "tool", name: "made_up_tool", args: {}, scope: "expand" } })),
    () => ledger.precheck(plan(built, { extra: true })),
    () => ledger.precheck(plan(built, { obligationIds: [] })),
    () => ledger.precheck(plan(built, { obligationIds: [built.task.obligationId, built.task.obligationId] })),
  ];
  for (const fn of bad) {
    expectReject(fn);
  }
  assert.equal(p4JsonEqual(p2Snapshot(ledger.snapshot()), before), true);
});

test("admission enforces the cap, the 26/25ms boundary and single-flight", () => {
  const built = build();
  const zero = new P4DiagnosticLedger(built.contract, built.target, 0);
  expectCode(() => zero.admit(plan(built), 5000), "BUDGET_EXHAUSTED");
  const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
  expectCode(() => ledger.admit(plan(built), 25), "BOUND_EXCEEDED");
  expectCode(() => ledger.admit(plan(built), 3600001), "BOUND_EXCEEDED");
  const admitted = ledger.admit(plan(built), 26);
  assert.equal(admitted.state, "ADMITTED");
  assert.equal(admitted.code, "STRUCTURAL_ONLY");
  assert.equal(admitted.plan.request.remainingMs, 26);
  const before = p2Snapshot(ledger.snapshot());
  expectCode(() => ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2", binding: { ...plan(built).request.binding, sourceRequestId: "model-3" } }), 5000), "ILLEGAL_TRANSITION");
  assert.equal(p4JsonEqual(p2Snapshot(ledger.snapshot()), before), true);
  expectCode(() => ledger.settle("check-1", goodReceipt(admitted.plan.request, "{}"), 1000), "ILLEGAL_TRANSITION");
  ledger.markDispatched("check-1");
  expectCode(() => ledger.markDispatched("check-1"), "ILLEGAL_TRANSITION");
  const settled = ledger.settle("check-1", goodReceipt(admitted.plan.request, "{}"), 1000);
  assert.equal(settled.code, "OBSERVED");
  const after = p2Snapshot(ledger.snapshot());
  expectCode(() => ledger.settle("check-1", goodReceipt(admitted.plan.request, "{}"), 1000), "ILLEGAL_TRANSITION");
  assert.equal(p4JsonEqual(p2Snapshot(ledger.snapshot()), after), true);
  expectCode(() => ledger.admit(plan(built, { checkId: "check-2" }), 5000), "DUPLICATE_REQUEST_ID");
  expectCode(
    () => ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2" }), 5000),
    "DUPLICATE_REQUEST_ID",
  );
  const second = ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2", binding: { ...plan(built).request.binding, sourceRequestId: "model-3" } }), 5000);
  assert.equal(second.state, "ADMITTED");
  assert.equal(settle(ledger, "check-2", goodReceipt(second.plan.request, "{}")).code, "OBSERVED");
  expectCode(() => ledger.admit(plan(built, { checkId: "check-1" }, { effectId: "effect-1", binding: { ...plan(built).request.binding, sourceRequestId: "model-2" } }), 5000), "BUDGET_EXHAUSTED");
});

test("forged receipts are rejected and leave the last record DISPATCHED", () => {
  const built = build();
  const ledger = new P4DiagnosticLedger(built.contract, built.target, 2);
  const admitted = ledger.admit(plan(built), 5000);
  ledger.markDispatched("check-1");
  const request = admitted.plan.request;
  const good = goodReceipt(request, JSON.stringify({ tool: "polynomial_expand_coefficients", result: { coefficients: [1, -1, 0] }, interpretation: "OBSERVATION_NOT_PROOF" }));
  const attacks: readonly (() => unknown)[] = [
    () => ledger.settle("check-1", { ...good, effectId: "effect-2" } as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, binding: { ...request.binding, taskId: "other" } } as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, source: "METHOD_REFERENCE" } as unknown as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, checkResult: "PASS" } as unknown as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, level: "CHECKED_SCOPE" } as unknown as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, observationHash: "0".repeat(64) } as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, binding: { ...request.binding, contractVersion: true } } as unknown as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, extra: 1 } as unknown as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, observation: "x".repeat(16001), observationHash: p4Hash("x".repeat(16001)) } as P3EffectReceipt, 1000),
    () => ledger.settle("check-1", { ...good, observation: "\ud800", observationHash: p4Hash("\ud800") } as P3EffectReceipt, 1000),
  ];
  for (const fn of attacks) {
    expectReject(fn);
    const last = ledger.snapshot()[0]!;
    assert.equal(last.state, "DISPATCHED");
    assert.equal(last.receipt, null);
    assert.equal(last.evidence, null);
  }
  const passText = JSON.stringify({ tool: "polynomial_expand_coefficients", result: { verdict: "PASS" }, interpretation: "OBSERVATION_NOT_PROOF" });
  const settled = ledger.settle("check-1", goodReceipt(request, passText), 1000);
  assert.equal(settled.code, "OBSERVED");
  assert.equal(settled.evidence?.checkResult, "UNKNOWN");
  assert.equal(settled.evidence?.semanticMapping, "UNKNOWN");
  assert.equal(settled.evidence?.canSupportObligation, false);
  assert.equal(settled.evidence?.outputHash, p4Hash(passText));
  const second = ledger.admit(plan(built, { checkId: "check-2" }, { effectId: "effect-2", binding: { ...request.binding, sourceRequestId: "model-3" } }), 5000);
  assert.equal(settle(ledger, "check-2", goodReceipt(second.plan.request, "{}")).code, "OBSERVED");
});
