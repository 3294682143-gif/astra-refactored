import assert from "node:assert/strict";
import test from "node:test";

import { MaterialsDomainAdapter } from "../dist/src/materials-adapter.js";
import { runUniversalAgentLoop } from "../../agent-kernel/dist/src/generic-loop.js";

const adapter = new MaterialsDomainAdapter();

test("MaterialsDomainAdapter runs on AgentKernel", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Predicted: space group Fm-3m, band gap 1.42 eV (direct)",
        finishReason: "stop",
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_mat_1",
        toolName,
        status: "SUCCESS",
        output: { bandGap: 1.42, formationEnergy: -0.85 },
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
      runId: "run_mat_01",
      domainId: "materials_science",
      domainVersion: "1.0.0",
      inputRefs: ["ref_perovskite_cif"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: { rawText: "计算新型钙钛矿晶体形成能与带隙" },
  });

  assert.equal(result.runId, "run_mat_01");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
});
