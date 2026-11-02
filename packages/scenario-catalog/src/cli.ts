import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import type { ScenarioPlugin } from "@zygos/scenario-sdk";
import { createProductionScenarioRegistry, createScenarioCatalog } from "./index.js";

function stringListEnv(name: string): readonly string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

async function loadExtraPlugins(): Promise<readonly ScenarioPlugin[]> {
  const plugins: ScenarioPlugin[] = [];
  for (const specifier of stringListEnv("ASTRA_SCENARIO_PLUGIN_MODULES")) {
    const resolved = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
    const module = await import(resolved) as Record<string, unknown>;
    for (const exported of Object.values(module)) {
      if (exported && typeof exported === "object" && "manifest" in exported && "domain" in exported) {
        plugins.push(exported as ScenarioPlugin);
      }
    }
  }
  return plugins;
}

const extraPlugins = await loadExtraPlugins();
const registry = createProductionScenarioRegistry(extraPlugins);
const availableCapabilities = stringListEnv("ASTRA_SCENARIO_AVAILABLE_CAPABILITIES");
const isolatedRuntimeAvailable = process.env.ASTRA_ISOLATED_WORKER_AVAILABLE === "true";
const scenarios = createScenarioCatalog(registry, availableCapabilities, isolatedRuntimeAvailable);
process.stdout.write(JSON.stringify({ scenarios, count: scenarios.length }));
