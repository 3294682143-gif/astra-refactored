"""D-03 只读 BFF / 导入 / 存档 的测试套件。

覆盖：
1. 存储层 (storage.py): 初始化、安全路径拼接 safe_join 防穿越、SQLite 增删查、多条件过滤
2. 存档层 (archive.py): atomic_write_bytes / atomic_write_json 原子写与覆写
3. 重放导入层 (replays.py): L1/L2/L3 载荷校验、run_id 规则、多格式导入、JSONL 容错
4. BFF 接口层 (app.py): /api/health (不调用模型), /api/capabilities, /api/runs, /api/replays, /api/assets
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
import pytest

from python.astra_web.storage import (
    Store,
    PathTraversalError,
    DuplicateRunError,
    is_valid_run_id,
)
from python.astra_web.archive import atomic_write_bytes, atomic_write_json
from python.astra_web.replays import (
    ImportValidationError,
    normalize_run,
    import_json_bytes,
    import_jsonl_bytes,
)
from python.astra_web.app import (
    create_app,
    create_run,
    health,
    http_exception_handler,
    capabilities,
    list_runs,
    get_run,
    list_replays,
    get_replay,
    list_assets,
    download_asset,
)
from starlette.requests import Request
from starlette.exceptions import HTTPException


@pytest.fixture
def temp_store(tmp_path: Path) -> Store:
    return Store(root=tmp_path / "store")


def test_is_valid_run_id():
    assert is_valid_run_id("run-001") is True
    assert is_valid_run_id("abc.123_DEF-99") is True
    assert is_valid_run_id("../evil") is False
    assert is_valid_run_id("") is False
    assert is_valid_run_id(None) is False
    assert is_valid_run_id("/root") is False


def test_storage_safe_join(temp_store: Store):
    safe_path = temp_store.safe_join("runs/run-1/details.json")
    assert safe_path.is_relative_to(temp_store.root)

    with pytest.raises(PathTraversalError):
        temp_store.safe_join("../outside.txt")

    with pytest.raises(PathTraversalError):
        temp_store.safe_join("runs/../../outside.txt")


def test_archive_atomic_writes(tmp_path: Path):
    target = tmp_path / "test" / "file.json"
    data = {"hello": "world", "number": 123}
    atomic_write_json(target, data)
    assert target.is_file()
    assert json.loads(target.read_text(encoding="utf-8")) == data

    # 覆写
    atomic_write_bytes(target, b"new bytes")
    assert target.read_bytes() == b"new bytes"


def test_replays_normalize_run_valid():
    raw = {
        "run_id": "run-test-1",
        "created_at": 1700000000.0,
        "status": "ok",
        "scenario": "imo-2024-p1",
        "model": "deepseek-v4.1",
        "seed": 42,
        "duration_s": 12.5,
        "summary": {"answer": "x = 42", "candidate_verified": False},
        "details": [{"step": 1, "action": "factorize"}],
        "artifacts": [{"name": "diagram.txt", "text": "A---B"}],
        "tags": ["math", "algebra"],
    }
    norm = normalize_run(raw, source="test")
    assert norm["run_id"] == "run-test-1"
    assert norm["status"] == "ok"
    assert norm["scenario"] == "imo-2024-p1"
    assert norm["summary"]["candidate_verified"] is False
    assert norm["checksum"] is not None


def test_replays_normalize_run_rejects_missing_l1():
    with pytest.raises(ImportValidationError, match="missing L1 payload"):
        normalize_run({"run_id": "run-x", "created_at": 100.0}, source="test")


def test_replays_import_json_and_duplicate(temp_store: Store):
    sample = {
        "run_id": "run-import-1",
        "status": "ok",
        "scenario": "test-scenario",
        "summary": {"status": "candidate", "candidate_verified": False},
        "details": {"steps": [1, 2, 3]},
        "artifacts": [
            {"name": "output.txt", "text": "sample text"},
            {"name": "data.bin", "data_base64": "SGVsbG8gV29ybGQ="},
        ],
    }
    res = import_json_bytes(temp_store, json.dumps(sample).encode("utf-8"))
    assert res["run_id"] == "run-import-1"
    assert res["assets"] == 2
    assert temp_store.has_run("run-import-1")

    # 查运行
    run = temp_store.get_run("run-import-1")
    assert run is not None
    assert run["scenario"] == "test-scenario"
    assert run["l2_path"] is not None

    # 重复导入默认抛错
    with pytest.raises(ImportValidationError, match="duplicate run_id"):
        import_json_bytes(temp_store, json.dumps(sample).encode("utf-8"))

    # overwrite=True 成功
    res_overwrite = import_json_bytes(
        temp_store, json.dumps(sample).encode("utf-8"), overwrite=True
    )
    assert res_overwrite["run_id"] == "run-import-1"


def test_replays_import_jsonl(temp_store: Store):
    line1 = json.dumps({"run_id": "run-l1", "summary": {"val": 1}})
    line2 = "# comment line"
    line3 = json.dumps({"run_id": "run-l2", "summary": {"val": 2}})
    blob = f"{line1}\n{line2}\n\n{line3}\n".encode("utf-8")

    res = import_jsonl_bytes(temp_store, blob)
    assert len(res) == 2
    assert res[0]["run_id"] == "run-l1"
    assert res[1]["run_id"] == "run-l2"


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


def test_bff_health_endpoint(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)
    req = _make_dummy_request(app, path="/api/health")
    resp = health(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["status"] == "ok"
    assert data["service"] == "astra-web-bff"
    assert data["model_invoked"] is False  # 红线：严格禁止调用模型


def test_bff_capabilities_endpoint(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)
    req = _make_dummy_request(app, path="/api/capabilities")
    resp = capabilities(req)
    assert resp.status_code == 200
    data = json.loads(resp.body.decode("utf-8"))
    assert data["execution_queue"] is True
    assert data["sse_streaming"] is True
    assert data["model_invoked"] is False
    assert "/api/runs" in data["routes"]


def test_bff_runs_and_replays_endpoints(temp_store: Store):
    app = create_app(data_root=temp_store.root, mount_static=False)

    # 导入数据
    run_payload = {
        "run_id": "run-bff-01",
        "scenario": "geometry",
        "summary": {"score": 100},
        "details": {"nodes": ["A", "B"]},
        "artifacts": [{"name": "proof.txt", "text": "QED"}],
    }
    import_json_bytes(temp_store, json.dumps(run_payload).encode("utf-8"))

    # GET /api/runs
    req = _make_dummy_request(app, path="/api/runs", query_params={"limit": 10})
    resp = list_runs(req)
    assert resp.status_code == 200
    runs_data = json.loads(resp.body.decode("utf-8"))
    assert runs_data["count"] == 1
    assert runs_data["items"][0]["run_id"] == "run-bff-01"

    # GET /api/runs/{run_id}
    req = _make_dummy_request(app, path="/api/runs/run-bff-01", path_params={"run_id": "run-bff-01"})
    resp = get_run(req)
    assert resp.status_code == 200
    run_detail = json.loads(resp.body.decode("utf-8"))
    assert run_detail["run_id"] == "run-bff-01"
    assert len(run_detail["assets"]) == 1

    # GET /api/replays
    req = _make_dummy_request(app, path="/api/replays")
    resp = list_replays(req)
    assert resp.status_code == 200
    replays_data = json.loads(resp.body.decode("utf-8"))
    assert replays_data["count"] == 1

    # GET /api/replays/{run_id}
    req = _make_dummy_request(app, path="/api/replays/run-bff-01", path_params={"run_id": "run-bff-01"})
    resp = get_replay(req)
    assert resp.status_code == 200
    replay_detail = json.loads(resp.body.decode("utf-8"))
    assert replay_detail["details"] == {"nodes": ["A", "B"]}

    # GET /api/assets
    req = _make_dummy_request(app, path="/api/assets")
    resp = list_assets(req)
    assets_data = json.loads(resp.body.decode("utf-8"))
    assert assets_data["count"] == 1

    # GET /api/assets/{asset_id}
    asset_id = assets_data["items"][0]["asset_id"]
    req = _make_dummy_request(app, path=f"/api/assets/{asset_id}", path_params={"asset_id": asset_id})
    resp = download_asset(req)
    assert resp.status_code == 200


def test_bff_static_dist_mount(tmp_path: Path):
    dist_dir = tmp_path / "web_dist"
    dist_dir.mkdir()
    index_html = dist_dir / "index.html"
    index_html.write_text("<!DOCTYPE html><html><body>Astra UI</body></html>", encoding="utf-8")

    app = create_app(data_root=tmp_path / "data", web_dist=dist_dir, mount_static=True)
    assert app.state.web_dist == dist_dir
    # 验证路由表中已挂载静态资源与 favicon
    route_names = [r.name for r in app.routes if hasattr(r, "name")]
    assert "web" in route_names

    # 验证 favicon 接口
    from python.astra_web.app import favicon
    fav_req = _make_dummy_request(app, path="/favicon.ico")
    fav_resp = favicon(fav_req)
    assert fav_resp.status_code == 200

    # 验证 MIME 类型已修复（Windows 注册表安全防御）
    import mimetypes
    assert mimetypes.guess_type("bundle.js")[0] == "application/javascript"
    assert mimetypes.guess_type("module.mjs")[0] == "application/javascript"


def test_validate_run_request():
    from python.astra_web.queue import validate_run_request, ValidationError

    # 合法请求
    valid = validate_run_request({
        "problem": "证明质数有无穷多个",
        "max_model_calls": 20,
        "max_method_loads": 1,
    })
    assert valid["problem"] == "证明质数有无穷多个"
    assert valid["max_method_loads"] == 1

    # 允许 0
    valid0 = validate_run_request({"problem": "test", "max_method_loads": 0})
    assert valid0["max_method_loads"] == 0

    # 严禁使用布尔型冒充数字 1
    with pytest.raises(ValidationError, match="boolean is forbidden"):
        validate_run_request({"problem": "test", "max_method_loads": True})

    # 严禁超出 {0, 1}
    with pytest.raises(ValidationError, match="exactly 0 or 1"):
        validate_run_request({"problem": "test", "max_method_loads": 2})

    # 严禁空问题
    with pytest.raises(ValidationError, match="non-empty string"):
        validate_run_request({"problem": "   "})


def test_execution_manager_prepare_and_events(temp_store: Store):
    from python.astra_web.queue import ExecutionManager

    manager = ExecutionManager(temp_store)
    run_id = manager.prepare_run(
        problem="构造任意阶幻方",
        max_model_calls=12,
        max_method_loads=0,
    )
    assert run_id.startswith("run-")
    assert manager.is_active(run_id)

    # 初始状态已入库
    saved = temp_store.get_run(run_id)
    assert saved is not None
    assert saved["status"] == "running"
    assert saved["summary"]["candidate_verified"] is False  # 红线

    # 追加事件
    manager.append_event_sync(run_id, {
        "seq": 1,
        "kind": "SESSION_INIT",
        "payload": {"sessionId": run_id},
    })
    manager.append_event_sync(run_id, {
        "seq": 2,
        "kind": "FINAL",
        "payload": {"answer": "x=1", "candidate_verified": False},
    })

    history = manager.get_history_events(run_id)
    assert len(history) == 2
    assert history[0]["seq"] == 1
    assert history[1]["seq"] == 2




# ===========================================================================
# t1 回归判据：后端保真与队列（去演示冒充 / 终态 / 幂等 / 串行）
# ===========================================================================

def test_no_real_solver_returns_explicit_not_executed_state(temp_store: Store):
    """未接线真实求解入口时：显式未执行态，绝不伪造 official_result / 固定答案。"""
    from python.astra_web.queue import ExecutionManager

    manager = ExecutionManager(temp_store)  # 未接线真实求解链
    assert manager.solver_configured is False

    async def scenario():
        r1 = await manager.enqueue_run(problem="证明质数有无穷多个", engine="ts")
        r2 = await manager.enqueue_run(problem="求所有满足 x^2 = 4 的整数", engine="ts")
        assert await manager.wait_idle(10.0)
        return r1, r2

    r1, r2 = asyncio.run(scenario())
    assert r1["run_id"] != r2["run_id"]

    for rid in (r1["run_id"], r2["run_id"]):
        run = temp_store.get_run(rid)
        assert run is not None
        summary = run["summary"]

        # 终态：system-failure（显式未执行），绝不显示为 candidate
        assert run["status"] == "error"
        assert summary["status"] == "error"
        assert summary["candidate_verified"] is False
        # final_response 不丢失，按官方契约给 Unsolved. 且带 stopReason
        assert summary["final_response"] == "Unsolved."
        assert summary["stopReason"] == "ERROR"
        assert summary["terminalKind"] == "system_failure"
        assert summary["executed"] is False
        assert summary["code"] == "SOLVER_NOT_CONFIGURED"

        # 不得生成任何伪造事件（尤其不得把演示数据标为 official_result）
        assert manager.get_history_events(rid) == []

    # 不得内置答案表：两个不同题目都不得吐出任何"固定答案"文本
    blob = json.dumps([temp_store.get_run(r1["run_id"])["summary"],
                       temp_store.get_run(r2["run_id"])["summary"]], ensure_ascii=False)
    assert "official_result" not in blob


def test_events_never_fabricated_official_result(temp_store: Store):
    """真实求解链之外不得产生 sourceKind=official_result 的事件。"""
    from python.astra_web.queue import ExecutionManager

    manager = ExecutionManager(temp_store)

    async def scenario():
        r = await manager.enqueue_run(problem="任意题目", engine="ts", idempotency_key="no-fabrication")
        assert await manager.wait_idle(10.0)
        return r

    r = asyncio.run(scenario())
    history = manager.get_history_events(r["run_id"])
    assert history == []
    assert all(ev.get("sourceKind") != "official_result" for ev in history)

    # L2 存档不得凭空存在（没有真实事件就没有详细存档）
    assert temp_store.get_run(r["run_id"])["l2_path"] is None


def test_terminal_kind_mapping_covers_four_buckets():
    """math-unsolved / budget-timeout / system-failure / cancelled 四类必须可判别。"""
    from python.astra_web.contracts.enums import StopReason, TerminalKind
    from python.astra_web.contracts.mapping import classify_stop_reason, classify_terminal_kind

    cases = {
        StopReason.NO_CANDIDATE: (TerminalKind.MATH_UNSOLVED, "unsolved"),
        StopReason.MAX_ITER: (TerminalKind.MATH_UNSOLVED, "unsolved"),
        StopReason.TIMEOUT: (TerminalKind.BUDGET_TIMEOUT, "unsolved"),
        StopReason.DEADLINE_EXCEEDED: (TerminalKind.BUDGET_TIMEOUT, "unsolved"),
        StopReason.BUDGET_EXHAUSTED: (TerminalKind.BUDGET_TIMEOUT, "unsolved"),
        StopReason.SPAWN_FAILED: (TerminalKind.SYSTEM_FAILURE, "error"),
        StopReason.CHILD_FAILED: (TerminalKind.SYSTEM_FAILURE, "error"),
        StopReason.ERROR: (TerminalKind.SYSTEM_FAILURE, "error"),
        StopReason.CANCELLED: (TerminalKind.CANCELLED, "aborted"),
    }
    for reason, (kind, status) in cases.items():
        assert classify_terminal_kind(reason) == kind, reason
        assert classify_stop_reason(reason).value == status, reason
        assert status != "candidate"

    # 候选型 stopReason 不属于四类异常收口
    assert classify_terminal_kind(StopReason.REVIEWS_COMPLETE) is None
    assert classify_stop_reason(StopReason.REVIEWS_COMPLETE).value == "candidate"


def test_terminal_records_preserve_final_response_and_never_candidate(temp_store: Store):
    """真实终态（超时/启动失败/取消/未解）落库后与 candidate 可区分，且保留 final_response。"""
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.queue import ExecutionManager, SolveOutcome

    cases = [
        ("math", StopReason.NO_CANDIDATE, "unsolved", "math_unsolved"),
        ("timeout", StopReason.DEADLINE_EXCEEDED, "unsolved", "budget_timeout"),
        ("spawn", StopReason.SPAWN_FAILED, "error", "system_failure"),
        ("cancel", StopReason.CANCELLED, "aborted", "cancelled"),
    ]

    for label, reason, expected_status, expected_kind in cases:
        outcome = SolveOutcome(
            stop_reason=reason,
            final_response="Unsolved.",
            reason=f"{label} terminal",
            code=f"CODE_{label.upper()}",
            executed=True,
        )
        manager = ExecutionManager(temp_store, solver=lambda request, o=outcome: o)

        async def go(m=manager, l=label):
            r = await m.enqueue_run(problem=f"题目-{l}", engine="ts", idempotency_key=f"terminal-{l}")
            assert await m.wait_idle(10.0)
            return r

        r = asyncio.run(go())
        run = temp_store.get_run(r["run_id"])
        summary = run["summary"]

        assert run["status"] == expected_status
        assert run["status"] != "candidate"
        assert summary["terminalKind"] == expected_kind
        assert summary["final_response"] == "Unsolved."
        assert summary["stopReason"] == reason.value
        assert summary["candidate_verified"] is False


def test_idempotent_key_starts_execution_once(temp_store: Store):
    """同一幂等键只启动一次执行；重复提交返回同一 runId 与既有状态。"""
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.queue import ExecutionManager, SolveOutcome

    calls = []

    def solver(request):
        calls.append(request["run_id"])
        return SolveOutcome(stop_reason=StopReason.NO_CANDIDATE, final_response="Unsolved.", reason="no candidate")

    manager = ExecutionManager(temp_store, solver=solver)

    async def duplicate_while_running():
        a = await manager.enqueue_run(problem="并发重复提交", engine="ts", idempotency_key="idem-concurrent")
        b = await manager.enqueue_run(problem="并发重复提交", engine="ts", idempotency_key="idem-concurrent")
        assert a["run_id"] == b["run_id"]
        assert a["started"] is True
        assert b["started"] is False and b["idempotent_replay"] is True
        assert await manager.wait_idle(10.0)
        return a, b

    a, b = asyncio.run(duplicate_while_running())
    assert calls == [a["run_id"]]  # 只启动了一次执行

    async def duplicate_after_terminal():
        first = await manager.enqueue_run(problem="同键重放", engine="ts", idempotency_key="idem-replay")
        assert first["started"] is True
        assert await manager.wait_idle(10.0)
        second = await manager.enqueue_run(problem="同键重放", engine="ts", idempotency_key="idem-replay")
        third = await manager.enqueue_run(problem="换了题面但同键", engine="ts", idempotency_key="idem-replay")
        assert await manager.wait_idle(10.0)
        return first, second, third

    first, second, third = asyncio.run(duplicate_after_terminal())
    assert first["run_id"] == second["run_id"] == third["run_id"]
    assert second["idempotent_replay"] is True and second["started"] is False
    assert third["started"] is False
    assert second["status"] == "unsolved"   # 既有状态原样返回
    assert second["terminal"] is True
    assert calls == [a["run_id"], first["run_id"]]  # 仍只各启动一次
    assert manager.stats()["started_total"] == 2


def test_terminal_record_is_immutable(temp_store: Store):
    """终态记录不可被覆盖：任何后续写入都必须保持原终态与原文。"""
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.queue import ExecutionManager, SolveOutcome

    manager = ExecutionManager(
        temp_store,
        solver=lambda request: SolveOutcome(stop_reason=StopReason.NO_CANDIDATE, final_response="Unsolved.", reason="no candidate"),
    )

    async def go():
        r = await manager.enqueue_run(problem="不可覆盖", engine="ts", idempotency_key="immutable-1")
        assert await manager.wait_idle(10.0)
        return r["run_id"]

    run_id = asyncio.run(go())
    before = temp_store.get_run(run_id)
    assert before["status"] == "unsolved"

    forged = {
        "run_id": run_id,
        "created_at": before["created_at"],
        "source": "worker",
        "status": "candidate",
        "scenario": "forged",
        "model": None,
        "seed": None,
        "duration_s": 0.0,
        "summary_json": json.dumps({"status": "candidate", "final_response": "4", "candidate_verified": False}),
        "l2_path": None,
        "l3_path": None,
        "tags": "",
        "checksum": None,
    }
    assert temp_store.save_run_terminal(forged) is False

    after = temp_store.get_run(run_id)
    assert after["status"] == "unsolved"
    assert after["summary"] == before["summary"]

    # prepare_run 也不得改写既有终态
    assert manager.prepare_run("另一个题目", run_id=run_id) == run_id
    assert temp_store.get_run(run_id)["summary"] == before["summary"]

    # 同键重复提交不重跑、不覆盖
    async def again():
        return await manager.enqueue_run(problem="不可覆盖", engine="ts", idempotency_key="immutable-1")

    r2 = asyncio.run(again())
    assert r2["idempotent_replay"] is True and r2["started"] is False
    assert temp_store.get_run(run_id)["summary"] == before["summary"]


def test_queue_enforces_single_concurrency_and_is_observable(temp_store: Store):
    """并发上限强制 1：执行从不并行，且经 stats() 可观测。"""
    import threading
    from python.astra_web.contracts.enums import StopReason
    from python.astra_web.queue import ExecutionManager, SolveOutcome

    lock = threading.Lock()
    state = {"inflight": 0, "max": 0, "order": []}

    def solver(request):
        with lock:
            state["inflight"] += 1
            state["max"] = max(state["max"], state["inflight"])
            state["order"].append(request["run_id"])
        time.sleep(0.05)
        with lock:
            state["inflight"] -= 1
        return SolveOutcome(stop_reason=StopReason.NO_CANDIDATE, final_response="Unsolved.", reason="no candidate")

    manager = ExecutionManager(temp_store, solver=solver)
    assert manager.max_concurrent == 1
    assert manager.stats()["max_concurrent_runs"] == 1

    async def go():
        rids = []
        for i in range(3):
            r = await manager.enqueue_run(problem=f"并发题-{i}", engine="ts", idempotency_key=f"conc-{i}")
            rids.append(r["run_id"])
        assert await manager.wait_idle(20.0)
        return rids

    rids = asyncio.run(go())
    assert state["max"] == 1                                   # 求解链从未并行
    assert state["order"] == rids                              # 串行且保持入队顺序
    assert manager.stats()["max_observed_concurrency"] == 1
    assert manager.stats()["running"] == 0 and manager.stats()["queued"] == 0
    for rid in rids:
        assert temp_store.get_run(rid)["status"] == "unsolved"


def test_run_detail_level_comes_from_real_artifacts(temp_store: Store):
    """详情级别由真实存档推导：L1 不得默认标 L3；缺记录显式 404。"""
    app = create_app(data_root=temp_store.root, mount_static=False)

    # 运行记录不存在 → 显式 404（不回落演示数据）
    req = _make_dummy_request(app, path="/api/runs/nope", path_params={"run_id": "nope"})
    with pytest.raises(HTTPException) as excinfo:
        get_run(req)
    assert excinfo.value.status_code == 404

    # 仅 L1 摘要 → L1
    import_json_bytes(temp_store, json.dumps({"run_id": "lvl-l1", "summary": {"status": "candidate"}}).encode("utf-8"))
    req = _make_dummy_request(app, path="/api/runs/lvl-l1", path_params={"run_id": "lvl-l1"})
    detail = json.loads(get_run(req).body.decode("utf-8"))
    assert detail["detail_level"] == "L1"

    # 有真实 L2 存档 → L2
    import_json_bytes(temp_store, json.dumps({
        "run_id": "lvl-l2", "summary": {"status": "candidate"}, "details": {"events": []},
    }).encode("utf-8"))
    req = _make_dummy_request(app, path="/api/runs/lvl-l2", path_params={"run_id": "lvl-l2"})
    detail = json.loads(get_run(req).body.decode("utf-8"))
    assert detail["detail_level"] == "L2"

    # 有真实 L3 附件 → L3
    import_json_bytes(temp_store, json.dumps({
        "run_id": "lvl-l3", "summary": {"status": "candidate"},
        "artifacts": [{"name": "proof.txt", "text": "QED"}],
    }).encode("utf-8"))
    req = _make_dummy_request(app, path="/api/runs/lvl-l3", path_params={"run_id": "lvl-l3"})
    detail = json.loads(get_run(req).body.decode("utf-8"))
    assert detail["detail_level"] == "L3"


def test_capabilities_and_health_expose_queue_truth(temp_store: Store):
    """能力/健康接口如实暴露队列与求解端口状态（不夸大能力）。"""
    app = create_app(data_root=temp_store.root, mount_static=False)

    cap = json.loads(capabilities(_make_dummy_request(app, path="/api/capabilities")).body.decode("utf-8"))
    execution = cap["execution"]
    assert execution["max_concurrent_runs"] == 1
    assert execution["solver_configured"] is False
    assert execution["fabricated_events"] is False
    assert cap["cancellation_supported"] is False

    hc = json.loads(health(_make_dummy_request(app, path="/api/health")).body.decode("utf-8"))
    assert hc["status"] == "ok"
    assert hc["model_invoked"] is False
    assert hc["execution"]["max_concurrent_runs"] == 1


def _make_json_request(app, path, payload, headers=()):
    """构造带真实 receive 通道的 POST 请求（供 await request.json() 使用）。"""
    raw = json.dumps(payload).encode("utf-8")
    scope = {
        "type": "http",
        "app": app,
        "method": "POST",
        "path": path,
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers],
        "path_params": {},
    }
    state = {"sent": False}

    async def receive():
        if state["sent"]:
            return {"type": "http.disconnect"}
        state["sent"] = True
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request(scope, receive=receive)


def test_create_run_response_is_idempotent_and_never_fabricates(temp_store: Store):
    """POST /api/runs：首次 201；同幂等键重放 200 且返回同一 runId 与既有状态。"""
    app = create_app(data_root=temp_store.root, mount_static=False)
    manager = app.state.execution_manager
    body = {"problem": "证明 sqrt(2) 是无理数", "engine": "ts"}
    idem = (("Idempotency-Key", "create-idem-1"),)

    async def submit_twice():
        first = await create_run(_make_json_request(app, "/api/runs", body, idem))
        assert await manager.wait_idle(10.0)
        second = await create_run(_make_json_request(app, "/api/runs", body, idem))
        return first, second

    first, second = asyncio.run(submit_twice())
    assert first.status_code == 201
    assert second.status_code == 200
    first_body = json.loads(first.body.decode("utf-8"))
    second_body = json.loads(second.body.decode("utf-8"))
    assert first_body["run_id"] == second_body["run_id"]
    assert first_body["started"] is True
    assert second_body["idempotent_replay"] is True and second_body["started"] is False
    assert second_body["status"] == "error"      # 未接线求解入口 → 显式未执行态

    # 库里是真话：没有候选答案、没有伪造事件
    stored = temp_store.get_run(first_body["run_id"])
    assert stored["status"] == "error"
    assert stored["summary"]["final_response"] == "Unsolved."
    assert stored["summary"]["executed"] is False
    assert stored["summary"]["code"] == "SOLVER_NOT_CONFIGURED"
    assert manager.get_history_events(first_body["run_id"]) == []
    assert manager.stats()["started_total"] == 1

def test_store_refuses_to_clobber_terminal_run_without_explicit_optin(temp_store: Store):
    """存储层终态保护：overwrite=True 也不得静默改写终态行，需显式 opt-in。"""
    record = {
        "run_id": "immutable-store-1",
        "created_at": 1700000000.0,
        "source": "worker",
        "status": "unsolved",
        "scenario": "terminal",
        "model": None,
        "seed": None,
        "duration_s": 1.0,
        "summary_json": json.dumps({"status": "unsolved", "final_response": "Unsolved.", "stopReason": "NO_CANDIDATE"}),
        "l2_path": None,
        "l3_path": None,
        "tags": "",
        "checksum": None,
    }
    temp_store.save_run(record, overwrite=False)
    assert temp_store.get_run("immutable-store-1")["status"] == "unsolved"

    forged = dict(record)
    forged["status"] = "candidate"
    forged["summary_json"] = json.dumps({"status": "candidate", "final_response": "4"})

    with pytest.raises(DuplicateRunError):
        temp_store.save_run(forged, overwrite=True)
    assert temp_store.get_run("immutable-store-1")["status"] == "unsolved"

    # 显式 opt-in（离线重放导入的刻意覆盖）才允许替换
    temp_store.save_run(forged, overwrite=True, allow_terminal_replace=True)
    assert temp_store.get_run("immutable-store-1")["status"] == "candidate"

def test_json_responses_declare_utf8_charset(temp_store: Store):
    """回归护栏：JSON 响应必须显式声明 charset=utf-8。

    端侧（如 PowerShell 5.1）在 Content-Type 无 charset 时会按系统 ANSI/GBK
    解释响应体，中文即显示为 ``BFF æª...`` 乱码。本判据覆盖 /api/health、
    /api/capabilities、/api/runs、/api/replays、/api/assets、运行详情与 404 错误体，
    并断言含中文字段的响应在 UTF-8 解码后完整可读。
    """
    app = create_app(data_root=temp_store.root, mount_static=False)
    manager = app.state.execution_manager

    async def go():
        r = await manager.enqueue_run(
            problem="中文题目：证明 sqrt(2) 是无理数",
            engine="ts",
            idempotency_key="charset-regression-1",
        )
        assert await manager.wait_idle(10.0)
        return r

    run_id = asyncio.run(go())["run_id"]

    responses = {
        "health": health(_make_dummy_request(app, path="/api/health")),
        "capabilities": capabilities(_make_dummy_request(app, path="/api/capabilities")),
        "list_runs": list_runs(_make_dummy_request(app, path="/api/runs", query_params={"limit": 5})),
        "list_replays": list_replays(_make_dummy_request(app, path="/api/replays")),
        "list_assets": list_assets(_make_dummy_request(app, path="/api/assets")),
        "get_run": get_run(_make_dummy_request(
            app, path=f"/api/runs/{run_id}", path_params={"run_id": run_id})),
    }
    for name, resp in responses.items():
        content_type = resp.headers.get("content-type", "")
        assert "application/json" in content_type.lower(), (name, content_type)
        assert "charset=utf-8" in content_type.lower(), (name, content_type)

    # 含中文字段的响应：UTF-8 解码后中文完整可读（无替换字符 U+FFFD）
    for name in ("get_run", "list_runs"):
        body = json.loads(responses[name].body.decode("utf-8"))
        obj = body if name == "get_run" else body["items"][0]
        reason = obj["summary"]["reason"]
        assert "未执行" in reason, (name, reason)
        assert "\ufffd" not in reason, (name, reason)
        assert any("\u4e00" <= ch <= "\u9fff" for ch in reason), (name, reason)

    # 404 错误体同为 JSON：同样声明 charset，且状态码/响应体语义不变
    req404 = _make_dummy_request(
        app, path="/api/runs/absent-charset", path_params={"run_id": "absent-charset"})
    with pytest.raises(HTTPException) as excinfo:
        get_run(req404)
    assert excinfo.value.status_code == 404
    err = http_exception_handler(req404, excinfo.value)
    assert err.status_code == 404
    assert "charset=utf-8" in err.headers.get("content-type", "").lower()
    assert json.loads(err.body.decode("utf-8")) == {"detail": "run not found"}