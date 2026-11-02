"""Scenario and Multi-Agent Team Contracts (E02).

Mirrors packages/domain-contract/src/scenario-contracts.ts into Python dataclasses.
Provides canonical scenario manifests, team profiles, role mappings, and input/output contracts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence


@dataclass(frozen=True)
class ScenarioManifest:
    scenario_id: str
    version: str
    name: str
    domain_type: str
    description: str
    goals: Sequence[str]
    required_model_capabilities: Sequence[str]
    requires_code_isolation: bool


@dataclass(frozen=True)
class AgentRoleDefinition:
    role_id: str
    name: str
    role_category: Literal["PLANNER", "WORKER", "REVIEWER", "REPAIRER", "VALIDATOR"]
    owned_dimension: str
    description: str
    trigger_condition: str
    context_visibility: Literal["FULL", "GOAL_AND_TOOLS", "CANDIDATE_ONLY", "HOLD_OUT_EVALUATION"]
    max_model_calls_per_task: int


@dataclass(frozen=True)
class TeamProfile:
    team_id: str
    scenario_id: str
    roles: Sequence[AgentRoleDefinition]
    default_route: str
    enable_parallel_review: bool
    enable_bounded_repair: bool
    max_repairs: int


@dataclass(frozen=True)
class ScenarioInputContract:
    input_kind: Literal["PROBLEM_STATEMENT", "TIMESERIES_DATA", "PDE_EXPERIMENT_SPEC", "TABULAR_DATA"]
    supported_extensions: Sequence[str]
    required_fields: Sequence[str]
    optional_fields: Sequence[str]
    data_isolation_policy: Literal["NONE", "TRAIN_HOLDOUT_SPLIT", "READ_ONLY_MOUNT"]


@dataclass(frozen=True)
class ScenarioResultContract:
    primary_artifact_kind: str
    exported_file_names: Sequence[str]
    required_metrics: Sequence[str]
    visualizer_component: str


@dataclass(frozen=True)
class ScenarioContract:
    manifest: ScenarioManifest
    inputs: ScenarioInputContract
    team: TeamProfile
    results: ScenarioResultContract


@dataclass(frozen=True)
class RoleSourceMappingEntry:
    source_engine: Literal["ts", "legacy", "lite"]
    legacy_role_or_stage: str
    trigger_condition: str
    context_visibility: str
    target_scenario_id: str
    target_role_id: str
    target_agent_id: str
    budget_cap_calls: int


# Standard Scenarios
MATH_SCENARIO_CONTRACT = ScenarioContract(
    manifest=ScenarioManifest(
        scenario_id="math.research",
        version="1.0.0",
        name="数学研究场景",
        domain_type="mathematics",
        description="数学问题的符号计算、定理推导、反例搜索与证据审计研究闭环",
        goals=["SYMBOLIC_CALCULATION", "PROOF_SYNTHESIS", "COUNTEREXAMPLE_SEARCH"],
        required_model_capabilities=["mathematical_reasoning", "tool_calling"],
        requires_code_isolation=False,
    ),
    inputs=ScenarioInputContract(
        input_kind="PROBLEM_STATEMENT",
        supported_extensions=[".txt", ".tex", ".json"],
        required_fields=["problemText"],
        optional_fields=["domainHints", "assumptions", "boundaryConditions"],
        data_isolation_policy="NONE",
    ),
    team=TeamProfile(
        team_id="math_research_team",
        scenario_id="math.research",
        roles=[
            AgentRoleDefinition(
                role_id="math_problem_analyst",
                name="问题分析与义务分解 Agent",
                role_category="PLANNER",
                owned_dimension="PROBLEM_ALIGNMENT",
                description="提取原题约束、定义域、参数范围，建立严格待求义务清单",
                trigger_condition="STAGE_START",
                context_visibility="FULL",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="math_solver_worker",
                name="多路线推导 Agent",
                role_category="WORKER",
                owned_dimension="DERIVATION_AND_TOOLS",
                description="调用注册数学工具与符号系统生成推导候选与见证",
                trigger_condition="PLAN_ADMITTED",
                context_visibility="GOAL_AND_TOOLS",
                max_model_calls_per_task=2,
            ),
            AgentRoleDefinition(
                role_id="math_rigor_reviewer",
                name="反例与严谨性审查 Agent",
                role_category="REVIEWER",
                owned_dimension="COUNTEREXAMPLE_AND_RIGOR",
                description="审查定义域漏根、极值点假说、边界条件遗漏并提出质疑",
                trigger_condition="CANDIDATE_PROPOSED",
                context_visibility="CANDIDATE_ONLY",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="math_repairer",
                name="证据修复 Agent",
                role_category="REPAIRER",
                owned_dimension="TARGETED_REPAIR",
                description="针对合法质疑在有限配额内修正候选解，保留父候选血统",
                trigger_condition="CHALLENGE_PERSISTED",
                context_visibility="FULL",
                max_model_calls_per_task=1,
            ),
        ],
        default_route="canonical_symbolic",
        enable_parallel_review=True,
        enable_bounded_repair=True,
        max_repairs=1,
    ),
    results=ScenarioResultContract(
        primary_artifact_kind="MATHEMATICAL_DERIVATION_PACK",
        exported_file_names=["mathematical_solution.json", "audit_receipts.json"],
        required_metrics=["toolCalls", "obligationsSatisfied", "auditEvidenceLevel"],
        visualizer_component="MathDerivationView",
    ),
)

CONTROL_SCENARIO_CONTRACT = ScenarioContract(
    manifest=ScenarioManifest(
        scenario_id="control.identification",
        version="1.0.0",
        name="动力学与控制研究场景",
        domain_type="engineering_control",
        description="从真实时序数据进行受迫振子系统参数辨识、抗混叠诊断与留出前向预测验证",
        goals=["SYSTEM_IDENTIFICATION", "INDEPENDENT_PREDICTION"],
        required_model_capabilities=["scientific_reasoning", "data_understanding"],
        requires_code_isolation=True,
    ),
    inputs=ScenarioInputContract(
        input_kind="TIMESERIES_DATA",
        supported_extensions=[".csv", ".tsv", ".json"],
        required_fields=["timeColumn", "excitationColumn", "responseColumn"],
        optional_fields=["samplingFrequency", "physicalBounds", "holdoutRatio"],
        data_isolation_policy="TRAIN_HOLDOUT_SPLIT",
    ),
    team=TeamProfile(
        team_id="control_dynamics_team",
        scenario_id="control.identification",
        roles=[
            AgentRoleDefinition(
                role_id="control_modeling_planner",
                name="系统建模与采样审查 Agent",
                role_category="PLANNER",
                owned_dimension="SAMPLING_AND_MODEL_FORM",
                description="核查采样率防混叠（fs >= 10x 带宽），划分训练集与 20% 留出验证集",
                trigger_condition="STAGE_START",
                context_visibility="FULL",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="control_estimation_worker",
                name="动力学参数估计 Agent",
                role_category="WORKER",
                owned_dimension="PARAMETER_ESTIMATION",
                description="在训练集上利用物理工具执行 m, c, k 最小二乘或状态空间辨识",
                trigger_condition="PLAN_ADMITTED",
                context_visibility="GOAL_AND_TOOLS",
                max_model_calls_per_task=2,
            ),
            AgentRoleDefinition(
                role_id="control_residual_reviewer",
                name="残差白性与物理边界审查 Agent",
                role_category="REVIEWER",
                owned_dimension="RESIDUAL_WHITENESS",
                description="核查物理正定性（m>0, c>0, k>0）及残差自相关，识别未建模动态",
                trigger_condition="CANDIDATE_PROPOSED",
                context_visibility="CANDIDATE_ONLY",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="control_validation_checker",
                name="独立前向预测验证 Agent",
                role_category="VALIDATOR",
                owned_dimension="HOLDOUT_PREDICTION_RMSE",
                description="在未参与辨识的留出测试集上前向积分仿真，计算独立 RMSE 与置信区间",
                trigger_condition="CANDIDATE_ADMITTED",
                context_visibility="HOLD_OUT_EVALUATION",
                max_model_calls_per_task=1,
            ),
        ],
        default_route="forced_damped_oscillator_fit",
        enable_parallel_review=False,
        enable_bounded_repair=True,
        max_repairs=1,
    ),
    results=ScenarioResultContract(
        primary_artifact_kind="DYNAMICS_IDENTIFICATION_PACK",
        exported_file_names=["system_identification_report.txt", "identified_parameters.json"],
        required_metrics=["mass", "damping", "stiffness", "holdoutRmse", "whitenessPValue"],
        visualizer_component="ControlDynamicsView",
    ),
)

SCI_COMPUTING_SCENARIO_CONTRACT = ScenarioContract(
    manifest=ScenarioManifest(
        scenario_id="scientific_computing.heat_transfer",
        version="1.0.0",
        name="热物理数值实验场景",
        domain_type="computational_science",
        description="一维传热与扩散偏微分方程有限差分实验、CFL 稳定性核验与网格收敛阶诊断",
        goals=["NUMERICAL_EXPERIMENT", "METHOD_REPLICATION"],
        required_model_capabilities=["scientific_reasoning", "numerical_methods"],
        requires_code_isolation=True,
    ),
    inputs=ScenarioInputContract(
        input_kind="PDE_EXPERIMENT_SPEC",
        supported_extensions=[".json", ".csv"],
        required_fields=["diffusivityAlpha", "length", "timeFinal", "initialCondition", "boundaryConditions"],
        optional_fields=["gridResolution", "cflTarget"],
        data_isolation_policy="READ_ONLY_MOUNT",
    ),
    team=TeamProfile(
        team_id="thermal_computing_team",
        scenario_id="scientific_computing.heat_transfer",
        roles=[
            AgentRoleDefinition(
                role_id="thermal_discretization_planner",
                name="数值离散与网格规划 Agent",
                role_category="PLANNER",
                owned_dimension="DISCRETIZATION_AND_CFL",
                description="根据扩散系数和目标步长核验 CFL 稳定性条件（dt <= dx^2 / (2*alpha)）",
                trigger_condition="STAGE_START",
                context_visibility="FULL",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="thermal_solver_worker",
                name="数值实验求解 Agent",
                role_category="WORKER",
                owned_dimension="PDE_INTEGRATION",
                description="调用有限差分数值求解器开展多网格计算与温度场演化模拟",
                trigger_condition="PLAN_ADMITTED",
                context_visibility="GOAL_AND_TOOLS",
                max_model_calls_per_task=2,
            ),
            AgentRoleDefinition(
                role_id="thermal_convergence_reviewer",
                name="网格渐近收敛阶审查 Agent",
                role_category="REVIEWER",
                owned_dimension="RICHARDSON_CONVERGENCE",
                description="核验多重网格细化（h -> h/2 -> h/4）的 Richardson 外推收敛性与阶数",
                trigger_condition="CANDIDATE_PROPOSED",
                context_visibility="CANDIDATE_ONLY",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="thermal_boundary_checker",
                name="初边值一致性与通量守恒 Agent",
                role_category="VALIDATOR",
                owned_dimension="BOUNDARY_CONSERVATION",
                description="核对边界条件是否欠缺或失真，校验积分热通量守恒性",
                trigger_condition="CANDIDATE_ADMITTED",
                context_visibility="HOLD_OUT_EVALUATION",
                max_model_calls_per_task=1,
            ),
        ],
        default_route="ftcs_diffusion_solve",
        enable_parallel_review=True,
        enable_bounded_repair=True,
        max_repairs=1,
    ),
    results=ScenarioResultContract(
        primary_artifact_kind="THERMAL_SIMULATION_PACK",
        exported_file_names=["temperature_distribution.json", "convergence_report.json"],
        required_metrics=["alpha", "gridResidual", "observedConvergenceOrder", "cflSatisfied"],
        visualizer_component="ThermalSimulationView",
    ),
)

DATA_ANALYSIS_SCENARIO_CONTRACT = ScenarioContract(
    manifest=ScenarioManifest(
        scenario_id="data_analysis.statistical_inference",
        version="1.0.0",
        name="实验数据科学研究场景",
        domain_type="scientific_data_analysis",
        description="真实实验或观测数据的统计假设检验、正态与同方差诊断、效应量与稳健性分析",
        goals=["STATISTICAL_INFERENCE", "DATA_QUALITY_ASSURANCE"],
        required_model_capabilities=["statistical_analysis", "data_understanding"],
        requires_code_isolation=True,
    ),
    inputs=ScenarioInputContract(
        input_kind="TABULAR_DATA",
        supported_extensions=[".csv", ".tsv", ".parquet"],
        required_fields=["groupColumn", "valueColumn"],
        optional_fields=["covariateColumns", "alphaLevel", "alternativeHypothesis"],
        data_isolation_policy="READ_ONLY_MOUNT",
    ),
    team=TeamProfile(
        team_id="data_science_team",
        scenario_id="data_analysis.statistical_inference",
        roles=[
            AgentRoleDefinition(
                role_id="data_study_designer",
                name="实验设计与假设理解 Agent",
                role_category="PLANNER",
                owned_dimension="STUDY_DESIGN_AND_POWER",
                description="解析实验设计（双样本对照/重复测量）、设定显著性水平与假设检验方向",
                trigger_condition="STAGE_START",
                context_visibility="FULL",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="data_statistical_worker",
                name="统计建模与检验 Agent",
                role_category="WORKER",
                owned_dimension="HYPOTHESIS_TESTING",
                description="调用统计分析工具计算统计量、自由度、p 值及 Cohen's d 效应量与置信区间",
                trigger_condition="PLAN_ADMITTED",
                context_visibility="GOAL_AND_TOOLS",
                max_model_calls_per_task=2,
            ),
            AgentRoleDefinition(
                role_id="data_assumption_diagnostician",
                name="统计前提与数据质量诊断 Agent",
                role_category="REVIEWER",
                owned_dimension="NORMALITY_AND_HOMOSCEDASTICITY",
                description="执行 Shapiro-Wilk 正态性检验与 Levene 方差齐性检验，指出非参数替代需求",
                trigger_condition="CANDIDATE_PROPOSED",
                context_visibility="CANDIDATE_ONLY",
                max_model_calls_per_task=1,
            ),
            AgentRoleDefinition(
                role_id="data_robustness_reviewer",
                name="稳健性与离群值敏感度审查 Agent",
                role_category="VALIDATOR",
                owned_dimension="ROBUSTNESS_AND_EFFECT_SIZE",
                description="检查离群值对抗性扰动对结论的影响，核验效应量实用价值与数据泄漏",
                trigger_condition="CANDIDATE_ADMITTED",
                context_visibility="HOLD_OUT_EVALUATION",
                max_model_calls_per_task=1,
            ),
        ],
        default_route="welch_t_test_inference",
        enable_parallel_review=True,
        enable_bounded_repair=True,
        max_repairs=1,
    ),
    results=ScenarioResultContract(
        primary_artifact_kind="STATISTICAL_INFERENCE_PACK",
        exported_file_names=["statistical_report.json", "diagnostic_metrics.json"],
        required_metrics=["tStatistic", "pValue", "cohensD", "confidenceInterval", "isSignificant"],
        visualizer_component="StatisticalAnalysisView",
    ),
)

ALL_SCENARIO_CONTRACTS: Mapping[str, ScenarioContract] = {
    "math.research": MATH_SCENARIO_CONTRACT,
    "control.identification": CONTROL_SCENARIO_CONTRACT,
    "scientific_computing.heat_transfer": SCI_COMPUTING_SCENARIO_CONTRACT,
    "data_analysis.statistical_inference": DATA_ANALYSIS_SCENARIO_CONTRACT,
}

SCENARIO_DOMAIN_IDS: Mapping[str, str] = {
    "math.research": "math",
    "control.identification": "control.identification",
    "scientific_computing.heat_transfer": "scientific_computing",
    "data_analysis.statistical_inference": "data_analysis",
}

DOMAIN_SCENARIO_IDS: Mapping[str, str] = {
    domain_id: scenario_id for scenario_id, domain_id in SCENARIO_DOMAIN_IDS.items()
}

ROLE_SOURCE_MAPPINGS: Sequence[RoleSourceMappingEntry] = (
    RoleSourceMappingEntry("ts", "R0:MEANING", "maxR0=1 AND STAGE=R0", "GOAL_ONLY", "math.research", "math_problem_analyst", "agent_math_analyst_01", 1),
    RoleSourceMappingEntry("ts", "WORK:ROUTE_1", "WORK_UNIT_ADMITTED", "GOAL_AND_TOOLS", "math.research", "math_solver_worker", "agent_math_solver_01", 2),
    RoleSourceMappingEntry("ts", "R0:METHOD", "maxR0=1 AND STAGE=R0", "METHODS_ONLY", "math.research", "math_rigor_reviewer", "agent_math_reviewer_01", 1),
    RoleSourceMappingEntry("ts", "REPAIR:ROUTE_REPAIR", "CHALLENGE_PERSISTED AND maxRepairs>=1", "FULL", "math.research", "math_repairer", "agent_math_repairer_01", 1),
    RoleSourceMappingEntry("ts", "CONTROL_PLANNER", "SCENARIO_ENTRY", "FULL", "control.identification", "control_modeling_planner", "agent_control_planner_01", 1),
    RoleSourceMappingEntry("ts", "CONTROL_ESTIMATOR", "DATASET_LOADED", "GOAL_AND_TOOLS", "control.identification", "control_estimation_worker", "agent_control_worker_01", 2),
    RoleSourceMappingEntry("ts", "CONTROL_RESIDUAL_REVIEWER", "PARAMS_PROPOSED", "CANDIDATE_ONLY", "control.identification", "control_residual_reviewer", "agent_control_reviewer_01", 1),
    RoleSourceMappingEntry("ts", "CONTROL_HOLDOUT_VALIDATOR", "RESIDUAL_ACCEPTED", "HOLD_OUT_EVALUATION", "control.identification", "control_validation_checker", "agent_control_validator_01", 1),
    RoleSourceMappingEntry("ts", "SCICOMP_DISCRETIZER", "SCENARIO_ENTRY", "FULL", "scientific_computing.heat_transfer", "thermal_discretization_planner", "agent_thermal_planner_01", 1),
    RoleSourceMappingEntry("ts", "SCICOMP_SOLVER", "GRID_APPROVED", "GOAL_AND_TOOLS", "scientific_computing.heat_transfer", "thermal_solver_worker", "agent_thermal_worker_01", 2),
    RoleSourceMappingEntry("ts", "SCICOMP_CONVERGENCE_REVIEWER", "MULTIGRID_SIMULATED", "CANDIDATE_ONLY", "scientific_computing.heat_transfer", "thermal_convergence_reviewer", "agent_thermal_reviewer_01", 1),
    RoleSourceMappingEntry("ts", "SCICOMP_FLUX_VALIDATOR", "CONVERGENCE_CHECKED", "HOLD_OUT_EVALUATION", "scientific_computing.heat_transfer", "thermal_boundary_checker", "agent_thermal_validator_01", 1),
    RoleSourceMappingEntry("ts", "DATA_DESIGNER", "SCENARIO_ENTRY", "FULL", "data_analysis.statistical_inference", "data_study_designer", "agent_data_designer_01", 1),
    RoleSourceMappingEntry("ts", "DATA_STATISTICIAN", "DESIGN_ADMITTED", "GOAL_AND_TOOLS", "data_analysis.statistical_inference", "data_statistical_worker", "agent_data_worker_01", 2),
    RoleSourceMappingEntry("ts", "DATA_DIAGNOSTICIAN", "EFFECTS_CALCULATED", "CANDIDATE_ONLY", "data_analysis.statistical_inference", "data_assumption_diagnostician", "agent_data_reviewer_01", 1),
    RoleSourceMappingEntry("ts", "DATA_ROBUSTNESS_VALIDATOR", "ASSUMPTIONS_CHECKED", "HOLD_OUT_EVALUATION", "data_analysis.statistical_inference", "data_robustness_reviewer", "agent_data_validator_01", 1),
)
