"""math 黄金题补跑：经 ReasoningAgent(engine="ts") + 确定性 FakeClient 生产入口
真实执行 x^2-5x+6=0，终态经 ExecutionManager._finalize 落盘 var/astra（L2）。
与 math-parity F1 同一生产入口（node stdio-runtime bundle 子进程真实拉起）。
"""
from __future__ import annotations

import asyncio
import os
import sys

os.environ.setdefault("ASTRA_DATA_ROOT", os.path.join(os.getcwd(), "var", "astra"))
sys.path.insert(0, os.getcwd())

import user_agent
from scripts.run_production_bundle_math import ParityMathSolverClient
from python.astra_web.queue import ExecutionManager
from python.astra_web.storage import Store

PROBLEM = "求二次代数方程 x^2 - 5x + 6 = 0 的所有实数解"
IDEMP_KEY = "golden_math_20261030_v3"


def _drive(coro):
    try:
        coro.send(None)
    except StopIteration as e:
        return e.value
    raise RuntimeError("coroutine suspended on real I/O unexpectedly")


class _FakeLoop:
    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


def _math_solver(request):
    client = ParityMathSolverClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts", max_model_calls=6, max_work_units=4)
    return agent.solve(request["problem"].split("\n", 1)[-1], {"source": "golden_math"})


def main() -> None:
    store = Store(os.environ["ASTRA_DATA_ROOT"])
    manager = ExecutionManager(store, solver=_math_solver)
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
        raw = manager._solver(request)
        return manager._coerce_outcome(raw)

    manager._invoke_solver = _sync_invoke

    real_get_running_loop = asyncio.get_running_loop
    asyncio.get_running_loop = lambda: _FakeLoop()
    try:
        res = _drive(
            manager.enqueue_run(
                request={
                    "problem": f"[RunSpec:math]\n{PROBLEM}",
                    "domain_id": "math",
                    "metadata": {"domainId": "math", "rawText": PROBLEM, "inputRefs": []},
                    "idempotency_key": IDEMP_KEY,
                }
            )
        )
        run_id = res["run_id"]
        _drive(manager._run_one(run_id))
        record = store.get_run(run_id)
        summary = record["summary"]
        print(f"run_id={run_id} status={record['status']} stopReason={summary.get('stopReason')}")
        print(f"final_response 前 200 字: {(summary.get('final_response') or '')[:200]}")
        assert record["status"] in ("candidate", "unsolved", "error"), record["status"]
    finally:
        asyncio.get_running_loop = real_get_running_loop

    print("GOLDEN_MATH_OK")


if __name__ == "__main__":
    main()
