from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from python.astra_web.app import create_app
from python.astra_web.config import default_budget
from python.astra_web.queue import ExecutionManager
from python.astra_web.storage import Store


async def _post(app, body, *, headers=None):
    transport = httpx.ASGITransport(app=app)
    payload = json.dumps(body, ensure_ascii=False, allow_nan=True)
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        return await http.post("/api/runs", content=payload, headers=request_headers)


def _body(problem="题目", **overrides):
    payload = {"problem": problem, "engine": "ts", **default_budget()}
    payload.update(overrides)
    return payload


def test_missing_solver_is_explicit_not_executed(tmp_path):
    async def run():
        app = create_app(data_root=tmp_path / "data", mount_static=False)
        response = await _post(app, _body())
        assert response.status_code == 201
        assert await app.state.execution_manager.wait_idle(10.0)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            detail = await http.get(f"/api/runs/{response.json()['run_id']}")
        return detail.json()

    detail = asyncio.run(run())
    summary = detail["summary"]
    assert summary["status"] == "error"
    assert summary["executed"] is False
    assert summary["code"] == "SOLVER_NOT_CONFIGURED"
    assert summary["candidate_verified"] is False
    assert summary["childReaped"] is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"max_effects": 3},
        {"max_effects": True},
        {"max_model_calls": True},
        {"max_work_units": 0},
        {"engine": "lite"},
        {"provider_url": "http://evil"},
        {"metadata": {"api_key": "x"}},
        {"metadata": {"x": float("inf")}},
    ],
)
def test_invalid_web_requests_are_rejected(tmp_path, overrides):
    async def run():
        app = create_app(data_root=tmp_path / "data", mount_static=False)
        return await _post(app, _body(**overrides))

    response = asyncio.run(run())
    assert response.status_code == 422


def test_solver_exception_preserves_error_and_unknown_child_state(tmp_path):
    def broken(_request):
        raise RuntimeError("provider failed after dispatch")

    async def run():
        manager = ExecutionManager(Store(root=tmp_path / "store"), solver=broken)
        run_id = manager.prepare_run(request=_body())
        manager._schedule(run_id)
        assert await manager.wait_idle(10.0)
        return manager.store.get_run(run_id)

    run = asyncio.run(run())
    summary = run["summary"]
    assert summary["status"] == "error"
    assert summary["executed"] is True
    assert summary["childReaped"] is None
    assert summary["code"] == "SOLVER_FAILED"


def test_solver_metrics_and_child_reaped_are_not_defaulted(tmp_path):
    def fake(_request):
        return {
            "status": "candidate",
            "stopReason": "REVIEWS_COMPLETE",
            "final_response": "x=1",
            "candidate_verified": False,
            "executed": True,
            "childReaped": False,
            "metrics": {
                "logical_model_calls": None,
                "tool_effect_calls": 1,
                "reported_tokens": None,
                "remote_outcome_unknown": True,
            },
        }

    async def run():
        manager = ExecutionManager(Store(root=tmp_path / "store"), solver=fake)
        run_id = manager.prepare_run(request=_body())
        manager._schedule(run_id)
        assert await manager.wait_idle(10.0)
        return manager.store.get_run(run_id)

    run = asyncio.run(run())
    summary = run["summary"]
    assert summary["status"] == "candidate"
    assert summary["childReaped"] is False
    assert summary["metrics"]["logical_model_calls"] is None
    assert summary["metrics"]["reported_tokens"] is None
    assert summary["metrics"]["remote_outcome_unknown"] is True


def test_idempotency_key_conflict_is_409(tmp_path):
    def fake(_request):
        return {
            "status": "candidate",
            "stopReason": "REVIEWS_COMPLETE",
            "final_response": "x=1",
            "candidate_verified": False,
            "executed": True,
            "childReaped": True,
        }

    async def run():
        app = create_app(data_root=tmp_path / "data", mount_static=False, solver=fake)
        first = await _post(app, _body("题目一"), headers={"Idempotency-Key": "same-key"})
        assert first.status_code == 201
        assert await app.state.execution_manager.wait_idle(10.0)
        second = await _post(app, _body("题目二"), headers={"Idempotency-Key": "same-key"})
        return first, second

    first, second = asyncio.run(run())
    assert second.status_code == 409
    assert first.json()["run_id"]
