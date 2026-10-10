"""Public transport ports, independent of coordination backend and model protocol."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Protocol

from .coordinator import AdmissionError, Item, Lease


@dataclass(frozen=True)
class PublicCallPolicy:
    max_input_chars: int = 64000
    max_response_chars: int = 65536

    def __post_init__(self):
        for value, maximum in (
            (self.max_input_chars, 64000),
            (self.max_response_chars, 65536),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError("invalid public call resource bound")


class PublicCoordinator(Protocol):
    """Controller owns math; transport owns no independent resource budget."""

    def acquire(self, item: Item, kind: str, **options) -> Lease: ...
    def may_dispatch(self, lease: Lease) -> bool: ...
    def settle_public_call(self, lease: Lease, **receipt) -> None: ...
    def checkpoint(self, item: Item, snapshot: dict) -> bool: ...
    def suggested_soft_seconds(self, item: Item, *, known_total=None) -> float: ...
    def stop_dispatch(self, reason: str) -> None: ...
    def metrics(self) -> dict: ...
    def close(self) -> None: ...


# Control-plane association in the actual call thread. Never sent in messages or
# to an unmodified official client's kwargs. An observer can reuse this lease.
_binding = ContextVar("mathagent_public_call_binding", default=None)


@contextmanager
def public_call_binding(coordinator, lease):
    token = _binding.set((getattr(coordinator, "authority", coordinator), lease))
    try:
        yield
    finally:
        _binding.reset(token)


def current_public_lease(authority, item):
    binding = _binding.get()
    if binding is None:
        return None
    bound_authority, lease = binding
    # Backward-compatible diagnostic composition: an item-only guard is not a
    # global authority and never spends SQLite quota. Production shared mode
    # binds the actual authority and reuses exactly one authoritative lease.
    from .platform_coordinator import PlatformItemCoordinator

    if isinstance(bound_authority, PlatformItemCoordinator):
        return None
    if bound_authority is not authority or lease.item_id != item.id:
        raise AdmissionError("observer authority/item does not match public lease")
    return lease


def current_public_request_metadata():
    """Explicit observer port in the actual dispatch thread; no prompt scanning."""
    binding = _binding.get()
    if binding is None:
        return None
    coordinator, lease = binding
    getter = getattr(coordinator, 'public_request_metadata', None)
    return getter(lease) if callable(getter) else {'kind': lease.kind, 'deadline': lease.deadline, 'lease_id': lease.id}


class SharedPublicCoordinator:
    """Explicit item facade over SQLite; never pretend it is an item-only guard."""

    def __init__(
        self, authority, item, *, public_return_settles=False, budget_observer=None
    ):
        self.authority, self.item = authority, item
        self.limits, self.clock = authority.limits, authority.clock
        self.hard_deadline = item.deadline
        self.policy = PublicCallPolicy()
        self.public_return_settles = public_return_settles
        self.budget_observer = budget_observer

    def _check_item(self, item):
        if item != self.item:
            raise AdmissionError("another shared item")

    def acquire(self, item, kind, **options):
        self._check_item(item)
        return self.authority.acquire(item, kind, **options)

    def may_dispatch(self, lease):
        self._check_item(Item(lease.item_id, self.item.started, self.item.deadline))
        return self.authority.may_dispatch(lease)

    def settle_public_call(
        self, lease, *, outcome, finish_reason=None, public_return=False
    ):
        ended = (
            outcome == "NOT_DISPATCHED"
            or finish_reason
            in {
                "stop",
                "end_turn",
                "length",
                "content_filter",
                "tool_calls",
                "function_call",
            }
            or (outcome == "RETURNED" and public_return and self.public_return_settles)
        )
        self.authority.finish(
            lease,
            status="FINISHED" if outcome == "RETURNED" else "FAILED",
            detail=outcome if ended else "public_remote_state_unknown",
            confirmed_ended=ended,
            local_worker_ended=True,
        )
        # The shared ledger retains unknown permits. A single failed/late role
        # does not stop unrelated work with legal capacity; runner configuration
        # failures and hard deadlines have separate durable stop reasons.
        if outcome in {"INVALID_PUBLIC_RESPONSE", "PUBLIC_CLIENT_CONFIGURATION_ERROR"}:
            self.stop_dispatch("public_response_contract_unusable")

    def stop_dispatch(self, reason):
        self.authority.stop_dispatch(reason, item=self.item)

    def checkpoint(self, item, snapshot):
        self._check_item(item)
        return self.authority.checkpoint(item, snapshot)

    def suggested_soft_seconds(self, item, *, known_total=None):
        self._check_item(item)
        value = self.authority.suggested_soft_seconds(item, known_total=known_total)
        if self.budget_observer is not None:
            self.budget_observer(
                {"known_total": known_total, "soft_seconds": value, "at": self.clock()}
            )
        return value

    def close(self):
        self.stop_dispatch("item_closed_no_new_generation")

    def metrics(self):
        values = self.authority.metrics()
        return {
            "scope": "shared_same_host_run",
            "global_logical_admissions": values["calls"],
            "global_remaining_calls": max(
                0, self.limits.logical_requests - values["calls"]
            ),
            "global_in_flight": values["in_flight"],
            "open_items": values["open_items"],
            "sdk_attempts": None,
            "remote_cancellation_confirmed": False,
        }
