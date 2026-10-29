from __future__ import annotations

import json

from python.astra_web.config import default_budget
from python.astra_web.solver_adapter import SolverAdapter
from tests.web_math_helpers import MathAssetScriptedClient


def test_adapter_runs_real_node_host_and_math_asset_path():
    client = MathAssetScriptedClient(
        "math.linear-algebra", "gf2_rank", {"rows": [1, 2]}
    )
    adapter = SolverAdapter(client_factory=lambda: client)
    request = {
        "run_id": "run-adapter-1",
        "problem": "求 GF(2) 上由 rows 表示的矩阵的秩",
        "engine": "ts",
        "metadata": {},
        **default_budget(),
    }
    result = adapter(request)
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    metrics = result["metrics"]
    assert metrics["tool_effect_calls"] == 1
    assert "gf2_rank" in metrics["tool_names"]
    assert client.observation_seen is True
    # The adapter does not verify the whole problem.
    assert result["strictAcceptance"] == "NOT_PERFORMED"
