"""独立可复跑探针：第二轮复核的四个边界缺陷（R1–R4）。

Usage:  python3 tests/web_review/probe_restart_recovery.py <treeRoot> [label]

不依赖 pytest / Node / 浏览器 / Starlette：只用 ``ExecutionManager`` + ``Store``
（stdlib sqlite3）、``PublicChatPort`` 与 ``AgentClient``，在私有临时数据根内运行，
从不写入被测树的实现文件。

R1 PID 复用：死属主的 pid 被新进程接管后，遗留运行仍必须可恢复。
R2 终态落盘中途退出：终态事件 + details.json 已写、数据库未提交时，恢复要补提交
   而不是把已完成的候选降级。
R3 责任判定：只保留真正未决请求的 remote_outcome_unknown。
R4 未发送：预算耗尽时端口在发送前拒绝，AgentClient 不得记为 OUTCOME_UNKNOWN 或封锁。

输出：一段 JSON（``{"R1": {...}, "R2": {...}, "R3": {...}, "R4": {...}}``），
任一 R 不符即 ``all_passed=false`` 并以退出码 1 结束。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

TREE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
LABEL = sys.argv[2] if len(sys.argv) > 2 else str(TREE)
sys.path.insert(0, str(TREE))

from python.astra_web.queue import ExecutionManager  # noqa: E402
from python.astra_web.storage import Store  # noqa: E402

DEAD_PID = 999_999
OLD_BOOT_ID = "00000000-dead-beef-0000-000000000000"
TMP = Path(tempfile.mkdtemp(prefix="astra_probe_recovery_"))


def _root(name: str) -> Path:
    path = TMP / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _start(root: Path, run_id: str) -> ExecutionManager:
    manager = ExecutionManager(Store(root), solver=None)
    manager.prepare_run(
        problem="求 GF(2) 上由 rows 表示的矩阵的秩",
        request={"problem": "求 GF(2) 上由 rows 表示的矩阵的秩", "engine": "ts", "metadata": {}},
        run_id=run_id,
    )
    return manager


def _rewrite(root: Path, run_id: str, **changes) -> None:
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


def probe_r1() -> dict:
    root = _root("r1")
    manager = _start(root, "probe-r1")
    manager.append_event_sync("probe-r1", {"kind": "model_dispatched", "payload": {"requestId": "m"}})
    _rewrite(
        root,
        "probe-r1",
        ownerPid=os.getpid(),
        ownerToken="previous-instance",
        ownerStartTicks=1,
        ownerBootId=OLD_BOOT_ID,
    )
    survivor = ExecutionManager(Store(root), solver=None)
    recovered = survivor.recover_orphan_runs()
    run = survivor.store.get_run("probe-r1")
    return {
        "recovered": recovered,
        "status_after": run["status"],
        "stopReason": run["summary"].get("stopReason"),
        "code": run["summary"].get("code"),
        "passed": recovered == ["probe-r1"] and run["status"] == "error",
    }


def probe_r2() -> dict:
    from python.astra_web.archive import atomic_write_json

    root = _root("r2")
    manager = _start(root, "probe-r2")
    manager.append_event_sync("probe-r2", {"kind": "model_dispatched", "payload": {"requestId": "m"}})
    terminal = {
        "runId": "probe-r2",
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
    manager.append_terminal_event("probe-r2", terminal)
    atomic_write_json(
        manager.store.safe_join("runs/probe-r2/details.json"),
        {"events": manager.get_history_events("probe-r2"), "summary": terminal},
    )
    mid_status = manager.store.get_run("probe-r2")["status"]
    _rewrite(root, "probe-r2", ownerPid=DEAD_PID, l2_path="runs/probe-r2/details.json")

    survivor = ExecutionManager(Store(root), solver=None)
    survivor.recover_orphan_runs()
    run = survivor.store.get_run("probe-r2")
    return {
        "status_before_commit": mid_status,
        "status_after": run["status"],
        "stopReason": run["summary"].get("stopReason"),
        "final_response": run["summary"].get("final_response"),
        "committedFromArchive": run["summary"].get("committedFromArchive"),
        "events": [row["kind"] for row in survivor.get_history_events("probe-r2")],
        "passed": (
            mid_status == "running"
            and run["status"] == "candidate"
            and run["summary"].get("stopReason") == "REVIEWS_COMPLETE"
            and run["summary"].get("final_response") == "rank = 2"
            and run["summary"].get("candidate_verified") is False
        ),
    }


def probe_r3() -> dict:
    root = _root("r3")
    for run_id, status in (("probe-r3-complete", "COMPLETE"), ("probe-r3-unknown", "UNKNOWN"), ("probe-r3-dangling", None)):
        manager = _start(root, run_id)
        manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m1"}})
        if status is not None:
            manager.append_event_sync(
                run_id, {"kind": "model_returned", "payload": {"requestId": "m1", "transportStatus": status}}
            )
        _rewrite(root, run_id, ownerPid=DEAD_PID)

    survivor = ExecutionManager(Store(root), solver=None)
    recovered = survivor.recover_orphan_runs()
    values = {
        run_id: survivor.store.get_run(run_id)["summary"]["metrics"]["remote_outcome_unknown"]
        for run_id in ("probe-r3-complete", "probe-r3-unknown", "probe-r3-dangling")
    }
    return {
        "recovered": recovered,
        "remote_outcome_unknown": values,
        "passed": (
            values["probe-r3-complete"] is False
            and values["probe-r3-unknown"] is True
            and values["probe-r3-dangling"] is True
        ),
    }


def probe_r4() -> dict:
    from python.astra_bridge.agent_client import AgentClient
    from python.astra_bridge.public_chat_port import PublicChatPort
    from mathagent.user_client import UserSuppliedS2Client

    connector = UserSuppliedS2Client(
        api_key="sk-" + "r4" * 12,
        endpoint="https://chat.intern-ai.org.cn/api/v1/chat/completions",
        model="Intern-S2-Preview-397B",
    )
    now = {"t": 0.0}
    port = PublicChatPort(connector, request_seconds=0.2, clock=lambda: now["t"])
    admitted = port.may_dispatch()
    now["t"] = 5.0
    refused = port.may_dispatch()
    client = AgentClient(port)
    result = client.generate(_minimal_request(), time.monotonic() + 5.0)
    sent = result.get("dispatchState") == "DISPATCHED"
    return {
        "admitted_before": admitted,
        "admitted_after": refused,
        "dispatchState": result.get("dispatchState"),
        "transportStatus": result.get("transportStatus"),
        "client_blocked": client.blocked,
        "client_calls": client.calls,
        "journal_states": [row["state"] for row in client.snapshot()],
        "connector_dispatched": bool(connector.last_transport_summary),
        "passed": (
            admitted is True
            and refused is False
            and result.get("dispatchState") == "NOT_DISPATCHED"
            and client.blocked is False
            and client.calls == 0
            and sent is False
            and connector.last_transport_summary == {}
        ),
    }


def _minimal_request() -> dict:
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


def main() -> int:
    out: dict = {"tree": str(TREE), "label": LABEL, "tmp": str(TMP)}
    for name, probe in (("R1", probe_r1), ("R2", probe_r2), ("R3", probe_r3), ("R4", probe_r4)):
        try:
            out[name] = probe()
        except Exception as exc:  # 探针自身失败也必须显式呈现
            out[name] = {"passed": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-1200:]}
    out["all_passed"] = all(out[name].get("passed") for name in ("R1", "R2", "R3", "R4"))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
