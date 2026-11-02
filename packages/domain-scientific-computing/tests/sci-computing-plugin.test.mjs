import test from "node:test";
import assert from "node:assert/strict";

import { SCI_COMPUTING_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ScenarioRegistry } from "../../scenario-sdk/src/index.ts";
import { SCI_COMPUTING_SCENARIO_PLUGIN } from "../dist/src/sci-computing-plugin.js";

test("E11: SCI_COMPUTING_SCENARIO_PLUGIN conforms to scenario contract", () => {
  assert.equal(SCI_COMPUTING_SCENARIO_PLUGIN.manifest.scenarioId, "scientific_computing.heat_transfer");
  assert.equal(SCI_COMPUTING_SCENARIO_PLUGIN.manifest.domainType, "computational_science");
  assert.equal(SCI_COMPUTING_SCENARIO_PLUGIN.inputs.inputKind, "PDE_EXPERIMENT_SPEC");
  assert.equal(SCI_COMPUTING_SCENARIO_PLUGIN.results.primaryArtifactKind, "THERMAL_SIMULATION_PACK");
  assert.equal(SCI_COMPUTING_SCENARIO_PLUGIN.manifest.requiresCodeIsolation, true);
});

test("E11: SCI_COMPUTING_SCENARIO_PLUGIN registers into ScenarioRegistry and checks readiness", () => {
  const registry = new ScenarioRegistry();
  registry.register(SCI_COMPUTING_SCENARIO_PLUGIN);

  assert.equal(registry.has("scientific_computing.heat_transfer"), true);

  // Missing code isolation worker or capabilities
  const notReady = registry.checkReadiness("scientific_computing.heat_transfer", ["unrelated"], false);
  assert.equal(notReady.isReady, false);

  // With required capabilities and isolation available
  const ready = registry.checkReadiness(
    "scientific_computing.heat_transfer",
    ["scientific_reasoning", "numerical_methods", "node_heat_equation_solver"],
    true
  );
  assert.equal(ready.isReady, true);
  assert.equal(ready.status, "READY");
});
