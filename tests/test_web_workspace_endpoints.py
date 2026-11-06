"""测试新增 BFF 端点：/api/runs/{id}/workspace、evidence、recovery、resume。

依据：《天轭前端Demo重构方案_评委版.md》第 8.3 节、第 9 节。
规范：《天轭前端Demo验收审查_2026-11-05.md》S1-S4 与 R1-R5 缺陷规避。
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path

import pytest
from starlette.exceptions import HTTPException
from starlette.requests import Request

from python.astra_bridge import host_carriers, host_checkpoint
from python.astra_web.app import (
    _resolve_run_and_events,
    create_app,
    get_evidence,
    get_recovery,
    get_workspace,
    validate_and_prepare_resume,
)
from python.astra_web.config import default_budget
from python.astra_web.solver_adapter import SolverAdapter
from python.astra_web.storage import Store
from tests.web_math_helpers import MathAssetScriptedClient


def _make_dummy_request(app, method="GET", path="/", path_params=None, headers=None) -> Request:
    raw_headers = [
        (k.lower().encode("latin1"), v.encode("latin1"))
        for k, v in (headers or {}).items()
    ]
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": raw_headers,
        "path_params": path_params or {},
        "query_string": b"",
        "app": app,
    }
    return Request(scope)


def _build_valid_checkpoint(problem: str, *, max_models=20, spent_models=5, unknown_requests=()):
    prob_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    session_id = uuid.uuid4().hex
    carrier = host_carriers.bind_carrier(
        "local",
        prob_hash,
        session_id,
        "math-agent-preview-v2",
        max_model_calls=max_models,
        max_work_units=5,
        max_effects=2,
        root_deadline_ms=60000,
    )
    ledger = [
        {
            "requestId": f"req-{i}",
            "sessionId": session_id,
            "phase": "WORK",
            "state": "REMOTE_TERMINAL_CONFIRMED",
            "totalTokens": 100,
        }
        for i in range(spent_models)
    ]
    session_log = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": problem}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 2, "tasks": 2}},
        {"seq": 3, "kind": "WORKUNIT", "data": {"role": "WORK", "proposal": "test step"}},
    ]
    return host_checkpoint.export_checkpoint(
        carrier=carrier,
        problem_hash=prob_hash,
        contract_version=1,
        spent={"modelCalls": spent_models, "effectCalls": 0},
        ledger=ledger,
        session_log=session_log,
        unknown_request_ids=tuple(unknown_requests),
    )


def test_workspace_snapshot_on_real_run():
    repo_root = Path(__file__).resolve().parent.parent
    data_root = repo_root / "var" / "astra"
    app = create_app(data_root=data_root, mount_static=False, recover_orphans=False)

    # 1. 验证真实存在的研究记录 run-16a5b148239f
    req = _make_dummy_request(
        app,
        path="/api/runs/run-16a5b148239f/workspace",
        path_params={"run_id": "run-16a5b148239f"},
    )
    resp = get_workspace(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))

    # 结构断言
    assert data["runId"] == "run-16a5b148239f"
    assert data["mode"] == "completed"
    assert data["candidateVerified"] is False  # 红线
    assert len(data["stages"]) == 4
    assert len(data["nodes"]) >= 4
    assert len(data["edges"]) >= 3
    assert len(data["evidences"]) >= 3
    assert data["budget"]["usedModelCalls"] >= 1
    assert data["finalAnswer"] is not None

    # 2. 验证证据详情接口 /api/runs/{run_id}/evidence/{evidence_id}
    first_ev_id = next(iter(data["evidences"].keys()))
    ev_req = _make_dummy_request(
        app,
        path=f"/api/runs/run-16a5b148239f/evidence/{first_ev_id}",
        path_params={"run_id": "run-16a5b148239f", "evidence_id": first_ev_id},
    )
    ev_resp = get_evidence(ev_req)
    assert ev_resp.status_code == 200
    ev_data = json.loads(ev_resp.body.decode("utf-8"))
    assert ev_data["id"] == first_ev_id
    assert ev_data["verified"] is False
    assert "###" in ev_data["markdownContent"]

    # 3. 验证恢复能力接口：已终态候选记录严格不可恢复 (S1 / R1)
    rec_req = _make_dummy_request(
        app,
        path="/api/runs/run-16a5b148239f/recovery",
        path_params={"run_id": "run-16a5b148239f"},
    )
    rec_resp = get_recovery(rec_req)
    assert rec_resp.status_code == 200
    rec_data = json.loads(rec_resp.body.decode("utf-8"))
    assert rec_data["eligible"] is False
    assert "终态" in rec_data["reason"] or "完成" in rec_data["reason"]


def test_recovery_on_timeout_without_checkpoint_is_ineligible(tmp_path):
    """规避审查发现：无检查点的超时记录不能被判为可恢复 (R1 / Standards S1)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    run_id = "run-timeout-no-checkpoint"
    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "timeout",
        "scenario": "Compute 2+2",
        "model": "test",
        "seed": 0,
        "duration_s": 12.0,
        "summary_json": json.dumps({
            "problem": "Compute 2+2",
            "status": "timeout",
            "stopReason": "TIMEOUT",
            "max_model_calls": 32,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "timeout",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/recovery", path_params={"run_id": run_id})
    resp = get_recovery(req)
    rec = json.loads(resp.body.decode("utf-8"))
    assert rec["eligible"] is False
    assert "未检测到可信中间检查点" in rec["reason"]

    # 尝试准备恢复必须被 400 拒绝，禁止把重新求解当作恢复
    run, events, is_active = _resolve_run_and_events(req, run_id)
    with pytest.raises(HTTPException) as exc_info:
        validate_and_prepare_resume(run, events, is_active)
    assert exc_info.value.status_code == 400


def test_recovery_on_tampered_checkpoint_is_ineligible(tmp_path):
    """篡改的检查点摘要或跨题目检查点必须被严格拒绝 (AGENTS.md:9)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    problem = "Prove Fermat's Last Theorem for n=3"
    cp = _build_valid_checkpoint(problem)
    # 恶意篡改：修改 spent 但保留原 digest
    cp["spent"]["modelCalls"] = 1

    run_id = "run-tampered-checkpoint"
    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "aborted",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 5.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "aborted",
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "aborted",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/recovery", path_params={"run_id": run_id})
    resp = get_recovery(req)
    rec = json.loads(resp.body.decode("utf-8"))
    assert rec["eligible"] is False
    assert "校验失败" in rec["reason"]

    run, events, is_active = _resolve_run_and_events(req, run_id)
    with pytest.raises(HTTPException) as exc_info:
        validate_and_prepare_resume(run, events, is_active)
    assert exc_info.value.status_code == 400


def test_recovery_blocked_on_outcome_unknown_request(tmp_path):
    """存在在途未知请求 (OUTCOME_UNKNOWN) 时必须安全阻断恢复，严禁自动重发 (AGENTS.md:9)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    problem = "Solve integral x^2 dx"
    cp = _build_valid_checkpoint(problem, unknown_requests=["req-in-flight-999"])

    run_id = "run-unknown-request"
    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "error",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 5.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "error",
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "error",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/recovery", path_params={"run_id": run_id})
    resp = get_recovery(req)
    rec = json.loads(resp.body.decode("utf-8"))
    assert rec["eligible"] is False
    assert "未确认远端请求" in rec["reason"]

    run, events, is_active = _resolve_run_and_events(req, run_id)
    with pytest.raises(HTTPException) as exc_info:
        validate_and_prepare_resume(run, events, is_active)
    assert exc_info.value.status_code == 400


def test_recovery_blocked_on_budget_exhaustion(tmp_path):
    """原模型调用预算已耗尽的检查点禁止超额续推."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    problem = "Factorize 100"
    cp = _build_valid_checkpoint(problem, max_models=10, spent_models=10)

    run_id = "run-budget-exhausted"
    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "timeout",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 15.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "timeout",
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "timeout",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/recovery", path_params={"run_id": run_id})
    resp = get_recovery(req)
    rec = json.loads(resp.body.decode("utf-8"))
    assert rec["eligible"] is False
    assert "预算已耗尽" in rec["reason"]

    run, events, is_active = _resolve_run_and_events(req, run_id)
    with pytest.raises(HTTPException) as exc_info:
        validate_and_prepare_resume(run, events, is_active)
    assert exc_info.value.status_code == 400


def test_valid_checkpoint_resumption_and_idempotency(tmp_path):
    """验证真正受约束的同题恢复与并发幂等 (方案 9 节 / Standards S1)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store
    manager = app.state.execution_manager

    problem = "Find roots of x^2 - 4 = 0"
    # 总预算 20，已用 5，剩余 15
    cp = _build_valid_checkpoint(problem, max_models=20, spent_models=5)

    now = time.time()
    run_id = "run-interrupted-valid"
    store.save_run({
        "run_id": run_id,
        "created_at": now - 8.0,
        "source": "worker",
        "status": "aborted",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 8.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "aborted",
            "problem_seconds": 60,
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "aborted",
        "checksum": None,
    })

    # 1. 恢复资格检查
    rec_req = _make_dummy_request(app, path=f"/api/runs/{run_id}/recovery", path_params={"run_id": run_id})
    rec_resp = get_recovery(rec_req)
    rec = json.loads(rec_resp.body.decode("utf-8"))
    assert rec["eligible"] is True
    assert rec["checkpointSeq"] == 3
    assert rec["remainingBudget"]["maxModelCalls"] == 15

    # 2. 校验准入并生成收紧预算的同题恢复请求 (Standards S2, S3)
    run, events, is_active = _resolve_run_and_events(rec_req, run_id)
    resume_req = validate_and_prepare_resume(
        run,
        events,
        is_active,
        headers={"Idempotency-Key": "resume-test-token-1"},
    )
    assert resume_req["problem"] == problem
    assert resume_req["metadata"]["resumed_from"] == run_id
    assert resume_req["metadata"]["checkpoint_seq"] == 3
    assert resume_req["metadata"]["remaining_model_calls"] == 15
    # 累计总预算传给 carrier，由 plan 内部扣减 spent，避免双重扣减 (Standards S3)
    assert resume_req["max_model_calls"] == 20
    assert resume_req["mode"] == "local"
    assert resume_req["resume_checkpoint"]["digest"] == cp["digest"]
    assert round(resume_req["problem_seconds"], 0) == 52.0  # 60 - 8

    # 3. 同步注册新任务并验证落盘
    new_run_id = manager.prepare_run(request=resume_req)
    assert new_run_id != run_id
    new_run = store.get_run(new_run_id)
    assert new_run is not None
    assert new_run["summary"]["metadata"]["resumed_from"] == run_id
    assert new_run["summary"]["max_model_calls"] == 20

    # 4. 幂等性检验：以相同幂等键再次注册，必须返回相同 run_id
    replay_run_id = manager.prepare_run(request=resume_req)
    assert replay_run_id == new_run_id


def test_rejected_repair_and_challenge_projection(tmp_path):
    """规避 Standards S3：被拒绝的修复/审查分支必须投影为 failed 与拒绝准入."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    run_id = "run-rejected-repair"
    problem = "Prove boundary symmetry"
    events = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": problem}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 1, "tasks": 1}},
        {"seq": 3, "kind": "WORKUNIT", "data": {"proposal": "trial 1"}},
        {
            "seq": 4,
            "kind": "REPAIR",
            "data": {
                "kind": "G2_ROUTE_REJECT",
                "rejected": True,
                "decision": "rejected",
                "reason": "反例验证不满足边界约束条件",
            },
        },
        {"seq": 5, "kind": "RESULT", "data": {"status": "unsolved", "stopReason": "REVISE_REJECTED"}},
    ]

    details_path = store.safe_join(f"runs/{run_id}/details.json")
    details_path.parent.mkdir(parents=True, exist_ok=True)
    details_path.write_text(json.dumps({"events": events, "summary": {"problem": problem}}), encoding="utf-8")

    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "unsolved",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 3.0,
        "summary_json": json.dumps({"problem": problem, "status": "unsolved", "stopReason": "REVISE_REJECTED"}),
        "l2_path": f"runs/{run_id}/details.json",
        "l3_path": None,
        "tags": "unsolved",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/workspace", path_params={"run_id": run_id})
    resp = get_workspace(req)
    ws = json.loads(resp.body.decode("utf-8"))

    # 找到 REPAIR 节点
    repair_node = next(n for n in ws["nodes"] if "review-4" in n["id"])
    # 必须为 failed，绝对不可为 completed
    assert repair_node["status"] == "failed"
    assert "拒绝准入" in repair_node["label"]
    assert "已拒绝" in repair_node["outputSummary"]

    # 检查证据详情
    ev = ws["evidences"][repair_node["evidenceId"]]
    assert "拒绝准入" in ev["markdownContent"]
    assert "合规受控" not in ev["markdownContent"]

    # 审查决策被拒绝且未产生后续修订工作单元，依规范禁止从节点位置伪造回流边 (Spec R2)
    repair_edges = [e for e in ws["edges"] if e.get("kind") == "repair_loop"]
    assert len(repair_edges) == 0


def test_real_solver_adapter_checkpoint_resumption():
    """验证真实 SolverAdapter -> ReasoningAgent 恢复链路：先经真实运行生成真实检查点，再恢复验证业务状态、剩余预算与产物延续 (Standards S1, S3)."""
    from tests.e2e.test_ts_entry import FakeClient

    problem = "Compute 2+2"
    client1 = FakeClient()
    adapter1 = SolverAdapter(client_factory=lambda: client1)
    req1 = {
        **default_budget(),
        "max_r0": 0,
        "max_consensus": 0,
        "max_reviews": 0,
        "max_repairs": 0,
        "run_id": "run-real-resume-first",
        "problem": problem,
        "engine": "ts",
        "mode": "local",
    }
    result1 = adapter1(req1)
    assert result1["status"] == "candidate"
    assert result1.get("checkpoint") is not None
    cp = result1["checkpoint"]

    client2 = FakeClient()
    adapter2 = SolverAdapter(client_factory=lambda: client2)
    # default_budget() 置于最前，避免覆盖显式预算 max_model_calls: 20
    resume_req = {
        **default_budget(),
        "max_r0": 0,
        "max_consensus": 0,
        "max_reviews": 0,
        "max_repairs": 0,
        "run_id": "run-real-resume-second",
        "problem": problem,
        "engine": "ts",
        "mode": "local",
        "resume_checkpoint": cp,
        "max_model_calls": 20,
        "metadata": {"resumed_from": "run-real-resume-first"},
    }
    result = adapter2(resume_req)
    # 验证业务状态、终态响应与无错误码
    assert result["status"] == "candidate"
    assert result["stopReason"] == "WORK_UNITS_COMPLETE"
    assert result["final_response"] == "4"
    assert result.get("code") is None
    assert result["executed"] is True
    assert result["candidate_verified"] is False  # 红线保真
    assert client2.calls == 0  # 恢复执行直接利用日志产物，已结算调用不重复发起


def test_recovery_rejected_when_deadline_or_duration_exceeded(tmp_path):
    """验证超出原限额或绝对截止时间时严格拒绝恢复，不重新赠送 1 秒 (Standards S2 / AGENTS.md:9)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    problem = "Solve system Ax = b"
    cp = _build_valid_checkpoint(problem, max_models=20, spent_models=5)

    # 用例 A：已耗时达到或超出原限额 (原限额 60s，已耗时 65s)
    run_id_dur = "run-dur-exceeded"
    store.save_run({
        "run_id": run_id_dur,
        "created_at": time.time() - 70.0,
        "source": "worker",
        "status": "aborted",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 65.0,  # 65 > 60
        "summary_json": json.dumps({
            "problem": problem,
            "status": "aborted",
            "problem_seconds": 60,
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "aborted",
        "checksum": None,
    })

    req_dur = _make_dummy_request(app, path=f"/api/runs/{run_id_dur}/recovery", path_params={"run_id": run_id_dur})
    rec_resp_dur = get_recovery(req_dur)
    rec_dur = json.loads(rec_resp_dur.body.decode("utf-8"))
    assert rec_dur["eligible"] is False
    assert "时间已超出限额" in rec_dur["reason"]

    run_obj, events, is_act = _resolve_run_and_events(req_dur, run_id_dur)
    with pytest.raises(HTTPException) as exc_dur:
        validate_and_prepare_resume(run_obj, events, is_act)
    assert exc_dur.value.status_code == 400
    assert "超出限额" in exc_dur.value.detail

    # 用例 B：原任务绝对截止时间已过期 (created_at 距今 100s，限额 60s)
    run_id_exp = "run-deadline-expired"
    store.save_run({
        "run_id": run_id_exp,
        "created_at": time.time() - 100.0,  # 100s ago
        "source": "worker",
        "status": "aborted",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 10.0,  # 历史耗时虽小，但当前时间已穿透截止期
        "summary_json": json.dumps({
            "problem": problem,
            "status": "aborted",
            "problem_seconds": 60,
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "aborted",
        "checksum": None,
    })

    req_exp = _make_dummy_request(app, path=f"/api/runs/{run_id_exp}/recovery", path_params={"run_id": run_id_exp})
    rec_resp_exp = get_recovery(req_exp)
    rec_exp = json.loads(rec_resp_exp.body.decode("utf-8"))
    assert rec_exp["eligible"] is False
    assert "时间已超出限额" in rec_exp["reason"]

    run_obj2, events2, is_act2 = _resolve_run_and_events(req_exp, run_id_exp)
    with pytest.raises(HTTPException) as exc_exp:
        validate_and_prepare_resume(run_obj2, events2, is_act2)
    assert exc_exp.value.status_code == 400
    assert "时间已超出限额" in exc_exp.value.detail


def test_tool_call_merging_and_truthful_failure_display(tmp_path):
    """验证工具调用事件按 effectId/id 合并去重，失败如实显示 failed 与错误内容 (Spec R1)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    run_id = "run-tool-failed-merge"
    problem = "Compute matrix inversion"
    # 同一次调用的两个互补事件：effect_returned (回执) + TOOL_OBSERVATION (观测)
    events = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": problem}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 1, "tasks": 1}},
        {
            "seq": 3,
            "kind": "effect_returned",
            "data": {
                "effectId": "eff-fail-101",
                "action": "math_asset",
                "name": "math.matrix_inv",
                "status": "ERROR",
                "checkResult": "FAILURE",
                "reason": "Singular matrix: determinant is 0",
            },
        },
        {
            "seq": 4,
            "kind": "TOOL_OBSERVATION",
            "data": {
                "id": "eff-fail-101",
                "tool": "math.matrix_inv",
                "args": {"matrix": [[1, 2], [2, 4]]},
                "observation": {"error": "Singular matrix: determinant is 0"},
            },
        },
        {"seq": 5, "kind": "RESULT", "data": {"status": "unsolved", "stopReason": "TOOL_ERROR"}},
    ]

    details_path = store.safe_join(f"runs/{run_id}/details.json")
    details_path.parent.mkdir(parents=True, exist_ok=True)
    details_path.write_text(json.dumps({"events": events, "summary": {"problem": problem}}), encoding="utf-8")

    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "unsolved",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 4.0,
        "summary_json": json.dumps({"problem": problem, "status": "unsolved", "stopReason": "TOOL_ERROR"}),
        "l2_path": f"runs/{run_id}/details.json",
        "l3_path": None,
        "tags": "unsolved",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/workspace", path_params={"run_id": run_id})
    resp = get_workspace(req)
    ws = json.loads(resp.body.decode("utf-8"))

    # 1. 验证去重：同一次调用只生成 1 个工具节点
    tool_nodes = [n for n in ws["nodes"] if "tool" in n["id"]]
    assert len(tool_nodes) == 1
    tn = tool_nodes[0]
    assert tn["id"] == "node-tool-eff-fail-101"

    # 2. 状态必须为 failed，不可伪装为 completed
    assert tn["status"] == "failed"
    assert "资产调用失败" in tn["label"]
    assert "math.matrix_inv" in tn["label"]

    # 3. 参数与观测真实合并，不可退化为 {}
    assert "matrix" in tn["inputSummary"]
    assert "Singular matrix" in tn["outputSummary"]

    # 4. 证据内容保真
    ev = ws["evidences"][tn["evidenceId"]]
    assert "调用失败" in ev["markdownContent"]
    assert "Singular matrix" in ev["markdownContent"]


def test_unresolved_obligations_projection(tmp_path):
    """验证未解决义务正确透传至交付节点 raw 与 snapshot，终态失败不展示多专家一致 (Spec R3)."""
    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store

    run_id = "run-unresolved-obl"
    problem = "Verify Fermat boundary condition"
    events = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": problem}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 2, "tasks": 2}},
        {"seq": 3, "kind": "WORKUNIT", "data": {"taskId": "task-01", "candidateProposal": "partial lemma"}},
        {
            "seq": 4,
            "kind": "RESULT",
            "data": {
                "status": "unsolved",
                "stopReason": "TIMEOUT",
                "unresolvedObligations": ["obl-1", "obl-2"],
            },
        },
    ]

    details_path = store.safe_join(f"runs/{run_id}/details.json")
    details_path.parent.mkdir(parents=True, exist_ok=True)
    details_path.write_text(json.dumps({"events": events, "summary": {"problem": problem}}), encoding="utf-8")

    store.save_run({
        "run_id": run_id,
        "created_at": time.time(),
        "source": "worker",
        "status": "unsolved",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 60.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "unsolved",
            "stopReason": "TIMEOUT",
            "unresolvedObligations": ["obl-1", "obl-2"],
        }),
        "l2_path": f"runs/{run_id}/details.json",
        "l3_path": None,
        "tags": "unsolved",
        "checksum": None,
    })

    req = _make_dummy_request(app, path=f"/api/runs/{run_id}/workspace", path_params={"run_id": run_id})
    resp = get_workspace(req)
    ws = json.loads(resp.body.decode("utf-8"))

    # 1. 根快照包含真实未闭合义务
    assert ws["unresolvedObligations"] == ["obl-1", "obl-2"]

    # 2. 交付节点 raw 包含未闭合义务
    delivery_node = next(n for n in ws["nodes"] if n["id"] == "node-delivery-final")
    assert delivery_node["status"] == "failed"
    del_raw = delivery_node["technical"]["raw"]
    assert del_raw["unresolvedObligations"] == ["obl-1", "obl-2"]
    assert del_raw["status"] == "unsolved"


def test_queuing_delay_exceeding_deadline_rejects_without_solver_call(tmp_path):
    """验证恢复请求排队等待期间原截止时间持续消耗，超期后出队严禁调用 solver，直接以系统级失败收口 (Standards S1)."""
    from python.astra_web.queue import ExecutionManager

    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store
    manager: ExecutionManager = app.state.execution_manager

    solver_called = False

    def mock_solver(request):
        nonlocal solver_called
        solver_called = True
        return {"status": "candidate", "stopReason": "WORK_UNITS_COMPLETE"}

    manager._solver = mock_solver

    # 模拟合法恢复请求：原限额剩余 0.05 秒
    root_deadline = time.time() + 0.05
    req = {
        "problem": "Solve bounded queuing equation",
        "engine": "ts",
        "root_deadline_ts": root_deadline,
        "problem_seconds": 0.05,
    }
    run_id = manager.prepare_run(request=req)

    # 在队列中等待 0.10 秒，超过剩余的 0.05 秒截止期
    time.sleep(0.10)
    assert time.time() > root_deadline

    # 出队并执行 _run_one
    coro = manager._run_one(run_id)
    try:
        coro.send(None)
    except StopIteration:
        pass

    # 验证 solver 从未被调用
    assert solver_called is False, "排队超期后严禁调用 solver！"

    # 验证终态记录与安全收口
    run = store.get_run(run_id)
    assert run["status"] == "error"
    summary = run["summary"]
    assert summary["stopReason"] == "ERROR"
    assert summary["code"] == "DEADLINE_EXCEEDED_IN_QUEUE"
    assert summary["executed"] is False
    assert summary["candidate_verified"] is False
    assert "已过期" in summary["reason"]


def test_resume_request_idempotency_two_independent_calls(tmp_path):
    """验证两次独立发起的相同恢复请求经过 validate_and_prepare_resume 产生恒定指纹，不返回 409 幂等冲突 (Standards S2)."""
    from python.astra_web.queue import ExecutionManager, request_fingerprint

    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store
    manager: ExecutionManager = app.state.execution_manager

    problem = "Idempotency retry problem"
    cp = _build_valid_checkpoint(problem, max_models=20, spent_models=5)
    run_id = "run-orig-idempotency"
    created_at = time.time() - 10.0
    store.save_run({
        "run_id": run_id,
        "created_at": created_at,
        "source": "worker",
        "status": "aborted",
        "scenario": problem,
        "model": "test",
        "seed": 0,
        "duration_s": 10.0,
        "summary_json": json.dumps({
            "problem": problem,
            "status": "aborted",
            "problem_seconds": 60,
            "checkpoint": cp,
        }),
        "l2_path": None,
        "l3_path": None,
        "tags": "aborted",
        "checksum": None,
    })

    req_dummy = _make_dummy_request(app, headers={"Idempotency-Key": "client-retry-key-001"})
    run1, events1, is_act1 = _resolve_run_and_events(req_dummy, run_id)

    # 第一次独立准备恢复请求
    resume_req1 = validate_and_prepare_resume(run1, events1, is_act1, headers=req_dummy.headers)
    run_id1 = manager.prepare_run(request=resume_req1)

    time.sleep(0.05)  # 物理时间流逝

    # 第二次独立准备恢复请求（模拟客户端超时重试）
    run2, events2, is_act2 = _resolve_run_and_events(req_dummy, run_id)
    resume_req2 = validate_and_prepare_resume(run2, events2, is_act2, headers=req_dummy.headers)

    # 请求指纹必须完全一致，排除相对秒数动态抖动导致的虚假冲突
    fp1 = request_fingerprint(resume_req1)
    fp2 = request_fingerprint(resume_req2)
    assert fp1 == fp2, "恢复请求指纹必须恒定！"

    # 第二次注册必须返回已有的同一运行 ID，且不抛出 IdempotencyConflict
    run_id2 = manager.prepare_run(request=resume_req2)
    assert run_id1 == run_id2


def test_repair_loop_no_guess_unrelated_vs_real_revision():
    """验证修复回流边仅依据精确修订关系建立：审查后执行无关任务无回流边，真实修订任务有可追溯回流边 (Spec R2)."""
    from python.astra_web.workspace_projector import project_workspace

    # 用例 1：审查 task-a 后，独立执行无关的 task-b（无父产物或修订声明）
    events_unrelated = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": "Test Problem"}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 2, "tasks": 2}},
        {"seq": 3, "kind": "WORKUNIT", "data": {"taskId": "task-a", "candidateProposal": "proposal a"}},
        {"seq": 4, "kind": "REVIEW_CHALLENGE", "data": {"targetTaskId": "task-a", "targetArtifactId": "art-a-1", "rationale": "defect found in task a", "challenges": 1}},
        {"seq": 5, "kind": "WORKUNIT", "data": {"taskId": "task-b", "candidateProposal": "proposal b"}},
    ]
    run_unrelated = {"run_id": "run-unrelated", "status": "running", "summary": {"problem": "Test Problem"}}
    ws1 = project_workspace(run_unrelated, events_unrelated, is_active=True)
    repair_edges1 = [e for e in ws1["edges"] if e.get("kind") == "repair_loop"]
    assert len(repair_edges1) == 0, "执行无关任务严禁伪造回流边！"

    # 用例 2：审查 task-a 后，执行显式声明 supersedes 对应父产物的真实修订任务 task-a-revised
    events_revision = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"problem": "Test Problem"}},
        {"seq": 2, "kind": "CONTRACT", "data": {"obligations": 2, "tasks": 2}},
        {"seq": 3, "kind": "WORKUNIT", "data": {"taskId": "task-a", "candidateProposal": "proposal a"}},
        {"seq": 4, "kind": "REVIEW_CHALLENGE", "data": {"targetTaskId": "task-a", "targetArtifactId": "art-a-1", "rationale": "defect found in task a", "challenges": 1}},
        {"seq": 5, "kind": "WORKUNIT", "data": {"taskId": "task-a-revised", "supersedes": {"artifactId": "art-a-1", "artifactVersion": 1}, "candidateProposal": "fixed proposal a"}},
    ]
    run_revision = {"run_id": "run-revision", "status": "running", "summary": {"problem": "Test Problem"}}
    ws2 = project_workspace(run_revision, events_revision, is_active=True)
    repair_edges2 = [e for e in ws2["edges"] if e.get("kind") == "repair_loop"]
    assert len(repair_edges2) == 1, "真实修订任务必须准确建立 1 条修复回流边！"
    assert "node-review-4" in repair_edges2[0]["source"]
    assert "node-work-5" in repair_edges2[0]["target"]


def test_real_queue_result_and_replay_preserves_unresolved_obligations(tmp_path):
    """验证真实队列终态 RESULT 事件写入 unresolvedObligations，快照与回放两条路径保留相同未解项 (Spec R1)."""
    from python.astra_web.app import get_replay
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.queue import ExecutionManager, SolveOutcome

    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store
    manager: ExecutionManager = app.state.execution_manager

    problem = "Verify unresolved obligations preservation"
    run_id = manager.prepare_run(problem=problem)
    info = manager._active_runs.get(run_id)

    # 求解器返回真实的未解义务清单
    outcome = SolveOutcome(
        stop_reason=StopReason.ERROR,
        reason="Attainment boundary unclosed",
        result={"unresolvedObligations": ["goal-main:answer", "goal-1:ATTAINMENT"]},
    )
    manager._finalize(info, outcome, duration_s=1.5)

    # 1. 真实生成的 RESULT 事件 payload 必须透传该字段
    history = manager.get_history_events(run_id)
    result_ev = next(ev for ev in history if ev.get("kind") == "RESULT")
    payload = result_ev.get("payload") or {}
    assert payload.get("unresolvedObligations") == ["goal-main:answer", "goal-1:ATTAINMENT"]

    # 2. Workspace 快照投影包含相同未解义务
    req_ws = _make_dummy_request(app, path=f"/api/runs/{run_id}/workspace", path_params={"run_id": run_id})
    resp_ws = get_workspace(req_ws)
    ws = json.loads(resp_ws.body.decode("utf-8"))
    assert ws.get("unresolvedObligations") == ["goal-main:answer", "goal-1:ATTAINMENT"]

    # 3. 回放事件流 details.events 包含相同未解义务
    req_rp = _make_dummy_request(app, path=f"/api/replays/{run_id}", path_params={"run_id": run_id})
    resp_rp = get_replay(req_rp)
    rp = json.loads(resp_rp.body.decode("utf-8"))
    rp_evs = rp.get("details", {}).get("events") or []
    rp_result = next(ev for ev in rp_evs if ev.get("kind") == "RESULT")
    rp_payload = rp_result.get("payload") or {}
    assert rp_payload.get("unresolvedObligations") == ["goal-main:answer", "goal-1:ATTAINMENT"]


def test_homepage_demo_mechanisms_configuration(tmp_path):
    """验证首页新建评委演示全机制时开启 R0、多专家共识、代数审查与条件修复配额 (Spec R3)."""
    from python.astra_web.contracts.dto import RunRequestDto
    from python.astra_web.queue import ExecutionManager

    app = create_app(data_root=tmp_path, mount_static=False, recover_orphans=False)
    store: Store = app.state.store
    manager: ExecutionManager = app.state.execution_manager

    # 模拟前端发送的评委演示全机制配置
    demo_body = {
        "problem": "整系数多项式完全平方判定定理",
        "engine": "ts",
        "max_model_calls": 32,
        "max_work_units": 4,
        "max_effects": 2,
        "max_reviews": 2,
        "max_method_loads": 1,
        "max_repairs": 1,
        "max_consensus": 1,
        "max_r0": 1,
    }

    # 经过官方 RunRequestDto 严格校验
    dto = RunRequestDto.model_validate(demo_body).model_dump()
    assert dto["max_r0"] == 1
    assert dto["max_consensus"] == 1
    assert dto["max_repairs"] == 1
    assert dto["max_reviews"] == 2
    assert dto["max_effects"] == 2

    # 真实队列入库与摘要保持
    run_id = manager.prepare_run(request=dto)
    run = store.get_run(run_id)
    summary = run["summary"]
    assert summary["max_r0"] == 1
    assert summary["max_consensus"] == 1
    assert summary["max_repairs"] == 1
    assert summary["max_reviews"] == 2
    assert summary["max_effects"] == 2


