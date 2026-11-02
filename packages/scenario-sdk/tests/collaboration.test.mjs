import test from "node:test";
import assert from "node:assert/strict";

import { ScenarioRegistry } from "../src/scenario-registry.ts";
import { CrossScenarioCoordinator } from "../src/collaboration.ts";
import { CONTROL_SCENARIO_CONTRACT, DATA_ANALYSIS_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { defineScenario } from "../src/define-scenario.ts";

function createMockPlugin(contract) {
  return defineScenario({
    manifest: contract.manifest,
    inputs: contract.inputs,
    team: contract.team,
    results: contract.results,
    domain: {
      id: contract.manifest.scenarioId,
      version: "1.0.0",
      compileContract: () => ({ goals: ["delegated_goal"], scope: {}, proposedObligations: [{ id: "ob_delegated", kind: "DELEGATED_CHECK" }] }),
      validateContract: () => ({ valid: true, errors: [] }),
      buildWorkContext: () => ({ systemPromptSegment: "", availableTools: ["data.cleaner"] }),
      validateWorkPacket: () => ({ accepted: true }),
      classifyRoute: () => ({ isSubstantive: true, score: 1 }),
      interpretObservation: () => [],
      proposeChecks: () => [],
      assessObligation: () => ({ newState: "ACCEPTED_WITHIN_SCOPE", rationale: "ok" }),
      projectDelivery: () => ({ deliveryState: "CANDIDATE_AVAILABLE", payload: {} }),
    },
    tools: [],
    checks: [],
    policy: {
      maxRounds: 3,
      timeoutMs: 30000,
      allowParallelReview: false,
      enableBoundedRepair: true,
      maxRepairs: 1,
      failureHandling: "FAIL_EXPLICIT_UNSOLVED",
    },
    execution: {
      bindingKind: "STANDALONE_WORKER",
      engineTarget: "worker",
      entrypoint: "mock.worker",
      allowedEngines: ["mock"],
      defaultEngine: "mock",
      supportsCheckpointResume: false,
    },
  });
}

function createHostPorts() {
  return {
    model: {
      requestCompletion: async () => ({
        content: JSON.stringify({ candidateProposal: "delegated candidate" }),
        finishReason: "stop",
      }),
    },
    asset: {
      execute: async (toolName) => ({
        callId: `call_${toolName}_1`,
        toolName,
        status: "SUCCESS",
        output: { valid: true },
      }),
    },
    clock: {
      nowMonotonicMs: () => 1000,
      remainingBudgetMs: () => 30000,
    },
  };
}

test("E13: Cross-scenario delegation succeeds for Control -> Data Analysis uncertainty evaluation", async () => {
  const registry = new ScenarioRegistry();
  registry.register(createMockPlugin(CONTROL_SCENARIO_CONTRACT));
  registry.register(createMockPlugin(DATA_ANALYSIS_SCENARIO_CONTRACT));

  const coordinator = new CrossScenarioCoordinator(registry, createHostPorts(), 1);

  const task = {
    taskId: "task_collab_ctl_data_001",
    parentRunId: "run_control_main_88",
    initiatingScenarioId: "control.identification",
    targetScenarioId: "data_analysis.statistical_inference",
    taskKind: "MODEL_UNCERTAINTY_EVALUATION",
    inputArtifacts: [{ holdoutRmse: 0.0046, parameters: { mass: 1.5, damping: 0.4, stiffness: 2.8 } }],
    inheritedBudget: {
      maxModelCalls: 3,
      maxToolCalls: 2,
      remainingDeadlineMs: 45000,
    },
    recursionDepth: 1,
  };

  const result = await coordinator.delegate(task);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.parentRunId, "run_control_main_88");
  assert.equal(result.targetScenarioId, "data_analysis.statistical_inference");
  assert.equal(result.candidateVerified, false, "Invariant I15 must hold on delegated returns");
  assert.ok(result.returnedArtifacts.length >= 1);
  assert.equal(result.returnedArtifacts[0].artifactKind, "SCENARIO_RUN_RESULT");
  assert.equal(result.returnedArtifacts[0].status, "COMPLETED");
  assert.equal(result.consumedBudget.modelCalls, 1);
  assert.equal(result.consumedBudget.toolCalls, 1);
});

test("E13: Cross-scenario delegation blocks infinite recursion (depth > maxDepth)", async () => {
  const registry = new ScenarioRegistry();
  registry.register(createMockPlugin(CONTROL_SCENARIO_CONTRACT));
  registry.register(createMockPlugin(DATA_ANALYSIS_SCENARIO_CONTRACT));

  const coordinator = new CrossScenarioCoordinator(registry, createHostPorts(), 1);

  const recursiveTask = {
    taskId: "task_collab_recursive_002",
    parentRunId: "run_control_main_88",
    initiatingScenarioId: "control.identification",
    targetScenarioId: "data_analysis.statistical_inference",
    taskKind: "RECURSIVE_CHAIN",
    inputArtifacts: [],
    inheritedBudget: { maxModelCalls: 2, maxToolCalls: 2, remainingDeadlineMs: 10000 },
    recursionDepth: 2, // Exceeds max depth 1
  };

  await assert.rejects(
    async () => coordinator.delegate(recursiveTask),
    /Recursion depth 2 exceeds max permitted depth 1/
  );
});

test("E13: Cross-scenario delegation fails cleanly when budget is exhausted", async () => {
  const registry = new ScenarioRegistry();
  registry.register(createMockPlugin(CONTROL_SCENARIO_CONTRACT));
  registry.register(createMockPlugin(DATA_ANALYSIS_SCENARIO_CONTRACT));

  const coordinator = new CrossScenarioCoordinator(registry, createHostPorts(), 1);

  const exhaustedTask = {
    taskId: "task_collab_exhausted_003",
    parentRunId: "run_control_main_88",
    initiatingScenarioId: "control.identification",
    targetScenarioId: "data_analysis.statistical_inference",
    taskKind: "MODEL_UNCERTAINTY_EVALUATION",
    inputArtifacts: [],
    inheritedBudget: { maxModelCalls: 0, maxToolCalls: 0, remainingDeadlineMs: -100 },
    recursionDepth: 1,
  };

  const result = await coordinator.delegate(exhaustedTask);
  assert.equal(result.status, "FAILED");
  assert.match(result.returnedArtifacts[0].error, /Inherited budget exhausted/);
});
