"""Linux owned-process supervision. Local death never settles remote leases."""

import json
import os
import signal
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from .runtime.request_observer import local_observers_pending


def drain_request_observers(path, *, run_id, owner_pid, deadline):
    """Keep this worker alive for existing observers, never start or settle work.

    The mathematical result must already be saved. Read-only queries cannot turn
    local expiry, process death, or a missing observer into a remote receipt.
    The parent retains its original hard deadline and kill grace.
    """
    db = sqlite3.connect(
        Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=1
    )
    try:
        while time.monotonic() < deadline:
            active = db.execute(
                "SELECT COUNT(*) FROM requests r JOIN request_observers o ON r.id=o.request "
                "WHERE r.run=? AND r.owner_pid=? AND r.status='IN_FLIGHT' AND o.active=1",
                (run_id, owner_pid),
            ).fetchone()[0]
            # Settlement can precede the final diagnostic flush by a few ms.
            # The process-local completion marker covers that exit race without
            # keeping an already-settled but stuck transport cleanup alive.
            journaling = owner_pid == os.getpid() and local_observers_pending(run_id)
            if not active and not journaling:
                return
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    finally:
        db.close()


def process_identity(pid):
    try:
        # comm may contain spaces and parentheses; fields after the final ')' are stable.
        fields = (
            Path(f"/proc/{pid}/stat")
            .read_text(encoding="utf-8")
            .rsplit(")", 1)[1]
            .split()
        )
        return int(fields[1]), fields[19]
    except (OSError, ValueError, IndexError):
        return None


@dataclass
class Child:
    process: object
    item: dict
    started: float
    deadline: float
    result_path: Path
    owned: dict = field(default_factory=dict)
    stopping_at: float | None = None
    stop_cause: str | None = None

    def discover(self):
        identity = process_identity(self.process.pid)
        if identity:
            self.owned.setdefault(self.process.pid, identity[1])
        table = {}
        for path in Path("/proc").iterdir():
            if path.name.isdecimal():
                pid = int(path.name)
                value = process_identity(pid)
                if value:
                    table[pid] = value
        living = {
            pid
            for pid, token in self.owned.items()
            if table.get(pid, (None, None))[1] == token
        }
        while True:
            added = {pid for pid, (ppid, _) in table.items() if ppid in living} - living
            if not added:
                break
            living |= added
        for pid in living:
            self.owned[pid] = table[pid][1]

    def signal_owned(self, sig):
        self.discover()
        for pid, token in tuple(self.owned.items()):
            value = process_identity(pid)
            if value and value[1] == token:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass


def supervise(
    items,
    *,
    launch,
    on_result,
    recover,
    can_start,
    run_deadline,
    parallelism=3,
    grace=10,
    first_serial=True,
    stop_requested=lambda: False,
    on_reaped=lambda child: None,
    start_block_reason=lambda: None,
):
    """At most three live item children; no eager queue of the whole suite.

    launch is trusted runner code. Result files are atomic worker-owned output,
    not unbounded stdout pipes. Escaped child sessions are tracked by pid/start
    identity, so killing the parent group cannot strand a WASI worker.
    """
    if os.name != "posix" or not 1 <= parallelism <= 3 or not 0 < grace <= 10:
        raise ValueError("same-host POSIX bounded process supervisor required")
    pending, results, index = [], [], 0
    bootstrap = not first_serial
    repeated_failure, stop_reason = 0, None
    try:
        while pending or index < len(items):
            now = time.monotonic()
            manual_stop = stop_requested()
            if manual_stop:
                stop_reason = (
                    manual_stop
                    if isinstance(manual_stop, str)
                    else "USER_OR_RUNTIME_STOP"
                )
            if now >= run_deadline:
                stop_reason = "RUN_HARD_DEADLINE"
            while (
                not stop_reason
                and index < len(items)
                and can_start()
                and len(pending) < (parallelism if bootstrap else 1)
            ):
                item = items[index]
                started = (
                    time.monotonic()
                )  # Before worker creation/import and all local queuing.
                if started >= run_deadline:
                    break
                child = launch(item, started)
                pending.append(child)
                index += 1
            if not pending:
                if index < len(items) and not stop_reason:
                    stop_reason = start_block_reason()
                break
            for child in tuple(pending):
                child.discover()
                now = time.monotonic()
                if (
                    manual_stop or now >= min(child.deadline, run_deadline)
                ) and child.stopping_at is None:
                    child.stopping_at = now
                    child.stop_cause = (
                        "HARD_DEADLINE"
                        if now >= min(child.deadline, run_deadline)
                        else manual_stop
                        if isinstance(manual_stop, str)
                        else "USER_OR_RUNTIME_STOP"
                    )
                    child.signal_owned(signal.SIGTERM)
                if (
                    child.stopping_at is not None
                    and now
                    >= min(child.deadline, run_deadline, child.stopping_at) + grace
                ):
                    child.signal_owned(signal.SIGKILL)
                if child.process.poll() is None:
                    continue
                child.signal_owned(signal.SIGKILL)
                child.process.wait(timeout=1)
                on_reaped(child)
                if child.result_path.exists():
                    row = json.loads(child.result_path.read_text(encoding="utf-8"))
                    if row.get("completed_at", float("inf")) > child.deadline:
                        row = recover(child, "HARD_DEADLINE")
                    elif str(row.get("idx")) != str(child.item["idx"]) or not row.get(
                        "final_response"
                    ):
                        row = recover(child, "INVALID_WORKER_RESULT")
                else:
                    row = recover(
                        child,
                        child.stop_cause
                        or ("HARD_DEADLINE" if child.stopping_at else "WORKER_ERROR"),
                    )
                row.setdefault("execution", {})["local_process_reaped"] = True
                execution = row.get("execution", {})
                capacity_blocked = (
                    not execution.get("logical_calls")
                    and "WAITING_CAPACITY" in row.get("blocked_by", [])
                    and row.get("status") != "candidate"
                )
                if capacity_blocked:
                    row["termination_reason"] = "UNSETTLED_REMOTE_CAPACITY"
                    stop_reason = "UNSETTLED_REMOTE_CAPACITY"
                results.append(row)
                on_result(row)
                pending.remove(child)
                bootstrap |= execution.get("bootstrap_succeeded") is True
                if execution.get("configuration_error"):
                    stop_reason = "CONFIGURATION_ERROR"
                if (
                    not capacity_blocked
                    and not execution.get("solver_entered")
                    and row.get("status") != "candidate"
                ):
                    signature = row.get("termination_reason", "NO_CANDIDATE")
                    previous = (
                        results[-2].get("termination_reason")
                        if len(results) > 1
                        else None
                    )
                    repeated_failure = (
                        repeated_failure + 1 if signature == previous else 1
                    )
                    if repeated_failure >= 3:
                        stop_reason = "REPEATED_INTEGRATION_FAILURE"
                else:
                    repeated_failure = 0
            if pending:
                time.sleep(0.02)
        return results, items[index:], stop_reason
    finally:
        for child in pending:
            child.signal_owned(signal.SIGKILL)
            child.process.wait(timeout=1)


class ForkHandle:
    """Compatibility runner only; child creates its own client after fork."""

    def __init__(self, process):
        self.process = process
        self.pid = process.pid

    def poll(self):
        return self.process.exitcode

    def wait(self, timeout):
        self.process.join(timeout)
        if self.process.is_alive():
            raise TimeoutError("owned child did not exit")
        return self.process.exitcode
