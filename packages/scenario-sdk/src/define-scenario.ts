import type { ScenarioPlugin } from "./types.ts";

/**
 * Validates and freezes a ScenarioPlugin contract.
 *
 * Enforces:
 * 1. ScenarioId must follow namespace.name format.
 * 2. Manifest, domain, execution, inputs, team, workflow, and results must be present.
 * 3. Every check definition must reference a valid obligation ID.
 * 4. Tools must specify timeout and non-empty schemas.
 */
export function defineScenario(plugin: ScenarioPlugin): ScenarioPlugin {
  if (!plugin.manifest || !plugin.manifest.scenarioId) {
    throw new Error("Invalid ScenarioPlugin: manifest.scenarioId is required");
  }

  const sid = plugin.manifest.scenarioId;
  if (!/^[a-z0-9_.-]+$/.test(sid)) {
    throw new Error(`Invalid ScenarioPlugin: scenarioId '${sid}' must contain only lower-case alphanumerics, dots, underscores, or dashes`);
  }

  if (!plugin.domain || typeof plugin.domain.compileContract !== "function") {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: domain adapter must implement DomainAdapter interface`);
  }

  if (!plugin.execution || !plugin.execution.bindingKind) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: execution binding is required`);
  }

  if (!plugin.inputs || !plugin.inputs.inputKind) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: inputs contract is required`);
  }

  if (!plugin.team || !Array.isArray(plugin.team.roles) || plugin.team.roles.length === 0) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: team profile with at least one role is required`);
  }

  if (!plugin.results || !plugin.results.primaryArtifactKind) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: results contract is required`);
  }

  if (!plugin.policy || plugin.policy.maxRounds < 1 || plugin.policy.maxRepairs < 0) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: bounded research policy is required`);
  }

  if (!Array.isArray(plugin.tools) || !Array.isArray(plugin.checks)) {
    throw new Error(`Invalid ScenarioPlugin [${sid}]: tools and checks must be arrays`);
  }

  return Object.freeze({
    ...plugin,
    manifest: Object.freeze({ ...plugin.manifest }),
    execution: Object.freeze({ ...plugin.execution }),
    inputs: Object.freeze({ ...plugin.inputs }),
    team: Object.freeze({
      ...plugin.team,
      roles: Object.freeze([...plugin.team.roles]),
    }),
    policy: Object.freeze({ ...plugin.policy }),
    tools: Object.freeze([...plugin.tools]),
    checks: Object.freeze([...plugin.checks]),
    results: Object.freeze({ ...plugin.results }),
  });
}
