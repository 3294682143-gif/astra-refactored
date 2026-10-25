"""A run must survive a BFF restart with its real events and an honest outcome.

Reviewed defects covered here:
* events lived only in memory until finalization, so a restart turned 1 observed
  event into 0 while the database still said ``running``;
* the new manager considered such a run inactive, so no terminal record, no
  replay and no owner of the unresolved remote request ever existed again.

Ownership is part of the contract: a spawned helper process re-imports the BFF
module, and a sibling manager (or a second BFF sharing a data root) must never
close a run that a live process is still working on.
"""
from __future__ import annotations

import json
import os

from python.astra_web.queue import ExecutionManager
from python.astra_web.storage import Store

DEAD_PID = 999_999


def _manager(root) -> ExecutionManager:
    return ExecutionManager(Store(root), solver=None)


def _start_run(manager: ExecutionManager, run_id: str = "run-restart-1") -> str:
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
    """Rewrite the running record's summary (simulates a previous process)."""
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


def test_events_hit_disk_before_the_run_finishes(tmp_path):
    manager = _manager(tmp_path)
    run_id = _start_run(manager)

    manager.append_event_sync(
        run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}}
    )

    path = tmp_path / "runs" / run_id / "events.jsonl"
    assert path.is_file(), "an observed event must not live only in memory"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    assert [row["kind"] for row in rows] == ["model_dispatched"]
    assert rows[0]["seq"] == 1
    assert rows[0]["runId"] == run_id


def test_restart_keeps_events_and_closes_the_run_honestly(tmp_path):
    before = _manager(tmp_path)
    run_id = _start_run(before)
    before.append_event_sync(
        run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}}
    )
    # model-1 never returned: its remote outcome is genuinely unresolved.
    before.append_event_sync(
        run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-2"}}
    )
    before.append_event_sync(
        run_id,
        {"kind": "model_returned", "payload": {"requestId": "model-2", "transportStatus": "COMPLETE"}},
    )

    # --- process restart: the owning process is gone, records survive on disk
    _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)
    after = ExecutionManager(Store(tmp_path), solver=None)
    replayed = after.get_history_events(run_id)
    assert [row["kind"] for row in replayed] == [
        "model_dispatched",
        "model_dispatched",
        "model_returned",
    ]
    assert after.is_active(run_id) is False

    recovered = after.recover_orphan_runs()
    assert recovered == [run_id]

    run = after.store.get_run(run_id)
    assert run is not None
    assert run["status"] == "error"
    summary = run["summary"]
    assert summary["stopReason"] == "TRANSPORT_STOP"
    assert summary["terminalKind"] == "system_failure"
    assert summary["code"] == "HOST_RESTARTED"
    assert summary["candidate_verified"] is False
    assert summary["executed"] is False
    # The unresolved remote request stays recorded instead of disappearing.
    assert summary["metrics"]["remote_outcome_unknown"] is True

    events = after.get_history_events(run_id)
    kinds = [row["kind"] for row in events]
    assert kinds[:3] == ["model_dispatched", "model_dispatched", "model_returned"]
    assert "error" in kinds and kinds[-1] == "RESULT"
    terminal = events[-1]
    assert terminal["sourceKind"] == "official_result"
    assert terminal["payload"]["status"] == "error"
    assert terminal["payload"]["candidate_verified"] is False

    archive = tmp_path / "runs" / run_id / "details.json"
    assert archive.is_file()
    payload = json.loads(archive.read_text(encoding="utf-8"))
    assert payload["summary"]["stopReason"] == "TRANSPORT_STOP"
    assert payload["events"][-1]["kind"] == "RESULT"

    # Recovery is idempotent: a terminal record is never rewritten.
    assert after.recover_orphan_runs() == []
    assert after.stats()["recovered_runs"] == 0


def test_recovery_without_a_dispatch_does_not_claim_an_unknown_remote_call(tmp_path):
    before = _manager(tmp_path)
    run_id = _start_run(before, run_id="run-restart-2")

    _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)
    after = ExecutionManager(Store(tmp_path), solver=None)
    assert after.recover_orphan_runs() == [run_id]

    run = after.store.get_run(run_id)
    assert run["summary"]["metrics"]["remote_outcome_unknown"] is False
    events = after.get_history_events(run_id)
    assert [row["kind"] for row in events] == ["error", "RESULT"]


def test_active_runs_are_never_recovered(tmp_path):
    manager = _manager(tmp_path)
    run_id = _start_run(manager, run_id="run-restart-3")
    manager.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {}})

    assert manager.recover_orphan_runs() == []
    assert manager.store.get_run(run_id)["status"] == "running"


def test_own_orphaned_run_is_recovered_after_the_manager_lost_it(tmp_path):
    manager = _manager(tmp_path)
    run_id = _start_run(manager, run_id="run-restart-5")
    # The manager loses track of a run it still owns (e.g. a failed worker).
    manager._active_runs.pop(run_id, None)

    assert manager.recover_orphan_runs() == [run_id]
    assert manager.store.get_run(run_id)["status"] == "error"


def test_a_live_owner_process_is_never_recovered(tmp_path):
    """A spawned helper or a sibling BFF must not close another process's run."""
    owner = _manager(tmp_path)
    run_id = _start_run(owner, run_id="run-restart-4")
    owner.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {}})

    intruder = ExecutionManager(Store(tmp_path), solver=None)
    assert intruder.recover_orphan_runs() == []
    assert intruder.store.get_run(run_id)["status"] == "running"
    assert owner.is_active(run_id) is True

    # Same pid, different manager token: still not ours to close.
    _rewrite_summary(tmp_path, run_id, ownerToken="other-manager")
    intruder2 = ExecutionManager(Store(tmp_path), solver=None)
    assert intruder2.recover_orphan_runs() == []
    assert intruder2.store.get_run(run_id)["status"] == "running"


def test_a_legacy_record_younger_than_this_process_is_left_alone(tmp_path):
    manager = _manager(tmp_path)
    run_id = _start_run(manager, run_id="run-legacy-1")
    _rewrite_summary(tmp_path, run_id, ownerPid=None, ownerToken=None)

    intruder = ExecutionManager(Store(tmp_path), solver=None)
    assert intruder.recover_orphan_runs() == []
    assert intruder.store.get_run(run_id)["status"] == "running"


def test_completed_requests_are_not_relabelled_as_unknown(tmp_path):
    """A dispatch+COMPLETE pair has a known outcome; recovery must not call it unknown."""
    before = _manager(tmp_path)
    run_id = _start_run(before, run_id="run-restart-6")
    before.append_event_sync(
        run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}}
    )
    before.append_event_sync(
        run_id,
        {"kind": "model_returned", "payload": {"requestId": "model-1", "transportStatus": "COMPLETE"}},
    )

    _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)
    after = ExecutionManager(Store(tmp_path), solver=None)
    assert after.recover_orphan_runs() == [run_id]

    summary = after.store.get_run(run_id)["summary"]
    assert summary["metrics"]["remote_outcome_unknown"] is False


def test_unknown_returns_and_dangling_dispatches_stay_unknown(tmp_path):
    """"UNKNOWN" returns and never-returned requests both keep the responsibility."""
    cases = {
        "run-unknown-1": [{"requestId": "model-1", "transportStatus": "UNKNOWN"}],
        "run-unknown-2": [{"requestId": "model-1", "transportStatus": "TRUNCATED"}],
    }
    for run_id, returns in cases.items():
        manager = _manager(tmp_path)
        _start_run(manager, run_id=run_id)
        manager.append_event_sync(
            run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}}
        )
        for row in returns:
            manager.append_event_sync(run_id, {"kind": "model_returned", "payload": row})
        _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID)

    after = ExecutionManager(Store(tmp_path), solver=None)
    recovered = set(after.recover_orphan_runs())
    assert recovered == {"run-unknown-1", "run-unknown-2"}
    assert after.store.get_run("run-unknown-1")["summary"]["metrics"]["remote_outcome_unknown"] is True
    # TRUNCATED is a *known* transport outcome (the provider answered, truncated).
    assert after.store.get_run("run-unknown-2")["summary"]["metrics"]["remote_outcome_unknown"] is False


def test_recycled_pid_does_not_block_recovery(tmp_path):
    """A live pid wearing the dead owner's number must not keep a run hostage."""
    owner = _manager(tmp_path)
    run_id = _start_run(owner, run_id="run-pid-reuse-1")
    owner.append_event_sync(run_id, {"kind": "model_dispatched", "payload": {"requestId": "m"}})

    # The old owner is gone; the kernel handed its pid to another process (us).
    _rewrite_summary(
        tmp_path,
        run_id,
        ownerPid=os.getpid(),
        ownerToken="previous-process-instance",
        ownerStartTicks=1,          # not this process's start time
        ownerBootId="00000000-dead-beef-0000-000000000000",
    )

    survivor = ExecutionManager(Store(tmp_path), solver=None)
    assert survivor.recover_orphan_runs() == [run_id]
    summary = survivor.store.get_run(run_id)["summary"]
    assert summary["stopReason"] == "TRANSPORT_STOP"
    assert summary["code"] == "HOST_RESTARTED"


def test_live_same_boot_owner_with_matching_identity_is_protected(tmp_path):
    """When the recorded identity really is a live process, nothing is recovered."""
    owner = _manager(tmp_path)
    run_id = _start_run(owner, run_id="run-live-owner-1")
    run = owner.store.get_run(run_id)
    recorded = dict(run["summary"])
    assert recorded.get("ownerPid") == os.getpid()
    assert recorded.get("ownerToken") == owner._owner_token

    sibling = ExecutionManager(Store(tmp_path), solver=None)
    assert sibling.recover_orphan_runs() == []
    assert sibling.store.get_run(run_id)["status"] == "running"


def test_crash_between_archive_and_database_keeps_the_candidate(tmp_path):
    """Terminal evidence on disk wins: the database row is completed, not downgraded."""
    manager = _manager(tmp_path)
    run_id = _start_run(manager, run_id="run-crash-order-1")
    manager.append_event_sync(
        run_id, {"kind": "model_dispatched", "payload": {"requestId": "model-1"}}
    )
    terminal_summary = {
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
    # _finalize writes the RESULT event and details.json before the DB commit;
    # simulate the crash exactly in that window.
    manager.append_terminal_event(run_id, terminal_summary)
    archive_rel = f"runs/{run_id}/details.json"
    from python.astra_web.archive import atomic_write_json

    atomic_write_json(
        manager.store.safe_join(archive_rel),
        {"events": manager.get_history_events(run_id), "summary": terminal_summary},
    )
    _rewrite_summary(tmp_path, run_id, ownerPid=DEAD_PID, l2_path=archive_rel)
    assert manager.store.get_run(run_id)["status"] == "running"

    after = ExecutionManager(Store(tmp_path), solver=None)
    assert after.recover_orphan_runs() == [run_id]

    run = after.store.get_run(run_id)
    assert run["status"] == "candidate", "the archived terminal must be completed, not overwritten"
    summary = run["summary"]
    assert summary["stopReason"] == "REVIEWS_COMPLETE"
    assert summary["final_response"] == "rank = 2"
    assert summary["candidate_verified"] is False
    assert summary["committedFromArchive"] is True
    assert summary.get("code") != "HOST_RESTARTED"

    events = after.get_history_events(run_id)
    assert [row["kind"] for row in events] == ["model_dispatched", "RESULT"]
    assert events[-1]["payload"]["status"] == "candidate"
