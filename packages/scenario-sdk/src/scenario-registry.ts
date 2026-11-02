import type {
  ScenarioPlugin,
  ScenarioReadinessStatus,
  ImmutableScenarioSnapshot,
} from "./types.ts";
import type { ScenarioManifest } from "@zygos/domain-contract";
import { defineScenario } from "./define-scenario.ts";

export class ScenarioRegistry {
  private readonly _plugins: Map<string, ScenarioPlugin> = new Map();

  /**
   * Register a scientific scenario plugin.
   * Plugin is strictly validated and frozen via defineScenario.
   */
  public register(plugin: ScenarioPlugin): void {
    const defined = defineScenario(plugin);
    const sid = defined.manifest.scenarioId;
    if (this._plugins.has(sid)) {
      throw new Error(`ScenarioRegistry: Scenario '${sid}' is already registered`);
    }
    this._plugins.set(sid, defined);
  }

  /**
   * Retrieve a registered scenario plugin.
   */
  public get(scenarioId: string): ScenarioPlugin | undefined {
    return this._plugins.get(scenarioId);
  }

  /**
   * Check if a scenario is registered.
   */
  public has(scenarioId: string): boolean {
    return this._plugins.has(scenarioId);
  }

  /**
   * List all registered scenario manifests.
   */
  public list(): readonly ScenarioManifest[] {
    return Array.from(this._plugins.values()).map((p) => p.manifest);
  }

  /**
   * Evaluate whether a scenario is ready to execute given the current environment's capabilities.
   * If required model capabilities or execution tools are missing, reports NOT_READY with explicit missing items.
   */
  public checkReadiness(
    scenarioId: string,
    availableCapabilities: readonly string[],
    isIsolatedRuntimeAvailable: boolean = true
  ): ScenarioReadinessStatus {
    const plugin = this._plugins.get(scenarioId);
    if (!plugin) {
      return {
        scenarioId,
        isReady: false,
        status: "NOT_READY",
        missingCapabilities: ["scenario_not_found"],
        reasons: [`Scenario '${scenarioId}' is not registered`],
      };
    }

    const availableSet = new Set(availableCapabilities);
    const missing: string[] = [];
    const reasons: string[] = [];

    // Check required model capabilities
    for (const req of plugin.manifest.requiredModelCapabilities) {
      if (!availableSet.has(req)) {
        missing.push(req);
        reasons.push(`Missing model capability: ${req}`);
      }
    }

    // Check code isolation requirement
    if (plugin.manifest.requiresCodeIsolation && !isIsolatedRuntimeAvailable) {
      missing.push("sandboxed_execution_worker");
      reasons.push("Requires isolated code execution worker, which is currently unavailable");
    }

    // Check execution binding
    if ((plugin.execution.bindingKind === "DELEGATED_ENGINE" || plugin.execution.bindingKind === "CONTAINER_WORKER") && !availableSet.has(plugin.execution.engineTarget)) {
      missing.push(plugin.execution.engineTarget);
      reasons.push(`Delegated engine '${plugin.execution.engineTarget}' is not active or supported`);
    }

    const isReady = missing.length === 0;
    return {
      scenarioId,
      isReady,
      status: isReady ? "READY" : "NOT_READY",
      missingCapabilities: Object.freeze(missing),
      reasons: Object.freeze(reasons),
    };
  }

  /**
   * Create an immutable snapshot of the scenario configuration for a research run.
   */
  public createSnapshot(scenarioId: string): ImmutableScenarioSnapshot {
    const plugin = this._plugins.get(scenarioId);
    if (!plugin) {
      throw new Error(`Cannot create snapshot: scenario '${scenarioId}' not found`);
    }

    return Object.freeze({
      scenarioId,
      version: plugin.manifest.version,
      snapshotTimestamp: new Date().toISOString(),
      plugin,
    });
  }
}
