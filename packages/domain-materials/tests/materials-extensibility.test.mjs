import assert from "node:assert/strict";
import test from "node:test";

import { ScenarioRegistry } from "../../scenario-sdk/src/scenario-registry.ts";
import { MATERIALS_SCENARIO_PLUGIN, MATERIALS_SCENARIO_CONTRACT } from "../src/materials-plugin.ts";
import { runUniversalAgentLoop } from "../../agent-kernel/dist/src/generic-loop.js";

test("E15 Extensibility: Register 5th scenario package into ScenarioRegistry with zero core changes", () => {
  const registry = new ScenarioRegistry();
  assert.equal(registry.list().length, 0);

  // Register 5th scenario package
  registry.register(MATERIALS_SCENARIO_PLUGIN);
  assert.equal(registry.list().length, 1);
  assert.ok(registry.has("materials.bandgap"));

  const retrieved = registry.get("materials.bandgap");
  assert.ok(retrieved);
  assert.equal(retrieved.manifest.scenarioId, "materials.bandgap");
  assert.equal(retrieved.manifest.domainType, "materials_science");
  assert.equal(retrieved.team.roles.length, 4);

  // Verify snapshot immutability
  const snapshot = registry.createSnapshot("materials.bandgap");
  assert.equal(snapshot.scenarioId, "materials.bandgap");
  assert.equal(snapshot.version, "1.0.0");
  assert.ok(snapshot.snapshotTimestamp);
});

test("E15 Extensibility: 5th scenario runs through universal agent loop unmodified", async () => {
  const mockHostPorts = {
    model: {
      requestCompletion: async () => ({
        content: "Predicted: space group Fm-3m, band gap 1.42 eV (direct)",
        finishReason: "stop",
        usage: { promptTokens: 25, completionTokens: 12, totalTokens: 37 },
      }),
    },
    asset: {
      execute: async (toolName, params) => ({
        callId: "call_mat_dft_01",
        toolName,
        status: "SUCCESS",
        output: { bandGap: 1.42, formationEnergy: -0.85, hullDistance: 0.01 },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 60000,
    },
  };

  const result = await runUniversalAgentLoop({
    domainAdapter: MATERIALS_SCENARIO_PLUGIN.domain,
    hostPorts: mockHostPorts,
    runSpec: {
      runId: "run_mat_zero_change_01",
      domainId: "materials.bandgap",
      domainVersion: "1.0.0",
      inputRefs: ["ref_cif_perovskite"],
      profileId: "prod",
      createdAt: new Date().toISOString(),
    },
    budget: { maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000 },
    rawInput: { rawText: "计算钙钛矿晶体 CsPbI3 形成能与能带结构" },
  });

  assert.equal(result.runId, "run_mat_zero_change_01");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.delivery, "CANDIDATE_AVAILABLE");
  assert.ok(result.metrics.modelCalls >= 1);
  assert.ok(result.metrics.toolCalls >= 1);
  assert.ok(result.artifactRefs.length >= 1);
});
