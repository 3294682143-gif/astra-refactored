from __future__ import annotations

import json
from starlette.requests import Request

from python.astra_web.v2_routes import (
    list_domains,
    get_v2_capabilities,
    create_v2_run,
    get_v2_run,
    get_v2_evidence,
    cancel_v2_run,
)


def _make_dummy_request(method="GET", path="/", body=None, path_params=None):
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [(b"content-type", b"application/json")],
        "path_params": path_params or {},
    }
    req = Request(scope)
    req._body = json.dumps(body).encode("utf-8") if body is not None else b""
    return req


def test_v2_domains_and_capabilities():
    # 1. GET /api/v2/domains
    req = _make_dummy_request(method="GET", path="/api/v2/domains")
    resp = list_domains(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["count"] >= 4
    domain_ids = [d["id"] for d in data["domains"]]
    assert "math" in domain_ids
    assert "control.identification" in domain_ids
    assert "scientific_computing" in domain_ids
    assert "data_analysis" in domain_ids

    # 2. GET /api/v2/capabilities
    caps_req = _make_dummy_request(method="GET", path="/api/v2/capabilities")
    caps_resp = get_v2_capabilities(caps_req)
    assert caps_resp.status_code == 200
    caps = json.loads(caps_resp.body.decode("utf-8"))
    assert caps["kernelVersion"] == "2.1.0"
    assert caps["honestCandidateVerified"] is False


def test_v2_run_lifecycle_and_cancellation():
    # 1. POST /api/v2/runs (create run in control domain)
    create_req = _make_dummy_request(
        method="POST",
        path="/api/v2/runs",
        body={
            "domainId": "control.identification",
            "problem": "辨识阻尼受迫振子系统参数",
            "idempotencyKey": "key_ctl_001",
        },
    )
    create_resp = create_v2_run(create_req)
    assert create_resp.status_code == 201
    run_data = json.loads(create_resp.body.decode("utf-8"))
    run_id = run_data["runId"]
    assert run_data["domainId"] == "control.identification"
    assert run_data["candidateVerified"] is False

    # 2. Idempotent re-submission returns 200 with same runId
    dup_req = _make_dummy_request(
        method="POST",
        path="/api/v2/runs",
        body={
            "domainId": "control.identification",
            "problem": "辨识阻尼受迫振子系统参数",
            "idempotencyKey": "key_ctl_001",
        },
    )
    dup_resp = create_v2_run(dup_req)
    assert dup_resp.status_code == 200
    assert json.loads(dup_resp.body.decode("utf-8"))["runId"] == run_id

    # 3. GET /api/v2/runs/{run_id}
    get_req = _make_dummy_request(
        method="GET",
        path=f"/api/v2/runs/{run_id}",
        path_params={"run_id": run_id},
    )
    get_resp = get_v2_run(get_req)
    assert get_resp.status_code == 200
    assert json.loads(get_resp.body.decode("utf-8"))["status"] == "COMPLETED"

    # 4. GET /api/v2/runs/{run_id}/evidence
    ev_req = _make_dummy_request(
        method="GET",
        path=f"/api/v2/runs/{run_id}/evidence",
        path_params={"run_id": run_id},
    )
    ev_resp = get_v2_evidence(ev_req)
    assert ev_resp.status_code == 200
    ev_data = json.loads(ev_resp.body.decode("utf-8"))
    assert len(ev_data["evidences"]) >= 1

    # 5. POST /api/v2/runs/{run_id}/cancel
    cancel_req = _make_dummy_request(
        method="POST",
        path=f"/api/v2/runs/{run_id}/cancel",
        path_params={"run_id": run_id},
    )
    cancel_resp = cancel_v2_run(cancel_req)
    assert cancel_resp.status_code == 200
    assert json.loads(cancel_resp.body.decode("utf-8"))["status"] == "CANCELLED"
