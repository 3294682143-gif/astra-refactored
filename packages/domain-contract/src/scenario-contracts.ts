/**
 * @zygos/domain-contract - ScenarioPlugin and Team Contracts (E02).
 *
 * Implements Section 4.2 & Section 6.4 of the Unified Scientific Multi-Agent Execution Plan:
 * 1. ScenarioManifest & TeamProfile definitions
 * 2. ScenarioInputContract & ScenarioResultContract specifications
 * 3. Standard manifests and multi-agent roles for all 4 science scenarios
 * 4. Engine -> Role -> Context -> AgentId Source Mapping Table
 */

export interface ScenarioManifest {
  readonly scenarioId: string;
  readonly version: string;
  readonly name: string;
  readonly domainType: string;
  readonly description: string;
  readonly goals: readonly string[];
  readonly requiredModelCapabilities: readonly string[];
  readonly requiresCodeIsolation: boolean;
}

export interface AgentRoleDefinition {
  readonly roleId: string;
  readonly name: string;
  readonly roleCategory: "PLANNER" | "WORKER" | "REVIEWER" | "REPAIRER" | "VALIDATOR";
  readonly ownedDimension: string;
  readonly description: string;
  readonly triggerCondition: string;
  readonly contextVisibility: "FULL" | "GOAL_AND_TOOLS" | "CANDIDATE_ONLY" | "HOLD_OUT_EVALUATION";
  readonly maxModelCallsPerTask: number;
}

export interface TeamProfile {
  readonly teamId: string;
  readonly scenarioId: string;
  readonly roles: readonly AgentRoleDefinition[];
  readonly defaultRoute: string;
  readonly enableParallelReview: boolean;
  readonly enableBoundedRepair: boolean;
  readonly maxRepairs: number;
}

export interface ScenarioInputContract {
  readonly inputKind: "PROBLEM_STATEMENT" | "TIMESERIES_DATA" | "PDE_EXPERIMENT_SPEC" | "TABULAR_DATA";
  readonly supportedExtensions: readonly string[];
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly dataIsolationPolicy: "NONE" | "TRAIN_HOLDOUT_SPLIT" | "READ_ONLY_MOUNT";
}

export interface ScenarioResultContract {
  readonly primaryArtifactKind: string;
  readonly exportedFileNames: readonly string[];
  readonly requiredMetrics: readonly string[];
  readonly visualizerComponent: string;
}

export interface ScenarioContract {
  readonly manifest: ScenarioManifest;
  readonly inputs: ScenarioInputContract;
  readonly team: TeamProfile;
  readonly results: ScenarioResultContract;
}

// ============================================================================
// Standard Scenario Manifests & Team Profiles (4 Core Science Scenarios)
// ============================================================================

export const MATH_SCENARIO_CONTRACT: ScenarioContract = {
  manifest: {
    scenarioId: "math.research",
    version: "1.0.0",
    name: "数学研究场景",
    domainType: "mathematics",
    description: "数学问题的符号计算、定理推导、反例搜索与证据审计研究闭环",
    goals: ["SYMBOLIC_CALCULATION", "PROOF_SYNTHESIS", "COUNTEREXAMPLE_SEARCH"],
    requiredModelCapabilities: ["mathematical_reasoning", "tool_calling"],
    requiresCodeIsolation: false,
  },
  inputs: {
    inputKind: "PROBLEM_STATEMENT" as const,
    supportedExtensions: [".txt", ".tex", ".json"],
    requiredFields: ["problemText"],
    optionalFields: ["domainHints", "assumptions", "boundaryConditions"],
    dataIsolationPolicy: "NONE" as const,
  },
  team: {
    teamId: "math_research_team",
    scenarioId: "math.research",
    roles: [
      {
        roleId: "math_problem_analyst",
        name: "问题分析与义务分解 Agent",
        roleCategory: "PLANNER" as const,
        ownedDimension: "PROBLEM_ALIGNMENT",
        description: "提取原题约束、定义域、参数范围，建立严格待求义务清单",
        triggerCondition: "STAGE_START",
        contextVisibility: "FULL" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "math_solver_worker",
        name: "多路线推导 Agent",
        roleCategory: "WORKER" as const,
        ownedDimension: "DERIVATION_AND_TOOLS",
        description: "调用注册数学工具与符号系统生成推导候选与见证",
        triggerCondition: "PLAN_ADMITTED",
        contextVisibility: "GOAL_AND_TOOLS" as const,
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "math_rigor_reviewer",
        name: "反例与严谨性审查 Agent",
        roleCategory: "REVIEWER" as const,
        ownedDimension: "COUNTEREXAMPLE_AND_RIGOR",
        description: "审查定义域漏根、极值点假说、边界条件遗漏并提出质疑",
        triggerCondition: "CANDIDATE_PROPOSED",
        contextVisibility: "CANDIDATE_ONLY" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "math_repairer",
        name: "证据修复 Agent",
        roleCategory: "REPAIRER" as const,
        ownedDimension: "TARGETED_REPAIR",
        description: "针对合法质疑在有限配额内修正候选解，保留父候选血统",
        triggerCondition: "CHALLENGE_PERSISTED",
        contextVisibility: "FULL" as const,
        maxModelCallsPerTask: 1,
      },
    ],
    defaultRoute: "canonical_symbolic",
    enableParallelReview: true,
    enableBoundedRepair: true,
    maxRepairs: 1,
  },
  results: {
    primaryArtifactKind: "MATHEMATICAL_DERIVATION_PACK",
    exportedFileNames: ["mathematical_solution.json", "audit_receipts.json"],
    requiredMetrics: ["toolCalls", "obligationsSatisfied", "auditEvidenceLevel"],
    visualizerComponent: "MathDerivationView",
  },
};

export const CONTROL_SCENARIO_CONTRACT: ScenarioContract = {
  manifest: {
    scenarioId: "control.identification",
    version: "1.0.0",
    name: "动力学与控制研究场景",
    domainType: "engineering_control",
    description: "从真实时序数据进行受迫振子系统参数辨识、抗混叠诊断与留出前向预测验证",
    goals: ["SYSTEM_IDENTIFICATION", "INDEPENDENT_PREDICTION"],
    requiredModelCapabilities: ["scientific_reasoning", "data_understanding"],
    requiresCodeIsolation: true,
  },
  inputs: {
    inputKind: "TIMESERIES_DATA" as const,
    supportedExtensions: [".csv", ".tsv", ".json"],
    requiredFields: ["timeColumn", "excitationColumn", "responseColumn"],
    optionalFields: ["samplingFrequency", "physicalBounds", "holdoutRatio"],
    dataIsolationPolicy: "TRAIN_HOLDOUT_SPLIT" as const,
  },
  team: {
    teamId: "control_dynamics_team",
    scenarioId: "control.identification",
    roles: [
      {
        roleId: "control_modeling_planner",
        name: "系统建模与采样审查 Agent",
        roleCategory: "PLANNER" as const,
        ownedDimension: "SAMPLING_AND_MODEL_FORM",
        description: "核查采样率防混叠（fs >= 10x 带宽），划分训练集与 20% 留出验证集",
        triggerCondition: "STAGE_START",
        contextVisibility: "FULL" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "control_estimation_worker",
        name: "动力学参数估计 Agent",
        roleCategory: "WORKER" as const,
        ownedDimension: "PARAMETER_ESTIMATION",
        description: "在训练集上利用物理工具执行 m, c, k 最小二乘或状态空间辨识",
        triggerCondition: "PLAN_ADMITTED",
        contextVisibility: "GOAL_AND_TOOLS" as const,
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "control_residual_reviewer",
        name: "残差白性与物理边界审查 Agent",
        roleCategory: "REVIEWER" as const,
        ownedDimension: "RESIDUAL_WHITENESS",
        description: "核查物理正定性（m>0, c>0, k>0）及残差自相关，识别未建模动态",
        triggerCondition: "CANDIDATE_PROPOSED",
        contextVisibility: "CANDIDATE_ONLY" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "control_validation_checker",
        name: "独立前向预测验证 Agent",
        roleCategory: "VALIDATOR" as const,
        ownedDimension: "HOLDOUT_PREDICTION_RMSE",
        description: "在未参与辨识的留出测试集上前向积分仿真，计算独立 RMSE 与置信区间",
        triggerCondition: "CANDIDATE_ADMITTED",
        contextVisibility: "HOLD_OUT_EVALUATION" as const,
        maxModelCallsPerTask: 1,
      },
    ],
    defaultRoute: "forced_damped_oscillator_fit",
    enableParallelReview: false,
    enableBoundedRepair: true,
    maxRepairs: 1,
  },
  results: {
    primaryArtifactKind: "DYNAMICS_IDENTIFICATION_PACK",
    exportedFileNames: ["system_identification_report.txt", "identified_parameters.json"],
    requiredMetrics: ["mass", "damping", "stiffness", "holdoutRmse", "whitenessPValue"],
    visualizerComponent: "ControlDynamicsView",
  },
};

export const SCI_COMPUTING_SCENARIO_CONTRACT: ScenarioContract = {
  manifest: {
    scenarioId: "scientific_computing.heat_transfer",
    version: "1.0.0",
    name: "热物理数值实验场景",
    domainType: "computational_science",
    description: "一维传热与扩散偏微分方程有限差分实验、CFL 稳定性核验与网格收敛阶诊断",
    goals: ["NUMERICAL_EXPERIMENT", "METHOD_REPLICATION"],
    requiredModelCapabilities: ["scientific_reasoning", "numerical_methods"],
    requiresCodeIsolation: true,
  },
  inputs: {
    inputKind: "PDE_EXPERIMENT_SPEC" as const,
    supportedExtensions: [".json", ".csv"],
    requiredFields: ["diffusivityAlpha", "length", "timeFinal", "initialCondition", "boundaryConditions"],
    optionalFields: ["gridResolution", "cflTarget"],
    dataIsolationPolicy: "READ_ONLY_MOUNT" as const,
  },
  team: {
    teamId: "thermal_computing_team",
    scenarioId: "scientific_computing.heat_transfer",
    roles: [
      {
        roleId: "thermal_discretization_planner",
        name: "数值离散与网格规划 Agent",
        roleCategory: "PLANNER" as const,
        ownedDimension: "DISCRETIZATION_AND_CFL",
        description: "根据扩散系数和目标步长核验 CFL 稳定性条件（dt <= dx^2 / (2*alpha)）",
        triggerCondition: "STAGE_START",
        contextVisibility: "FULL" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "thermal_solver_worker",
        name: "数值实验求解 Agent",
        roleCategory: "WORKER" as const,
        ownedDimension: "PDE_INTEGRATION",
        description: "调用有限差分数值求解器开展多网格计算与温度场演化模拟",
        triggerCondition: "PLAN_ADMITTED",
        contextVisibility: "GOAL_AND_TOOLS" as const,
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "thermal_convergence_reviewer",
        name: "网格渐近收敛阶审查 Agent",
        roleCategory: "REVIEWER" as const,
        ownedDimension: "RICHARDSON_CONVERGENCE",
        description: "核验多重网格细化（h -> h/2 -> h/4）的 Richardson 外推收敛性与阶数",
        triggerCondition: "CANDIDATE_PROPOSED",
        contextVisibility: "CANDIDATE_ONLY" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "thermal_boundary_checker",
        name: "初边值一致性与通量守恒 Agent",
        roleCategory: "VALIDATOR" as const,
        ownedDimension: "BOUNDARY_CONSERVATION",
        description: "核对边界条件是否欠缺或失真，校验积分热通量守恒性",
        triggerCondition: "CANDIDATE_ADMITTED",
        contextVisibility: "HOLD_OUT_EVALUATION" as const,
        maxModelCallsPerTask: 1,
      },
    ],
    defaultRoute: "ftcs_diffusion_solve",
    enableParallelReview: true,
    enableBoundedRepair: true,
    maxRepairs: 1,
  },
  results: {
    primaryArtifactKind: "THERMAL_SIMULATION_PACK",
    exportedFileNames: ["temperature_distribution.json", "convergence_report.json"],
    requiredMetrics: ["alpha", "gridResidual", "observedConvergenceOrder", "cflSatisfied"],
    visualizerComponent: "ThermalSimulationView",
  },
};

export const DATA_ANALYSIS_SCENARIO_CONTRACT: ScenarioContract = {
  manifest: {
    scenarioId: "data_analysis.statistical_inference",
    version: "1.0.0",
    name: "实验数据科学研究场景",
    domainType: "scientific_data_analysis",
    description: "真实实验或观测数据的统计假设检验、正态与同方差诊断、效应量与稳健性分析",
    goals: ["STATISTICAL_INFERENCE", "DATA_QUALITY_ASSURANCE"],
    requiredModelCapabilities: ["statistical_analysis", "data_understanding"],
    requiresCodeIsolation: true,
  },
  inputs: {
    inputKind: "TABULAR_DATA" as const,
    supportedExtensions: [".csv", ".tsv", ".parquet"],
    requiredFields: ["groupColumn", "valueColumn"],
    optionalFields: ["covariateColumns", "alphaLevel", "alternativeHypothesis"],
    dataIsolationPolicy: "READ_ONLY_MOUNT" as const,
  },
  team: {
    teamId: "data_science_team",
    scenarioId: "data_analysis.statistical_inference",
    roles: [
      {
        roleId: "data_study_designer",
        name: "实验设计与假设理解 Agent",
        roleCategory: "PLANNER" as const,
        ownedDimension: "STUDY_DESIGN_AND_POWER",
        description: "解析实验设计（双样本对照/重复测量）、设定显著性水平与假设检验方向",
        triggerCondition: "STAGE_START",
        contextVisibility: "FULL" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "data_statistical_worker",
        name: "统计建模与检验 Agent",
        roleCategory: "WORKER" as const,
        ownedDimension: "HYPOTHESIS_TESTING",
        description: "调用统计分析工具计算统计量、自由度、p 值及 Cohen's d 效应量与置信区间",
        triggerCondition: "PLAN_ADMITTED",
        contextVisibility: "GOAL_AND_TOOLS" as const,
        maxModelCallsPerTask: 2,
      },
      {
        roleId: "data_assumption_diagnostician",
        name: "统计前提与数据质量诊断 Agent",
        roleCategory: "REVIEWER" as const,
        ownedDimension: "NORMALITY_AND_HOMOSCEDASTICITY",
        description: "执行 Shapiro-Wilk 正态性检验与 Levene 方差齐性检验，指出非参数替代需求",
        triggerCondition: "CANDIDATE_PROPOSED",
        contextVisibility: "CANDIDATE_ONLY" as const,
        maxModelCallsPerTask: 1,
      },
      {
        roleId: "data_robustness_reviewer",
        name: "稳健性与离群值敏感度审查 Agent",
        roleCategory: "VALIDATOR" as const,
        ownedDimension: "ROBUSTNESS_AND_EFFECT_SIZE",
        description: "检查离群值对抗性扰动对结论的影响，核验效应量实用价值与数据泄漏",
        triggerCondition: "CANDIDATE_ADMITTED",
        contextVisibility: "HOLD_OUT_EVALUATION" as const,
        maxModelCallsPerTask: 1,
      },
    ],
    defaultRoute: "welch_t_test_inference",
    enableParallelReview: true,
    enableBoundedRepair: true,
    maxRepairs: 1,
  },
  results: {
    primaryArtifactKind: "STATISTICAL_INFERENCE_PACK",
    exportedFileNames: ["statistical_report.json", "diagnostic_metrics.json"],
    requiredMetrics: ["tStatistic", "pValue", "cohensD", "confidenceInterval", "isSignificant"],
    visualizerComponent: "StatisticalAnalysisView",
  },
};

export const ALL_SCENARIO_CONTRACTS: Readonly<Record<string, ScenarioContract>> = Object.freeze({
  "math.research": MATH_SCENARIO_CONTRACT,
  "control.identification": CONTROL_SCENARIO_CONTRACT,
  "scientific_computing.heat_transfer": SCI_COMPUTING_SCENARIO_CONTRACT,
  "data_analysis.statistical_inference": DATA_ANALYSIS_SCENARIO_CONTRACT,
});

// ============================================================================
// Engine -> Role -> Context -> AgentId Source Mapping Table (§4.2)
// ============================================================================

export interface RoleSourceMappingEntry {
  readonly sourceEngine: "ts" | "legacy" | "lite";
  readonly legacyRoleOrStage: string;
  readonly triggerCondition: string;
  readonly contextVisibility: string;
  readonly targetScenarioId: string;
  readonly targetRoleId: string;
  readonly targetAgentId: string;
  readonly budgetCapCalls: number;
}

export const ROLE_SOURCE_MAPPINGS: readonly RoleSourceMappingEntry[] = Object.freeze([
  // Math TS Engine Mappings
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "R0:MEANING",
    triggerCondition: "maxR0=1 AND STAGE=R0",
    contextVisibility: "GOAL_ONLY",
    targetScenarioId: "math.research",
    targetRoleId: "math_problem_analyst",
    targetAgentId: "agent_math_analyst_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "WORK:ROUTE_1",
    triggerCondition: "WORK_UNIT_ADMITTED",
    contextVisibility: "GOAL_AND_TOOLS",
    targetScenarioId: "math.research",
    targetRoleId: "math_solver_worker",
    targetAgentId: "agent_math_solver_01",
    budgetCapCalls: 2,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "R0:METHOD",
    triggerCondition: "maxR0=1 AND STAGE=R0",
    contextVisibility: "METHODS_ONLY",
    targetScenarioId: "math.research",
    targetRoleId: "math_rigor_reviewer",
    targetAgentId: "agent_math_reviewer_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "REPAIR:ROUTE_REPAIR",
    triggerCondition: "CHALLENGE_PERSISTED AND maxRepairs>=1",
    contextVisibility: "FULL",
    targetScenarioId: "math.research",
    targetRoleId: "math_repairer",
    targetAgentId: "agent_math_repairer_01",
    budgetCapCalls: 1,
  },

  // Control Scenario Mappings
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "CONTROL_PLANNER",
    triggerCondition: "SCENARIO_ENTRY",
    contextVisibility: "FULL",
    targetScenarioId: "control.identification",
    targetRoleId: "control_modeling_planner",
    targetAgentId: "agent_control_planner_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "CONTROL_ESTIMATOR",
    triggerCondition: "DATASET_LOADED",
    contextVisibility: "GOAL_AND_TOOLS",
    targetScenarioId: "control.identification",
    targetRoleId: "control_estimation_worker",
    targetAgentId: "agent_control_worker_01",
    budgetCapCalls: 2,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "CONTROL_RESIDUAL_REVIEWER",
    triggerCondition: "PARAMS_PROPOSED",
    contextVisibility: "CANDIDATE_ONLY",
    targetScenarioId: "control.identification",
    targetRoleId: "control_residual_reviewer",
    targetAgentId: "agent_control_reviewer_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "CONTROL_HOLDOUT_VALIDATOR",
    triggerCondition: "RESIDUAL_ACCEPTED",
    contextVisibility: "HOLD_OUT_EVALUATION",
    targetScenarioId: "control.identification",
    targetRoleId: "control_validation_checker",
    targetAgentId: "agent_control_validator_01",
    budgetCapCalls: 1,
  },

  // Scientific Computing Scenario Mappings
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "SCICOMP_DISCRETIZER",
    triggerCondition: "SCENARIO_ENTRY",
    contextVisibility: "FULL",
    targetScenarioId: "scientific_computing.heat_transfer",
    targetRoleId: "thermal_discretization_planner",
    targetAgentId: "agent_thermal_planner_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "SCICOMP_SOLVER",
    triggerCondition: "GRID_APPROVED",
    contextVisibility: "GOAL_AND_TOOLS",
    targetScenarioId: "scientific_computing.heat_transfer",
    targetRoleId: "thermal_solver_worker",
    targetAgentId: "agent_thermal_worker_01",
    budgetCapCalls: 2,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "SCICOMP_CONVERGENCE_REVIEWER",
    triggerCondition: "MULTIGRID_SIMULATED",
    contextVisibility: "CANDIDATE_ONLY",
    targetScenarioId: "scientific_computing.heat_transfer",
    targetRoleId: "thermal_convergence_reviewer",
    targetAgentId: "agent_thermal_reviewer_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "SCICOMP_FLUX_VALIDATOR",
    triggerCondition: "CONVERGENCE_CHECKED",
    contextVisibility: "HOLD_OUT_EVALUATION",
    targetScenarioId: "scientific_computing.heat_transfer",
    targetRoleId: "thermal_boundary_checker",
    targetAgentId: "agent_thermal_validator_01",
    budgetCapCalls: 1,
  },

  // Data Analysis Scenario Mappings
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "DATA_DESIGNER",
    triggerCondition: "SCENARIO_ENTRY",
    contextVisibility: "FULL",
    targetScenarioId: "data_analysis.statistical_inference",
    targetRoleId: "data_study_designer",
    targetAgentId: "agent_data_designer_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "DATA_STATISTICIAN",
    triggerCondition: "DESIGN_ADMITTED",
    contextVisibility: "GOAL_AND_TOOLS",
    targetScenarioId: "data_analysis.statistical_inference",
    targetRoleId: "data_statistical_worker",
    targetAgentId: "agent_data_worker_01",
    budgetCapCalls: 2,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "DATA_DIAGNOSTICIAN",
    triggerCondition: "EFFECTS_CALCULATED",
    contextVisibility: "CANDIDATE_ONLY",
    targetScenarioId: "data_analysis.statistical_inference",
    targetRoleId: "data_assumption_diagnostician",
    targetAgentId: "agent_data_reviewer_01",
    budgetCapCalls: 1,
  },
  {
    sourceEngine: "ts",
    legacyRoleOrStage: "DATA_ROBUSTNESS_VALIDATOR",
    triggerCondition: "ASSUMPTIONS_CHECKED",
    contextVisibility: "HOLD_OUT_EVALUATION",
    targetScenarioId: "data_analysis.statistical_inference",
    targetRoleId: "data_robustness_reviewer",
    targetAgentId: "agent_data_validator_01",
    budgetCapCalls: 1,
  },
]);
