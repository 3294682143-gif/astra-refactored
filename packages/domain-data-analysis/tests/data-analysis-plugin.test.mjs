import test from "node:test";
import assert from "node:assert/strict";

import { DATA_ANALYSIS_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ScenarioRegistry } from "../../scenario-sdk/src/index.ts";
import { DATA_ANALYSIS_SCENARIO_PLUGIN } from "../dist/src/data-analysis-plugin.js";

test("E12: DATA_ANALYSIS_SCENARIO_PLUGIN conforms to scenario contract", () => {
  assert.equal(DATA_ANALYSIS_SCENARIO_PLUGIN.manifest.scenarioId, "data_analysis.statistical_inference");
  assert.equal(DATA_ANALYSIS_SCENARIO_PLUGIN.manifest.domainType, "scientific_data_analysis");
  assert.equal(DATA_ANALYSIS_SCENARIO_PLUGIN.inputs.inputKind, "TABULAR_DATA");
  assert.equal(DATA_ANALYSIS_SCENARIO_PLUGIN.results.primaryArtifactKind, "STATISTICAL_INFERENCE_PACK");
  assert.equal(DATA_ANALYSIS_SCENARIO_PLUGIN.manifest.requiresCodeIsolation, true);
});

test("E12: DATA_ANALYSIS_SCENARIO_PLUGIN registers into ScenarioRegistry and checks readiness", () => {
  const registry = new ScenarioRegistry();
  registry.register(DATA_ANALYSIS_SCENARIO_PLUGIN);

  assert.equal(registry.has("data_analysis.statistical_inference"), true);

  // Missing code isolation worker or capabilities
  const notReady = registry.checkReadiness("data_analysis.statistical_inference", ["unrelated"], false);
  assert.equal(notReady.isReady, false);

  // With required capabilities and isolation available
  const ready = registry.checkReadiness(
    "data_analysis.statistical_inference",
    ["statistical_analysis", "data_understanding", "node_statistical_analyzer"],
    true
  );
  assert.equal(ready.isReady, true);
  assert.equal(ready.status, "READY");
});
