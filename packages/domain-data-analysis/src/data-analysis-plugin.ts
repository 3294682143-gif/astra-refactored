/**
 * @zygos/domain-data-analysis - Data Analysis Scenario Plugin Definition (E12).
 *
 * Implements ScenarioPlugin for experimental data science, wrapping
 * DATA_ANALYSIS_SCENARIO_CONTRACT and providing Welch t-test statistical inference,
 * normality and homoscedasticity diagnostics, and effect size calculation.
 */

import { defineScenario, type ScenarioPlugin } from "@zygos/scenario-sdk";
import { DATA_ANALYSIS_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { DataAnalysisAdapter } from "./data-analysis-adapter.ts";

export const DATA_ANALYSIS_SCENARIO_PLUGIN: ScenarioPlugin = defineScenario({
  manifest: DATA_ANALYSIS_SCENARIO_CONTRACT.manifest,
  inputs: DATA_ANALYSIS_SCENARIO_CONTRACT.inputs,
  team: DATA_ANALYSIS_SCENARIO_CONTRACT.team,
  results: DATA_ANALYSIS_SCENARIO_CONTRACT.results,
  domain: new DataAnalysisAdapter(),
  tools: [],
  checks: [],
  policy: {
    maxRounds: 5,
    timeoutMs: 60000,
    allowParallelReview: true,
    enableBoundedRepair: true,
    maxRepairs: 1,
    failureHandling: "FAIL_EXPLICIT_UNSOLVED",
  },
  execution: {
    bindingKind: "CONTAINER_WORKER",
    engineTarget: "node_statistical_analyzer",
    entrypoint: "packages/domain-data-analysis/src/statistical-analyzer.ts",
    allowedEngines: ["node", "python_worker"],
    defaultEngine: "node",
    supportsCheckpointResume: false,
  },
});
