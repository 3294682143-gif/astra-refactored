import test from "node:test";
import assert from "node:assert/strict";

import { MATH_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ScenarioRegistry } from "../../scenario-sdk/src/index.ts";
import { MATH_SCENARIO_PLUGIN } from "../dist/src/math-plugin.js";

test("E07: MATH_SCENARIO_PLUGIN conforms to scenario contract", () => {
  assert.equal(MATH_SCENARIO_PLUGIN.manifest.scenarioId, "math.research");
  assert.equal(MATH_SCENARIO_PLUGIN.manifest.name, "数学研究场景");
  assert.equal(MATH_SCENARIO_PLUGIN.manifest.domainType, "mathematics");
  assert.equal(MATH_SCENARIO_PLUGIN.execution.bindingKind, "DELEGATED_ENGINE");
  assert.equal(MATH_SCENARIO_PLUGIN.execution.engineTarget, "ts");
  assert.equal(MATH_SCENARIO_PLUGIN.execution.entrypoint, "mathagent.user_agent.ReasoningAgent");
  assert.deepEqual(Array.from(MATH_SCENARIO_PLUGIN.execution.allowedEngines), ["ts", "legacy", "lite"]);
  assert.equal(MATH_SCENARIO_PLUGIN.execution.supportsCheckpointResume, true);
});

test("E07: MATH_SCENARIO_PLUGIN registers into ScenarioRegistry and passes readiness check", () => {
  const registry = new ScenarioRegistry();
  registry.register(MATH_SCENARIO_PLUGIN);

  assert.equal(registry.has("math.research"), true);
  const retrieved = registry.get("math.research");
  assert.ok(retrieved);

  // Missing capabilities check
  const notReady = registry.checkReadiness("math.research", ["unrelated_cap"]);
  assert.equal(notReady.isReady, false);
  assert.equal(notReady.status, "NOT_READY");

  // With required capabilities and ts engine
  const ready = registry.checkReadiness(
    "math.research",
    ["mathematical_reasoning", "tool_calling", "ts"],
    true
  );
  assert.equal(ready.isReady, true);
  assert.equal(ready.status, "READY");
});

test("E07: MATH_SCENARIO_PLUGIN produces immutable snapshot", () => {
  const registry = new ScenarioRegistry();
  registry.register(MATH_SCENARIO_PLUGIN);

  const snapshot = registry.createSnapshot("math.research");
  assert.equal(snapshot.scenarioId, "math.research");
  assert.equal(snapshot.version, "1.0.0");
  assert.ok(snapshot.snapshotTimestamp);
  assert.ok(Object.isFrozen(snapshot));
});
