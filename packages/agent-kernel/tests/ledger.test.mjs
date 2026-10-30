import assert from "node:assert/strict";
import test from "node:test";
import { ContractLedger } from "../dist/src/ledger.js";

test("I01: 目标契约变更严格保留原始输入引用并自增版本号", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_orig_control_identification_99",
      goals: ["IDENTIFY_SYSTEM_PARAMETERS"],
      scope: { raw: "m*x'' + c*x' + k*x = u(t)" },
      obligations: [],
      version: 1,
    },
    { maxModelCalls: 10, maxToolCalls: 5, deadlineMonotonicMs: Date.now() + 10000 }
  );

  // Mutate goals and scope
  ledger.updateContract((curr) => ({
    goals: ["IDENTIFY_SYSTEM_PARAMETERS", "CHECK_LYAPUNOV_STABILITY"],
    scope: { ...curr.scope, damping_model: "viscous" },
  }));

  // Assert I01: originalInputRef is strictly immutable and version is incremented
  assert.equal(ledger.contract.originalInputRef, "ref_orig_control_identification_99");
  assert.equal(ledger.contract.version, 2);
  assert.deepEqual(ledger.contract.goals, ["IDENTIFY_SYSTEM_PARAMETERS", "CHECK_LYAPUNOV_STABILITY"]);
  assert.equal(ledger.contract.scope.damping_model, "viscous");

  // Second mutation bumps version to 3
  ledger.updateContract((curr) => ({
    goals: curr.goals,
    scope: { ...curr.scope, bounds_checked: true },
  }));
  assert.equal(ledger.contract.version, 3);
  assert.equal(ledger.contract.originalInputRef, "ref_orig_control_identification_99");
});

test("I02: 任务完成与结构合法回答不自动关闭研究义务，必须关联验证回执", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_orig_scientific_analysis_01",
      goals: ["STABILITY_PROOF"],
      scope: {},
      obligations: [
        {
          id: "ob_parameter_bounds",
          kind: "PARAMETER_BOUNDS",
          subjectRef: "param_m",
          scopeRef: "scope_real_positive",
          acceptancePolicyRef: "policy_strict",
          state: "OPEN",
        },
        {
          id: "ob_energy_decay",
          kind: "LYAPUNOV_DECAY",
          subjectRef: "lyapunov_v",
          scopeRef: "scope_state_space",
          acceptancePolicyRef: "policy_strict",
          state: "OPEN",
        },
      ],
      version: 1,
    },
    { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: Date.now() + 10000 }
  );

  // Obligations start in OPEN state
  assert.equal(ledger.allObligationsAccepted(), false);

  // Intermediate or partial assessment (SUPPORTED) does not close obligation
  ledger.recordObligationAssessment("ob_parameter_bounds", "SUPPORTED", "Preliminary bounds derived");
  assert.equal(ledger.allObligationsAccepted(), false);

  // Only ACCEPTED_WITHIN_SCOPE closes the obligation
  ledger.recordObligationAssessment("ob_parameter_bounds", "ACCEPTED_WITHIN_SCOPE", "Validated by interval arithmetic");
  assert.equal(ledger.allObligationsAccepted(), false); // Second obligation still OPEN

  // Close second obligation with valid receipt
  ledger.recordObligationAssessment("ob_energy_decay", "ACCEPTED_WITHIN_SCOPE", "Validated by Lyapunov derivative checker");
  assert.equal(ledger.allObligationsAccepted(), true);

  // Invalid obligation id throws error
  assert.throws(
    () => ledger.recordObligationAssessment("ob_nonexistent", "ACCEPTED_WITHIN_SCOPE"),
    { message: /Obligation not found/ }
  );
});

test("I05: 根预算配额硬约束，子任务、修复与重试不能逃逸或重置预算", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_budget_test",
      goals: ["ESTIMATE"],
      scope: {},
      obligations: [],
      version: 1,
    },
    { maxModelCalls: 2, maxToolCalls: 1, deadlineMonotonicMs: 5000 }
  );

  // Within budget
  assert.equal(ledger.canDispatchModelCall(1000), true);
  ledger.recordDispatchedModelCall(true);
  assert.equal(ledger.consumption.modelCalls, 1);

  assert.equal(ledger.canDispatchModelCall(2000), true);
  ledger.recordDispatchedModelCall(true);
  assert.equal(ledger.consumption.modelCalls, 2);

  // Model call limit reached (maxModelCalls: 2)
  assert.equal(ledger.canDispatchModelCall(3000), false);
  assert.equal(ledger.consumption.rejectedCalls, 1);

  // Tool call within budget
  assert.equal(ledger.canDispatchToolCall(3500), true);
  ledger.recordDispatchedToolCall();
  assert.equal(ledger.consumption.toolCalls, 1);

  // Tool call limit reached (maxToolCalls: 1)
  assert.equal(ledger.canDispatchToolCall(4000), false);
  assert.equal(ledger.consumption.rejectedCalls, 2);

  // Exceeding deadline (monotonic ms >= 5000)
  assert.equal(ledger.canDispatchModelCall(5001), false);
  assert.equal(ledger.canDispatchToolCall(5001), false);
  assert.equal(ledger.consumption.rejectedCalls, 4);
});

test("I06: 未发送（本地门控拦截）与已发送但结果未知严格分别记账", () => {
  const ledger = new ContractLedger(
    {
      originalInputRef: "ref_accounting_test",
      goals: ["IDENTIFICATION"],
      scope: {},
      obligations: [],
      version: 1,
    },
    { maxModelCalls: 1, maxToolCalls: 0, deadlineMonotonicMs: 2000 }
  );

  // Dispatch 1 call, but it timed out with unknown remote outcome
  assert.equal(ledger.canDispatchModelCall(1000), true);
  ledger.recordDispatchedModelCall(false, true); // timedOutWithoutEvidence = true

  // Dispatch 2nd call rejected locally because budget exhausted
  assert.equal(ledger.canDispatchModelCall(1500), false);

  // Invariant I06 check:
  // - modelCalls: 1 (actually dispatched)
  // - rejectedCalls: 1 (locally intercepted, NOT_DISPATCHED)
  // - unknownOutcomeCalls: 1 (dispatched but OUTCOME_UNKNOWN)
  assert.equal(ledger.consumption.modelCalls, 1);
  assert.equal(ledger.consumption.rejectedCalls, 1);
  assert.equal(ledger.consumption.unknownOutcomeCalls, 1);
});
