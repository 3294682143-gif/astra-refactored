"""BFF -> official ReasoningAgent adapter.

The adapter maps validated Web budgets to the official public entry point. It
does not route mathematics, read legacy registries, execute tools itself or
invent answers. Tests may inject a scripted public client, but the Node bundle,
Python Host and unified ``use_math_asset`` executor remain the real ones.
"""
from __future__ import annotations

import inspect
import os
from typing import Any, Callable, Mapping, Optional

from .config import DEFAULT_BUDGET

_BUDGET_KEYS = (
    "max_model_calls",
    "max_work_units",
    "max_effects",
    "max_reviews",
    "max_method_loads",
    "max_repairs",
    "max_consensus",
    "max_r0",
    "problem_seconds",
    "policy",
)


def _accepts_budget(factory: Callable[..., Any]) -> bool:
    """Report whether ``factory`` wants the per-run budget mapping."""
    try:
        signature = inspect.signature(factory)
    except (TypeError, ValueError):  # builtins / C callables: assume zero-arg
        return False
    positional = 0
    for parameter in signature.parameters.values():
        if parameter.kind in (
            parameter.POSITIONAL_ONLY,
            parameter.POSITIONAL_OR_KEYWORD,
            parameter.VAR_POSITIONAL,
        ):
            positional += 1
        elif parameter.kind is parameter.KEYWORD_ONLY and parameter.default is parameter.empty:
            return True
    return positional > 0


def _request_metadata(request: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = request.get("metadata")
    return metadata if isinstance(metadata, Mapping) else {}


def _synthetic_data_allowed(request: Mapping[str, Any]) -> bool:
    return _request_metadata(request).get("allowSyntheticData") is True


def _input_asset(request: Mapping[str, Any]) -> Mapping[str, Any]:
    assets = _request_metadata(request).get("inputAssets")
    if not isinstance(assets, list) or not assets or not isinstance(assets[0], Mapping):
        raise ValueError("INPUT_ASSET_REQUIRED")
    return assets[0]


def _validated_asset_path(asset: Mapping[str, Any]) -> Any:
    import hashlib
    from pathlib import Path

    path = Path(str(asset.get("path") or ""))
    if not path.is_file():
        raise ValueError("INPUT_ASSET_NOT_FOUND")
    if path.stat().st_size != asset.get("bytes"):
        raise ValueError("INPUT_ASSET_CHANGED")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != asset.get("sha256"):
        raise ValueError("INPUT_ASSET_CHANGED")
    return path


def _csv_asset_rows(request: Mapping[str, Any], required_columns: set[str]) -> tuple[list[dict[str, str]], Mapping[str, Any]]:
    import csv

    asset = _input_asset(request)
    path = _validated_asset_path(asset)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or [])
        missing = required_columns - fields
        if missing:
            raise ValueError(f"INPUT_COLUMNS_MISSING:{','.join(sorted(missing))}")
        rows = list(reader)
    if len(rows) < 10:
        raise ValueError("INPUT_ASSET_INSUFFICIENT_ROWS")
    return rows, asset


def _execute_node_json(module_path: Any, script: str, payload: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    import json
    import subprocess

    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30.0,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Scientific Node execution failed: {proc.stderr[-2000:]}")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Scientific Node execution returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise RuntimeError("Scientific Node execution returned a non-object result")
    return result, proc.stdout.strip()


class SolverAdapter:
    """Callable solver port used by ``ExecutionManager``."""

    def __init__(
        self,
        *,
        client_factory: Callable[..., Any],
        agent_factory: Callable[..., Any] | None = None,
        provider_name: str | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._agent_factory = agent_factory
        self._provider_name = provider_name
        # A production factory needs the per-run budgets (the transport deadline
        # follows ``problem_seconds``); test fixtures usually need no arguments.
        # Both shapes are accepted explicitly instead of guessing at call time.
        self._factory_takes_budget = _accepts_budget(client_factory)

    def _build_client(self, budgets: Mapping[str, Any]) -> Any:
        if self._factory_takes_budget:
            return self._client_factory(dict(budgets))
        return self._client_factory()

    def _agent_class(self) -> Callable[..., Any]:
        if self._agent_factory is not None:
            return self._agent_factory
        from user_agent import ReasoningAgent

        return ReasoningAgent

    def _scientific_workflow(self, request: Mapping[str, Any]) -> dict[str, Any]:
        metadata = _request_metadata(request)
        mode = str(metadata.get("evaluationMode") or "B2")
        skipped = (
            metadata.get("allowSyntheticData") is True
            or metadata.get("skipModelWorkflow") is True
            or mode == "B1"
        )
        budgets = {key: request.get(key, DEFAULT_BUDGET[key]) for key in _BUDGET_KEYS}
        configured_max = 3 if mode in {"A1", "A2", "A3"} else 5
        max_calls = min(configured_max, int(budgets["max_model_calls"]))
        return {
            "client": None if skipped else self._build_client(budgets),
            "calls": 0,
            "maxCalls": max_calls,
            "skipped": skipped,
            "mode": mode,
            "literatureEvidence": metadata.get("literatureEvidence"),
        }

    def _scenario_chat_json(
        self,
        workflow: dict[str, Any],
        *,
        role_id: str,
        system_prompt: str,
        user_payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        import json

        if workflow["calls"] >= workflow["maxCalls"]:
            raise RuntimeError("SCIENTIFIC_MODEL_BUDGET_EXHAUSTED")
        workflow["calls"] += 1
        response = workflow["client"].chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            temperature=0.2,
            max_tokens=2048,
        )
        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"{role_id}_RESPONSE_CONTRACT_INVALID") from exc
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError(f"{role_id}_RESPONSE_EMPTY")
        stripped = content.strip()
        if stripped.startswith("```"):
            lines = stripped.splitlines()
            if len(lines) >= 3 and lines[-1].strip() == "```":
                stripped = "\n".join(lines[1:-1]).strip()
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{role_id}_JSON_REQUIRED") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError(f"{role_id}_JSON_OBJECT_REQUIRED")
        return parsed

    def _plan_scientific_scenario(
        self,
        workflow: dict[str, Any],
        *,
        domain_id: str,
        tool_id: str,
        problem: str,
        input_payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        if workflow["skipped"]:
            return {"roleId": "planner", "decision": "EXECUTE", "status": "SKIPPED_EXPLICIT_TEST"}
        dataset = input_payload.get("dataset")
        dataset_summary: dict[str, Any] = {}
        if isinstance(dataset, Mapping):
            points = dataset.get("points")
            if isinstance(points, list):
                dataset_summary = {
                    "dt": dataset.get("dt"),
                    "pointCount": len(points),
                    "trainCount": len(dataset.get("trainIndices") or []),
                    "holdoutCount": len(dataset.get("valIndices") or []),
                }
            else:
                dataset_summary = {
                    key: len(value) if isinstance(value, list) else value
                    for key, value in dataset.items()
                    if key in {"groupA", "groupB"}
                }
        if workflow["mode"] in {"B3", "A5"}:
            planner_prompt = (
                "你是统一科研智能体，独立完成规划、执行和自审，不使用领域启发式或独立角色。"
                "仅输出 JSON：decision=EXECUTE|ABSTAIN, toolId, goal, rationale。"
            )
        else:
            planner_prompt = (
                f"你是 {domain_id} 科研规划 Agent。只能决定是否调用给定白名单工具，不得编造数据或结果。"
                "仅输出 JSON：decision=EXECUTE|ABSTAIN, toolId, goal, rationale。"
                "输入不属于该领域、缺少必要科学信息或工具不适用时必须 ABSTAIN。"
            )
        if workflow["mode"] == "A4":
            planner_prompt += "只能采用给定单一路由，禁止备选路线。"
        plan = self._scenario_chat_json(
            workflow,
            role_id="SCIENTIFIC_PLANNER",
            system_prompt=planner_prompt,
            user_payload={
                "domainId": domain_id,
                "allowedToolId": tool_id,
                "problem": problem,
                "inputMode": input_payload.get("mode"),
                "source": input_payload.get("source"),
                "literatureEvidence": input_payload.get("literatureEvidence") or workflow.get("literatureEvidence"),
                "datasetSummary": dataset_summary,
                "alpha": input_payload.get("alpha"),
                "tFinal": input_payload.get("tFinal"),
            },
        )
        if plan.get("decision") == "ABSTAIN":
            raise ValueError(f"MODEL_PLAN_ABSTAINED:{plan.get('rationale') or 'no rationale'}")
        if plan.get("decision") != "EXECUTE" or plan.get("toolId") != tool_id:
            raise RuntimeError("SCIENTIFIC_PLANNER_TOOL_CONTRACT_INVALID")
        if not isinstance(plan.get("goal"), str) or not plan["goal"].strip():
            raise RuntimeError("SCIENTIFIC_PLANNER_GOAL_REQUIRED")
        plan["roleId"] = "planner"
        plan["candidateVerified"] = False
        return plan

    def _review_scientific_scenario(
        self,
        workflow: dict[str, Any],
        *,
        domain_id: str,
        problem: str,
        plan: Mapping[str, Any],
        numerical_payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        mode = workflow["mode"]
        if workflow["skipped"]:
            return {
                "planner": plan,
                "mode": mode,
                "status": "SKIPPED_EXPLICIT_TEST",
                "accepted": numerical_payload.get("allObligationsMet", True),
                "repaired": False,
                "modelCalls": 0,
                "candidateVerified": False,
            }
        receipt: Mapping[str, Any] = numerical_payload
        if workflow.get("literatureEvidence") is not None:
            receipt = {
                **numerical_payload,
                "literatureEvidence": workflow["literatureEvidence"],
            }
        model_receipt: Mapping[str, Any] = receipt
        if mode == "A2":
            model_receipt = {
                "status": "FEEDBACK_WITHHELD",
                "allObligationsMet": False,
                "candidateVerified": False,
            }
        if mode in {"B3", "A5"}:
            worker_prompt = (
                "你是统一科研智能体，不使用领域启发式或独立角色。"
                "仅依据可见回执输出 JSON：decision=CANDIDATE|UNSOLVED, summary, claims[], limitations[]。"
            )
        else:
            worker_prompt = (
                f"你是 {domain_id} 领域解释 Agent。只能依据给定数值工具回执形成候选解释，"
                "不得修改数值、补充未计算指标或声称已验证。仅输出 JSON："
                "decision=CANDIDATE|UNSOLVED, summary, claims[], limitations[]。"
            )
        worker = self._scenario_chat_json(
            workflow,
            role_id="SCIENTIFIC_WORKER",
            system_prompt=worker_prompt,
            user_payload={
                "domainId": domain_id,
                "problem": problem,
                "goal": plan.get("goal"),
                "numericalReceipt": model_receipt,
            },
        )
        if worker.get("decision") not in {"CANDIDATE", "UNSOLVED"}:
            raise RuntimeError("SCIENTIFIC_WORKER_DECISION_INVALID")
        if not isinstance(worker.get("summary"), str) or not isinstance(worker.get("limitations"), list):
            raise RuntimeError("SCIENTIFIC_WORKER_CONTRACT_INVALID")
        if mode == "A1":
            accepted = worker["decision"] == "CANDIDATE" and receipt.get("allObligationsMet") is True
            return {
                "planner": plan,
                "worker": worker,
                "mode": mode,
                "reviewerAblated": True,
                "accepted": accepted,
                "repaired": False,
                "modelCalls": workflow["calls"],
                "candidateVerified": False,
            }

        def review(candidate: Mapping[str, Any]) -> dict[str, Any]:
            if mode in {"B3", "A5"}:
                reviewer_prompt = (
                    "你是同一个统一科研智能体，正在进行自审而非独立审查，不使用领域启发式。"
                    "仅输出 JSON：decision=ACCEPT_WITHIN_SCOPE|REQUEST_REPAIR|REJECT|INCONCLUSIVE,"
                    "rationale, unresolvedObligations[]。"
                )
            else:
                reviewer_prompt = (
                    "你是独立科研审查 Agent，只审查候选和数值证据，不参与规划。"
                    "不得把候选标为已验证。仅输出 JSON：decision=ACCEPT_WITHIN_SCOPE|REQUEST_REPAIR|REJECT|INCONCLUSIVE,"
                    "rationale, unresolvedObligations[]。任一数值义务未闭合、证据不足或候选超出证据时必须拒绝。"
                )
            result = self._scenario_chat_json(
                workflow,
                role_id="SCIENTIFIC_REVIEWER",
                system_prompt=reviewer_prompt,
                user_payload={
                    "domainId": domain_id,
                    "candidate": candidate,
                    "planContext": plan if mode == "B3" else None,
                    "numericalReceipt": model_receipt,
                },
            )
            if result.get("decision") not in {"ACCEPT_WITHIN_SCOPE", "REQUEST_REPAIR", "REJECT", "INCONCLUSIVE"}:
                raise RuntimeError("SCIENTIFIC_REVIEWER_DECISION_INVALID")
            if not isinstance(result.get("unresolvedObligations"), list) or not isinstance(result.get("rationale"), str):
                raise RuntimeError("SCIENTIFIC_REVIEWER_CONTRACT_INVALID")
            return result

        reviewer = review(worker)
        repaired = False
        repair_blocked = False
        if reviewer["decision"] == "REQUEST_REPAIR":
            if mode in {"A2", "A3"}:
                repair_blocked = True
            else:
                repair = self._scenario_chat_json(
                    workflow,
                    role_id="SCIENTIFIC_REPAIRER",
                    system_prompt=(
                        "你是有界修复 Agent，只能根据审查质疑修正候选解释，不得修改数值证据。"
                        "仅输出 JSON：decision=CANDIDATE|UNSOLVED, summary, claims[], limitations[]。"
                    ),
                    user_payload={
                        "domainId": domain_id,
                        "candidate": worker,
                        "challenge": reviewer,
                        "numericalReceipt": model_receipt,
                    },
                )
                if repair.get("decision") not in {"CANDIDATE", "UNSOLVED"}:
                    raise RuntimeError("SCIENTIFIC_REPAIRER_DECISION_INVALID")
                if not isinstance(repair.get("summary"), str) or not isinstance(repair.get("limitations"), list):
                    raise RuntimeError("SCIENTIFIC_REPAIRER_CONTRACT_INVALID")
                worker = repair
                repaired = True
                reviewer = review(worker)
        unresolved = reviewer["unresolvedObligations"]
        accepted = (
            mode != "A2"
            and not repair_blocked
            and worker["decision"] == "CANDIDATE"
            and reviewer["decision"] == "ACCEPT_WITHIN_SCOPE"
            and not unresolved
            and receipt.get("allObligationsMet") is True
        )
        return {
            "planner": plan,
            "worker": worker,
            "reviewer": reviewer,
            "mode": mode,
            "accepted": accepted,
            "repaired": repaired,
            "repairBlocked": repair_blocked,
            "feedbackWithheld": mode == "A2",
            "literatureEvidence": workflow.get("literatureEvidence"),
            "modelCalls": workflow["calls"],
            "candidateVerified": False,
        }

    def _solve_control(self, problem: str, request: Mapping[str, Any]) -> Mapping[str, Any]:
        import math
        import re
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[2]
        module_url = (repo_root / "packages" / "domain-control" / "dist" / "src" / "index.js").as_uri()
        metadata = _request_metadata(request)
        if _synthetic_data_allowed(request):
            match_m = re.search(r"m\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            match_c = re.search(r"c\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            match_k = re.search(r"k\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            input_payload: Mapping[str, Any] = {
                "mode": "synthetic",
                "options": {
                    "m": float(match_m.group(1)) if match_m else 1.5,
                    "c": float(match_c.group(1)) if match_c else 0.4,
                    "k": float(match_k.group(1)) if match_k else 2.8,
                    "duration": 30.0,
                    "dt": 0.01,
                    "noiseStd": 0.0005,
                    "holdoutRatio": 0.2,
                },
            }
        else:
            rows, asset = _csv_asset_rows(
                request,
                {"time_s", "excitation_u_N", "measured_displacement_x_m"},
            )
            points = []
            for index, row in enumerate(rows):
                try:
                    t = float(row["time_s"])
                    u = float(row["excitation_u_N"])
                    x = float(row["measured_displacement_x_m"])
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"INPUT_NUMERIC_VALUE_REQUIRED:{index + 2}") from exc
                if not all(math.isfinite(value) for value in (t, u, x)):
                    raise ValueError(f"INPUT_NON_FINITE_VALUE:{index + 2}")
                points.append({"t": t, "u": u, "x": x, "sampleId": index})
            if any(points[index]["t"] <= points[index - 1]["t"] for index in range(1, len(points))):
                raise ValueError("INPUT_TIME_NOT_STRICTLY_INCREASING")
            dt = (points[-1]["t"] - points[0]["t"]) / (len(points) - 1)
            if dt <= 0:
                raise ValueError("INPUT_INVALID_SAMPLING_INTERVAL")
            holdout_ratio = metadata.get("holdoutRatio", 0.2)
            if not isinstance(holdout_ratio, (int, float)) or not 0.1 <= holdout_ratio <= 0.5:
                raise ValueError("INPUT_INVALID_HOLDOUT_RATIO")
            split = int(len(points) * (1.0 - holdout_ratio))
            if split < 5 or len(points) - split < 3:
                raise ValueError("INPUT_INSUFFICIENT_TRAIN_OR_HOLDOUT_ROWS")
            train_indices = list(range(split))
            val_indices = list(range(split, len(points)))
            points = [
                {**point, "partition": "train" if point["sampleId"] < split else "validation"}
                for point in points
            ]
            input_payload = {
                "mode": "file",
                "dataset": {
                    "dt": dt,
                    "points": points,
                    "trainIndices": train_indices,
                    "valIndices": val_indices,
                },
                "source": {key: asset[key] for key in ("ref", "sha256", "bytes")},
            }

        workflow = self._scientific_workflow(request)
        plan = self._plan_scientific_scenario(
            workflow,
            domain_id="control.identification",
            tool_id="control.parameter_estimator",
            problem=problem,
            input_payload=input_payload,
        )
        node_script = f"""
import fs from 'node:fs';
const {{ generateOscillatorDataset, ParameterEstimator, CONTROL_DOMAIN_ID }} = await import('{module_url}');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const dataset = input.mode === 'synthetic' ? generateOscillatorDataset(input.options) : input.dataset;
const fitResult = ParameterEstimator.estimate(dataset, {{ maxHoldoutRmse: 0.05 }});
const output = {{
  domainId: CONTROL_DOMAIN_ID,
  targetSystem: 'forced_damped_oscillator',
  sourceDataset: input.source ?? {{ kind: 'explicit_synthetic_fixture' }},
  parameters: fitResult.parameters,
  confidenceIntervals: fitResult.confidenceIntervals,
  samplingGuard: fitResult.samplingGuard,
  leakageGuard: fitResult.leakageGuard,
  residualDiagnosis: fitResult.residualDiagnosis,
  holdoutValidation: {{
    holdoutRmse: fitResult.holdoutValidation.holdoutRmse,
    threshold: fitResult.holdoutValidation.threshold,
    passed: fitResult.holdoutValidation.passed
  }},
  allObligationsMet: fitResult.allObligationsMet,
  candidateVerified: false
}};
console.log(JSON.stringify(output));
"""
        control_payload, control_json_str = _execute_node_json(module_url, node_script, input_payload)
        agent_workflow = self._review_scientific_scenario(
            workflow,
            domain_id="control.identification",
            problem=problem,
            plan=plan,
            numerical_payload=control_payload,
        )
        control_payload["agentWorkflow"] = agent_workflow
        import json
        control_json_str = json.dumps(control_payload, ensure_ascii=False)
        accepted = agent_workflow["accepted"] is True

        observer = request.get("_event_sink")
        if callable(observer):
            observer({
                "kind": "CONTRACT",
                "sourceKind": "official_result",
                "payload": {
                    "domainId": "control.identification",
                    "obligations": [
                        "ob_leak_prevention",
                        "ob_physics_bounds",
                        "ob_aliasing_guard",
                        "ob_residual_whiteness",
                        "ob_independent_rmse",
                    ],
                },
            })
            observer({
                "kind": "RESULT",
                "sourceKind": "official_result",
                "payload": {
                    "status": "candidate" if accepted else "unsolved",
                    "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
                    "candidate_verified": False,
                    "parameters": control_payload["parameters"],
                },
            })

        return {
            "status": "candidate" if accepted else "unsolved",
            "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
            "stop_reason": "STOPPED" if accepted else "NO_CANDIDATE",
            "final_response": control_json_str,
            "candidate_verified": False,
            "executed": True,
            "code": None,
            "reason": "DYNAMICS_IDENTIFICATION_EVALUATED" if accepted else "SCIENTIFIC_OBLIGATIONS_UNRESOLVED",
            "provider": self._provider_name or "s2",
            "runId": request.get("run_id"),
            "details": control_payload,
            "agentWorkflow": agent_workflow,
            "metrics": {"modelCalls": agent_workflow["modelCalls"], "toolCalls": 1},
        }

    def _solve_data_analysis(self, problem: str, request: Mapping[str, Any]) -> Mapping[str, Any]:
        import math
        import re
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[2]
        module_url = (repo_root / "packages" / "domain-data-analysis" / "dist" / "src" / "index.js").as_uri()
        metadata = _request_metadata(request)
        options = metadata.get("inputOptions") if isinstance(metadata.get("inputOptions"), Mapping) else {}
        alpha = options.get("alphaLevel", 0.05)
        if not isinstance(alpha, (int, float)) or not 0 < alpha < 1:
            raise ValueError("INPUT_INVALID_ALPHA_LEVEL")
        if _synthetic_data_allowed(request):
            match_mean1 = re.search(r"mean1\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            match_mean2 = re.search(r"mean2\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            input_payload: Mapping[str, Any] = {
                "mode": "synthetic",
                "options": {
                    "n1": 50,
                    "n2": 50,
                    "mean1": float(match_mean1.group(1)) if match_mean1 else 10.0,
                    "mean2": float(match_mean2.group(1)) if match_mean2 else 12.5,
                    "std1": 1.2,
                    "std2": 1.4,
                    "seed": 42,
                },
                "alpha": alpha,
            }
        else:
            group_column = options.get("groupColumn", "group")
            value_column = options.get("valueColumn", "score_change")
            if not isinstance(group_column, str) or not isinstance(value_column, str):
                raise ValueError("INPUT_INVALID_COLUMN_MAPPING")
            rows, asset = _csv_asset_rows(request, {group_column, value_column})
            grouped: dict[str, list[float]] = {}
            for index, row in enumerate(rows):
                group = (row.get(group_column) or "").strip()
                if not group:
                    raise ValueError(f"INPUT_GROUP_REQUIRED:{index + 2}")
                try:
                    value = float(row[value_column])
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"INPUT_NUMERIC_VALUE_REQUIRED:{index + 2}") from exc
                if not math.isfinite(value):
                    raise ValueError(f"INPUT_NON_FINITE_VALUE:{index + 2}")
                grouped.setdefault(group, []).append(value)
            if len(grouped) != 2:
                raise ValueError("INPUT_EXACTLY_TWO_GROUPS_REQUIRED")
            group_labels = sorted(grouped)
            group_a, group_b = (grouped[label] for label in group_labels)
            if len(group_a) < 3 or len(group_b) < 3:
                raise ValueError("INPUT_AT_LEAST_THREE_ROWS_PER_GROUP_REQUIRED")
            input_payload = {
                "mode": "file",
                "dataset": {"groupA": group_a, "groupB": group_b},
                "groupLabels": group_labels,
                "alpha": alpha,
                "source": {key: asset[key] for key in ("ref", "sha256", "bytes")},
            }

        workflow = self._scientific_workflow(request)
        plan = self._plan_scientific_scenario(
            workflow,
            domain_id="data_analysis",
            tool_id="data.statistical_analyzer",
            problem=problem,
            input_payload=input_payload,
        )
        node_script = f"""
import fs from 'node:fs';
const {{ generateTwoSampleDataset, StatisticalAnalyzer, DATA_ANALYSIS_ID }} = await import('{module_url}');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const dataset = input.mode === 'synthetic' ? generateTwoSampleDataset(input.options) : input.dataset;
const report = StatisticalAnalyzer.analyze(dataset, {{ alpha: input.alpha }});
const output = {{
  domainId: DATA_ANALYSIS_ID,
  sourceDataset: input.source ?? {{ kind: 'explicit_synthetic_fixture' }},
  groupLabels: input.groupLabels ?? ['groupA', 'groupB'],
  testMethod: report.testMethod,
  groupA: report.groupA,
  groupB: report.groupB,
  testResult: report.testResult,
  normalityDiagnosis: report.normalityDiagnosis,
  homoscedasticityDiagnosis: report.homoscedasticityDiagnosis,
  residualDiagnosis: report.residualDiagnosis,
  allObligationsMet: report.allObligationsMet,
  candidateVerified: false
}};
console.log(JSON.stringify(output));
"""
        stats_payload, stats_json_str = _execute_node_json(module_url, node_script, input_payload)
        agent_workflow = self._review_scientific_scenario(
            workflow,
            domain_id="data_analysis",
            problem=problem,
            plan=plan,
            numerical_payload=stats_payload,
        )
        stats_payload["agentWorkflow"] = agent_workflow
        import json
        stats_json_str = json.dumps(stats_payload, ensure_ascii=False)
        accepted = agent_workflow["accepted"] is True

        observer = request.get("_event_sink")
        if callable(observer):
            observer({
                "kind": "CONTRACT",
                "sourceKind": "official_result",
                "payload": {
                    "domainId": "data_analysis",
                    "obligations": [
                        "ob_normality_homoscedasticity",
                        "ob_effect_significance",
                        "ob_residual_whiteness",
                    ],
                },
            })
            observer({
                "kind": "RESULT",
                "sourceKind": "official_result",
                "payload": {
                    "status": "candidate" if accepted else "unsolved",
                    "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
                    "candidate_verified": False,
                    "testResult": stats_payload["testResult"],
                },
            })

        return {
            "status": "candidate" if accepted else "unsolved",
            "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
            "stop_reason": "STOPPED" if accepted else "NO_CANDIDATE",
            "final_response": stats_json_str,
            "candidate_verified": False,
            "strictAcceptance": "NOT_PERFORMED",
            "executed": True,
            "code": None,
            "reason": "STATISTICAL_INFERENCE_EVALUATED" if accepted else "SCIENTIFIC_OBLIGATIONS_UNRESOLVED",
            "provider": self._provider_name or "s2",
            "runId": request.get("run_id"),
            "details": stats_payload,
            "agentWorkflow": agent_workflow,
            "metrics": {"modelCalls": agent_workflow["modelCalls"], "toolCalls": 1},
        }

    def _solve_scientific_computing(self, problem: str, request: Mapping[str, Any]) -> Mapping[str, Any]:
        import math
        import re
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[2]
        module_url = (repo_root / "packages" / "domain-scientific-computing" / "dist" / "src" / "index.js").as_uri()
        metadata = _request_metadata(request)
        options = metadata.get("inputOptions") if isinstance(metadata.get("inputOptions"), Mapping) else {}
        match_alpha = re.search(r"alpha\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
        alpha_value = options.get("diffusivityAlpha")
        if alpha_value is None and match_alpha:
            alpha_value = float(match_alpha.group(1))
        if alpha_value is None and _synthetic_data_allowed(request):
            alpha_value = 0.1
        if not isinstance(alpha_value, (int, float)) or not math.isfinite(alpha_value) or alpha_value <= 0:
            raise ValueError("INPUT_POSITIVE_ALPHA_REQUIRED")
        fault = None
        if "MISSING_BOUNDARY" in problem or "遗漏边界" in problem:
            fault = "MISSING_BOUNDARY"
        elif "CFL_VIOLATION" in problem or "CFL违例" in problem:
            fault = "CFL_VIOLATION"

        if _synthetic_data_allowed(request):
            match_t = re.search(r"tFinal\s*=\s*([0-9.]+)", problem, re.IGNORECASE)
            input_payload: Mapping[str, Any] = {
                "mode": "synthetic",
                "alpha": alpha_value,
                "tFinal": float(match_t.group(1)) if match_t else 0.2,
                "fault": fault,
            }
        else:
            rows, asset = _csv_asset_rows(
                request,
                {"time_s", "position_x_m", "temperature_degC"},
            )
            observations = []
            for index, row in enumerate(rows):
                try:
                    time_s = float(row["time_s"])
                    position = float(row["position_x_m"])
                    temperature = float(row["temperature_degC"])
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"INPUT_NUMERIC_VALUE_REQUIRED:{index + 2}") from exc
                if not all(math.isfinite(value) for value in (time_s, position, temperature)) or time_s < 0:
                    raise ValueError(f"INPUT_INVALID_THERMAL_OBSERVATION:{index + 2}")
                observations.append({"time": time_s, "x": position, "value": temperature})
            initial_time = min(row["time"] for row in observations)
            final_time = max(row["time"] for row in observations)
            if final_time <= initial_time:
                raise ValueError("INPUT_THERMAL_TIME_RANGE_REQUIRED")
            initial_rows = sorted(
                (row for row in observations if row["time"] == initial_time),
                key=lambda row: row["x"],
            )
            final_rows = [row for row in observations if row["time"] == final_time]
            if len(initial_rows) < 3 or len(final_rows) < 3:
                raise ValueError("INPUT_THERMAL_SPATIAL_SAMPLES_REQUIRED")
            positions = [row["x"] for row in initial_rows]
            if len(set(positions)) != len(positions):
                raise ValueError("INPUT_DUPLICATE_INITIAL_POSITION")
            input_payload = {
                "mode": "file",
                "alpha": alpha_value,
                "tFinal": final_time - initial_time,
                "fault": fault,
                "initialProfile": [{"x": row["x"], "value": row["value"]} for row in initial_rows],
                "finalObservations": [{"x": row["x"], "value": row["value"]} for row in final_rows],
                "boundaryLeft": initial_rows[0]["value"],
                "boundaryRight": initial_rows[-1]["value"],
                "source": {key: asset[key] for key in ("ref", "sha256", "bytes")},
            }

        workflow = self._scientific_workflow(request)
        plan = self._plan_scientific_scenario(
            workflow,
            domain_id="scientific_computing",
            tool_id="scicomp.heat_equation_solver",
            problem=problem,
            input_payload=input_payload,
        )
        node_script = f"""
import fs from 'node:fs';
const {{ HeatEquationSolver, SCI_COMPUTING_ID }} = await import('{module_url}');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const report = HeatEquationSolver.verifyConvergence({{ alpha: input.alpha, tFinal: input.tFinal, fault: input.fault }}, [20, 40, 80]);
let experimentalSimulation = null;
if (input.mode === 'file') {{
  const simulation = HeatEquationSolver.simulateProfile({{
    alpha: input.alpha,
    tFinal: input.tFinal,
    nx: 80,
    initialProfile: input.initialProfile,
    boundaryLeft: input.boundaryLeft,
    boundaryRight: input.boundaryRight
  }});
  const estimate = (x) => {{
    if (x <= simulation.xGrid[0]) return simulation.numericalValues[0];
    const last = simulation.xGrid.length - 1;
    if (x >= simulation.xGrid[last]) return simulation.numericalValues[last];
    for (let index = 1; index <= last; index += 1) {{
      if (x <= simulation.xGrid[index]) {{
        const ratio = (x - simulation.xGrid[index - 1]) / (simulation.xGrid[index] - simulation.xGrid[index - 1]);
        return simulation.numericalValues[index - 1] + ratio * (simulation.numericalValues[index] - simulation.numericalValues[index - 1]);
      }}
    }}
    return simulation.numericalValues[last];
  }};
  const errors = input.finalObservations.map((observation) => estimate(observation.x) - observation.value);
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  const maxError = Math.max(...errors.map((error) => Math.abs(error)));
  experimentalSimulation = {{
    xGrid: simulation.xGrid,
    numericalValues: simulation.numericalValues,
    finalObservations: input.finalObservations,
    rmse,
    maxError,
    maxAllowedRmse: 1.0,
    passed: Number.isFinite(rmse) && rmse <= 1.0,
    dt: simulation.dt,
    cfl: simulation.cfl
  }};
}}
const output = {{
  domainId: SCI_COMPUTING_ID,
  sourceDataset: input.source ?? {{ kind: 'explicit_synthetic_fixture' }},
  scheme: report.scheme,
  alpha: report.alpha,
  tFinal: report.tFinal,
  observedOrder: report.observedOrder,
  expectedOrder: report.expectedOrder,
  isOrderConsistent: report.isOrderConsistent,
  grids: report.grids,
  cflDiagnosis: report.cflDiagnosis,
  boundaryDiagnosis: report.boundaryDiagnosis,
  experimentalSimulation,
  allObligationsMet: report.allObligationsMet && (experimentalSimulation === null || experimentalSimulation.passed),
  candidateVerified: false
}};
console.log(JSON.stringify(output));
"""
        sci_payload, sci_json_str = _execute_node_json(module_url, node_script, input_payload)
        agent_workflow = self._review_scientific_scenario(
            workflow,
            domain_id="scientific_computing",
            problem=problem,
            plan=plan,
            numerical_payload=sci_payload,
        )
        sci_payload["agentWorkflow"] = agent_workflow
        import json
        sci_json_str = json.dumps(sci_payload, ensure_ascii=False)
        accepted = agent_workflow["accepted"] is True

        observer = request.get("_event_sink")
        if callable(observer):
            observer({
                "kind": "CONTRACT",
                "sourceKind": "official_result",
                "payload": {
                    "domainId": "scientific_computing",
                    "obligations": [
                        "ob_mesh_convergence",
                        "ob_boundary_conservation",
                        "ob_cfl_stability",
                        "ob_experimental_comparison",
                    ],
                },
            })
            observer({
                "kind": "RESULT",
                "sourceKind": "official_result",
                "payload": {
                    "status": "candidate" if accepted else "unsolved",
                    "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
                    "candidate_verified": False,
                    "observedOrder": sci_payload["observedOrder"],
                    "allObligationsMet": sci_payload["allObligationsMet"],
                },
            })

        return {
            "status": "candidate" if accepted else "unsolved",
            "stopReason": "STOPPED" if accepted else "NO_CANDIDATE",
            "stop_reason": "STOPPED" if accepted else "NO_CANDIDATE",
            "final_response": sci_json_str,
            "candidate_verified": False,
            "strictAcceptance": "NOT_PERFORMED",
            "executed": True,
            "code": None,
            "reason": "SCIENTIFIC_COMPUTATION_EVALUATED" if accepted else "SCIENTIFIC_OBLIGATIONS_UNRESOLVED",
            "provider": self._provider_name or "s2",
            "runId": request.get("run_id"),
            "details": sci_payload,
            "agentWorkflow": agent_workflow,
            "metrics": {"modelCalls": agent_workflow["modelCalls"], "toolCalls": 1},
        }

    def __call__(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        problem = request.get("problem")
        if not isinstance(problem, str) or not problem.strip():
            raise ValueError("invalid problem")

        metadata = request.get("metadata") or {}
        domain_id = (
            request.get("domain_id")
            or metadata.get("domainId")
            or metadata.get("domain_id")
        )
        if not domain_id:
            import re
            m = re.search(r"\[(?:RunSpec|domain):([a-zA-Z0-9_.-]+)\]", problem)
            if m:
                domain_id = m.group(1)
            elif "振子" in problem or "oscillator" in problem:
                domain_id = "control.identification"
            elif "两组" in problem or "样本" in problem or "welch" in problem or "t-test" in problem or "统计" in problem:
                domain_id = "data_analysis"
            elif "热传导" in problem or "heat" in problem or "pde" in problem or "scicomp" in problem or "有限差分" in problem:
                domain_id = "scientific_computing"
            else:
                domain_id = "math"

        if domain_id in {"control", "control.identification"}:
            return self._solve_control(problem, request)

        if domain_id in {"data_analysis", "data-analysis", "statistics"}:
            return self._solve_data_analysis(problem, request)

        if domain_id in {"scientific_computing", "scicomp", "domain-scientific-computing"}:
            return self._solve_scientific_computing(problem, request)

        budgets = {
            key: request.get(key, DEFAULT_BUDGET[key])
            for key in _BUDGET_KEYS
        }
        client = self._build_client(budgets)
        observer = request.get("_event_sink")
        agent_kwargs = dict(budgets)
        if callable(observer):
            agent_kwargs["observer"] = observer
        agent = self._agent_class()(client=client, **agent_kwargs)
        metadata = request.get("metadata")
        result = agent.solve(problem, dict(metadata) if isinstance(metadata, Mapping) else {})
        if not isinstance(result, Mapping):
            raise TypeError("ReasoningAgent.solve must return a mapping")
        payload = dict(result)
        # A Web run can never turn a candidate into a verified answer.
        if payload.get("candidate_verified") is not False:
            payload["candidate_verified"] = False
            payload["reason"] = (
                str(payload.get("reason") or "")
                + "; web adapter downgraded candidate_verified to false"
            ).strip("; ")
        payload.setdefault("executed", True)
        payload.setdefault("runId", request.get("run_id"))
        if self._provider_name is not None:
            payload.setdefault("provider", self._provider_name)
        return payload


def build_solver_from_env() -> Optional[SolverAdapter]:
    """Build a production solver only when explicit server credentials exist.

    Credentials are read from the service process environment, never from a
    browser request. With no configuration the BFF keeps the explicit
    ``SOLVER_NOT_CONFIGURED`` path rather than silently using a fixture.

    Provider selection (server-side env ``ASTRA_PROVIDER`` only):
    - ``atria`` / ``intern-atria``: ``mathagent.atria_client.AtriaDawnClient``
      against the InkStone discovery gateway (default provider when an Atria
      key is present).
    - ``inkstone-desktop``: ``InkstoneDesktopBridgeClient`` bridging to the
      inkstone-re-lab desktop protocol stack (needs ``INKSTONE_RE_LAB_ROOT``).
    - otherwise: the original ``UserSuppliedS2Client`` Intern-S2 path.
    """
    provider = os.environ.get("ASTRA_PROVIDER", "").strip().lower()

    if provider in {"mock", "mock-offline", "test"}:
        def _mock_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            import json
            from python.astra_bridge.public_chat_port import PublicChatPort

            class _MockConnector:
                def __init__(self, **_kw):
                    self.calls = 0

                def chat(self, messages, **_kw):
                    self.calls += 1
                    return {
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "stop",
                                "message": {
                                    "role": "assistant",
                                    "content": json.dumps({
                                        "candidateProposal": "ok",
                                        "claim": "domain identification complete",
                                        "deliveryStatus": "COMPLETE",
                                    }),
                                },
                            }
                        ]
                    }

            return PublicChatPort(_MockConnector(), request_seconds=30.0)

        return SolverAdapter(client_factory=_mock_factory, provider_name="mock")

    if provider == "inkstone-desktop":
        inkstone_root = os.environ.get("INKSTONE_RE_LAB_ROOT", "").strip()
        if not inkstone_root:
            return None
        model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()

        def _desktop_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            from mathagent.atria_client import InkstoneDesktopBridgeClient
            from python.astra_bridge.public_chat_port import PublicChatPort

            connector = InkstoneDesktopBridgeClient(
                inkstone_repo_root=inkstone_root,
                model=model,
            )
            seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
            return PublicChatPort(connector, request_seconds=seconds)

        return SolverAdapter(client_factory=_desktop_factory, provider_name="inkstone-desktop")

    atria_key = (
        os.environ.get("ASTRA_ATRIA_API_KEY")
        or os.environ.get("ATRIA_API_KEY")
        or (os.environ.get("INTERN_API_KEY") if provider in {"atria", "intern-atria"} else None)
    )
    if provider in {"atria", "intern-atria"} or (not provider and atria_key):
        if not atria_key:
            return None
        endpoint = os.environ.get(
            "ASTRA_ATRIA_ENDPOINT",
            "https://discovery-api.intern-ai.org.cn/v1/chat/completions",
        ).strip()
        model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()

        def _atria_factory(budgets: Mapping[str, Any] | None = None) -> Any:
            from mathagent.atria_client import AtriaDawnClient
            from python.astra_bridge.public_chat_port import PublicChatPort

            connector = AtriaDawnClient(
                api_key=atria_key,
                endpoint=endpoint,
                model=model,
            )
            seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
            return PublicChatPort(connector, request_seconds=seconds)

        return SolverAdapter(client_factory=_atria_factory, provider_name="atria")

    api_key = os.environ.get("ASTRA_S2_API_KEY") or os.environ.get("INTERN_API_KEY")
    endpoint = os.environ.get("ASTRA_S2_ENDPOINT") or os.environ.get("INTERN_ENDPOINT")
    model = os.environ.get("ASTRA_S2_MODEL", "Intern-S2-Preview-397B")
    if not api_key or not endpoint:
        return None

    def _factory(budgets: Mapping[str, Any] | None = None) -> Any:
        """Build one explicit connector for one run.

        The connector is bound to the formal ``chat`` contract through
        ``PublicChatPort``: without that port the first dispatch raises
        ``TypeError`` (the user-supplied connector needs the frozen S2 settings,
        a bounded timeout and a cancellation event) and the Host would block the
        client for the rest of the process.
        """
        from mathagent.user_client import UserSuppliedS2Client
        from python.astra_bridge.public_chat_port import PublicChatPort

        connector = UserSuppliedS2Client(
            api_key=api_key,
            endpoint=endpoint,
            model=model,
        )
        seconds = (budgets or {}).get("problem_seconds", DEFAULT_BUDGET["problem_seconds"])
        return PublicChatPort(connector, request_seconds=seconds)

    return SolverAdapter(client_factory=_factory, provider_name="s2")


__all__ = ["SolverAdapter", "build_solver_from_env"]
