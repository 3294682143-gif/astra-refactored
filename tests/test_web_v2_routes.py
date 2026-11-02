from __future__ import annotations

import json
from pathlib import Path
import pytest
from starlette.requests import Request

from python.astra_web.app import create_app
from python.astra_web.v2_routes import (
    create_v2_run,
    get_v2_run,
    get_v2_evidence,
    list_domains,
    get_v2_capabilities,
    list_scenarios,
    get_scenario_detail,
)


def _make_dummy_request(app, method="GET", path="/", query_params=None, path_params=None):
    from urllib.parse import urlencode
    qs = urlencode(query_params or {}).encode("utf-8")
    scope = {
        "type": "http",
        "app": app,
        "method": method,
        "path": path,
        "query_string": qs,
        "headers": [],
        "path_params": path_params or {},
    }
    return Request(scope)


def _make_json_request(app, path, payload, headers=(), method="POST", path_params=None):
    raw = json.dumps(payload).encode("utf-8")
    scope = {
        "type": "http",
        "app": app,
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "path_params": path_params or {},
    }
    state = {"sent": False}

    async def receive():
        if state["sent"]:
            return {"type": "http.disconnect"}
        state["sent"] = True
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request(scope, receive=receive)


@pytest.fixture
def bff_app(tmp_path: Path):
    """Start BFF app with NO API key and NO solver configured."""
    return create_app(solver=None, data_root=tmp_path / "data", recover_orphans=False)


@pytest.mark.anyio
async def test_t0_v2_post_real_problem_text_not_default_problem(bff_app):
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
    req = _make_json_request(bff_app, "/api/v2/runs", payload)
    resp = await create_v2_run(req)
    assert resp.status_code in (200, 201), resp.body.decode("utf-8")
    data = json.loads(resp.body.decode("utf-8"))

    # T0 Critical assertion: rawText must be exactly the input problem, NEVER 'default_problem'
    assert data["rawText"] == problem_input, f"Expected input text but got: {data['rawText']}"
    assert data["rawText"] != "default_problem"
    assert data["domainId"] == "control.identification"


@pytest.mark.anyio
async def test_t1_v2_solver_not_configured_honest_status_and_real_events(bff_app):
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
    post_req = _make_json_request(bff_app, "/api/v2/runs", payload)
    post_resp = await create_v2_run(post_req)
    assert post_resp.status_code in (200, 201), post_resp.body.decode("utf-8")
    post_data = json.loads(post_resp.body.decode("utf-8"))

    run_id = post_data["runId"]
    assert post_data["status"] == "error"
    assert post_data["code"] == "SOLVER_NOT_CONFIGURED"
    assert post_data["candidateVerified"] is False
    assert post_data["executed"] is False

    # Query GET /api/v2/runs/{run_id}
    get_req = _make_dummy_request(bff_app, path=f"/api/v2/runs/{run_id}", path_params={"run_id": run_id})
    get_resp = get_v2_run(get_req)
    assert get_resp.status_code == 200
    get_data = json.loads(get_resp.body.decode("utf-8"))
    assert get_data["status"] == "error"
    assert get_data["code"] == "SOLVER_NOT_CONFIGURED"

    # Query GET /api/v2/runs/{run_id}/evidence
    ev_req = _make_dummy_request(bff_app, path=f"/api/v2/runs/{run_id}/evidence", path_params={"run_id": run_id})
    ev_resp = get_v2_evidence(ev_req)
    assert ev_resp.status_code == 200
    ev_data = json.loads(ev_resp.body.decode("utf-8"))

    # T1 Critical assertion: events array must be a real, non-empty array
    events = ev_data["events"]
    assert isinstance(events, list)
    assert len(events) >= 1, f"Expected non-empty events array, got: {events}"
    assert events[0]["kind"] == "RESULT"
    assert events[0]["payload"]["code"] == "SOLVER_NOT_CONFIGURED"
    assert events[0]["payload"]["executed"] is False
    assert events[0]["payload"]["candidate_verified"] is False


def test_v2_domains_and_capabilities(bff_app):
    # 1. GET /api/v2/domains
    req = _make_dummy_request(bff_app, path="/api/v2/domains")
    resp = list_domains(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["count"] >= 4
    domain_ids = [d["id"] for d in data["domains"]]
    assert "math" in domain_ids
    assert "control.identification" in domain_ids

    # 2. GET /api/v2/capabilities
    caps_req = _make_dummy_request(bff_app, path="/api/v2/capabilities")
    caps_resp = get_v2_capabilities(caps_req)
    assert caps_resp.status_code == 200
    caps = json.loads(caps_resp.body.decode("utf-8"))
    assert caps["kernelVersion"] == "2.1.0"
    assert caps["honestCandidateVerified"] is False


def test_e06_scenarios_catalog_and_detail(bff_app):
    # 1. GET /api/v2/scenarios
    req = _make_dummy_request(bff_app, path="/api/v2/scenarios")
    resp = list_scenarios(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["count"] == 4
    sids = [s["scenarioId"] for s in data["scenarios"]]
    assert "math.research" in sids
    assert "control.identification" in sids
    assert "scientific_computing.heat_transfer" in sids
    assert "data_analysis.statistical_inference" in sids

    # 2. GET /api/v2/scenarios/{scenario_id}
    for sid in sids:
        det_req = _make_dummy_request(
            bff_app, path=f"/api/v2/scenarios/{sid}", path_params={"scenario_id": sid}
        )
        det_resp = get_scenario_detail(det_req)
        assert det_resp.status_code == 200
        det_data = json.loads(det_resp.body.decode("utf-8"))
        assert det_data["manifest"]["scenarioId"] == sid
        assert det_data["manifest"]["version"] == "1.0.0"
        assert len(det_data["team"]["roles"]) >= 3
        assert det_data["inputs"]["inputKind"] is not None
        assert det_data["results"]["visualizerComponent"] is not None


@pytest.mark.anyio
async def test_e06_scenario_id_dispatch(bff_app):
    """Ensure posting scenarioId dynamically routes to the right domain."""
    payload = {
        "scenarioId": "scientific_computing.heat_transfer",
        "problem": "数值求解一维导热方程边界条件收敛性",
        "idempotencyKey": "key_e06_sci_comp_001",
    }
    req = _make_json_request(bff_app, "/api/v2/runs", payload)
    resp = await create_v2_run(req)
    assert resp.status_code in (200, 201)
    data = json.loads(resp.body.decode("utf-8"))
    assert data["domainId"] == "scientific_computing"
    assert data["rawText"] == payload["problem"]
