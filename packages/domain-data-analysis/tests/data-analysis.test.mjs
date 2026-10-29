import assert from "node:assert/strict";
import test from "node:test";

import { DataAnalysisAdapter } from "../dist/src/data-analysis-adapter.js";
import { runUniversalAgentLoop } from "../../agent-kernel/dist/src/generic-loop.js";

const adapter = new DataAnalysisAdapter();

test("compileContract: 建立统计推断与正态性/方差齐性检查契约", () => {
  const contract = adapter.compileContract({ rawText: "对比两组生物医学样本表达量差异并进行假设检验" });
  assert.deepEqual(contract.goals, ["STATISTICAL_INFERENCE", "DATA_QUALITY_ASSURANCE"]);
  assert.equal(contract.proposedObligations.length, 2);
  assert.equal(contract.proposedObligations[0].id, "ob_normality_homoscedasticity");
});

test("第 20.4 节案例 D 硬验收：第三领域零调度核心改动接入并完成推断", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Hypothesis test: Welch t-test, p-value=0.0034 < 0.05, Cohen's d=1.45 (large effect)",
        finishReason: "stop",
        usage: { promptTokens: 35, completionTokens: 25, totalTokens: 60 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_stats_1",
        toolName,
        status: "SUCCESS",
        output: { pValue: 0.0034, effectSize: 1.45, normalityPassed: true },
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
      runId: "run_stats_01",
      domainId: "data_analysis",
      domainVersion: "1.0.0",
      inputRefs: ["ref_biomedical_sample_csv"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: { rawText: "样本表达量统计假设检验" },
  });

  assert.equal(result.runId, "run_stats_01");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
});
