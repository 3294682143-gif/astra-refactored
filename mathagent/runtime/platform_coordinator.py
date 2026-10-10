"""Single-invocation guards, not a replacement for the platform's global limits.

No run ID, shared filesystem, clock-epoch inference or cross-question state.
Counters describe local public-client invocations only; SDK retries and remote
permits remain owned by the injected client/runner.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from .config import Limits
from .coordinator import AdmissionError, DeadlineExceeded, Item, Lease


@dataclass(frozen=True)
class PlatformPolicy:
    # This ceiling is a local safety bound, never an allocation of a fresh global
    # 10000 calls. Platform admission is authoritative on every actual call.
    limits: Limits = field(default_factory=lambda: Limits(problems=1, in_flight=2))
    exit_reserve_seconds: float = 10.0
    max_input_chars: int = 64000
    max_response_chars: int = 65536
    max_trace_events: int = 64

    def __post_init__(self):
        if type(self.max_trace_events) is not int or self.max_trace_events < 2:
            raise ValueError("trace needs room for contract and summary")
        if self.limits.problems != 1 or self.limits.in_flight > 2:
            raise ValueError(
                "platform local guard covers one invocation and at most two calls"
            )
        if not 0 <= self.exit_reserve_seconds < self.limits.problem_seconds:
            raise ValueError("invalid local return reserve")
        for value, maximum in [
            (self.max_input_chars, 64000),
            (self.max_response_chars, 65536),
            (self.max_trace_events, 128),
        ]:
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError("invalid local output/context protection")


class PlatformItemCoordinator:
    def __init__(self, *, started, policy=None, clock=time.monotonic):
        self.policy = policy or PlatformPolicy()
        self.limits, self.clock = self.policy.limits, clock
        self.hard_deadline = started + self.limits.problem_seconds
        self.item = Item(
            "invocation-local-item",
            started,
            self.hard_deadline - self.policy.exit_reserve_seconds,
        )
        self.condition = threading.Condition(threading.RLock())
        self.requests = {}
        self.once_flags = set()
        self.queue = []
        self.serial = self.calls = self.checkpoints = 0
        self.reserved = 2
        self.closed = self.stopped = False
        self.stop_reason = ""

    def _check_item(self, item):
        if item is not self.item:
            raise AdmissionError("another invocation item")

    def acquire(
        self,
        item,
        kind,
        *,
        deadline=None,
        once=None,
        final=False,
        wait=True,
        priority=10,
    ):
        self._check_item(item)
        cutoff = min(item.deadline, item.deadline if deadline is None else deadline)
        with self.condition:
            self.serial += 1
            ticket = (priority, self.serial)
            self.queue.append(ticket)
            try:
                while True:
                    if self.clock() >= cutoff:
                        raise DeadlineExceeded("original local dispatch deadline")
                    if self.closed or self.stopped:
                        raise AdmissionError(
                            "local invocation stopped; no additional dispatch"
                        )
                    if once and once in self.once_flags:
                        raise AdmissionError("one-shot generation already attempted")
                    if self.calls >= self.limits.logical_requests - (
                        0 if final else self.reserved
                    ):
                        raise AdmissionError(
                            "local protective ceiling or closeout reserve"
                        )
                    active = sum(r["local_active"] for r in self.requests.values())
                    if active >= self.limits.in_flight and not any(
                        r["local_active"] and not r.get("worker_returned")
                        for r in self.requests.values()
                    ):
                        raise AdmissionError(
                            "unsettled_remote_capacity_no_local_observer"
                        )
                    if active < self.limits.in_flight and min(self.queue) == ticket:
                        self.calls += 1
                        if once:
                            self.once_flags.add(once)
                        if final:
                            self.reserved = max(0, self.reserved - 1)
                        lease = Lease(
                            f"local-call-{self.calls:06d}", item.id, cutoff, kind
                        )
                        self.requests[lease.id] = {
                            "lease": lease,
                            "local_active": True,
                            "public_started": False,
                            "outcome": "DISPATCHED",
                            "remote_end": "NOT_EXPOSED",
                            "late": False,
                        }
                        return lease
                    if not wait:
                        raise AdmissionError("local public-call slots busy")
                    self.condition.wait(min(0.05, max(0, cutoff - self.clock())))
            finally:
                self.queue.remove(ticket)
                self.condition.notify_all()

    def may_dispatch(self, lease):
        with self.condition:
            if self.requests.get(lease.id, {}).get("lease") is not lease:
                raise AdmissionError("another invocation lease")
            allowed = (
                not self.closed and not self.stopped and self.clock() < lease.deadline
            )
            if allowed:
                self.requests[lease.id]["public_started"] = True
            return allowed

    def settle_public_call(
        self, lease, *, outcome, finish_reason=None, public_return=False
    ):
        with self.condition:
            row = self.requests.get(lease.id)
            if row is None or row["lease"] is not lease:
                raise AdmissionError("unknown local invocation")
            ended = (
                outcome == "NOT_DISPATCHED"
                or outcome == "CONFIRMED_REJECTION"
                or finish_reason
                in {
                    "stop",
                    "end_turn",
                    "length",
                    "content_filter",
                    "tool_calls",
                    "function_call",
                }
                or (outcome == "RETURNED" and public_return)
            )
            row.update(
                local_active=not ended,
                worker_returned=True,
                outcome=outcome,
                remote_end=finish_reason
                if finish_reason is not None
                else "NOT_EXPOSED",
                late=self.closed or self.clock() >= lease.deadline,
            )
            # Uncertain work still occupies its slot. It does not by itself
            # prohibit unrelated work in another available slot.
            if outcome in {
                "INVALID_PUBLIC_RESPONSE",
                "PUBLIC_CLIENT_CONFIGURATION_ERROR",
            }:
                self.stopped = True
                self.stop_reason = "public_response_contract_unusable"
            self.condition.notify_all()

    def stop_dispatch(self, reason):
        with self.condition:
            self.stopped = True
            self.stop_reason = reason
            self.condition.notify_all()

    def checkpoint(self, item, snapshot):
        self._check_item(item)
        # Store already owns the invocation's working memory. No durable checkpoint
        # or cross-process recovery is promised by this facade.
        with self.condition:
            self.checkpoints += 1
            return not self.closed and self.clock() < item.deadline

    def suggested_soft_seconds(self, item, *, known_total=None):
        self._check_item(item)
        # No inference from idx or presumed test-set size/global progress.
        return item.deadline - item.started

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()

    def metrics(self):
        with self.condition:
            return {
                "scope": "single_solve_invocation",
                "local_admissions": self.calls,
                "public_client_calls": sum(
                    r["public_started"] for r in self.requests.values()
                ),
                "local_calls_still_running": sum(
                    r["local_active"] for r in self.requests.values()
                ),
                "public_calls_with_explicit_terminal_metadata": sum(
                    r["remote_end"] != "NOT_EXPOSED" for r in self.requests.values()
                ),
                "sdk_attempts": None,
                "global_remaining_calls": None,
                "global_in_flight": None,
                "remote_cancellation_confirmed": False,
                "dispatch_stopped": self.stopped,
            }
