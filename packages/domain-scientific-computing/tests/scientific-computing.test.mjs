import assert from "node:assert/strict";
import test from "node:test";

import { ScientificComputingAdapter } from "../dist/src/scientific-computing-adapter.js";
import { runUniversalAgentLoop } from "../../agent-kernel/dist/src/generic-loop.js";

const adapter = new ScientificComputingAdapter();

test("compileContract: 生成数值收敛性与边界守恒义务", () => {
  const contract = adapter.compileContract({ rawText: "求解二维热传导方程初边值问题" });
  assert.deepEqual(contract.goals, ["NUMERICAL_EXPERIMENT", "METHOD_REPLICATION"]);
  assert.equal(contract.proposedObligations.length, 2);
});

test("跑通通用 AgentKernel 全流程（ScientificComputingAdapter）", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Discretization scheme: Crank-Nicolson, step dt=0.01, dx=0.05",
        finishReason: "stop",
        usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_pde_1",
        toolName,
        status: "SUCCESS",
        output: { residualL2: 1.2e-5, cflNumber: 0.45 },
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
      runId: "run_pde_01",
      domainId: "scientific_computing",
      domainVersion: "1.0.0",
      inputRefs: ["ref_heat_eq"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: { rawText: "二维非齐次热传导方程求解" },
  });

  assert.equal(result.runId, "run_pde_01");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
});
