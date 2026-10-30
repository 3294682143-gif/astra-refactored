from __future__ import annotations

import json
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from python.astra_web.app import create_app


@pytest.fixture
def bff_client(tmp_path: Path):
    """Start BFF app with NO API key and NO solver configured."""
    app = create_app(solver=None, data_root=tmp_path / "data", recover_orphans=False)
    with TestClient(app) as client:
        yield client


def test_t0_v2_post_real_problem_text_not_default_problem(bff_client: TestClient):
    """T0 verification:

    Ensures body = await request.json() properly reads the submitted problem text,
    and rawText in the response strictly matches the input rather than silently
    falling back to 'default_problem'.
    """
    problem_input = "辨识非线性阻尼受迫振子质量阻尼刚度三参数 (m=1.5, c=0.4, k=2.8)"
    payload = {
        "domainId": "control.identification",
        "problem": problem_input,
        "idempotencyKey": "key_t0_verify_001",
    }
    resp = bff_client.post("/api/v2/runs", json=payload)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()

    # T0 Critical assertion: rawText must be exactly the input problem, NEVER 'default_problem'
    assert data["rawText"] == problem_input, f"Expected input text but got: {data['rawText']}"
    assert data["rawText"] != "default_problem"
    assert data["domainId"] == "control.identification"


def test_t1_v2_solver_not_configured_honest_status_and_real_events(bff_client: TestClient):
    """T1 verification:

    When no solver is configured (no API key in environment), POST /api/v2/runs
    must execute through ExecutionManager and return an honest SOLVER_NOT_CONFIGURED
    status (NEVER a fake COMPLETED).
    Furthermore, the events/evidence endpoint must return a non-empty array of real events.
    """
    payload = {
        "domainId": "control.identification",
        "problem": "测试无模型配置下的真实派发链路",
        "idempotencyKey": "key_t1_verify_honest_002",
    }
    post_resp = bff_client.post("/api/v2/runs", json=payload)
    assert post_resp.status_code in (200, 201), post_resp.text
    post_data = post_resp.json()

    run_id = post_data["runId"]
    assert post_data["status"] == "error"
    assert post_data["code"] == "SOLVER_NOT_CONFIGURED"
    assert post_data["candidateVerified"] is False
    assert post_data["executed"] is False

    # Query GET /api/v2/runs/{run_id}
    get_resp = bff_client.get(f"/api/v2/runs/{run_id}")
    assert get_resp.status_code == 200
    get_data = get_resp.json()
    assert get_data["status"] == "error"
    assert get_data["code"] == "SOLVER_NOT_CONFIGURED"

    # Query GET /api/v2/runs/{run_id}/evidence
    ev_resp = bff_client.get(f"/api/v2/runs/{run_id}/evidence")
    assert ev_resp.status_code == 200
    ev_data = ev_resp.json()

    # T1 Critical assertion: events array must be a real, non-empty array
    events = ev_data["events"]
    assert isinstance(events, list)
    assert len(events) >= 1, f"Expected non-empty events array, got: {events}"
    assert events[0]["kind"] == "RESULT"
    assert events[0]["payload"]["code"] == "SOLVER_NOT_CONFIGURED"
    assert events[0]["payload"]["executed"] is False
    assert events[0]["payload"]["candidate_verified"] is False


def test_v2_domains_and_capabilities(bff_client: TestClient):
    # 1. GET /api/v2/domains
    resp = bff_client.get("/api/v2/domains")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] >= 4
    domain_ids = [d["id"] for d in data["domains"]]
    assert "math" in domain_ids
    assert "control.identification" in domain_ids

    # 2. GET /api/v2/capabilities
    caps_resp = bff_client.get("/api/v2/capabilities")
    assert caps_resp.status_code == 200
    caps = caps_resp.json()
    assert caps["kernelVersion"] == "2.1.0"
    assert caps["honestCandidateVerified"] is False
