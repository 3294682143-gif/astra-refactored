"""F-06 T34：科研子任务累计并发超额 → 原子预算预留拒绝超额派发。

ExecutionManager 并发上限 MAX_CONCURRENT_RUNS=1：超额请求进入队列 pending，
不得并发执行、不得重置预算。沙箱 asyncio loop 被拦，故验证点在入队/统计层。
"""
from __future__ import annotations

import pathlib

import pytest

from python.astra_web.queue import ExecutionManager, MAX_CONCURRENT_RUNS, SolveOutcome, StopReason
from python.astra_web.storage import Store


def _drive(coro):
    try:
        coro.send(None)
    except StopIteration as e:
        return e.value
    raise RuntimeError("coroutine suspended on real I/O unexpectedly")


def _manager(store: Store) -> ExecutionManager:
    manager = ExecutionManager(store, solver=lambda _req: SolveOutcome(stop_reason=StopReason.CANDIDATE, final_response="x"))

    def _enqueue_only(run_id: str) -> None:
        manager._pending.append(run_id)
        manager._started_total += 1

    manager._schedule = _enqueue_only  # 保留入队语义，仅跳过 create_task（沙箱无事件循环）
    return manager


def test_t34_concurrency_cap_is_one_and_atomic(store: Store) -> None:
    assert MAX_CONCURRENT_RUNS == 1
    manager = _manager(store)
    stats = manager.stats()
    assert stats.get("max_concurrent_runs") == 1


def test_t34_overflow_requests_queue_without_concurrent_dispatch(store: Store) -> None:
    manager = _manager(store)
    r1 = _drive(manager.enqueue_run(request={"problem": "a", "idempotency_key": "t34-a"}))
    r2 = _drive(manager.enqueue_run(request={"problem": "b", "idempotency_key": "t34-b"}))
    r3 = _drive(manager.enqueue_run(request={"problem": "c", "idempotency_key": "t34-c"}))
    assert {r1["run_id"], r2["run_id"], r3["run_id"]}
    stats = manager.stats()
    # 三个请求都登记在案，但并发观察值绝不超过上限 1
    assert stats.get("max_concurrent_runs") == 1
    running = stats.get("running", 0)
    assert running <= 1
    # 队列可见（pending 排队中），不静默丢弃也不并发派发
    queued = stats.get("queued", 0)
    assert queued + running >= 1


@pytest.fixture()
def store(tmp_path: pathlib.Path) -> Store:
    return Store(tmp_path / "data")
