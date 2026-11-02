"""Zygos Universal API v2 routes (K19 & PR-T0/T1).

Complies with Section 13.2 of the Zygos Execution Plan:
- GET  /api/v2/domains
- GET  /api/v2/capabilities
- POST /api/v2/runs
- GET  /api/v2/runs/{run_id}
- GET  /api/v2/runs/{run_id}/evidence
- GET  /api/v2/runs/{run_id}/events
- POST /api/v2/runs/{run_id}/cancel
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .queue import ExecutionManager
from .storage import Store
from .solver_adapter import build_solver_from_env
from .isolated_worker import isolated_worker_capability
from .input_assets import resolve_input_assets, store_uploaded_asset
from python.astra_bridge.scenario_contracts import (
    ALL_SCENARIO_CONTRACTS,
    SCENARIO_DOMAIN_IDS,
)

logger = logging.getLogger("astra_web.v2_routes")


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


_SCENARIO_TOOLS = {
    "math.research": ["math.linear-algebra", "math.polynomials", "math.number-theory"],
    "control.identification": ["control.timeseries_loader", "control.parameter_estimator", "control.forward_simulator"],
    "scientific_computing.heat_transfer": ["scicomp.grid_generator", "scicomp.pde_solver", "scicomp.convergence_analyst"],
    "data_analysis.statistical_inference": ["data.cleaner", "data.normality_test", "data.hypothesis_tester"],
}

_FALLBACK_MANAGER: Optional[Tuple[ExecutionManager, Store]] = None


def _get_manager_and_store(request: Request) -> Tuple[ExecutionManager, Store]:
    """Retrieve ExecutionManager and Store from Starlette app state or isolated test fallback."""
    global _FALLBACK_MANAGER
    if (
        hasattr(request, "app")
        and hasattr(request.app, "state")
        and hasattr(request.app.state, "execution_manager")
    ):
        return request.app.state.execution_manager, request.app.state.store

    if _FALLBACK_MANAGER is None:
        import tempfile
        tmp_dir = Path(tempfile.mkdtemp(prefix="astra_v2_store_"))
        store = Store(tmp_dir)
        manager = ExecutionManager(store, solver=build_solver_from_env())
        _FALLBACK_MANAGER = (manager, store)
    return _FALLBACK_MANAGER


def _fallback_scenario_catalog(reason: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for scenario_id, contract in ALL_SCENARIO_CONTRACTS.items():
        entries.append({
            "scenarioId": scenario_id,
            "domainId": SCENARIO_DOMAIN_IDS[scenario_id],
            "version": contract.manifest.version,
            "name": contract.manifest.name,
            "domainType": contract.manifest.domain_type,
            "description": contract.manifest.description,
            "goals": list(contract.manifest.goals),
            "teamRolesCount": len(contract.team.roles),
            "inputKind": contract.inputs.input_kind,
            "visualizerComponent": contract.results.visualizer_component,
            "readinessStatus": "NOT_READY",
            "readinessReasons": [reason],
            "manifest": {
                "scenarioId": contract.manifest.scenario_id,
                "version": contract.manifest.version,
                "name": contract.manifest.name,
                "domainType": contract.manifest.domain_type,
                "description": contract.manifest.description,
                "goals": list(contract.manifest.goals),
                "requiredModelCapabilities": list(contract.manifest.required_model_capabilities),
                "requiresCodeIsolation": contract.manifest.requires_code_isolation,
            },
            "inputs": {
                "inputKind": contract.inputs.input_kind,
                "supportedExtensions": list(contract.inputs.supported_extensions),
                "requiredFields": list(contract.inputs.required_fields),
                "optionalFields": list(contract.inputs.optional_fields),
                "dataIsolationPolicy": contract.inputs.data_isolation_policy,
            },
            "team": {
                "teamId": contract.team.team_id,
                "scenarioId": contract.team.scenario_id,
                "roles": [
                    {
                        "roleId": role.role_id,
                        "name": role.name,
                        "roleCategory": role.role_category,
                        "ownedDimension": role.owned_dimension,
                        "description": role.description,
                        "triggerCondition": role.trigger_condition,
                        "contextVisibility": role.context_visibility,
                        "maxModelCallsPerTask": role.max_model_calls_per_task,
                    }
                    for role in contract.team.roles
                ],
                "defaultRoute": contract.team.default_route,
                "enableParallelReview": contract.team.enable_parallel_review,
                "enableBoundedRepair": contract.team.enable_bounded_repair,
                "maxRepairs": contract.team.max_repairs,
            },
            "results": {
                "primaryArtifactKind": contract.results.primary_artifact_kind,
                "exportedFileNames": list(contract.results.exported_file_names),
                "requiredMetrics": list(contract.results.required_metrics),
                "visualizerComponent": contract.results.visualizer_component,
            },
        })
    return entries


def _scenario_catalog(request: Request) -> List[Dict[str, Any]]:
    manager, _ = _get_manager_and_store(request)
    repo_root = Path(__file__).resolve().parents[2]
    worker_available, _ = isolated_worker_capability()
    configured_capabilities = os.environ.get("ASTRA_SCENARIO_AVAILABLE_CAPABILITIES")
    if configured_capabilities is None:
        model_capabilities = sorted({
            capability
            for contract in ALL_SCENARIO_CONTRACTS.values()
            for capability in contract.manifest.required_model_capabilities
        }) if manager._solver is not None else []
        engine_paths = {
            "ts": repo_root / "release" / "stdio-runtime.bundle.mjs",
            "node_parameter_estimator": repo_root / "packages" / "domain-control" / "dist" / "src" / "index.js",
            "node_heat_equation_solver": repo_root / "packages" / "domain-scientific-computing" / "dist" / "src" / "index.js",
            "node_statistical_analyzer": repo_root / "packages" / "domain-data-analysis" / "dist" / "src" / "index.js",
        }
        capabilities = model_capabilities + [name for name, path in engine_paths.items() if path.is_file()]
    else:
        capabilities = []
    env = os.environ.copy()
    if configured_capabilities is None:
        env["ASTRA_SCENARIO_AVAILABLE_CAPABILITIES"] = json.dumps(capabilities)
    env["ASTRA_ISOLATED_WORKER_AVAILABLE"] = "true" if worker_available else "false"
    try:
        completed = subprocess.run(
            [os.environ.get("NODE_EXECUTABLE", "node"), "packages/scenario-catalog/dist/src/cli.js"],
            cwd=repo_root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10.0,
            check=True,
        )
        payload = json.loads(completed.stdout)
        scenarios = payload.get("scenarios") if isinstance(payload, dict) else None
        if not isinstance(scenarios, list) or not scenarios:
            raise ValueError("empty scenario registry response")
        scenario_ids = [entry.get("scenarioId") for entry in scenarios if isinstance(entry, dict)]
        if len(scenario_ids) != len(scenarios) or any(not isinstance(sid, str) or not sid for sid in scenario_ids):
            raise ValueError("invalid scenario registry response")
        if len(set(scenario_ids)) != len(scenario_ids):
            raise ValueError("duplicate scenario registry response")
        return scenarios
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.warning("Scenario registry unavailable: %s", exc)
        return _fallback_scenario_catalog("scenario_registry_unavailable")


def _domain_entries(request: Request) -> List[Dict[str, Any]]:
    return [
        {
            "id": entry["domainId"],
            "scenarioId": entry["scenarioId"],
            "version": entry["version"],
            "description": entry["description"],
            "tools": _SCENARIO_TOOLS.get(entry["scenarioId"], []),
        }
        for entry in _scenario_catalog(request)
    ]


def list_domains(request: Request) -> JSONResponse:
    domains = _domain_entries(request)
    return JSONResponse({"domains": domains, "count": len(domains)})


def v2_health(request: Request) -> JSONResponse:
    import platform
    import sys

    manager, store = _get_manager_and_store(request)
    solver_configured = manager._solver is not None
    worker_available, worker_reasons = isolated_worker_capability()
    return JSONResponse({
        "status": "HEALTHY" if solver_configured and worker_available else "DEGRADED",
        "platform": platform.system(),
        "pythonVersion": sys.version.split()[0],
        "scenariosCount": len(_scenario_catalog(request)),
        "solverConfigured": solver_configured,
        "judgeModeAvailable": True,
        "isolatedWorkerAvailable": worker_available,
        "isolatedWorkerReasons": list(worker_reasons),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })


def list_scenarios(request: Request) -> JSONResponse:
    summary_fields = (
        "scenarioId", "domainId", "version", "name", "domainType", "description",
        "goals", "teamRolesCount", "inputKind", "visualizerComponent",
        "readinessStatus", "readinessReasons",
    )
    scenarios = [
        {field: entry[field] for field in summary_fields}
        for entry in _scenario_catalog(request)
    ]
    return JSONResponse({"scenarios": scenarios, "count": len(scenarios)})


def get_scenario_detail(request: Request) -> JSONResponse:
    scenario_id = request.path_params.get("scenario_id")
    entry = next((item for item in _scenario_catalog(request) if item["scenarioId"] == scenario_id), None)
    if entry is None:
        return JSONResponse({"error": f"Scenario '{scenario_id}' not found"}, status_code=404)
    return JSONResponse({
        "readinessStatus": entry["readinessStatus"],
        "readinessReasons": entry["readinessReasons"],
        "manifest": entry["manifest"],
        "inputs": entry["inputs"],
        "team": entry["team"],
        "results": entry["results"],
    })


def get_v2_capabilities(request: Request) -> JSONResponse:
    return JSONResponse({
        "kernelVersion": "2.1.0",
        "supportedDomains": [d["id"] for d in _domain_entries(request)],
        "supportsCancellation": True,
        "supportsCheckpoints": True,
        "supportsReplay": True,
        "honestCandidateVerified": False,
        "maxModelBudget": 50,
        "maxToolBudget": 20,
    })


def _default_topic_id(scenario_id: str) -> str:
    return f"topic_{re.sub(r'[^a-zA-Z0-9]', '_', scenario_id)}"


def _record_run_in_topic(
    *,
    store: Store,
    topic_id: str,
    title: str,
    scenario_id: str,
    raw_text: str,
    input_assets: List[Dict[str, Any]],
    run_record: Dict[str, Any],
) -> str:
    from .topic_memory import TopicMemoryManager

    run_id = run_record.get("run_id") or run_record.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("run id is required for topic memory")
    manager = TopicMemoryManager(store.root)
    archive = manager.create_topic(topic_id, title, scenario_id)
    if any(memory.record_id == f"run_{run_id}" for memory in archive.memories):
        return "ALREADY_RECORDED"
    data_version_ids: List[str] = []
    evidence_hashes: List[str] = []
    for asset in input_assets:
        sha256 = asset["sha256"]
        version_id = f"dver_{sha256[:16]}"
        archive = manager.get_topic(topic_id)
        for old_id, old_version in list(archive.data_versions.items()):
            if (
                old_version["dataset_name"] == asset["ref"]
                and old_version["sha256"] != sha256
                and old_version["status"] == "ACTIVE"
            ):
                manager.cascade_invalidate_data_version(
                    topic_id,
                    old_id,
                    reason=f"Upstream asset replaced by {sha256}",
                )
        if version_id not in manager.get_topic(topic_id).data_versions:
            manager.add_data_version(
                topic_id,
                version_id,
                asset["ref"],
                sha256,
                None,
                metadata={"bytes": asset["bytes"], "recordCountKnown": False},
            )
        data_version_ids.append(version_id)
        evidence_hashes.append(sha256)
    hypothesis_id = f"hypothesis_{run_id}"
    if not any(item.hypothesis_id == hypothesis_id for item in manager.get_topic(topic_id).hypotheses):
        manager.add_hypothesis(
            topic_id,
            hypothesis_id,
            raw_text,
            data_version_ids,
            evidence_hashes=evidence_hashes,
            provenance={"runId": run_id, "scenarioId": scenario_id},
        )
    summary = run_record.get("summary") or {}
    content = {
        "status": run_record.get("status"),
        "stopReason": summary.get("stopReason") or run_record.get("stopReason"),
        "code": summary.get("code") or run_record.get("code"),
        "executed": run_record.get("executed") if run_record.get("executed") is not None else summary.get("executed", False),
        "finalResponse": run_record.get("final_response") or summary.get("final_response"),
        "inputRefs": [asset["ref"] for asset in input_assets],
        "candidateVerified": False,
    }
    manager.record_memory(
        topic_id,
        f"run_{run_id}",
        "RUN_RESULT",
        content,
        provenance_run_id=run_id,
        data_version_ids=data_version_ids,
        allow_reuse=True,
    )
    return "RECORDED"


async def create_v2_run(request: Request) -> JSONResponse:
    """T0 & T1: Asynchronous body read and real dispatch through ExecutionManager."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not isinstance(body, dict):
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)

    scenario_id = body.get("scenarioId")
    catalog = _scenario_catalog(request)
    if scenario_id:
        matched_scenario = next((entry for entry in catalog if entry["scenarioId"] == scenario_id), None)
        if matched_scenario is None:
            return JSONResponse({"error": f"Unknown scenario: {scenario_id}"}, status_code=400)
    else:
        domain_id = body.get("domainId", "math")
        matched_scenario = next((entry for entry in catalog if entry["domainId"] == domain_id), None)
        if matched_scenario is None:
            return JSONResponse({"error": f"Unknown domain: {domain_id}"}, status_code=400)
        scenario_id = matched_scenario["scenarioId"]
    canonical_domain_id = matched_scenario["domainId"]

    raw_text = body.get("problem") or body.get("rawText")
    if not raw_text or not isinstance(raw_text, str) or not raw_text.strip():
        return JSONResponse({"error": "Missing or empty problem/rawText in request body"}, status_code=400)

    header_key = request.headers.get("Idempotency-Key")
    idempotency_key = header_key or body.get("idempotencyKey")

    manager, store = _get_manager_and_store(request)

    # Dispatch to ExecutionManager
    wrapped_problem = (
        raw_text
        if raw_text.startswith("[RunSpec:") or raw_text.startswith("[domain:")
        else f"[RunSpec:{canonical_domain_id}]\n{raw_text}"
    )
    try:
        input_assets = resolve_input_assets(
            body.get("inputRefs", []),
            storage_root=store.root,
            repo_root=Path(__file__).resolve().parents[2],
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc), "code": "INVALID_INPUT_REFS"}, status_code=400)

    literature_evidence = None
    literature_query = body.get("literatureQuery")
    if literature_query is not None:
        if not isinstance(literature_query, str) or not 3 <= len(literature_query.strip()) <= 300:
            return JSONResponse({"error": "literatureQuery must contain between 3 and 300 characters"}, status_code=400)
        from .literature_client import SemanticScholarClient

        client = SemanticScholarClient()
        try:
            literature_evidence = client.search(literature_query.strip(), limit=2)
            for paper in literature_evidence["papers"]:
                if paper["hasPdfAccess"]:
                    paper["fullText"] = client.read_open_access_pdf(paper, max_characters=12_000)
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            return JSONResponse({
                "error": "LITERATURE_SOURCE_UNAVAILABLE",
                "detail": str(exc),
                "candidateVerified": False,
            }, status_code=503)

    topic_id = body.get("topicId") or _default_topic_id(scenario_id)
    if (
        not isinstance(topic_id, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", topic_id)
        or ".." in topic_id
    ):
        return JSONResponse({"error": "invalid topicId"}, status_code=400)

    run_payload = {
        "problem": wrapped_problem,
        "domain_id": canonical_domain_id,
        "metadata": {
            "domainId": canonical_domain_id,
            "scenarioId": scenario_id,
            "rawText": raw_text,
            "inputRefs": body.get("inputRefs", []),
            "inputAssets": input_assets,
            "inputOptions": body.get("inputOptions") if isinstance(body.get("inputOptions"), dict) else {},
            "literatureEvidence": literature_evidence,
            "topicId": topic_id,
        },
        "idempotency_key": idempotency_key,
    }

    try:
        enqueue_res = await manager.enqueue_run(request=run_payload)
    except Exception as exc:
        return JSONResponse({"error": f"Failed to enqueue run: {exc}"}, status_code=409)

    run_id = enqueue_res["run_id"]

    # Wait for the worker to process the initial stage
    await manager.wait_idle(timeout=10.0)

    run_record = store.get_run(run_id) or {}
    summary = run_record.get("summary") or {}
    status = run_record.get("status", "running")
    stop_reason = summary.get("stopReason") or run_record.get("stopReason") or summary.get("stop_reason")
    code = run_record.get("code") or summary.get("code") or stop_reason
    if manager._solver is None and status == "error":
        code = "SOLVER_NOT_CONFIGURED"

    events = manager.get_history_events(run_id)
    executed = run_record.get("executed") if run_record.get("executed") is not None else summary.get("executed", False)
    final_resp = run_record.get("final_response") or summary.get("final_response")
    try:
        topic_memory_status = _record_run_in_topic(
            store=store,
            topic_id=topic_id,
            title=f"{matched_scenario['name']} 课题归档",
            scenario_id=scenario_id,
            raw_text=raw_text,
            input_assets=input_assets,
            run_record=run_record,
        )
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("Topic memory recording failed for %s: %s", run_id, exc)
        topic_memory_status = "RECORD_FAILED"

    response_payload = {
        "runId": run_id,
        "domainId": canonical_domain_id,
        "scenarioId": scenario_id,
        "topicId": topic_id,
        "topicMemoryStatus": topic_memory_status,
        "domainVersion": matched_scenario["version"],
        "status": status,
        "stopReason": stop_reason,
        "code": code,
        "rawText": raw_text,
        "idempotencyKey": idempotency_key,
        "candidateVerified": False,
        "executed": executed,
        "unresolvedObligations": [f"ob_{canonical_domain_id}_primary"],
        "evidenceCount": len(events),
        "createdAt": run_record.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if final_resp:
        response_payload["final_response"] = final_resp

    status_code = 200 if enqueue_res.get("idempotent_replay") else 201
    return JSONResponse(response_payload, status_code=status_code)


def get_v2_run(request: Request) -> JSONResponse:
    run_id = request.path_params.get("run_id")
    manager, store = _get_manager_and_store(request)
    record = store.get_run(run_id)
    if not record:
        return JSONResponse({"error": f"Run {run_id} not found"}, status_code=404)

    summary = record.get("summary") or {}
    metadata = summary.get("metadata") or record.get("metadata") or {}
    domain_id = metadata.get("domainId", "math")
    code = summary.get("code") or record.get("code")
    if manager._solver is None and record.get("status") == "error":
        code = "SOLVER_NOT_CONFIGURED"

    events = manager.get_history_events(run_id)

    return JSONResponse({
        "runId": run_id,
        "domainId": domain_id,
        "status": record.get("status"),
        "stopReason": summary.get("stopReason") or record.get("stopReason"),
        "code": code,
        "rawText": summary.get("problem") or metadata.get("rawText"),
        "candidateVerified": False,
        "executed": summary.get("executed", False),
        "evidenceCount": len(events),
        "createdAt": record.get("created_at"),
    })


def get_v2_evidence(request: Request) -> JSONResponse:
    run_id = request.path_params.get("run_id")
    manager, store = _get_manager_and_store(request)
    if not store.has_run(run_id) and not manager.is_active(run_id):
        return JSONResponse({"error": f"Run {run_id} not found"}, status_code=404)

    events = manager.get_history_events(run_id)
    return JSONResponse({
        "runId": run_id,
        "evidenceCount": len(events),
        "events": events,
    })


async def cancel_v2_run(request: Request) -> JSONResponse:
    run_id = request.path_params.get("run_id")
    manager, store = _get_manager_and_store(request)
    if not store.has_run(run_id) and not manager.is_active(run_id):
        return JSONResponse({"error": f"Run {run_id} not found"}, status_code=404)

    cancelled = manager.cancel_run(run_id)
    return JSONResponse({"runId": run_id, "cancelled": cancelled, "status": "CANCELLED"})


async def create_collaboration_route(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    try:
        from .collaboration import CollaborationTask, CrossScenarioDelegationRefused, CrossScenarioDelegator

        budget = body.get("inheritedBudget") or {}
        if not isinstance(budget, dict):
            raise ValueError("inheritedBudget must be an object")
        max_model_calls = budget.get("maxModelCalls", budget.get("max_model_calls", 0))
        max_tool_calls = budget.get("maxToolCalls", budget.get("max_tool_calls", 1))
        remaining_deadline_ms = budget.get("remainingDeadlineMs", budget.get("remaining_deadline_ms", 1000))
        for value in (max_model_calls, max_tool_calls, remaining_deadline_ms):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError("inherited budget values must be numeric")
        input_artifacts = body.get("inputArtifacts") or []
        if not isinstance(input_artifacts, list) or len(input_artifacts) > 8:
            raise ValueError("inputArtifacts must be an array with at most 8 entries")
        if any(not isinstance(artifact, dict) for artifact in input_artifacts):
            raise ValueError("each input artifact must be an object")
        task = CollaborationTask(
            task_id=str(body["taskId"]),
            parent_run_id=str(body["parentRunId"]),
            initiating_scenario_id=str(body["initiatingScenarioId"]),
            target_scenario_id=str(body["targetScenarioId"]),
            prompt=str(body["prompt"]),
            input_artifacts=input_artifacts,
            inherited_budget={
                "max_model_calls": max_model_calls,
                "max_tool_calls": max_tool_calls,
                "remaining_deadline_ms": remaining_deadline_ms,
            },
            recursion_depth=int(body.get("recursionDepth", 1)),
        )
        if not task.prompt.strip() or len(task.prompt) > 4000:
            raise ValueError("prompt must be non-empty and at most 4000 characters")
        result = CrossScenarioDelegator(max_depth=1).delegate(task)
        from dataclasses import asdict

        return JSONResponse(_json_safe(asdict(result)), status_code=200 if result.status == "COMPLETED" else 422)
    except CrossScenarioDelegationRefused as exc:
        return JSONResponse({"error": str(exc), "candidateVerified": False}, status_code=409)
    except (KeyError, TypeError, ValueError) as exc:
        return JSONResponse({"error": str(exc), "candidateVerified": False}, status_code=400)


async def search_literature_route(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    query = body.get("query") if isinstance(body, dict) else None
    limit = body.get("limit", 3) if isinstance(body, dict) else 3
    if not isinstance(query, str) or not 3 <= len(query.strip()) <= 300:
        return JSONResponse({"error": "query must contain between 3 and 300 characters"}, status_code=400)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5:
        return JSONResponse({"error": "limit must be an integer between 1 and 5"}, status_code=400)
    from .literature_client import SemanticScholarClient

    client = SemanticScholarClient()
    try:
        result = client.search(query.strip(), limit=limit)
        if body.get("includeFullText") is True:
            for paper in result["papers"]:
                if not paper["hasPdfAccess"]:
                    continue
                try:
                    paper["fullText"] = client.read_open_access_pdf(paper)
                except (OSError, ValueError, RuntimeError) as exc:
                    paper["fullText"] = {
                        "status": "FULL_TEXT_EXTRACTION_FAILED",
                        "reason": str(exc),
                        "candidateVerified": False,
                    }
        return JSONResponse(result)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        return JSONResponse({
            "error": "LITERATURE_SOURCE_UNAVAILABLE",
            "detail": str(exc),
            "candidateVerified": False,
        }, status_code=503)


async def extract_curve_route(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    _, store = _get_manager_and_store(request)
    try:
        assets = resolve_input_assets(
            [body.get("inputRef")],
            storage_root=store.root,
            repo_root=Path(__file__).resolve().parents[2],
        )
        calibration_data = body["calibration"]
        plot_bounds = body["plotBounds"]
        trace_color = body["traceColor"]
        if not isinstance(calibration_data, dict) or not isinstance(plot_bounds, dict):
            raise ValueError("calibration and plotBounds must be objects")
        from .scientific_curve_parser import AxisCalibration, ScientificCurveParser

        calibration = AxisCalibration(
            x_name=str(calibration_data["xName"]),
            x_unit=str(calibration_data["xUnit"]),
            x_min=float(calibration_data["xMin"]),
            x_max=float(calibration_data["xMax"]),
            y_name=str(calibration_data["yName"]),
            y_unit=str(calibration_data["yUnit"]),
            y_min=float(calibration_data["yMin"]),
            y_max=float(calibration_data["yMax"]),
            is_ambiguous=bool(calibration_data.get("isAmbiguous", False)),
            ambiguity_reason=calibration_data.get("ambiguityReason"),
        )
        if not calibration.x_max > calibration.x_min or not calibration.y_max > calibration.y_min:
            raise ValueError("calibration ranges must be increasing")
        extraction = ScientificCurveParser().extract_from_image(
            assets[0]["ref"],
            Path(assets[0]["path"]).read_bytes(),
            calibration,
            plot_bounds=plot_bounds,
            trace_color=trace_color,
            color_tolerance=float(body.get("colorTolerance", 45.0)),
        )
        from dataclasses import asdict

        payload = _json_safe(asdict(extraction))
        reference_points = body.get("referencePoints")
        if reference_points is not None:
            points = [tuple(map(float, point)) for point in reference_points]
            payload["referenceAudit"] = ScientificCurveParser().verify_against_reference(extraction, points)
        payload["candidateVerified"] = False
        return JSONResponse(_json_safe(payload))
    except (KeyError, TypeError, ValueError, OSError, RuntimeError) as exc:
        return JSONResponse({"error": str(exc), "candidateVerified": False}, status_code=400)


async def upload_input_asset(request: Request) -> JSONResponse:
    content_length = request.headers.get("content-length")
    if content_length and not content_length.isdigit():
        return JSONResponse({"error": "invalid content length"}, status_code=400)
    if content_length and int(content_length) > 40 * 1024 * 1024:
        return JSONResponse({"error": "upload too large"}, status_code=413)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    _, store = _get_manager_and_store(request)
    try:
        asset = store_uploaded_asset(
            storage_root=store.root,
            file_name=body.get("fileName"),
            content_base64=body.get("contentBase64"),
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse({
        "inputRef": asset["ref"],
        "sha256": asset["sha256"],
        "bytes": asset["bytes"],
    }, status_code=201)


async def create_topic_route(request: Request) -> JSONResponse:
    from .topic_memory import TopicMemoryManager

    manager, store = _get_manager_and_store(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    topic_id = body.get("topicId") or f"topic_{uuid.uuid4().hex[:12]}"
    title = body.get("title", "Untitled Research Topic")
    scenario_id = body.get("scenarioId", "math.research")

    topic_mgr = TopicMemoryManager(store.root)
    archive = topic_mgr.create_topic(topic_id, title, scenario_id)
    return JSONResponse(
        {
            "topicId": archive.topic_id,
            "title": archive.title,
            "scenarioId": archive.scenario_id,
            "status": "CREATED",
        },
        status_code=201,
    )


def get_topic_route(request: Request) -> JSONResponse:
    from .topic_memory import TopicMemoryManager

    topic_id = request.path_params.get("topic_id")
    manager, store = _get_manager_and_store(request)
    topic_mgr = TopicMemoryManager(store.root)
    archive = topic_mgr.get_topic(topic_id)
    if not archive:
        return JSONResponse({"error": f"Topic {topic_id} not found"}, status_code=404)
    return JSONResponse(archive.to_dict())


def export_topic_route(request: Request) -> Response:
    from .topic_memory import TopicMemoryManager

    topic_id = request.path_params.get("topic_id")
    fmt = request.query_params.get("format", "json").lower()
    manager, store = _get_manager_and_store(request)
    topic_mgr = TopicMemoryManager(store.root)
    archive = topic_mgr.get_topic(topic_id)
    if not archive:
        return JSONResponse({"error": f"Topic {topic_id} not found"}, status_code=404)

    if fmt in ("markdown", "md"):
        md_text = topic_mgr.export_markdown(topic_id)
        return Response(
            content=md_text,
            media_type="text/markdown",
            headers={"Content-Disposition": f"attachment; filename={topic_id}_report.md"},
        )
    elif fmt == "zip":
        zip_path = store.root / "exports" / f"{topic_id}.zip"
        topic_mgr.export_zip(topic_id, zip_path)
        content = zip_path.read_bytes()
        return Response(
            content=content,
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename={topic_id}.zip"},
        )
    else:
        json_text = topic_mgr.export_json(topic_id)
        return Response(
            content=json_text,
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={topic_id}.json"},
        )


async def set_topic_memory_reuse_route(request: Request) -> JSONResponse:
    from .topic_memory import TopicMemoryManager

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)
    allow_reuse = body.get("allowReuse") if isinstance(body, dict) else None
    if not isinstance(allow_reuse, bool):
        return JSONResponse({"error": "allowReuse must be boolean"}, status_code=400)
    _, store = _get_manager_and_store(request)
    manager = TopicMemoryManager(store.root)
    updated = manager.set_memory_reuse(
        request.path_params["topic_id"],
        request.path_params["record_id"],
        allow_reuse,
    )
    if not updated:
        return JSONResponse({"error": "Topic memory record not found"}, status_code=404)
    return JSONResponse({"updated": True, "allowReuse": allow_reuse})


def delete_topic_memory_route(request: Request) -> JSONResponse:
    from .topic_memory import TopicMemoryManager

    _, store = _get_manager_and_store(request)
    manager = TopicMemoryManager(store.root)
    removed = manager.remove_memory(
        request.path_params["topic_id"],
        request.path_params["record_id"],
    )
    if not removed:
        return JSONResponse({"error": "Topic memory record not found"}, status_code=404)
    return JSONResponse({"removed": True})


def build_v2_routes() -> List[Route]:
    from .app import sse_events
    return [
        Route("/health", endpoint=v2_health, methods=["GET"]),
        Route("/api/v2/health", endpoint=v2_health, methods=["GET"]),
        Route("/api/v2/domains", endpoint=list_domains, methods=["GET"]),
        Route("/api/v2/scenarios", endpoint=list_scenarios, methods=["GET"]),
        Route("/api/v2/scenarios/{scenario_id}", endpoint=get_scenario_detail, methods=["GET"]),
        Route("/api/v2/capabilities", endpoint=get_v2_capabilities, methods=["GET"]),
        Route("/api/v2/assets", endpoint=upload_input_asset, methods=["POST"]),
        Route("/api/v2/collaborations", endpoint=create_collaboration_route, methods=["POST"]),
        Route("/api/v2/literature/search", endpoint=search_literature_route, methods=["POST"]),
        Route("/api/v2/curves/extract", endpoint=extract_curve_route, methods=["POST"]),
        Route("/api/v2/runs", endpoint=create_v2_run, methods=["POST"]),
        Route("/api/v2/runs/{run_id}", endpoint=get_v2_run, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/evidence", endpoint=get_v2_evidence, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/events", endpoint=sse_events, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/cancel", endpoint=cancel_v2_run, methods=["POST"]),
        Route("/api/v2/topics", endpoint=create_topic_route, methods=["POST"]),
        Route("/api/v2/topics/{topic_id}", endpoint=get_topic_route, methods=["GET"]),
        Route("/api/v2/topics/{topic_id}/export", endpoint=export_topic_route, methods=["GET"]),
        Route("/api/v2/topics/{topic_id}/memories/{record_id}", endpoint=set_topic_memory_reuse_route, methods=["PATCH"]),
        Route("/api/v2/topics/{topic_id}/memories/{record_id}", endpoint=delete_topic_memory_route, methods=["DELETE"]),
    ]
