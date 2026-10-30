from __future__ import annotations

import json
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from python.astra_web.app import create_app
from python.astra_web.solver_adapter import build_solver_from_env


def test_p1_data_analysis_end_to_end_and_l2_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ASTRA_PROVIDER", "mock")
    data_dir = tmp_path / "data"

    solver = build_solver_from_env()
    assert solver is not None, "mock solver should be built when ASTRA_PROVIDER=mock"

    app = create_app(solver=solver, data_root=data_dir, recover_orphans=False)
    client = TestClient(app)

    problem_text = "两组生物医学样本表达量显著性差异检验 (mean1=10.0, mean2=12.5) 与残差诊断"
    payload = {
        "domainId": "data_analysis",
        "problem": problem_text,
        "idempotencyKey": "key_p1_data_analysis_verify_001",
    }

    # 1. POST /api/v2/runs
    post_resp = client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201), post_resp.text
    post_data = post_resp.json()

    run_id = post_data["runId"]
    assert post_data["domainId"] == "data_analysis"
    assert post_data["status"] == "candidate"
    assert post_data["stopReason"] == "STOPPED"
    assert post_data["candidateVerified"] is False
    assert post_data["executed"] is True
    assert "final_response" in post_data

    # Parse final response JSON
    calc_res = json.loads(post_data["final_response"])
    assert calc_res["domainId"] == "data_analysis"
    assert calc_res["testMethod"] == "two_sample_welch_t_test"
    assert "testResult" in calc_res

    test_res = calc_res["testResult"]
    assert test_res["tStatistic"] < -5.0
    assert test_res["degreesOfFreedom"] > 90.0
    assert test_res["pValue"] < 0.001
    assert test_res["isSignificant"] is True
    assert "confidenceInterval" in test_res
    assert len(test_res["confidenceInterval"]) == 2
    assert "cohensD" in test_res

    assert calc_res["normalityDiagnosis"]["passed"] is True
    assert calc_res["residualDiagnosis"]["isWhite"] is True
    assert calc_res["allObligationsMet"] is True
    assert calc_res["candidateVerified"] is False

    # 2. Check L2 disk archive: runs/{run_id}/details.json
    l2_file = data_dir / "runs" / run_id / "details.json"
    assert l2_file.is_file(), f"L2 archive not found at {l2_file}"

    details_content = json.loads(l2_file.read_text(encoding="utf-8"))
    assert "events" in details_content
    assert "summary" in details_content
    summary = details_content["summary"]
    assert summary["provider"] == "mock"
    assert summary["stopReason"] == "STOPPED"
    assert summary["candidate_verified"] is False

    # 3. GET /api/runs/{run_id}
    get_run_resp = client.get(f"/api/runs/{run_id}")
    assert get_run_resp.status_code == 200
    run_info = get_run_resp.json()
    assert run_info["summary"]["provider"] == "mock"
    assert run_info["summary"]["stopReason"] == "STOPPED"

    # 4. GET /runs/{run_id} (Web visibility route)
    page_resp = client.get(f"/runs/{run_id}")
    assert page_resp.status_code == 200
    assert "html" in page_resp.headers.get("content-type", "").lower()
