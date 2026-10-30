from __future__ import annotations

import json
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from python.astra_web.app import create_app
from python.astra_web.solver_adapter import build_solver_from_env


def test_f11_scicomp_end_to_end_and_l2_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ASTRA_PROVIDER", "mock")
    data_dir = tmp_path / "data"

    solver = build_solver_from_env()
    assert solver is not None, "mock solver should be built when ASTRA_PROVIDER=mock"

    app = create_app(solver=solver, data_root=data_dir, recover_orphans=False)
    client = TestClient(app)

    # 1. Normal Case B Dispatch: 1D Heat Conduction PDE FDM vs Analytical Reference
    problem_text = "一维热传导方程有限差分复现 (alpha=0.1, tFinal=0.2) 与 Richardson 外推网格收敛阶验证"
    payload = {
        "domainId": "scientific_computing",
        "problem": problem_text,
        "idempotencyKey": "key_f11_scicomp_verify_001",
    }

    post_resp = client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201), post_resp.text
    post_data = post_resp.json()

    run_id = post_data["runId"]
    assert post_data["domainId"] == "scientific_computing"
    assert post_data["status"] == "candidate"
    assert post_data["stopReason"] == "STOPPED"
    assert post_data["candidateVerified"] is False
    assert post_data["executed"] is True
    assert "final_response" in post_data

    # Parse final response JSON
    calc_res = json.loads(post_data["final_response"])
    assert calc_res["domainId"] == "scientific_computing"
    assert calc_res["scheme"] == "forward_euler_finite_difference"
    assert abs(calc_res["observedOrder"] - 2.0) <= 0.25
    assert calc_res["isOrderConsistent"] is True
    assert calc_res["cflDiagnosis"]["isStable"] is True
    assert calc_res["boundaryDiagnosis"]["dirichletMatched"] is True
    assert calc_res["allObligationsMet"] is True
    assert calc_res["candidateVerified"] is False

    # Check L2 disk archive: runs/{run_id}/details.json
    l2_file = data_dir / "runs" / run_id / "details.json"
    assert l2_file.is_file(), f"L2 archive not found at {l2_file}"

    details_content = json.loads(l2_file.read_text(encoding="utf-8"))
    assert "events" in details_content
    assert "summary" in details_content
    summary = details_content["summary"]
    assert summary["provider"] == "mock"
    assert summary["stopReason"] == "STOPPED"
    assert summary["candidate_verified"] is False

    # Check Web visibility routes
    get_run_resp = client.get(f"/api/runs/{run_id}")
    assert get_run_resp.status_code == 200
    run_info = get_run_resp.json()
    assert run_info["summary"]["provider"] == "mock"
    assert run_info["summary"]["stopReason"] == "STOPPED"

    page_resp = client.get(f"/runs/{run_id}")
    assert page_resp.status_code == 200
    assert "html" in page_resp.headers.get("content-type", "").lower()


def test_f11_scicomp_fault_injection_missing_boundary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ASTRA_PROVIDER", "mock")
    data_dir = tmp_path / "data"

    solver = build_solver_from_env()
    app = create_app(solver=solver, data_root=data_dir, recover_orphans=False)
    client = TestClient(app)

    # Fault Injection: MISSING_BOUNDARY
    problem_text = "一维热传导方程有限差分复现 (alpha=0.1, tFinal=0.2) 遗漏边界 MISSING_BOUNDARY"
    payload = {
        "domainId": "scientific_computing",
        "problem": problem_text,
        "idempotencyKey": "key_f11_fault_boundary_001",
    }

    post_resp = client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201)
    post_data = post_resp.json()
    calc_res = json.loads(post_data["final_response"])

    assert calc_res["boundaryDiagnosis"]["dirichletMatched"] is False
    assert calc_res["allObligationsMet"] is False
    assert calc_res["candidateVerified"] is False

    # L2 disk check
    run_id = post_data["runId"]
    l2_file = data_dir / "runs" / run_id / "details.json"
    assert l2_file.is_file()
    details_content = json.loads(l2_file.read_text(encoding="utf-8"))
    assert details_content["summary"]["candidate_verified"] is False


def test_f11_scicomp_fault_injection_cfl_violation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ASTRA_PROVIDER", "mock")
    data_dir = tmp_path / "data"

    solver = build_solver_from_env()
    app = create_app(solver=solver, data_root=data_dir, recover_orphans=False)
    client = TestClient(app)

    # Fault Injection: CFL_VIOLATION
    problem_text = "一维热传导方程有限差分复现 (alpha=0.1, tFinal=0.2) 稳定性破坏 CFL_VIOLATION"
    payload = {
        "domainId": "scientific_computing",
        "problem": problem_text,
        "idempotencyKey": "key_f11_fault_cfl_001",
    }

    post_resp = client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201)
    post_data = post_resp.json()
    calc_res = json.loads(post_data["final_response"])

    assert calc_res["cflDiagnosis"]["isStable"] is False
    assert calc_res["cflDiagnosis"]["maxCfl"] > 0.5
    assert calc_res["allObligationsMet"] is False
    assert calc_res["candidateVerified"] is False

    # L2 disk check
    run_id = post_data["runId"]
    l2_file = data_dir / "runs" / run_id / "details.json"
    assert l2_file.is_file()
