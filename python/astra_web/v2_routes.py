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

logger = logging.getLogger("astra_web.v2_routes")

AVAILABLE_DOMAINS = [
    {
        "id": "math",
        "version": "1.4.0",
        "description": "Mathematics: algebraic derivation, closed-answer checking, 26 math assets",
        "tools": ["math.linear-algebra", "math.polynomials", "math.number-theory"],
    },
    {
        "id": "control.identification",
        "version": "1.0.0",
        "description": "Control & Dynamics: forced damped oscillator parameter identification & independent validation",
        "tools": ["control.timeseries_loader", "control.parameter_estimator", "control.forward_simulator"],
    },
    {
        "id": "scientific_computing",
        "version": "1.0.0",
        "description": "Scientific Computing: PDE/ODE numerical experiment, grid convergence & conservation",
        "tools": ["scicomp.grid_generator", "scicomp.pde_solver", "scicomp.convergence_analyst"],
    },
    {
        "id": "data_analysis",
        "version": "1.0.0",
        "description": "Data Analysis: statistical inference, hypothesis testing, FDR multiple-testing correction",
        "tools": ["data.cleaner", "data.normality_test", "data.hypothesis_tester"],
    },
]

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


def list_domains(request: Request) -> JSONResponse:
    return JSONResponse({"domains": AVAILABLE_DOMAINS, "count": len(AVAILABLE_DOMAINS)})


def get_v2_capabilities(request: Request) -> JSONResponse:
    return JSONResponse({
        "kernelVersion": "2.1.0",
        "supportedDomains": [d["id"] for d in AVAILABLE_DOMAINS],
        "supportsCancellation": True,
        "supportsCheckpoints": True,
        "supportsReplay": True,
        "honestCandidateVerified": False,
        "maxModelBudget": 50,
        "maxToolBudget": 20,
    })


async def create_v2_run(request: Request) -> JSONResponse:
    """T0 & T1: Asynchronous body read and real dispatch through ExecutionManager."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    if not isinstance(body, dict):
        return JSONResponse({"error": "Request body must be a JSON object"}, status_code=400)

    domain_id = body.get("domainId", "math")
    matched_domain = next(
        (d for d in AVAILABLE_DOMAINS if d["id"] == domain_id or d["id"] == f"{domain_id}.identification"),
        None,
    )
    if not matched_domain:
        return JSONResponse({"error": f"Unknown domain: {domain_id}"}, status_code=400)
    canonical_domain_id = matched_domain["id"]

    raw_text = body.get("problem") or body.get("rawText")
    if not raw_text or not isinstance(raw_text, str) or not raw_text.strip():
        return JSONResponse({"error": "Missing or empty problem/rawText in request body"}, status_code=400)

    header_key = request.headers.get("Idempotency-Key")
    idempotency_key = header_key or body.get("idempotencyKey")

    manager, store = _get_manager_and_store(request)

    # Dispatch to ExecutionManager
    run_payload = {
        "problem": raw_text,
        "domain_id": canonical_domain_id,
        "metadata": {
            "domainId": canonical_domain_id,
            "rawText": raw_text,
            "inputRefs": body.get("inputRefs", []),
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
    status = run_record.get("status", "running")
    code = run_record.get("code") or run_record.get("stopReason")
    if manager._solver is None and status == "error":
        code = "SOLVER_NOT_CONFIGURED"

    events = manager.get_history_events(run_id)

    response_payload = {
        "runId": run_id,
        "domainId": canonical_domain_id,
        "domainVersion": matched_domain["version"],
        "status": status,
        "stopReason": run_record.get("stopReason") or run_record.get("stop_reason"),
        "code": code,
        "rawText": raw_text,
        "idempotencyKey": idempotency_key,
        "candidateVerified": False,
        "executed": run_record.get("executed", False),
        "unresolvedObligations": [f"ob_{canonical_domain_id}_primary"],
        "evidenceCount": len(events),
        "createdAt": run_record.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if run_record.get("final_response"):
        response_payload["final_response"] = run_record["final_response"]

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


def build_v2_routes() -> List[Route]:
    from .app import sse_events
    return [
        Route("/api/v2/domains", endpoint=list_domains, methods=["GET"]),
        Route("/api/v2/capabilities", endpoint=get_v2_capabilities, methods=["GET"]),
        Route("/api/v2/runs", endpoint=create_v2_run, methods=["POST"]),
        Route("/api/v2/runs/{run_id}", endpoint=get_v2_run, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/evidence", endpoint=get_v2_evidence, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/events", endpoint=sse_events, methods=["GET"]),
        Route("/api/v2/runs/{run_id}/cancel", endpoint=cancel_v2_run, methods=["POST"]),
    ]
