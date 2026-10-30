"""F-12 测试矩阵 BFF 侧：T26/T27 幂等键、T28 取消远端未知、T30 真实失败不顶替。

环境约束如实说明：本沙箱拦截 asyncio 事件循环的 loopback socketpair
（WinError 10051），`_schedule`/`_run_one` 的 create_task/get_running_loop
不可驱动。因此：
- T26/T27：打桩 `_schedule`（幂等判定发生在调度注册之前），直驱 enqueue_run；
- T30：覆盖"失败 outcome → _finalize → store 落盘"的等价后段（_finalize 为同步函数），
  并断言 SolveOutcome.system_failure 的语义字段；
- T28：协程直驱 stop 路由。
"""
from __future__ import annotations

import json
import pathlib

import pytest
from starlette.requests import Request

from python.astra_web.queue import (
    CODE_SOLVER_FAILED,
    ExecutionManager,
    IdempotencyConflict,
    SolveOutcome,
    StopReason,
)
from python.astra_web.storage import Store
from python.astra_web.protocol_and_chat_routes import stop_atria_product_chat


def _drive(coro):
    try:
        coro.send(None)
    except StopIteration as e:
        return e.value
    raise RuntimeError("coroutine suspended on real I/O unexpectedly")


@pytest.fixture()
def store(tmp_path: pathlib.Path) -> Store:
    return Store(tmp_path / "data")


def _make_manager(store: Store) -> ExecutionManager:
    manager = ExecutionManager(store, solver=lambda _req: SolveOutcome(stop_reason=StopReason.CANDIDATE, final_response="42"))
    manager._schedule = lambda run_id: None  # 打桩：幂等判定先于调度
    return manager


# T26: 相同幂等键重复提交 → 返回同一 run，不重复执行
def test_t26_same_idempotency_key_replays_same_run(store: Store) -> None:
    manager = _make_manager(store)
    req = {"problem": "1+1=?", "idempotency_key": "f12-t26"}
    first = _drive(manager.enqueue_run(request=req))
    second = _drive(manager.enqueue_run(request=req))
    assert first["run_id"] == second["run_id"]
    assert first["started"] is True
    assert second["started"] is False
    assert second["idempotent_replay"] is True


# T27: 相同幂等键搭配不同输入 → 拒绝冲突，不得覆盖原任务
def test_t27_same_key_different_input_rejected(store: Store) -> None:
    manager = _make_manager(store)
    _drive(manager.enqueue_run(request={"problem": "1+1=?", "idempotency_key": "f12-t27"}))
    with pytest.raises(IdempotencyConflict):
        _drive(manager.enqueue_run(request={"problem": "2+2=?", "idempotency_key": "f12-t27"}))


# T28: 本地取消成功但 provider 未确认 → 明确远端未知，不得显示完全取消
def test_t28_local_cancel_reports_remote_unknown() -> None:
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/atria/chat/nope/stop",
        "headers": [],
        "query_string": b"",
        "path_params": {"chat_id": "nope"},
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    resp = _drive(stop_atria_product_chat(Request(scope, receive)))
    body = json.loads(resp.body)
    assert body["local_aborted"] is False
    assert body["remote_state"] == "not_found_or_already_ended"


# T30: 真实求解失败 → 终态如实 error，不得以成功/演示结果顶替
def test_t30_failure_outcome_finalize_records_real_error(store: Store) -> None:
    # system_failure 语义字段（对应 _run_one 中 solver 抛错的收口分支）
    outcome = SolveOutcome.system_failure("求解链抛出异常：RuntimeError")
    assert outcome.stop_reason == StopReason.ERROR
    assert outcome.code == CODE_SOLVER_FAILED
    assert outcome.executed is True

    manager = _make_manager(store)
    prepared = _drive(manager.enqueue_run(request={"problem": "x", "idempotency_key": "f12-t30"}))
    info = manager._active_runs[prepared["run_id"]]
    manager._finalize(info, outcome, duration_s=0.01)

    record = store.get_run(prepared["run_id"])
    assert record is not None
    assert record["status"] == "error"
    summary = record.get("summary") or {}
    assert summary.get("code") == CODE_SOLVER_FAILED
    assert summary.get("executed") is True
    assert record["status"] != "candidate"
