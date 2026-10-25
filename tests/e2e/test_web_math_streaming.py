from __future__ import annotations

import asyncio
import json

from python.astra_web.config import default_budget
from python.astra_web.queue import ExecutionManager
from python.astra_web.solver_adapter import SolverAdapter
from python.astra_web.storage import Store
from tests.web_math_helpers import MathAssetScriptedClient


def test_real_events_reach_subscriber_and_replay_without_recompute(tmp_path):
    client = MathAssetScriptedClient(
        "math.linear-algebra", "gf2_rank", {"rows": [1, 2]}
    )
    manager = ExecutionManager(
        Store(root=tmp_path / "store"),
        solver=SolverAdapter(client_factory=lambda: client),
    )
    request = {
        "problem": "求 GF(2) 上矩阵的秩",
        "engine": "ts",
        "metadata": {},
        **default_budget(),
    }

    async def scenario():
        run_id = manager.prepare_run(request=request)
        queue = manager.subscribe(run_id)
        manager._schedule(run_id)
        live = []
        while True:
            event = await asyncio.wait_for(queue.get(), timeout=20.0)
            if event.get("kind") == "close":
                break
            live.append(event)
        assert await manager.wait_idle(20.0)
        history = manager.get_history_events(run_id)
        again = manager.get_history_events(run_id)
        run = manager.store.get_run(run_id)
        return run_id, live, history, again, run

    run_id, live, history, again, run = asyncio.run(scenario())
    kinds = [row["kind"] for row in live]
    assert "model_dispatched" in kinds
    assert "effect_returned" in kinds
    assert history == again == list(history)
    assert [row["seq"] for row in history] == list(range(1, len(history) + 1))
    assert all(row["runId"] == run_id for row in history)
    # 观测事件一律 observed_archive；只有最后那条权威终态允许 official_result。
    assert all(
        row["sourceKind"] == "observed_archive" for row in history[:-1]
    )
    assert history[-1]["kind"] == "RESULT"
    assert history[-1]["sourceKind"] == "official_result"
    assert any(row["kind"] == "effect_returned" for row in history)
    assert run is not None and run["l2_path"]
    l2 = json.loads(manager.store.safe_join(run["l2_path"]).read_text(encoding="utf-8"))
    assert l2["events"] == history
    assert client.turn >= 2
    turns_after = client.turn
    manager.get_history_events(run_id)
    assert client.turn == turns_after


def test_sse_last_event_id_replays_only_missing_events_without_recompute(tmp_path):
    from types import SimpleNamespace

    from python.astra_web.app import sse_events

    def fake(_request):
        return {
            "status": "candidate",
            "stopReason": "REVIEWS_COMPLETE",
            "final_response": "x=1",
            "candidate_verified": False,
            "executed": True,
            "childReaped": True,
        }

    manager = ExecutionManager(Store(root=tmp_path / "store"), solver=fake)
    run_id = manager.prepare_run(request={
        "problem": "任意题目",
        "engine": "ts",
        "metadata": {},
        **default_budget(),
    })
    manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"n": 1}})
    manager.append_event_sync(run_id, {"kind": "model_returned", "payload": {"n": 2}})
    manager.append_event_sync(run_id, {"kind": "effect_returned", "payload": {"n": 3}})

    async def scenario():
        manager._schedule(run_id)
        assert await manager.wait_idle(10.0)
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(
                store=manager.store,
                execution_manager=manager,
            )),
            path_params={"run_id": run_id},
            headers={"Last-Event-ID": "1"},
            query_params={},
        )
        response = await sse_events(request)
        chunks = [chunk async for chunk in response.body_iterator]
        return "".join(chunks)

    body = asyncio.run(scenario())
    assert "id: 1" not in body
    assert "id: 2" in body and "id: 3" in body
    assert "event: close" in body
    # A reconnect replays stored events; it never starts a second solve.
    assert len([row for row in manager.get_history_events(run_id) if row["kind"] == "effect_returned"]) == 1
