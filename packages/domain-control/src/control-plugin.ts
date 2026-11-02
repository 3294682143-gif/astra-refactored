/**
 * @zygos/domain-control - Control Scenario Plugin Definition (E10).
 *
 * Implements ScenarioPlugin for dynamics & control, wrapping CONTROL_SCENARIO_CONTRACT
 * and providing system identification and holdout prediction for forced damped oscillators.
 */

import { defineScenario, type ScenarioPlugin } from "@zygos/scenario-sdk";
import { CONTROL_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { ControlDomainAdapter } from "./control-adapter.ts";

export const CONTROL_SCENARIO_PLUGIN: ScenarioPlugin = defineScenario({
  manifest: CONTROL_SCENARIO_CONTRACT.manifest,
  inputs: CONTROL_SCENARIO_CONTRACT.inputs,
  team: CONTROL_SCENARIO_CONTRACT.team,
  results: CONTROL_SCENARIO_CONTRACT.results,
  domain: new ControlDomainAdapter(),
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
    engineTarget: "node_parameter_estimator",
    entrypoint: "packages/domain-control/src/parameter-estimator.ts",
    allowedEngines: ["node", "python_worker"],
    defaultEngine: "node",
    supportsCheckpointResume: false,
  },
});
