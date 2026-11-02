import assert from "node:assert/strict";
import test from "node:test";

import { MathDomainAdapter } from "../../domain-math/dist/src/math-adapter.js";
import { ControlDomainAdapter } from "../../domain-control/dist/src/control-adapter.js";
import { ScientificComputingAdapter } from "../../domain-scientific-computing/dist/src/scientific-computing-adapter.js";
import { DataAnalysisAdapter } from "../../domain-data-analysis/dist/src/data-analysis-adapter.js";
import { runUniversalAgentLoop } from "../dist/src/generic-loop.js";

function createMockHostPorts(toolPayload = {}) {
  return {
    model: {
      requestCompletion: async () => ({
        content: JSON.stringify({ candidateProposal: "ok", answer: "42", deliveryStatus: "COMPLETE" }),
        finishReason: "stop",
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      }),
    },
    asset: {
      execute: async (toolName) => ({
        callId: `call_${toolName}_1`,
        toolName,
        status: "SUCCESS",
        output: { valid: true, ...toolPayload },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 60000,
    },
  };
}

const DOMAIN_CASES = [
  {
    name: "Mathematics",
    adapter: new MathDomainAdapter(),
    rawInput: { rawText: "求二次方程根与形式化证明" },
    runSpec: { runId: "run_math_parity_01", domainId: "math", inputRefs: ["ref_m1"] },
  },
  {
    name: "Control Dynamics",
    adapter: new ControlDomainAdapter(),
    rawInput: { rawText: "辨识受迫振子质量阻尼刚度三参数" },
    runSpec: { runId: "run_ctl_parity_01", domainId: "control.identification", inputRefs: ["ref_c1"] },
  },
  {
    name: "Scientific Computing",
    adapter: new ScientificComputingAdapter(),
    rawInput: { rawText: "一维导热方程有限差分收敛性分析" },
    runSpec: { runId: "run_pde_parity_01", domainId: "scientific_computing", inputRefs: ["ref_p1"] },
  },
  {
    name: "Data Analysis",
    adapter: new DataAnalysisAdapter(),
    rawInput: { rawText: "双样本对照干预实验 Welch t 检验" },
    runSpec: { runId: "run_stats_parity_01", domainId: "data_analysis", inputRefs: ["ref_d1"] },
  },
];

for (const tc of DOMAIN_CASES) {
  test(`E08-B 统一内核硬验收：${tc.name} 场景共用单一无偏调度循环`, async () => {
    const hostPorts = createMockHostPorts();
    const budget = { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 };

    const result = await runUniversalAgentLoop({
      domainAdapter: tc.adapter,
      hostPorts,
      runSpec: tc.runSpec,
      budget,
      rawInput: tc.rawInput,
    });

    assert.equal(result.runId, tc.runSpec.runId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
    assert.equal(result.metrics.modelCalls, 1);
    assert.ok(result.metrics.toolCalls >= 1);
    assert.ok(result.artifactRefs.length >= 1);
  });
}
