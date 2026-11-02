import test from "node:test";
import assert from "node:assert/strict";

import { CONTROL_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ScenarioRegistry } from "../../scenario-sdk/src/index.ts";
import { CONTROL_SCENARIO_PLUGIN } from "../dist/src/control-plugin.js";

test("E10: CONTROL_SCENARIO_PLUGIN conforms to scenario contract", () => {
  assert.equal(CONTROL_SCENARIO_PLUGIN.manifest.scenarioId, "control.identification");
  assert.equal(CONTROL_SCENARIO_PLUGIN.manifest.domainType, "engineering_control");
  assert.equal(CONTROL_SCENARIO_PLUGIN.inputs.inputKind, "TIMESERIES_DATA");
  assert.equal(CONTROL_SCENARIO_PLUGIN.results.primaryArtifactKind, "DYNAMICS_IDENTIFICATION_PACK");
  assert.equal(CONTROL_SCENARIO_PLUGIN.manifest.requiresCodeIsolation, true);
});

test("E10: CONTROL_SCENARIO_PLUGIN registers into ScenarioRegistry and checks readiness", () => {
  const registry = new ScenarioRegistry();
  registry.register(CONTROL_SCENARIO_PLUGIN);

  assert.equal(registry.has("control.identification"), true);

  // Missing code isolation worker or capabilities
  const notReady = registry.checkReadiness("control.identification", ["unrelated"], false);
  assert.equal(notReady.isReady, false);

  // With required capabilities and isolation available
  const ready = registry.checkReadiness(
    "control.identification",
    ["scientific_reasoning", "data_understanding", "node_parameter_estimator"],
    true
  );
  assert.equal(ready.isReady, true);
  assert.equal(ready.status, "READY");
});
