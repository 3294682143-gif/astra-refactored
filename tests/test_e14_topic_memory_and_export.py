"""Test suite for Work Package E14: Topic Memory, Invalidation, and Multi-Format Export.

Verifies:
1. Multi-tier memory lifecycle (create topic, hypotheses, memories, data versions).
2. Cascading invalidation (T37) when upstream dataset or premises change.
3. User provenance controls (remove record, toggle reuse).
4. Multi-format export (JSON, Markdown report, sealed ZIP archive).
5. Time-capsule archive verification (cryptographic integrity, tamper rejection).
6. HTTP route endpoints (/api/v2/topics and /api/v2/topics/{id}/export).
"""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import zipfile

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from python.astra_web.storage import Store
from python.astra_web.topic_memory import TopicMemoryManager
from python.astra_web.v2_routes import (
    create_topic_route,
    get_topic_route,
    export_topic_route,
)


def _make_dummy_request(
    path: str,
    method: str = "GET",
    headers: dict | None = None,
    path_params: dict | None = None,
    query_params: dict | None = None,
    body: dict | None = None,
    store: Store | None = None,
) -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [(k.lower().encode("utf-8"), v.encode("utf-8")) for k, v in (headers or {}).items()],
        "path_params": path_params or {},
        "query_string": "&".join(f"{k}={v}" for k, v in (query_params or {}).items()).encode("utf-8"),
    }
    req = Request(scope)
    req._path_params = path_params or {}
    req._query_params = query_params or {}
    if body is not None:
        async def mock_json():
            return body
        req.json = mock_json

    if store is not None:
        class DummyState:
            pass
        class DummyApp:
            def __init__(self):
                self.state = DummyState()
                self.state.store = store
                from python.astra_web.queue import ExecutionManager
                from python.astra_web.solver_adapter import build_solver_from_env
                self.state.execution_manager = ExecutionManager(store, solver=build_solver_from_env())
        req.scope["app"] = DummyApp()

    return req


def test_e14_topic_lifecycle_and_provenance():
    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = TopicMemoryManager(tmpdir)
        archive = mgr.create_topic(
            topic_id="top_pendulum_01",
            title="Damped Nonlinear Pendulum Dynamics",
            scenario_id="control.identification",
        )
        assert archive.topic_id == "top_pendulum_01"
        assert archive.scenario_id == "control.identification"

        # 1. Register data version
        mgr.add_data_version(
            topic_id="top_pendulum_01",
            version_id="dver_osc_v1",
            dataset_name="forced_oscillator_200hz",
            sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            record_count=1200,
        )

        # 2. Register research hypothesis
        hyp = mgr.add_hypothesis(
            topic_id="top_pendulum_01",
            hypothesis_id="hyp_damping_ratio",
            statement="Viscous damping ratio zeta is approximately 0.13 under small angle approximation",
            data_version_ids=["dver_osc_v1"],
            provenance={"author_role": "ControlTheoristAgent"},
        )
        assert hyp.status == "PENDING"

        # 3. Record derivation & memory
        rec = mgr.record_memory(
            topic_id="top_pendulum_01",
            record_id="rec_ident_01",
            kind="PARAMETER_BOUND",
            content={"m": 1.4915, "c": 0.3981, "k": 2.7856, "rmse": 0.0046},
            provenance_run_id="run_ctrl_ident_88",
            data_version_ids=["dver_osc_v1"],
            allow_reuse=True,
        )
        assert rec.allow_reuse is True
        assert rec.is_invalidated is False

        # Reload from disk
        loaded = mgr.get_topic("top_pendulum_01")
        assert loaded is not None
        assert len(loaded.hypotheses) == 1
        assert len(loaded.memories) == 1
        assert "run_ctrl_ident_88" in loaded.associated_run_ids


def test_e14_cascading_invalidation():
    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = TopicMemoryManager(tmpdir)
        mgr.create_topic("top_cascade_01", "Thermodynamic Heat Conduction", "sci_computing.thermal")

        mgr.add_data_version("top_cascade_01", "dver_heat_raw", "grid_mesh_dx005", "abc123hash", 500)
        mgr.add_hypothesis(
            "top_cascade_01",
            "hyp_convergence",
            "Finite difference scheme exhibits O(dx^2) convergence",
            data_version_ids=["dver_heat_raw"],
        )
        mgr.record_memory(
            "top_cascade_01",
            "rec_richardson",
            "DERIVATION_STEP",
            content={"order_p": 2.001, "cfl_number": 0.4},
            data_version_ids=["dver_heat_raw"],
            allow_reuse=True,
        )

        # Trigger cascading invalidation of upstream data version
        inval_res = mgr.cascade_invalidate_data_version(
            "top_cascade_01", "dver_heat_raw", reason="Calibration sensor drift discovered in mesh"
        )

        assert "rec_richardson" in inval_res["invalidated_memories"]
        assert "hyp_convergence" in inval_res["invalidated_hypotheses"]

        # Verify state in stored topic
        topic = mgr.get_topic("top_cascade_01")
        assert topic.data_versions["dver_heat_raw"]["status"] == "INVALIDATED"
        assert topic.hypotheses[0].status == "REQUIRES_REVERIFICATION"
        assert topic.memories[0].is_invalidated is True
        assert topic.memories[0].allow_reuse is False
        assert "Cascaded" in topic.memories[0].invalidation_reason


def test_e14_user_provenance_controls():
    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = TopicMemoryManager(tmpdir)
        mgr.create_topic("top_controls_01", "Math Research", "math.research")
        mgr.record_memory("top_controls_01", "rec_m1", "HYPOTHESIS", {"text": "All roots in disk"})
        mgr.record_memory("top_controls_01", "rec_m2", "HYPOTHESIS", {"text": "Degree bounded by 4"})

        # Toggle reuse
        assert mgr.set_memory_reuse("top_controls_01", "rec_m1", allow_reuse=False) is True
        topic = mgr.get_topic("top_controls_01")
        assert topic.memories[0].allow_reuse is False

        # Remove memory
        assert mgr.remove_memory("top_controls_01", "rec_m2") is True
        topic = mgr.get_topic("top_controls_01")
        assert len(topic.memories) == 1
        assert topic.memories[0].record_id == "rec_m1"


def test_e14_multi_format_export_and_time_capsule_verification():
    with tempfile.TemporaryDirectory() as tmpdir:
        mgr = TopicMemoryManager(tmpdir)
        mgr.create_topic("top_export_01", "Statistical Significance Study", "data_analysis.statistical_inference")
        mgr.add_data_version("top_export_01", "dver_stat_01", "clinical_two_arm_rct", "beef456789", 80)
        mgr.add_hypothesis(
            "top_export_01",
            "hyp_arm_diff",
            "Treatment arm mean exceeds control arm with Cohen's d > 0.8",
            data_version_ids=["dver_stat_01"],
        )
        mgr.record_memory(
            "top_export_01",
            "rec_welch_t",
            "AUDIT_VERDICT",
            content={"t_stat": 3.71, "p_val": 0.0004, "cohens_d": 0.83},
            provenance_run_id="run_welch_001",
            data_version_ids=["dver_stat_01"],
        )

        # 1. JSON export
        json_export = mgr.export_json("top_export_01")
        parsed = json.loads(json_export)
        assert parsed["topic_id"] == "top_export_01"
        assert "integrity_sha256" in parsed

        # 2. Markdown export
        md_export = mgr.export_markdown("top_export_01")
        assert "# Scientific Research Topic Report: Statistical Significance Study" in md_export
        assert "clinical_two_arm_rct" in md_export
        assert "Treatment arm mean exceeds control arm" in md_export
        assert "`rec_welch_t`" in md_export

        # 3. ZIP export
        zip_file = Path(tmpdir) / "exports" / "top_export_01.zip"
        res_path = mgr.export_zip("top_export_01", zip_file)
        assert res_path.is_file()

        # 4. Time capsule verification
        verify_res = TopicMemoryManager.verify_topic_archive(zip_file)
        assert verify_res["valid"] is True
        assert verify_res["topic_id"] == "top_export_01"
        assert verify_res["records_verified"] == 1
        assert verify_res["hypotheses_verified"] == 1

        # 5. Tamper detection: modify zip payload and ensure verification fails
        tampered_zip = Path(tmpdir) / "exports" / "tampered.zip"
        with zipfile.ZipFile(zip_file, "r") as zin, zipfile.ZipFile(tampered_zip, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "report.md":
                    data = data + b"\n<!-- TAMPERED DATA -->"
                zout.writestr(item, data)

        tamper_res = TopicMemoryManager.verify_topic_archive(tampered_zip)
        assert tamper_res["valid"] is False
        assert "Checksum mismatch" in tamper_res["error"]


@pytest.mark.anyio
async def test_e14_v2_routes_integration():
    with tempfile.TemporaryDirectory() as tmpdir:
        store = Store(tmpdir)

        # 1. POST /api/v2/topics
        req_create = _make_dummy_request(
            path="/api/v2/topics",
            method="POST",
            body={
                "topicId": "top_http_01",
                "title": "Quantum Oscillator Damping",
                "scenarioId": "control.identification",
            },
            store=store,
        )
        resp_create = await create_topic_route(req_create)
        assert resp_create.status_code == 201
        body_create = json.loads(resp_create.body.decode("utf-8"))
        assert body_create["topicId"] == "top_http_01"

        # 2. GET /api/v2/topics/{topic_id}
        req_get = _make_dummy_request(
            path="/api/v2/topics/top_http_01",
            path_params={"topic_id": "top_http_01"},
            store=store,
        )
        resp_get = get_topic_route(req_get)
        assert resp_get.status_code == 200
        body_get = json.loads(resp_get.body.decode("utf-8"))
        assert body_get["title"] == "Quantum Oscillator Damping"

        # 3. GET /api/v2/topics/{topic_id}/export?format=markdown
        req_export_md = _make_dummy_request(
            path="/api/v2/topics/top_http_01/export",
            path_params={"topic_id": "top_http_01"},
            query_params={"format": "markdown"},
            store=store,
        )
        resp_export_md = export_topic_route(req_export_md)
        assert resp_export_md.status_code == 200
        assert resp_export_md.media_type == "text/markdown"
        assert b"Quantum Oscillator Damping" in resp_export_md.body

        # 4. GET /api/v2/topics/{topic_id}/export?format=zip
        req_export_zip = _make_dummy_request(
            path="/api/v2/topics/top_http_01/export",
            path_params={"topic_id": "top_http_01"},
            query_params={"format": "zip"},
            store=store,
        )
        resp_export_zip = export_topic_route(req_export_zip)
        assert resp_export_zip.status_code == 200
        assert resp_export_zip.media_type == "application/zip"
        assert len(resp_export_zip.body) > 0
