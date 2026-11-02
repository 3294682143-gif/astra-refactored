from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional


@dataclass
class EvalTaskSpec:
    task_id: str
    scenario_id: str
    name: str
    raw_prompt: str
    ground_truth: Dict[str, Any]
    input_ref: Optional[str] = None


@dataclass
class RunEvaluationResult:
    task_id: str
    scenario_id: str
    group: str
    success: bool
    model_calls: int
    tool_calls: int
    repaired: bool
    scientific_precision_score: float
    duration_ms: int
    audit_verdict: str
    failure_reason: Optional[str] = None
    configuration: Dict[str, Any] = field(default_factory=dict)


BENCHMARK_TASKS: List[EvalTaskSpec] = [
    EvalTaskSpec(
        task_id="eval_math_01",
        scenario_id="math.research",
        name="Exact Quadratic Roots",
        raw_prompt="求二次方程 x^2 - 5x + 6 = 0 的全部实数根，并给出代入核验。",
        ground_truth={"roots": [2, 3]},
    ),
    EvalTaskSpec(
        task_id="eval_control_02",
        scenario_id="control.identification",
        name="Forced Damped Oscillator Parameter Estimation",
        raw_prompt="根据挂载时序数据估计 m、c、k，并进行留出预测和残差诊断。",
        ground_truth={"max_rmse": 0.05},
        input_ref="benchmarks/control/oscillator_real_sample.csv",
    ),
    EvalTaskSpec(
        task_id="eval_thermal_03",
        scenario_id="scientific_computing.heat_transfer",
        name="Heat Equation Finite Difference Convergence",
        raw_prompt="对挂载热传导观测执行 alpha=0.05 的数值模拟，核验 CFL、二阶收敛和实验末态误差。",
        ground_truth={"order_p": 2.0, "cfl_limit": 0.5, "max_order_err": 0.1, "max_experiment_rmse": 1.0},
        input_ref="benchmarks/scientific_computing/heat_rod_experimental_sample.csv",
    ),
    EvalTaskSpec(
        task_id="eval_stats_04",
        scenario_id="data_analysis.statistical_inference",
        name="Two-Group Welch Test and Effect Size",
        raw_prompt="对挂载双组数据执行 Welch t 检验，报告 p 值、Cohen's d、置信区间与前提诊断。",
        ground_truth={"p_val_threshold": 0.01, "cohens_d_expected": 0.8},
        input_ref="benchmarks/data_analysis/clinical_trial_sample.csv",
    ),
]

_DOMAIN_IDS = {
    "math.research": "math",
    "control.identification": "control.identification",
    "scientific_computing.heat_transfer": "scientific_computing",
    "data_analysis.statistical_inference": "data_analysis",
}


class ScientificEvaluationEngine:
    def __init__(
        self,
        random_seed: int = 42,
        *,
        runner: Optional[Callable[[EvalTaskSpec, str], RunEvaluationResult]] = None,
        solver_factory: Optional[Callable[[], Any]] = None,
        repo_root: Optional[Path] = None,
    ) -> None:
        self.seed = random_seed
        self.runner = runner
        self.solver_factory = solver_factory
        self.repo_root = repo_root or Path(__file__).resolve().parents[2]

    @staticmethod
    def _details(result: Mapping[str, Any]) -> Mapping[str, Any]:
        details = result.get("details")
        if isinstance(details, Mapping):
            return details
        final_response = result.get("final_response")
        if isinstance(final_response, str):
            try:
                parsed = json.loads(final_response)
                if isinstance(parsed, Mapping):
                    return parsed
            except json.JSONDecodeError:
                pass
        return result

    def _score(self, task: EvalTaskSpec, result: Mapping[str, Any]) -> tuple[float, List[str]]:
        details = self._details(result)
        missing: List[str] = []
        checks: List[bool] = []
        if task.scenario_id == "math.research":
            text = str(result.get("final_response") or details.get("formattedSummary") or details)
            for root in task.ground_truth["roots"]:
                present = bool(re.search(rf"(?:x\s*=\s*{root}(?:\D|$)|\b{root}\b)", text))
                checks.append(present)
                if not present:
                    missing.append(f"missing_root_{root}")
        elif task.scenario_id == "control.identification":
            parameters = details.get("parameters") or {}
            holdout = details.get("holdoutValidation") or {}
            residual = details.get("residualDiagnosis") or {}
            leakage = details.get("leakageGuard") or {}
            sampling = details.get("samplingGuard") or {}
            checks = [
                all(parameters.get(key, 0) > 0 for key in ("mass", "damping", "stiffness")),
                holdout.get("passed") is True and holdout.get("holdoutRmse", float("inf")) <= task.ground_truth["max_rmse"],
                residual.get("isWhite") is True,
                leakage.get("leakageDetected") is False,
                sampling.get("aliasingDetected") is False,
            ]
            names = ["physical_bounds", "holdout_rmse", "residual_whiteness", "leakage_guard", "sampling_guard"]
            missing = [name for name, passed in zip(names, checks) if not passed]
        elif task.scenario_id == "scientific_computing.heat_transfer":
            experiment = details.get("experimentalSimulation") or {}
            checks = [
                abs(details.get("observedOrder", 0) - task.ground_truth["order_p"]) <= task.ground_truth["max_order_err"],
                (details.get("cflDiagnosis") or {}).get("isStable") is True,
                (details.get("boundaryDiagnosis") or {}).get("dirichletMatched") is True,
                experiment.get("passed") is True and experiment.get("rmse", float("inf")) <= task.ground_truth["max_experiment_rmse"],
            ]
            names = ["convergence_order", "cfl_stability", "boundary_conditions", "experimental_comparison"]
            missing = [name for name, passed in zip(names, checks) if not passed]
        elif task.scenario_id == "data_analysis.statistical_inference":
            test_result = details.get("testResult") or {}
            interval = test_result.get("confidenceInterval")
            checks = [
                details.get("testMethod") == "two_sample_welch_t_test",
                test_result.get("pValue", 1) <= task.ground_truth["p_val_threshold"],
                abs(test_result.get("cohensD", 0)) >= task.ground_truth["cohens_d_expected"],
                isinstance(interval, list) and len(interval) == 2,
                (details.get("normalityDiagnosis") or {}).get("passed") is True,
            ]
            names = ["welch_method", "p_value", "effect_size", "confidence_interval", "normality"]
            missing = [name for name, passed in zip(names, checks) if not passed]
        if not checks:
            return 0.0, ["numeric_evidence_required"]
        return sum(1 for passed in checks if passed) / len(checks), missing

    def _evaluate_with_solver(self, task: EvalTaskSpec, group: str) -> RunEvaluationResult:
        from .solver_adapter import build_solver_from_env
        from .input_assets import resolve_input_assets
        from .config import DEFAULT_BUDGET

        start = time.monotonic()
        model_calls = 0
        tool_calls = 0
        try:
            adapter = self.solver_factory() if self.solver_factory is not None else build_solver_from_env()
            if adapter is None:
                raise RuntimeError("SOLVER_NOT_CONFIGURED")
            metadata: Dict[str, Any] = {"evaluationMode": group}
            if task.input_ref:
                metadata["inputAssets"] = resolve_input_assets(
                    [task.input_ref],
                    storage_root=self.repo_root / ".tmp",
                    repo_root=self.repo_root,
                )
            request: Dict[str, Any] = {
                "run_id": f"{task.task_id}_{group}",
                "domain_id": _DOMAIN_IDS[task.scenario_id],
                "problem": task.raw_prompt,
                "metadata": metadata,
            }
            if task.scenario_id == "math.research":
                if group in {"B1", "A1"}:
                    request["max_reviews"] = 0
                if group in {"B1", "A3"}:
                    request["max_repairs"] = 0
                if group in {"B1", "A4"}:
                    request["max_work_units"] = 1
                if group == "A5":
                    request["max_method_loads"] = 0
                if group == "A2":
                    raise RuntimeError("CONFIGURATION_UNSUPPORTED:math_feedback_ablation")
            if group == "B0":
                budgets = {key: request.get(key, DEFAULT_BUDGET[key]) for key in (
                    "max_model_calls", "max_work_units", "max_effects", "max_reviews",
                    "max_method_loads", "max_repairs", "max_consensus", "max_r0", "problem_seconds", "policy",
                )}
                response = adapter._build_client(budgets).chat(
                    messages=[
                        {"role": "system", "content": "仅依据模型自身知识回答科研问题，不得调用工具或编造实验结果。"},
                        {"role": "user", "content": task.raw_prompt},
                    ],
                    temperature=0.2,
                    max_tokens=2048,
                )
                content = response["choices"][0]["message"]["content"]
                model_calls = 1
                result: Mapping[str, Any] = {
                    "status": "candidate",
                    "final_response": content,
                    "candidate_verified": False,
                    "reason": "PURE_MODEL_SINGLE_SHOT_NO_TOOL_EVIDENCE",
                }
            else:
                result = adapter(request)
                metrics = result.get("metrics") or {}
                model_calls = int(metrics.get("modelCalls", (result.get("agentWorkflow") or {}).get("modelCalls", 0)))
                tool_calls = int(metrics.get("toolCalls", 1 if group != "B0" else 0))
            score, missing = self._score(task, result)
            status = result.get("status")
            success = group != "B0" and status == "candidate" and score == 1.0 and result.get("candidate_verified") is False
            workflow = result.get("agentWorkflow") or {}
            repaired = workflow.get("repaired") is True
            reason = result.get("reason")
            return RunEvaluationResult(
                task_id=task.task_id,
                scenario_id=task.scenario_id,
                group=group,
                success=success,
                model_calls=model_calls,
                tool_calls=tool_calls,
                repaired=repaired,
                scientific_precision_score=score,
                duration_ms=int((time.monotonic() - start) * 1000),
                audit_verdict=str(reason or ("SCORER_ACCEPTED" if success else "SCORER_REJECTED")),
                failure_reason=None if success else ";".join(missing) or str(reason or status),
                configuration={"evaluationMode": group, "scorerVersion": "frozen-v1"},
            )
        except Exception as exc:
            return RunEvaluationResult(
                task_id=task.task_id,
                scenario_id=task.scenario_id,
                group=group,
                success=False,
                model_calls=model_calls,
                tool_calls=tool_calls,
                repaired=False,
                scientific_precision_score=0.0,
                duration_ms=int((time.monotonic() - start) * 1000),
                audit_verdict="EXECUTION_FAILED",
                failure_reason=str(exc),
                configuration={"evaluationMode": group, "scorerVersion": "frozen-v1"},
            )

    def evaluate_task(self, task: EvalTaskSpec, group: str) -> RunEvaluationResult:
        if group not in {"B0", "B1", "B2", "B3", "A1", "A2", "A3", "A4", "A5"}:
            raise ValueError(f"Unknown evaluation group: {group}")
        if self.runner is not None:
            return self.runner(task, group)
        return self._evaluate_with_solver(task, group)

    def run_full_suite(self, groups: Optional[List[str]] = None) -> Dict[str, Any]:
        target_groups = groups or ["B0", "B1", "B2", "B3", "A1", "A2", "A3", "A4", "A5"]
        results = [self.evaluate_task(task, group) for group in target_groups for task in BENCHMARK_TASKS]
        summary_by_group: Dict[str, Dict[str, Any]] = {}
        for group in target_groups:
            group_results = [result for result in results if result.group == group]
            count = len(group_results)
            success_count = sum(1 for result in group_results if result.success)
            summary_by_group[group] = {
                "group": group,
                "total_runs": count,
                "success_count": success_count,
                "precision_denominator": count,
                "success_rate": success_count / count if count else 0.0,
                "avg_precision": sum(result.scientific_precision_score for result in group_results) / count if count else 0.0,
                "avg_model_calls": sum(result.model_calls for result in group_results) / count if count else 0.0,
                "avg_tool_calls": sum(result.tool_calls for result in group_results) / count if count else 0.0,
                "repair_rate": sum(1 for result in group_results if result.repaired) / count if count else 0.0,
            }
        return {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scorerVersion": "frozen-v1",
            "tasks_count": len(BENCHMARK_TASKS),
            "groups_evaluated": target_groups,
            "summary": summary_by_group,
            "raw_results": [asdict(result) for result in results],
        }

    @staticmethod
    def format_factsheet_markdown(suite_result: Dict[str, Any]) -> str:
        summary = suite_result["summary"]
        lines = [
            "# AI4S Multi-Agent Scientific Research Ablation & Baseline Factsheet",
            "",
            f"- **Evaluation Timestamp**: {suite_result.get('timestamp')}",
            f"- **Scorer Version**: {suite_result.get('scorerVersion', 'frozen-v1')}",
            f"- **Evaluated Benchmarks**: {suite_result.get('tasks_count')} tasks; every run is included in the denominator",
            "",
            "| 组别 | 配置说明 | 成功数/分母 | 成功率 | 科学精度得分 | 平均模型调用 | 平均工具调用 | 修复介入率 |",
            "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
        ]
        descriptions = {
            "B0": "纯模型直接单发（无工具）",
            "B1": "基础工具执行（无角色闭环）",
            "B2": "完整规划、工具、独立审查与有界修复",
            "B3": "单智能体同工具同预算自审",
            "A1": "消融：去除独立审查",
            "A2": "消融：阻断工具反馈",
            "A3": "消融：禁止修复",
            "A4": "消融：固定单一路由",
            "A5": "消融：去除领域启发式",
        }
        for group, description in descriptions.items():
            if group not in summary:
                continue
            item = summary[group]
            lines.append(
                f"| **{group}** | {description} | {item['success_count']}/{item['precision_denominator']} | "
                f"{item['success_rate'] * 100:.1f}% | {item['avg_precision']:.3f} | "
                f"{item['avg_model_calls']:.1f} | {item['avg_tool_calls']:.1f} | {item['repair_rate'] * 100:.1f}% |"
            )
        if "B2" in summary and "B3" in summary:
            difference = summary["B2"]["avg_precision"] - summary["B3"]["avg_precision"]
            lines.extend([
                "",
                "## 实测对照说明",
                "",
                f"B2 与 B3 的科学精度差值为 **{difference:+.3f}**；"
                f"两组分母均为 {summary['B2']['precision_denominator']}。该值只描述本次冻结任务与配置的实际运行，"
                "不预设正负方向，也不在样本量不足时宣称统计显著性。",
            ])
        return "\n".join(lines)
