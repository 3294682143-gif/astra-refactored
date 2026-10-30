import assert from "node:assert/strict";
import test from "node:test";

import { ControlDomainAdapter } from "../../../packages/domain-control/dist/src/control-adapter.js";
import { runUniversalAgentLoop } from "../../../packages/agent-kernel/dist/src/generic-loop.js";

const adapter = new ControlDomainAdapter();

test("ControlDomainAdapter: 5 项不可妥协义务完整性验证", () => {
  const contract = adapter.compileContract({
    rawText: "辨识受迫阻尼振子质量、阻尼与刚度三参数 (m, c, k)，并验证独立预测",
  });

  const obligationIds = contract.proposedObligations.map((o) => o.id);
  assert.ok(obligationIds.includes("ob_leak_prevention"), "Missing ob_leak_prevention");
  assert.ok(obligationIds.includes("ob_physics_bounds"), "Missing ob_physics_bounds");
  assert.ok(obligationIds.includes("ob_aliasing_guard"), "Missing ob_aliasing_guard");
  assert.ok(obligationIds.includes("ob_residual_whiteness"), "Missing ob_residual_whiteness");
  assert.ok(obligationIds.includes("ob_independent_rmse"), "Missing ob_independent_rmse");
});

test("ControlDomainAdapter 门控断言：混叠与残差非白性收敛为 REFUTED", () => {
  // Test aliasing violation receipt
  const aliasingReceipt = [
    {
      validatorId: "control_aliasing_guard",
      validatorVersion: "1.0",
      subjectHash: "h_alias",
      scope: "sampling",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const aliasAssess = adapter.assessObligation(aliasingReceipt, {
    obligation: { id: "ob_aliasing_guard", kind: "SAMPLING_ALIASING_GUARD", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(aliasAssess.newState, "REFUTED");
  assert.match(aliasAssess.rationale, /欠采样混叠违规/);

  // Test whiteness violation receipt
  const whitenessReceipt = [
    {
      validatorId: "control_whiteness_evaluator",
      validatorVersion: "1.0",
      subjectHash: "h_white",
      scope: "residuals",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];
  const whiteAssess = adapter.assessObligation(whitenessReceipt, {
    obligation: { id: "ob_residual_whiteness", kind: "RESIDUAL_WHITENESS_CHECK", subjectRef: "", scopeRef: "", acceptancePolicyRef: "", state: "OPEN" },
  });
  assert.equal(whiteAssess.newState, "REFUTED");
  assert.match(whiteAssess.rationale, /结构欠定/);
});

test("端到端内核集成：通用 AgentLoop 驱动控制领域全流程辨识与投递", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Identified: m=1.5kg, c=0.4Ns/m, k=2.8N/m, holdout RMSE=0.012",
        finishReason: "stop",
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_ctl_001",
        toolName,
        status: "SUCCESS",
        output: {
          mass: 1.5,
          damping: 0.4,
          stiffness: 2.8,
          rmseHoldout: 0.012,
          whiteness: "RESIDUAL_WHITE",
          samplingGuard: "PASS",
        },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 50000,
    },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_control_e2e_001",
      domainId: "control.identification",
      domainVersion: "1.0.0",
      inputRefs: ["vibration_sensor_data"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: {
      maxModelCalls: 5,
      maxToolCalls: 5,
      deadlineMonotonicMs: 60000,
    },
    rawInput: { rawText: "辨识非线性阻尼受迫振子质量阻尼刚度三参数 (m=1.5, c=0.4, k=2.8)" },
  });

  assert.equal(result.runId, "run_control_e2e_001");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.metrics.toolCalls, 1);
});
