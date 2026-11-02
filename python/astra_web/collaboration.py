from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from statistics import NormalDist
from typing import Any, Callable, Dict, List, Optional


def _chi_square_sf(value: float, degrees_of_freedom: int) -> float:
    if value < 0 or degrees_of_freedom <= 0:
        raise ValueError("invalid chi-square input")
    if value == 0:
        return 1.0
    shape = degrees_of_freedom / 2.0
    x = value / 2.0
    if x < shape + 1.0:
        term = 1.0 / shape
        total = term
        index = shape
        for _ in range(1000):
            index += 1.0
            term *= x / index
            total += term
            if abs(term) < abs(total) * 1e-14:
                break
        return min(1.0, max(0.0, 1.0 - total * math.exp(-x + shape * math.log(x) - math.lgamma(shape))))
    b = x + 1.0 - shape
    c = 1.0 / 1e-300
    d = 1.0 / b
    h = d
    for index in range(1, 1000):
        an = -index * (index - shape)
        b += 2.0
        d = an * d + b
        if abs(d) < 1e-300:
            d = 1e-300
        c = b + an / c
        if abs(c) < 1e-300:
            c = 1e-300
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return min(1.0, max(0.0, math.exp(-x + shape * math.log(x) - math.lgamma(shape)) * h))


def _student_t_critical(degrees_of_freedom: int) -> float:
    table = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
        6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
        16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
        21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
        26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
    }
    if degrees_of_freedom in table:
        return table[degrees_of_freedom]
    z = NormalDist().inv_cdf(0.975)
    df = float(degrees_of_freedom)
    return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3) / (96 * df ** 2)


class CrossScenarioDelegationRefused(Exception):
    pass


@dataclass
class CollaborationTask:
    task_id: str
    parent_run_id: str
    initiating_scenario_id: str
    target_scenario_id: str
    prompt: str
    input_artifacts: List[Dict[str, Any]] = field(default_factory=list)
    inherited_budget: Dict[str, Any] = field(default_factory=dict)
    recursion_depth: int = 1


@dataclass
class CollaborationResult:
    task_id: str
    parent_run_id: str
    target_scenario_id: str
    status: str
    consumed_budget: Dict[str, Any] = field(default_factory=dict)
    returned_artifacts: List[Dict[str, Any]] = field(default_factory=list)
    candidate_verified: bool = False


STANDARD_SCENARIO_IDS = {
    "math.research",
    "control.identification",
    "scientific_computing.heat_transfer",
    "data_analysis.statistical_inference",
}


class CrossScenarioDelegator:
    def __init__(
        self,
        registered_scenarios: Optional[set[str]] = None,
        max_depth: int = 1,
        executor: Optional[Callable[[CollaborationTask], CollaborationResult]] = None,
    ) -> None:
        self.registered_scenarios = registered_scenarios if registered_scenarios is not None else set(STANDARD_SCENARIO_IDS)
        self.max_depth = max_depth
        self.executor = executor

    @staticmethod
    def _failure(task: CollaborationTask, reason: str, start_time: float) -> CollaborationResult:
        return CollaborationResult(
            task_id=task.task_id,
            parent_run_id=task.parent_run_id,
            target_scenario_id=task.target_scenario_id,
            status="FAILED",
            consumed_budget={"model_calls": 0, "tool_calls": 0, "duration_ms": int((time.monotonic() - start_time) * 1000)},
            returned_artifacts=[{"error": reason}],
            candidate_verified=False,
        )

    def delegate(self, task: CollaborationTask) -> CollaborationResult:
        if task.recursion_depth > self.max_depth:
            raise CrossScenarioDelegationRefused(
                f"Recursion depth {task.recursion_depth} exceeds max permitted depth {self.max_depth}"
            )
        start_time = time.monotonic()
        if task.initiating_scenario_id == task.target_scenario_id:
            return self._failure(task, "Self-delegation is not allowed", start_time)
        if task.target_scenario_id not in self.registered_scenarios:
            return self._failure(task, f"Target scenario '{task.target_scenario_id}' not registered", start_time)
        max_model_calls = task.inherited_budget.get("max_model_calls", 0)
        max_tool_calls = task.inherited_budget.get("max_tool_calls", 1)
        remaining_deadline_ms = task.inherited_budget.get("remaining_deadline_ms", 1000)
        if max_model_calls < 0 or max_tool_calls < 0 or remaining_deadline_ms <= 0:
            return self._failure(task, "Inherited budget exhausted before dispatch", start_time)

        flagship = (
            task.initiating_scenario_id == "control.identification"
            and task.target_scenario_id == "data_analysis.statistical_inference"
        )
        if flagship:
            if max_tool_calls < 1:
                return self._failure(task, "Inherited tool budget exhausted before residual analysis", start_time)
            return self._evaluate_residuals(task, start_time, max_tool_calls)
        if self.executor is None:
            return self._failure(task, "Target scenario executor is not configured", start_time)
        try:
            result = self.executor(task)
            if not isinstance(result, CollaborationResult) or result.candidate_verified is not False:
                return self._failure(task, "Target scenario executor returned an invalid result", start_time)
            return result
        except Exception as exc:
            return self._failure(task, str(exc), start_time)

    @staticmethod
    def _evaluate_residuals(
        task: CollaborationTask,
        start_time: float,
        max_tool_calls: int,
    ) -> CollaborationResult:
        tool_calls = 0
        try:
            input_data = task.input_artifacts[0] if task.input_artifacts else {}
            raw_residuals = input_data.get("residuals")
            if not isinstance(raw_residuals, list) or len(raw_residuals) < 8:
                raise ValueError("RESIDUAL_SERIES_REQUIRED: at least 8 observations")
            if len(raw_residuals) > 10_000:
                raise ValueError("RESIDUAL_SERIES_TOO_LARGE")
            residuals = [float(value) for value in raw_residuals]
            if any(not math.isfinite(value) for value in residuals):
                raise ValueError("RESIDUAL_SERIES_CONTAINS_NON_FINITE_VALUES")
            count = len(residuals)
            tool_calls = 1
            mean = sum(residuals) / count
            population_variance = sum((value - mean) ** 2 for value in residuals) / count
            if population_variance <= 1e-20:
                raise ValueError("RESIDUAL_SERIES_HAS_ZERO_VARIANCE")
            population_std = math.sqrt(population_variance)
            std = math.sqrt(sum((value - mean) ** 2 for value in residuals) / (count - 1))
            rmse = math.sqrt(sum(value ** 2 for value in residuals) / count)
            skewness = sum((value - mean) ** 3 for value in residuals) / count / population_std ** 3
            kurtosis = sum((value - mean) ** 4 for value in residuals) / count / population_std ** 4
            jarque_bera = count / 6.0 * (skewness ** 2 + (kurtosis - 3.0) ** 2 / 4.0)
            centered = [value - mean for value in residuals]
            max_lags = min(10, max(1, count // 5))
            denominator = sum(value ** 2 for value in centered)
            autocorrelations = [
                sum(centered[index] * centered[index + lag] for index in range(count - lag)) / denominator
                for lag in range(1, max_lags + 1)
            ]
            ljung_box = count * (count + 2) * sum(
                correlation ** 2 / (count - lag)
                for lag, correlation in enumerate(autocorrelations, start=1)
            )
            normality_p = _chi_square_sf(jarque_bera, 2)
            whiteness_p = _chi_square_sf(ljung_box, max_lags)
            standard_error = std / math.sqrt(count)
            critical = _student_t_critical(count - 1)
            confidence_interval = [mean - critical * standard_error, mean + critical * standard_error]
            acceptable = rmse < 0.05 and normality_p > 0.05 and whiteness_p > 0.05
            artifact = {
                "artifact_kind": "COLLABORATIVE_UNCERTAINTY_EVALUATION",
                "source_scenario_id": task.initiating_scenario_id,
                "target_scenario_id": task.target_scenario_id,
                "analysis_method": "jarque_bera_and_ljung_box",
                "diagnosis": "RESIDUAL_WHITE" if acceptable else "RESIDUAL_DIAGNOSTICS_NOT_ACCEPTABLE",
                "sample_count": count,
                "residual_mean": mean,
                "residual_rmse": rmse,
                "jarque_bera_statistic": jarque_bera,
                "p_val_normality": normality_p,
                "p_val_whiteness": whiteness_p,
                "ljung_box_statistic": ljung_box,
                "ljung_box_lags": max_lags,
                "lag_autocorrelations": autocorrelations,
                "confidence_interval_95": confidence_interval,
                "is_uncertainty_acceptable": acceptable,
                "verdict": (
                    "Residual normality and whiteness diagnostics passed within the declared thresholds"
                    if acceptable
                    else "Residual diagnostics did not close all uncertainty obligations"
                ),
                "candidate_verified": False,
            }
            duration_ms = int((time.monotonic() - start_time) * 1000)
            return CollaborationResult(
                task_id=task.task_id,
                parent_run_id=task.parent_run_id,
                target_scenario_id=task.target_scenario_id,
                status="COMPLETED",
                consumed_budget={"model_calls": 0, "tool_calls": min(tool_calls, max_tool_calls), "duration_ms": duration_ms},
                returned_artifacts=[artifact],
                candidate_verified=False,
            )
        except Exception as exc:
            return CollaborationResult(
                task_id=task.task_id,
                parent_run_id=task.parent_run_id,
                target_scenario_id=task.target_scenario_id,
                status="FAILED",
                consumed_budget={
                    "model_calls": 0,
                    "tool_calls": tool_calls,
                    "duration_ms": int((time.monotonic() - start_time) * 1000),
                },
                returned_artifacts=[{"error": str(exc)}],
                candidate_verified=False,
            )
