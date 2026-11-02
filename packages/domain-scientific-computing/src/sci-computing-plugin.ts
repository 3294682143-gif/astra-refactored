/**
 * @zygos/domain-scientific-computing - Scientific Computing Scenario Plugin Definition (E11).
 *
 * Implements ScenarioPlugin for thermal physics numerical experiments, wrapping
 * SCI_COMPUTING_SCENARIO_CONTRACT and providing PDE discretization, Richardson convergence, and CFL checks.
 */

import { defineScenario, type ScenarioPlugin } from "@zygos/scenario-sdk";
import { SCI_COMPUTING_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ScientificComputingAdapter } from "./scientific-computing-adapter.ts";

export const SCI_COMPUTING_SCENARIO_PLUGIN: ScenarioPlugin = defineScenario({
  manifest: SCI_COMPUTING_SCENARIO_CONTRACT.manifest,
  inputs: SCI_COMPUTING_SCENARIO_CONTRACT.inputs,
  team: SCI_COMPUTING_SCENARIO_CONTRACT.team,
  results: SCI_COMPUTING_SCENARIO_CONTRACT.results,
  domain: new ScientificComputingAdapter(),
  tools: [],
  checks: [],
  policy: {
    maxRounds: 5,
    timeoutMs: 60000,
    allowParallelReview: false,
    enableBoundedRepair: true,
    maxRepairs: 1,
    failureHandling: "FAIL_EXPLICIT_UNSOLVED",
  },
  execution: {
    bindingKind: "CONTAINER_WORKER",
    engineTarget: "node_heat_equation_solver",
    entrypoint: "packages/domain-scientific-computing/src/heat-equation-solver.ts",
    allowedEngines: ["node", "python_worker"],
    defaultEngine: "node",
    supportsCheckpointResume: false,
  },
});
