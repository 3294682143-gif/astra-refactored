/**
 * @zygos/domain-materials - Materials Science 5th Test Scenario Plugin (E15).
 *
 * Implements Section 6.4:
 * Validates the extensibility hard acceptance criterion:
 * Adding a 5th test scenario requires ONLY adding this scenario package
 * and registration configuration, with ZERO modifications to agent-kernel,
 * runtime-core, or core dispatch logic.
 */

import { defineScenario, type ScenarioPlugin } from "@zygos/scenario-sdk";
import type { ScenarioContract } from "@zygos/domain-contract";
import { MaterialsDomainAdapter } from "./materials-adapter.ts";

export const MATERIALS_SCENARIO_CONTRACT: ScenarioContract = {
  manifest: {
    scenarioId: "materials.bandgap",
    version: "1.0.0",
    name: "Computational Materials Crystal Property & Bandgap Analysis",
    domainType: "materials_science",
    description: "Predict crystal phase stability on convex hull and electronic bandgap under DFT surrogates",
    goals: [
      "CRYSTAL_PROPERTY_PREDICTION",
      "PHASE_STABILITY_ANALYSIS",
    ],
    requiredModelCapabilities: ["structured_outputs", "materials_domain_knowledge"],
    requiresCodeIsolation: true,
  },
  inputs: {
    inputKind: "TABULAR_DATA",
    supportedExtensions: [".cif", ".json", ".csv"],
    requiredFields: ["crystal_formula", "lattice_parameters"],
    optionalFields: ["wyckoff_positions", "dft_functional"],
    dataIsolationPolicy: "READ_ONLY_MOUNT",
  },
  team: {
    teamId: "team_materials_dft",
    scenarioId: "materials.bandgap",
    roles: [
      {
        roleId: "crystallographer",
        name: "Crystallographer & Symmetry Specialist",
        roleCategory: "PLANNER",
        ownedDimension: "LATTICE_SYMMETRY",
        description: "Parse CIF crystal structure, Wyckoff positions, and verify space group invariance",
        triggerCondition: "ALWAYS_ON_INIT",
        contextVisibility: "GOAL_AND_TOOLS",
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "dft_surrogate_worker",
        name: "DFT Surrogate Worker",
        roleCategory: "WORKER",
        ownedDimension: "ELECTRONIC_BANDGAP",
        description: "Invoke surrogate ML/DFT potentials to predict formation energy and band structure",
        triggerCondition: "AFTER_SYMMETRY_VALIDATION",
        contextVisibility: "FULL",
        maxModelCallsPerTask: 3,
      },
      {
        roleId: "thermodynamic_reviewer",
        name: "Phase Convex Hull Reviewer",
        roleCategory: "REVIEWER",
        ownedDimension: "CONVEX_HULL_STABILITY",
        description: "Audit thermodynamic stability distance to convex hull (delta E <= 0.05 eV/atom)",
        triggerCondition: "ON_CANDIDATE_SUBMISSION",
        contextVisibility: "HOLD_OUT_EVALUATION",
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "structure_repairer",
        name: "Crystal Geometry Relaxation Repairer",
        roleCategory: "REPAIRER",
        ownedDimension: "GEOMETRY_RELAXATION",
        description: "Perform bounded atomic position relaxation if hull distance is marginal",
        triggerCondition: "ON_REVIEW_REJECTION",
        contextVisibility: "FULL",
        maxModelCallsPerTask: 2,
      },
    ],
    defaultRoute: "crystallographer -> dft_surrogate_worker -> thermodynamic_reviewer",
    enableParallelReview: false,
    enableBoundedRepair: true,
    maxRepairs: 1,
  },
  results: {
    primaryArtifactKind: "MATERIALS_PROPERTY_REPORT",
    exportedFileNames: ["materials_prediction_report.txt", "band_structure.json"],
    requiredMetrics: ["band_gap_ev", "formation_energy_per_atom_ev", "hull_distance_ev"],
    visualizerComponent: "MaterialsBandStructureCard",
  },
};

export const MATERIALS_SCENARIO_PLUGIN: ScenarioPlugin = defineScenario({
  manifest: MATERIALS_SCENARIO_CONTRACT.manifest,
  inputs: MATERIALS_SCENARIO_CONTRACT.inputs,
  team: MATERIALS_SCENARIO_CONTRACT.team,
  results: MATERIALS_SCENARIO_CONTRACT.results,
  domain: new MaterialsDomainAdapter(),
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
    engineTarget: "materials_surrogate_runner",
    entrypoint: "packages/domain-materials/src/materials-adapter.ts",
    allowedEngines: ["node", "python_worker"],
    defaultEngine: "node",
    supportsCheckpointResume: false,
  },
});
