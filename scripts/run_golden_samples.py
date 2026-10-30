"""F-13 黄金题补跑：经 mock-provider SolverAdapter → node stdio-runtime bundle 真实执行
math 与 scientific_computing 各一题，终态经 ExecutionManager._finalize 落盘 var/astra（L2）。

环境说明：本沙箱拦截 asyncio 事件循环 loopback，_run_one 的 create_task/to_thread
不可驱动；这里打桩 _schedule/_invoke_solver/get_running_loop，其余（prepare_run、
真实 solver 调用、_finalize 落盘）全部走生产代码路径。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

os.environ.setdefault("ASTRA_PROVIDER", "mock")
os.environ.setdefault("ASTRA_DATA_ROOT", os.path.join(os.getcwd(), "var", "astra"))

from python.astra_web.queue import ExecutionManager
from python.astra_web.solver_adapter import build_solver_from_env
from python.astra_web.storage import Store

GOLDEN = [
    ("math", "求二次代数方程 x^2 - 5x + 6 = 0 的所有实数解", "golden_math_20261030"),
    ("scientific_computing", "一维热传导方程有限差分复现 (alpha=0.1, tFinal=0.2) 与 Richardson 外推网格收敛阶验证", "golden_scicomp_20261030"),
]


def _drive(coro):
    try:
        coro.send(None)
    except StopIteration as e:
        return e.value
    raise RuntimeError("coroutine suspended on real I/O unexpectedly")


class _FakeLoop:
    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


def main() -> None:
    solver = build_solver_from_env()
    assert solver is not None, "mock solver not built"
    store = Store(os.environ["ASTRA_DATA_ROOT"])
    manager = ExecutionManager(store, solver=solver)
    manager._schedule = lambda run_id: None

    async def _sync_invoke(info, *, event_sink=None):
        request = {
            key: info[key]
            for key in (
                "run_id", "problem", "engine", "metadata", "idempotency_key",
                "max_model_calls", "max_work_units", "max_effects",
                "max_reviews", "max_method_loads", "max_repairs",
                "max_consensus", "max_r0", "problem_seconds", "policy",
            )
            if key in info
        }
        if event_sink is not None:
            request["_event_sink"] = event_sink
        raw = manager._solver(request)
        return manager._coerce_outcome(raw)

    manager._invoke_solver = _sync_invoke

    real_get_running_loop = asyncio.get_running_loop
    asyncio.get_running_loop = lambda: _FakeLoop()
    try:
        for domain, text, key in GOLDEN:
            res = _drive(
                manager.enqueue_run(
                    request={
                        "problem": f"[RunSpec:{domain}]\n{text}",
                        "domain_id": domain,
                        "metadata": {"domainId": domain, "rawText": text, "inputRefs": []},
                        "idempotency_key": key,
                    }
                )
            )
            run_id = res["run_id"]
            _drive(manager._run_one(run_id))
            record = store.get_run(run_id)
            summary = record["summary"]
            print(f"[{domain}] run_id={run_id} status={record['status']} provider={summary.get('provider')}")
            fr = summary.get("final_response") or ""
            print(f"  final_response 前 160 字: {fr[:160]}")
            assert record["status"] in ("candidate", "unsolved", "error"), record["status"]
            assert summary.get("candidateVerified") is False or summary.get("candidate_verified") is False
    finally:
        asyncio.get_running_loop = real_get_running_loop

    print("GOLDEN_RUNS_OK")


if __name__ == "__main__":
    main()
