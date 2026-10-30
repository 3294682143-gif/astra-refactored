from __future__ import annotations

import json
import os
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from python.astra_web.app import create_app
from python.astra_web.solver_adapter import build_solver_from_env


def test_p0_control_dynamics_end_to_end_and_visibility(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ASTRA_PROVIDER", "mock")
    data_dir = tmp_path / "data"

    solver = build_solver_from_env()
    assert solver is not None, "mock solver should be built when ASTRA_PROVIDER=mock"

    app = create_app(solver=solver, data_root=data_dir, recover_orphans=False)
    client = TestClient(app)

    problem_text = "辨识非线性阻尼受迫振子质量阻尼刚度三参数 (m=1.5, c=0.4, k=2.8)"
    payload = {
        "domainId": "control.identification",
        "problem": problem_text,
        "idempotencyKey": "key_p0_control_verify_001",
    }

    # 1. POST /api/v2/runs
    post_resp = client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201), post_resp.text
    post_data = post_resp.json()
    print("DEBUG POST DATA:", post_data)
    ev_resp = client.get(f"/api/v2/runs/{post_data['runId']}/evidence")
    print("DEBUG EVIDENCE:", ev_resp.json())

    run_id = post_data["runId"]
    assert post_data["domainId"] == "control.identification"
    assert post_data["status"] == "candidate"
    assert post_data["stopReason"] == "STOPPED"
    assert post_data["candidateVerified"] is False
    assert post_data["executed"] is True
    assert "final_response" in post_data

    # Parse final response JSON
    calc_res = json.loads(post_data["final_response"])
    assert calc_res["targetSystem"] == "forced_damped_oscillator"
    assert "parameters" in calc_res
    params = calc_res["parameters"]
    assert abs(params["mass"] - 1.5) < 0.05
    assert abs(params["damping"] - 0.4) < 0.05
    assert abs(params["stiffness"] - 2.8) < 0.05

    assert calc_res["samplingGuard"]["aliasingDetected"] is False
    assert calc_res["leakageGuard"]["leakageDetected"] is False
    assert calc_res["residualDiagnosis"]["isWhite"] is True
    assert calc_res["holdoutValidation"]["passed"] is True

    # 2. Check L2 disk archive: runs/{run_id}/details.json
    l2_file = data_dir / "runs" / run_id / "details.json"
    assert l2_file.is_file(), f"L2 archive not found at {l2_file}"

    details_content = json.loads(l2_file.read_text(encoding="utf-8"))
    assert "events" in details_content
    assert "summary" in details_content
    summary = details_content["summary"]
    assert summary["provider"] == "mock"
    assert summary["stopReason"] == "STOPPED"

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
