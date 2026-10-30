import assert from "node:assert/strict";
import test from "node:test";

import { ControlDomainAdapter } from "../dist/src/control-adapter.js";
import { runUniversalAgentLoop } from "../../agent-kernel/dist/src/generic-loop.js";

const adapter = new ControlDomainAdapter();

test("compileContract: 自动生成受迫振子系统辨识与独立预测契约，预留 20% 验证集", () => {
  const contract = adapter.compileContract({
    rawText: "已知外部激励 u(t)=sin(2t) 下质点位移时序数据，求阻尼受迫振子参数 m, c, k 并验证前向预测",
  });

  assert.deepEqual(contract.goals, ["SYSTEM_IDENTIFICATION", "INDEPENDENT_PREDICTION"]);
  assert.equal(contract.scope.validationSplitRatio, 0.2);
  assert.equal(contract.proposedObligations.length, 5);
  assert.equal(contract.proposedObligations[0].id, "ob_leak_prevention");
});

test("proposeChecks: 生成数据泄漏检测器、特征值稳定性、抗混叠、残差白性与 RMSE 验证器", () => {
  const checks = adapter.proposeChecks({
    candidateId: "cand_ctl_1",
    rawContent: { mass: 1.0, damping: 0.2, stiffness: 10.0, rmseHoldout: 0.02 },
    artifacts: [],
  });

  assert.equal(checks.length, 5);
  assert.equal(checks[0].validatorId, "control_leak_detector");
  assert.equal(checks[1].validatorId, "control_eigenvalue_stability");
  assert.equal(checks[2].validatorId, "control_aliasing_guard");
  assert.equal(checks[3].validatorId, "control_whiteness_evaluator");
  assert.equal(checks[4].validatorId, "control_rmse_evaluator");
});

test("assessObligation: 数据泄露被检查器识别并判定 REFUTED (T36)", () => {
  const leakedReceipts = [
    {
      validatorId: "control_leak_detector",
      validatorVersion: "1.0",
      subjectHash: "h1",
      scope: "holdout",
      outcome: "FAIL",
      evidenceRefs: [],
      issuedAt: new Date().toISOString(),
    },
  ];

  const assessment = adapter.assessObligation(leakedReceipts, {
    obligation: {
      id: "ob_leak_prevention",
      kind: "DATA_LEAK_PREVENTION",
      subjectRef: "s",
      scopeRef: "sc",
      acceptancePolicyRef: "p",
      state: "OPEN",
    },
  });

  assert.equal(assessment.newState, "REFUTED");
  assert.match(assessment.rationale, /Data leakage detected/);
});

test("第 15 章内核复制硬验收：相同 agent-kernel 跑通 ControlDomainAdapter 全流程", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Identified: m=1.0kg, c=0.2Ns/m, k=10.0N/m, holdout RMSE=0.018",
        finishReason: "stop",
        usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_sysid_1",
        toolName,
        status: "SUCCESS",
        output: { mass: 1.0, damping: 0.2, stiffness: 10.0, rmseHoldout: 0.018 },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 60000,
    },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: adapter,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_control_sysid_01",
      domainId: "control.identification",
      domainVersion: "1.0.0",
      inputRefs: ["ref_vibration_data_csv"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: {
      maxModelCalls: 5,
      maxToolCalls: 5,
      deadlineMonotonicMs: 60000,
    },
    rawInput: { rawText: "辨识受迫阻尼振子动力学参数" },
  });

  assert.equal(result.runId, "run_control_sysid_01");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.metrics.toolCalls, 1);
});
