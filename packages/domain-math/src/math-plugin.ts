/**
 * @zygos/domain-math - Math Scenario Plugin Definition (E07).
 *
 * Implements ScenarioPlugin for mathematics, wrapping MATH_SCENARIO_CONTRACT
 * and delegating execution to the Astra mathematical production chain (ts/legacy/lite).
 */

import { defineScenario, type ScenarioPlugin } from "@zygos/scenario-sdk";
import { MATH_SCENARIO_CONTRACT } from "@zygos/domain-contract";
import { MathDomainAdapter } from "./math-adapter.ts";

export const MATH_SCENARIO_PLUGIN: ScenarioPlugin = defineScenario({
  manifest: MATH_SCENARIO_CONTRACT.manifest,
  inputs: MATH_SCENARIO_CONTRACT.inputs,
  team: MATH_SCENARIO_CONTRACT.team,
  results: MATH_SCENARIO_CONTRACT.results,
  domain: new MathDomainAdapter(),
  tools: [],
  checks: [],
  policy: {
    maxRounds: 5,
    timeoutMs: 60000,
    allowParallelReview: false,
    enableBoundedRepair: true,
    maxRepairs: 2,
    failureHandling: "FAIL_EXPLICIT_UNSOLVED",
  },
  execution: {
    bindingKind: "DELEGATED_ENGINE",
    engineTarget: "ts",
    entrypoint: "mathagent.user_agent.ReasoningAgent",
    allowedEngines: ["ts", "legacy", "lite"],
    defaultEngine: "ts",
    supportsCheckpointResume: true,
  },
});
