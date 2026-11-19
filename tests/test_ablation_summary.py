from __future__ import annotations

import json
from pathlib import Path

from python.astra_web.ablation import load_problems, load_summary

REAL_ROOT = Path(__file__).resolve().parent.parent / "python" / "astra_web" / "ablation_data"


def test_load_real_summary_has_nine_configs():
    summary = load_summary(REAL_ROOT)
    assert summary is not None
    assert len(summary["configs"]) == 9
    assert summary["pool"]["oracle_n"] == 167
    groups = {row["group"] for row in summary["configs"]}
    assert groups == {"外部基线", "内部消融"}


def test_missing_root_returns_none(tmp_path):
    assert load_summary(tmp_path / "not-exist") is None


def test_bad_json_returns_none(tmp_path):
    (tmp_path / "summary.json").write_text("{not json", encoding="utf-8")
    assert load_summary(tmp_path) is None


def test_missing_configs_returns_none(tmp_path):
    (tmp_path / "summary.json").write_text(json.dumps({"title": "x"}), encoding="utf-8")
    assert load_summary(tmp_path) is None


def test_oversize_returns_none(tmp_path):
    (tmp_path / "summary.json").write_text(" " * (2 * 1024 * 1024 + 1), encoding="utf-8")
    assert load_summary(tmp_path) is None


def test_load_problems_has_200_rows_with_nine_verdicts():
    problems = load_problems(REAL_ROOT)
    assert problems is not None
    assert len(problems) == 200
    sample = problems["A-001"]
    assert set(sample["external"]) == {"mathchat", "mathagent", "macm"}
    assert len(sample["internal"]) == 6
    assert sample["problem"]
    assert sample["reference_answer"]
    assert sample["pool_category"] in {"delivered_correct", "right_but_wrong_choice", "right_but_undelivered", "true_short"}


def test_problems_missing_root_returns_none(tmp_path):
    assert load_problems(tmp_path / "not-exist") is None


def test_ablation_runs_mock_directory_and_honesty(tmp_path):
    from starlette.testclient import TestClient
    from python.astra_web.ablation_runs import (
        get_eval200_replay_payload,
        get_eval200_run,
        load_eval200_index,
        make_eval200_run_id,
        parse_eval200_run_id,
        resolve_eval200_run_and_events,
    )
    from python.astra_web.app import create_app

    assert parse_eval200_run_id(make_eval200_run_id("full", "B-001")) == ("full", "B-001")
    assert parse_eval200_run_id("../bad") is None
    assert load_eval200_index(tmp_path / "missing") is None

    runs_dir = tmp_path / "full200_fixv3"
    runs_dir.mkdir(parents=True)
    # Row 1: candidate with non-empty trace (L2)
    (runs_dir / "full.jsonl").write_text(
        "\n".join([
            json.dumps({
                "experiment_id": "zygos-eval200-ablation",
                "config_id": "full",
                "problem_id": "B-001",
                "repetition": 0,
                "problem_sha256": "abc",
                "code_sha": "def",
                "model_id": "intern-s2",
                "final_answer": "2",
                "elapsed_seconds": 12.3,
                "trace_path": "results/full200_fixv3/full__B-001__r0.trace.json",
                "stop_reason": "REVIEW_STOP",
                "status": "candidate",
                "metrics": {"logical_model_calls": 4, "frames": 4, "method_ids": ["modular-crt"]},
            }),
            json.dumps({
                "experiment_id": "zygos-eval200-ablation",
                "config_id": "full",
                "problem_id": "A-009",
                "repetition": 0,
                "problem_sha256": "xyz",
                "code_sha": "def",
                "model_id": "intern-s2",
                "final_answer": "Unsolved.",
                "elapsed_seconds": 100.0,
                "trace_path": "results/full200_fixv3/full__A-009__r0.trace.json",
                "stop_reason": "ERROR",
                "status": "unsolved",
                "metrics": {"logical_model_calls": 0, "frames": 0, "method_ids": []},
            }),
        ]) + "\n",
        encoding="utf-8",
    )
    (runs_dir / "full__B-001__r0.trace.json").write_text(
        json.dumps([
            {"seq": 1, "kind": "MODEL", "id": "m1", "state": "DISPATCHED", "code": "R0"},
            {"seq": 2, "kind": "MODEL", "id": "m1", "state": "RETURNED", "code": "COMPLETE"},
            {"seq": 3, "kind": "EFFECT", "id": "e1", "state": "RETURNED", "code": "COMPLETE"},
            {"seq": 4, "kind": "CONTROL", "id": "c", "state": "RECORDED", "code": "REVIEW_STOP"},
        ]),
        encoding="utf-8",
    )
    # Empty [] trace -> must remain L1 with no replay payload
    (runs_dir / "full__A-009__r0.trace.json").write_text("[]", encoding="utf-8")

    b_run = get_eval200_run("eval200-full-B-001", runs_root=runs_dir, problems_data_root=REAL_ROOT)
    a_run = get_eval200_run("eval200-full-A-009", runs_root=runs_dir, problems_data_root=REAL_ROOT)
    assert b_run is not None and b_run["detail_level"] == "L2"
    assert a_run is not None and a_run["detail_level"] == "L1" and a_run["l2_path"] is None

    replay = get_eval200_replay_payload("eval200-full-B-001", runs_root=runs_dir, problems_data_root=REAL_ROOT)
    assert replay is not None and len(replay["details"]["events"]) == 5
    assert replay["details"]["events"][-1]["kind"] == "RESULT"
    assert replay["details"]["events"][-1]["payload"]["candidateVerified"] is False
    assert get_eval200_replay_payload("eval200-full-A-009", runs_root=runs_dir, problems_data_root=REAL_ROOT) is None

    resolved_a = resolve_eval200_run_and_events("eval200-full-A-009", runs_root=runs_dir, problems_data_root=REAL_ROOT)
    assert resolved_a is not None and resolved_a[1] == []

    # Test HTTP route integration with env var override
    prev_env = None
    import os
    prev_env = os.environ.get("ASTRA_EVAL200_RUNS_ROOT")
    os.environ["ASTRA_EVAL200_RUNS_ROOT"] = str(runs_dir)
    try:
        app = create_app(data_root=tmp_path / "store", mount_static=False, recover_orphans=False)
        client = TestClient(app)
        resp = client.get("/api/ablation/runs?limit=10&offset=0")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["available"] is True
        assert payload["total_all"] == 2
        assert payload["stats_all"]["l2_count"] == 1
        assert payload["stats_all"]["l1_count"] == 1
        # Filtered by status=error_stop
        err_resp = client.get("/api/ablation/runs?status=error_stop").json()
        assert err_resp["count"] == 1
        assert err_resp["items"][0]["run_id"] == "eval200-full-A-009"
        # Single-run endpoints
        assert client.get("/api/runs/eval200-full-B-001").status_code == 200
        assert client.get("/api/replays/eval200-full-B-001").status_code == 200
        assert client.get("/api/replays/eval200-full-A-009").status_code == 404
        ws = client.get("/api/runs/eval200-full-B-001/workspace")
        assert ws.status_code == 200
        ws_json = ws.json()
        assert ws_json["candidateVerified"] is False
        assert "modular-crt" in ws_json["multiAgentSolving"]["methodRoutes"]
    finally:
        if prev_env is None:
            os.environ.pop("ASTRA_EVAL200_RUNS_ROOT", None)
        else:
            os.environ["ASTRA_EVAL200_RUNS_ROOT"] = prev_env


def test_real_eval200_1200_runs_if_present():
    from python.astra_web.ablation_runs import load_eval200_index, resolve_eval200_runs_root

    root = resolve_eval200_runs_root()
    if root is None:
        return
    loaded = load_eval200_index(root)
    assert loaded is not None
    entries, by_id = loaded
    assert len(entries) == 1200
    assert len(by_id) == 1200
    assert sum(1 for e in entries if e["status"] == "candidate") == 1012
    assert sum(1 for e in entries if e["status"] == "unsolved") == 188
    assert sum(1 for e in entries if e["detail_level"] == "L2") == 1161
    assert sum(1 for e in entries if e["detail_level"] == "L1") == 39

    from starlette.testclient import TestClient
    from python.astra_web.app import create_app
    app = create_app(mount_static=False, recover_orphans=False)
    res = TestClient(app).get("/api/ablation/runs?results_only=1&cap=1000&limit=50&offset=0")
    assert res.status_code == 200
    body = res.json()
    assert body["total_all"] == 1000
    assert body["count"] == 1000
    assert body["stats_all"]["total"] == 1000
    assert body["stats_all"]["candidate"] == 1000
    assert body["stats_all"]["unsolved"] == 0
    assert body["stats_all"]["error_stop"] == 0
    assert body["stats_all"]["l2_count"] == 1000
    assert body["stats_all"]["delivered_correct_count"] == 723


def test_problem_set_jsonl_import_endpoints(tmp_path):
    from starlette.testclient import TestClient
    from python.astra_web.app import create_app

    app = create_app(data_root=tmp_path / "store", mount_static=False, recover_orphans=False)
    with TestClient(app) as client:
        # 1. Invalid line rejected with 422 + line number
        bad = client.post(
            "/api/problem-sets/import",
            json={"name": "bad", "jsonl_text": '{"id":"P-1"}\n', "mode": "catalog"},
        )
        assert bad.status_code == 422
        assert "line 1" in bad.json()["detail"]

        # 2. Valid catalog JSONL import
        sample_jsonl = "\n".join([
            json.dumps({"id": "A-001", "stratum": "A", "problem": "Prove x^3 - 9 is irreducible in F_31."}),
            json.dumps({"id": "B-001", "stratum": "B", "problem": "Find minimum moves for Xenia and Sergey."}),
        ])
        ok_cat = client.post(
            "/api/problem-sets/import",
            json={"name": "demo-set", "jsonl_text": sample_jsonl, "mode": "catalog"},
        )
        assert ok_cat.status_code == 201
        cat_body = ok_cat.json()
        assert cat_body["ok"] is True
        assert cat_body["mode"] == "catalog"
        assert cat_body["problem_set"]["count"] == 2
        set_id = cat_body["problem_set"]["set_id"]

        listed = client.get("/api/problem-sets").json()
        assert listed["count"] == 1
        assert listed["items"][0]["set_id"] == set_id

        detail = client.get(f"/api/problem-sets/{set_id}").json()
        assert detail["data"]["items"][1]["id"] == "B-001"

        # 3. Enqueue mode creates real queued runs (and closes honestly when no solver configured)
        ok_enq = client.post(
            "/api/problem-sets/import",
            json={"name": "queue-set", "jsonl_text": json.dumps({"problem": "Solve 1+1."}), "mode": "enqueue"},
        )
        assert ok_enq.status_code == 201
        enq_body = ok_enq.json()
        assert enq_body["solver_configured"] is False
        assert enq_body["enqueued_count"] == 1
        assert len(enq_body["run_ids"]) == 1

        # 4. Replays JSONL import persists SolveResult directly into store
        rep_jsonl = json.dumps({
            "run_id": "run-import-batch-1",
            "status": "ok",
            "scenario": "Solve 2+2",
            "summary": {"status": "candidate", "final_response": "4", "candidate_verified": False},
        })
        ok_rep = client.post(
            "/api/problem-sets/import",
            json={"jsonl_text": rep_jsonl, "mode": "replays"},
        )
        assert ok_rep.status_code == 201
        assert ok_rep.json()["imported_count"] == 1
        assert client.get("/api/runs/run-import-batch-1").status_code == 200

        # 5. Delete imported set
        del_res = client.delete(f"/api/problem-sets/{set_id}")
        assert del_res.status_code == 200
        assert client.get(f"/api/problem-sets/{set_id}").status_code == 404
