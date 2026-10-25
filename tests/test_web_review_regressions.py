"""回归测试：第二轮独立复核的四个边界缺陷（R1–R4）。

每个类对应复核报告里的一条可复现边界，命名固定为 ``R1..R4``，便于单独运行：

    python3 -m pytest -q tests/test_web_review_regressions.py
    python3 -m pytest -q tests/test_web_review_regressions.py -k R2

这些用例**不依赖** Node 运行时、Starlette、httpx 或浏览器：

* R1 / R2 / R3 只用 `ExecutionManager` + `Store`（stdlib sqlite3）；
* R4 只用 `PublicChatPort` + `AgentClient`（模块级 HTTP 传输不参与）。

R1 PID 复用
   只判断 ``os.kill(pid, 0)`` 会被内核的 pid 回收骗过：死进程的 pid 被新进程接管后，
    遗留运行会被永久认作「属主还活着」，永远无法恢复。修复要求核验进程*实例*身份。

R2 终态落盘中途退出
   终态事件与 `details.json` 先写、数据库提交最后写，崩溃落在该窗口时，恢复逻辑会把
    已完成候选降级成 ``error / Unsolved.``，与存档矛盾。修复要求恢复时优先核对已持久化终态。

R3 已完成请求的责任判定
   只要出现过 ``model_dispatched`` 就把 ``remote_outcome_unknown`` 置真，忽略了同一
   请求的 ``model_returned``。修复要求按 requestId 配对。

R4 「未发送」贯通到调用层
   端口在预算耗尽时抛 ``RequestNotDispatched``，但 ``AgentClient`` 把所有异常统一记成
   ``DISPATCHED → OUTCOME_UNKNOWN`` 并封锁客户端。修复要求区分「证明未发送」与
   「发送后未知」。
"""
from __future__ import annotations

import json
import os
import time

import pytest

from python.astra_web.queue import ExecutionManager
from python.astra_web.storage import Store

DEAD_PID = 999_999
OLD_BOOT_ID = "00000000-dead-beef-0000-000000000000"


# --------------------------------------------------------------------------- 工具
def _manager(root) -> ExecutionManager:
    return ExecutionManager(Store(root), solver=None)


def _start_run(manager: ExecutionManager, run_id: str) -> str:
    return manager.prepare_run(
        problem="求 GF(2) 上由 rows 表示的矩阵的秩",
        request={
            "problem": "求 GF(2) 上由 rows 表示的矩阵的秩",
            "engine": "ts",
            "metadata": {},
        },
        run_id=run_id,
    )


def _rewrite_summary(root, run_id: str, **changes) -> dict:
    """改写运行中的记录（模拟「上一个进程」写下的历史记录）。"""
    store = Store(root)
    run = store.get_run(run_id)
    summary = dict(run.get("summary") or {})
    summary.update(changes)
    store.save_run(
        {
            "run_id": run_id,
            "created_at": run.get("created_at"),
            "source": run.get("source"),
            "status": run.get("status"),
            "scenario": run.get("scenario"),
            "model": run.get("model"),
            "seed": run.get("seed"),
            "duration_s": run.get("duration_s"),
            "summary_json": json.dumps(summary, ensure_ascii=False),
            "l2_path": run.get("l2_path"),
            "l3_path": run.get("l3_path"),
            "tags": ",".join(run.get("tags") or []),
            "checksum": run.get("checksum"),
        },
        overwrite=True,
    )
    return summary


# ======================================================================== R1
class TestR1ProcessIdentity:
    """R1：PID 被复用后，旧运行必须仍可恢复。"""

    def test_r1_recycled_pid_is_still_recoverable(self, tmp_path):
        owner = _manager(tmp_path)
        run_id = _start_run(owner, "run-r1-recycled")
        owner.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}})

        # 旧属主已死；内核把它的 pid 交给了我（本进程）。只有实例身份能分辨。
        _rewrite_summary(
            tmp_path,
            run_id,
            ownerPid=os.getpid(),
            ownerToken="previous-process-instance",
            ownerStartTicks=1,
            ownerBootId=OLD_BOOT_ID,
        )

        survivor = ExecutionManager(Store(tmp_path), solver=None)
        assert survivor.recover_orphan_runs() == [run_id]
        summary = survivor.store.get_run(run_id)["summary"]
        assert summary["stopReason"] == "TRANSPORT_STOP"
        assert summary["code"] == "HOST_RESTARTED"
        assert summary["candidate_verified"] is False

    def test_r1_rebooted_host_orphan_is_recoverable(self, tmp_path):
        owner = _manager(tmp_path)
        run_id = _start_run(owner, "run-r1-reboot")
        _rewrite_summary(
            tmp_path,
            run_id,
            ownerPid=os.getpid(),
            ownerToken="owner-before-reboot",
            ownerStartTicks=1,
            ownerBootId=OLD_BOOT_ID,
        )

        survivor = ExecutionManager(Store(tmp_path), solver=None)
        assert survivor.recover_orphan_runs() == [run_id]

    def test_r1_live_instance_with_same_identity_is_protected(self, tmp_path):
        owner = _manager(tmp_path)
        run_id = _start_run(owner, "run-r1-live")
        recorded = dict(owner.store.get_run(run_id)["summary"])
        # 身份与属主完全一致（同一进程实例、同一 token），不得被收口。
        assert recorded["ownerPid"] == os.getpid()
        assert recorded["ownerToken"] == owner._owner_token
        assert isinstance(recorded.get("ownerStartTicks"), int)

        sibling = ExecutionManager(Store(tmp_path), solver=None)
        assert sibling.recover_orphan_runs() == []
        assert sibling.store.get_run(run_id)["status"] == "running"

    def test_r1_sibling_manager_in_one_process_is_not_an_owner(self, tmp_path):
        owner = _manager(tmp_path)
        run_id = _start_run(owner, "run-r1-sibling")
        # 同一 pid、同一启动时刻，但属主 token 不是我的：不是我的运行。
        _rewrite_summary(tmp_path, run_id, ownerToken="another-manager")

        sibling = ExecutionManager(Store(tmp_path), solver=None)
        assert sibling.recover_orphan_runs() == []
        assert sibling.store.get_run(run_id)["status"] == "running"


# ======================================================================== R2
class TestR2TerminalCommitWindow:
    """R2：终态已落盘但数据库未提交时，恢复必须补提交而不是降级。"""

    def _write_terminal_archive(self, manager: ExecutionManager, run_id: str) -> dict:
        from python.astra_web.archive import atomic_write_json

        terminal = {
            "runId": run_id,
            "engine": "ts",
            "status": "candidate",
            "stopReason": "REVIEWS_COMPLETE",
            "terminalKind": "REVIEWS_COMPLETE",
            "final_response": "rank = 2",
            "reason": "reviews complete",
            "code": None,
            "executed": True,
            "candidate_verified": False,
            "childReaped": True,
            "elapsedMs": 1234,
            "sessionId": "session-1",
        }
        manager.append_terminal_event(run_id, terminal)
        atomic_write_json(
            manager.store.safe_join(f"runs/{run_id}/details.json"),
            {"events": manager.get_history_events(run_id), "summary": terminal},
        )
        return terminal

    def test_r2_crash_after_archive_keeps_the_candidate(self, tmp_path):
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r2-crash")
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m"}})
        self._write_terminal_archive(manager, run_id)
        # 数据库此刻仍是 running：这正是崩溃窗口。
        assert manager.store.get_run(run_id)["status"] == "running"
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID, l2_path=f"runs/{run_id}/details.json")

        after = ExecutionManager(Store(tmp_path), solver=None)
        assert after.recover_orphan_runs() == [run_id]

        run = after.store.get_run(run_id)
        assert run["status"] == "candidate"
        summary = run["summary"]
        assert summary["stopReason"] == "REVIEWS_COMPLETE"
        assert summary["final_response"] == "rank = 2"
        assert summary["candidate_verified"] is False
        assert summary["committedFromArchive"] is True
        assert summary.get("code") != "HOST_RESTARTED"

    def test_r2_events_archive_and_database_agree_after_recovery(self, tmp_path):
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r2-agree")
        self._write_terminal_archive(manager, run_id)
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID, l2_path=f"runs/{run_id}/details.json")

        after = ExecutionManager(Store(tmp_path), solver=None)
        after.recover_orphan_runs()

        events = after.get_history_events(run_id)
        assert [row["kind"] for row in events] == ["RESULT"]
        assert events[-1]["payload"]["status"] == "candidate"
        archive = json.loads(
            after.store.safe_join(f"runs/{run_id}/details.json").read_text(encoding="utf-8")
        )
        assert archive["summary"]["status"] == after.store.get_run(run_id)["status"]
        assert archive["summary"]["stopReason"] == "REVIEWS_COMPLETE"

    def test_r2_run_without_terminal_evidence_still_fails_closed(self, tmp_path):
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r2-no-evidence")
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m"}})
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

        after = ExecutionManager(Store(tmp_path), solver=None)
        assert after.recover_orphan_runs() == [run_id]
        summary = after.store.get_run(run_id)["summary"]
        assert summary["status"] == "error"
        assert summary["code"] == "HOST_RESTARTED"
        assert summary["candidate_verified"] is False


# ======================================================================== R3
class TestR3RequestPairing:
    """R3：只保留真正未决请求的远端未知责任。"""

    def test_r3_completed_pair_is_not_unknown(self, tmp_path):
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r3-complete")
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}})
        manager.append_event_sync(
            run_id,
            {"kind": "model_returned", "payload": {"requestId": "model-1", "transportStatus": "COMPLETE"}},
        )
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

        after = ExecutionManager(Store(tmp_path), solver=None)
        after.recover_orphan_runs()
        assert after.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"] is False

    def test_r3_unknown_and_dangling_requests_stay_unknown(self, tmp_path):
        for run_id, status in (("run-r3-unknown", "UNKNOWN"), ("run-r3-dangling", None)):
            manager = _manager(tmp_path)
            _start_run(manager, run_id)
            manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m1"}})
            if status is not None:
                manager.append_event_sync(
                    run_id,
                    {"kind": "model_returned", "payload": {"requestId": "m1", "transportStatus": status}},
                )
            _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

        after = ExecutionManager(Store(tmp_path), solver=None)
        assert set(after.recover_orphan_runs()) == {"run-r3-unknown", "run-r3-dangling"}
        for run_id in ("run-r3-unknown", "run-r3-dangling"):
            assert after.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"] is True

    def test_r3_only_the_unresolved_request_is_unknown(self, tmp_path):
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r3-mixed")
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m1"}})
        manager.append_event_sync(
            run_id, {"kind": "model_returned", "payload": {"requestId": "m1", "transportStatus": "COMPLETE"}}
        )
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m2"}})
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

        after = ExecutionManager(Store(tmp_path), solver=None)
        after.recover_orphan_runs()
        assert after.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"] is True


# ======================================================================== R4
class TestR4NotDispatched:
    """R4：证明未发送的调用不得记为远端未知，也不得封锁客户端。"""

    def _port(self, *, remaining: float):
        from python.astra_bridge.public_chat_port import PublicChatPort
        from mathagent.user_client import UserSuppliedS2Client

        connector = UserSuppliedS2Client(
            api_key="sk-" + "r4" * 12,
            endpoint="https://chat.intern-ai.org.cn/api/v1/chat/completions",
            model="Intern-S2-Preview-397B",
        )
        now = {"t": 0.0}
        port = PublicChatPort(connector, request_seconds=remaining, clock=lambda: now["t"])
        return port, connector, now

    def test_r4_budget_precheck_refuses_without_sending(self):
        port, connector, now = self._port(remaining=0.2)
        assert port.may_dispatch() is True
        now["t"] = 5.0
        assert port.may_dispatch() is False
        assert port.calls == 0

    def test_r4_agent_client_records_not_dispatched_and_keeps_client_usable(self):
        import time as _time

        from python.astra_bridge.agent_client import AgentClient

        port, connector, now = self._port(remaining=0.2)
        now["t"] = 5.0
        client = AgentClient(port)

        result = client.generate(_minimal_request(), _time.monotonic() + 5.0)

        assert result["dispatchState"] == "NOT_DISPATCHED"
        assert result["transportStatus"] == "UNKNOWN"
        assert client.blocked is False, "a provably unsent call must not block the client"
        assert client.calls == 0
        assert [row["state"] for row in client.snapshot()] == ["NOT_DISPATCHED"]

    def test_r4_dispatch_state_survives_host_event_and_restart(self, tmp_path):
        """派发状态必须贯穿 Host 事件、持久化与重启恢复。

        Host 对未派发请求发出 ``model_returned`` 时带上 ``dispatchState``；
        恢复判定据此把该请求视为「已结清」，而不是又一次变成远端未知。
        """
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r4-restart")
        # 与 Host observer 实际下发的事件逐字段一致。
        manager.append_event_sync(
            run_id,
            {
                "kind": "model_dispatched",
                "payload": {"requestId": "model-1", "phase": "WORK", "modelCalls": 0, "remainingMs": 600000},
            },
        )
        manager.append_event_sync(
            run_id,
            {
                "kind": "model_returned",
                "payload": {
                    "requestId": "model-1",
                    "phase": "WORK",
                    "transportStatus": "UNKNOWN",
                    "dispatchState": "NOT_DISPATCHED",
                    "modelCalls": 1,
                    "remainingMs": 599000,
                },
            },
        )
        assert ExecutionManager.remote_outcome_unknown(manager.get_history_events(run_id)) is False

        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)
        survivor = ExecutionManager(Store(tmp_path), solver=None)
        assert survivor.recover_orphan_runs() == [run_id]
        assert survivor.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"] is False

    def test_r4_legacy_event_without_dispatch_state_still_counts_as_unknown(self, tmp_path):
        """旧存档没有 dispatchState：UNKNOWN 传输仍按未决处理（不擅自放宽）。"""
        manager = _manager(tmp_path)
        run_id = _start_run(manager, "run-r4-legacy")
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m1"}})
        manager.append_event_sync(
            run_id, {"kind": "model_returned", "payload": {"requestId": "m1", "transportStatus": "UNKNOWN"}}
        )
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

        survivor = ExecutionManager(Store(tmp_path), solver=None)
        survivor.recover_orphan_runs()
        assert survivor.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"] is True

    def test_r4_timed_out_call_is_still_counted_as_dispatched(self):
        """超时未返回的调用必须计为一次派发（迟到结果不得改写已交付计数）。"""
        import threading
        import time as _time

        from python.astra_bridge.agent_client import AgentClient

        class SlowPort:
            def __init__(self):
                self.calls = 0
                self.release = threading.Event()

            def may_dispatch(self):
                return True

            def chat(self, *, messages, temperature, max_tokens):
                self.calls += 1
                self.release.wait(2.0)  # replies long after the deadline
                return {"choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": "late"}}]}

        port = SlowPort()
        client = AgentClient(port)
        started = _time.monotonic()
        result = client.generate(_minimal_request(), _time.monotonic() + 0.3)
        elapsed = _time.monotonic() - started

        assert elapsed < 1.0, "the deadline must not wait for the late reply"
        assert result["dispatchState"] == "DISPATCHED"
        assert result["transportStatus"] == "UNKNOWN"
        assert client.calls == 1, "a dispatched call is counted at dispatch time"
        assert client.blocked is True
        assert client.snapshot()[-1]["state"] == "OUTCOME_UNKNOWN"
        port.release.set()

    def test_r4_transport_error_after_send_is_still_unknown(self):
        """对照：真正发出去之后失败，必须仍然是远端未知并封锁客户端。"""
        import time as _time

        from python.astra_bridge.agent_client import AgentClient
        from mathagent.runtime.transport import UnconfirmedTransportFailure

        class ExplodingPort:
            def __init__(self):
                self.calls = 0

            def may_dispatch(self):
                return True

            def chat(self, *, messages, temperature, max_tokens):
                self.calls += 1
                raise UnconfirmedTransportFailure("RuntimeError", {}, "transport_failure_unconfirmed")

        port = ExplodingPort()
        client = AgentClient(port)
        result = client.generate(_minimal_request(), _time.monotonic() + 5.0)

        assert result["dispatchState"] == "DISPATCHED"
        assert client.blocked is True
        assert client.calls == 1
        assert client.snapshot()[-1]["state"] == "OUTCOME_UNKNOWN"


def _minimal_request() -> dict:
    """满足 Host→client 严格校验器的最小请求。"""
    import hashlib

    messages = [
        {"role": "system", "content": "host"},
        {"role": "user", "content": "{}"},
    ]
    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    encoded = serialized.encode("utf-8")
    return {
        "sessionId": "session-1",
        "problemHash": "0" * 64,
        "requestId": "model-1",
        "phase": "WORK",
        "taskId": "task-1",
        "scopeId": "1" * 64,
        "messages": messages,
        "contextHash": hashlib.sha256(encoded).hexdigest(),
        "contextBytes": len(encoded),
        "remainingMs": 4000,
        "maxTokens": 8192,
    }
