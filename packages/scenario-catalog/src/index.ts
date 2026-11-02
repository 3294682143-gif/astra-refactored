import { ScenarioRegistry, type ScenarioPlugin } from "@zygos/scenario-sdk";
import { MATH_SCENARIO_PLUGIN } from "@zygos/domain-math";
import { CONTROL_SCENARIO_PLUGIN } from "@zygos/domain-control";
import { SCI_COMPUTING_SCENARIO_PLUGIN } from "@zygos/domain-scientific-computing";
import { DATA_ANALYSIS_SCENARIO_PLUGIN } from "@zygos/domain-data-analysis";

const DOMAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "math.research": "math",
  "control.identification": "control.identification",
  "scientific_computing.heat_transfer": "scientific_computing",
  "data_analysis.statistical_inference": "data_analysis",
});

export function createProductionScenarioRegistry(extraPlugins: readonly ScenarioPlugin[] = []): ScenarioRegistry {
  const registry = new ScenarioRegistry();
  const plugins = [
    MATH_SCENARIO_PLUGIN,
    CONTROL_SCENARIO_PLUGIN,
    SCI_COMPUTING_SCENARIO_PLUGIN,
    DATA_ANALYSIS_SCENARIO_PLUGIN,
    ...extraPlugins,
  ];
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  return registry;
}

export function createScenarioCatalog(
  registry: ScenarioRegistry,
  availableCapabilities: readonly string[],
  isolatedRuntimeAvailable: boolean,
) {
  return registry.list().map((manifest) => {
    const plugin = registry.get(manifest.scenarioId);
    if (!plugin) {
      throw new Error(`Scenario '${manifest.scenarioId}' disappeared from registry`);
    }
    const readiness = registry.checkReadiness(manifest.scenarioId, availableCapabilities, isolatedRuntimeAvailable);
    return {
      scenarioId: manifest.scenarioId,
      domainId: DOMAIN_IDS[manifest.scenarioId] ?? manifest.scenarioId,
      version: manifest.version,
      name: manifest.name,
      domainType: manifest.domainType,
      description: manifest.description,
      goals: manifest.goals,
      teamRolesCount: plugin.team.roles.length,
      inputKind: plugin.inputs.inputKind,
      visualizerComponent: plugin.results.visualizerComponent,
      readinessStatus: readiness.status,
      readinessReasons: readiness.reasons,
      manifest,
      inputs: plugin.inputs,
      team: plugin.team,
      results: plugin.results,
    };
  });
}
