from __future__ import annotations

import asyncio
import importlib

import httpx
import pytest

from python.astra_web.app import create_app
from python.astra_web.config import default_budget
from python.astra_web.solver_adapter import SolverAdapter
from tests.web_math_helpers import MathAssetScriptedClient

ALL_82_CASES = []
for b_idx in range(6):
    module = importlib.import_module(f"tests.math_assets.test_math_assets_w{b_idx}")
    ALL_82_CASES.extend(getattr(module, f"W{b_idx}_CASES"))


async def _run_case(tmp_path, aid: str, tgt: str, inp: dict):
    client = MathAssetScriptedClient(aid, tgt, inp)
    app = create_app(
        data_root=tmp_path / "data",
        mount_static=False,
        solver=SolverAdapter(client_factory=lambda: client),
    )
    body = {
        "problem": f"Formally solve mathematical problem using {tgt}",
        "engine": "ts",
        "metadata": {"target": tgt},
        **default_budget(),
    }
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        created = await http.post("/api/runs", json=body)
        assert created.status_code == 201, created.text
        run_id = created.json()["run_id"]
        detail = None
        for _ in range(500):
            response = await http.get(f"/api/runs/{run_id}")
            assert response.status_code == 200
            detail = response.json()
            if detail["status"] not in {"running", "queued"}:
                break
            await asyncio.sleep(0.02)
        assert detail is not None
        assert await app.state.execution_manager.wait_idle(20.0)
        return detail, client


@pytest.mark.parametrize(
    "aid,tgt,inp",
    ALL_82_CASES,
    ids=[f"{aid}_{tgt}" for aid, tgt, _ in ALL_82_CASES],
)
def test_bff_executes_all_82_math_asset_behaviors(tmp_path, aid, tgt, inp):
    detail, client = asyncio.run(_run_case(tmp_path, aid, tgt, inp))
    summary = detail["summary"]
    assert summary["status"] == "candidate", (aid, tgt, summary.get("code"))
    assert summary["candidate_verified"] is False
    assert summary["executed"] is True
    assert summary["childReaped"] is True
    assert summary["metrics"]["tool_effect_calls"] == 1
    assert tgt in summary["metrics"]["tool_names"]
    assert client.observation_seen is True
    assert summary["sessionId"]
    assert summary["trace"]
    assert summary["max_method_loads"] == 0
    events = detail.get("l2_path")
    assert events
