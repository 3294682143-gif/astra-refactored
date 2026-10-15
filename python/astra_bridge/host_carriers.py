"""G7/PR7 (Slice 7a) — RunC carriers + recovery discipline under the single TS loop.

The official platform, the local runner and the shared_public runner differ only
in their *carrier* (how the run is identified and leased); the math control stays
in the single TS ``runAgentLoop``. This module fixes the carrier invariants the
Host enforces:

- a carrier binds one problem_hash + session + profile + the root budget;
- **recovery restores the same authorization/profile and never resets or widens
  the root budget** (a bigger budget on recovery is a fixed error);
- cross-problem isolation: two carriers never share a session for different
  problems;
- an in-flight ``OUTCOME_UNKNOWN`` is recorded and **never auto-replayed** (no
  blind re-dispatch), matching the request-responsibility journal.

Pure module: no I/O, no network, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

__all__ = [
    "MODES",
    "CarrierError",
    "RunCarrier",
    "bind_carrier",
    "recover_carrier",
    "check_isolation",
    "UnknownOutcomeGuard",
]

MODES = ("platform", "local", "shared_public")


class CarrierError(Exception):
    """Fixed-code carrier failure; never carries raw input."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _bounded_int(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise CarrierError("BUDGET")
    return value


@dataclass(frozen=True)
class RunCarrier:
    mode: str
    problem_hash: str
    session_id: str
    profile_id: str
    max_model_calls: int
    max_work_units: int
    max_effects: int
    root_deadline_ms: int


def bind_carrier(mode, problem_hash, session_id, profile_id, *, max_model_calls,
                 max_work_units, max_effects, root_deadline_ms):
    """Bind one carrier. Unknown modes / malformed identity are fixed errors."""
    if mode not in MODES:
        raise CarrierError("MODE")
    for value, code in ((problem_hash, "PROBLEM_HASH"), (session_id, "SESSION"), (profile_id, "PROFILE")):
        if not isinstance(value, str) or not value.strip():
            raise CarrierError(code)
    if len(problem_hash) != 64 or any(c not in "0123456789abcdef" for c in problem_hash):
        raise CarrierError("PROBLEM_HASH")
    return RunCarrier(
        mode=mode,
        problem_hash=problem_hash,
        session_id=session_id,
        profile_id=profile_id,
        max_model_calls=_bounded_int(max_model_calls, 0, 32),
        max_work_units=_bounded_int(max_work_units, 1, 32),
        max_effects=_bounded_int(max_effects, 0, 2),
        root_deadline_ms=_bounded_int(root_deadline_ms, 1, 3600000),
    )


def recover_carrier(prior: RunCarrier, *, session_id, max_model_calls=None, max_work_units=None,
                    max_effects=None, root_deadline_ms=None):
    """Recover a carrier from a checkpoint.

    The same problem_hash and profile are kept; a new session may be bound. The
    root budget may only *tighten*: any field that would increase above the prior
    value is a fixed ``BUDGET_WIDENED`` error. Recovery never refreshes or
    enlarges the root.
    """
    if not isinstance(prior, RunCarrier):
        raise CarrierError("CARRIER")
    if not isinstance(session_id, str) or not session_id.strip():
        raise CarrierError("SESSION")
    next_budget = {
        "max_model_calls": prior.max_model_calls if max_model_calls is None else max_model_calls,
        "max_work_units": prior.max_work_units if max_work_units is None else max_work_units,
        "max_effects": prior.max_effects if max_effects is None else max_effects,
        "root_deadline_ms": prior.root_deadline_ms if root_deadline_ms is None else root_deadline_ms,
    }
    for field, value in next_budget.items():
        if value > getattr(prior, field):
            raise CarrierError("BUDGET_WIDENED")
    if next_budget["max_work_units"] < 1:
        raise CarrierError("BUDGET")
    return replace(prior, session_id=session_id, **next_budget)


def check_isolation(left: RunCarrier, right: RunCarrier):
    """Cross-problem isolation: different problems never share a session id."""
    if left.problem_hash != right.problem_hash and left.session_id == right.session_id:
        raise CarrierError("CROSS_PROBLEM_SESSION")
    return True


class UnknownOutcomeGuard:
    """Records in-flight OUTCOME_UNKNOWN request ids; refuses any auto-replay."""

    def __init__(self):
        self._unknown = set()

    def record_unknown(self, request_id):
        if not isinstance(request_id, str) or not request_id:
            raise CarrierError("REQUEST_ID")
        self._unknown.add(request_id)

    def may_dispatch(self, request_id):
        """A previously-unknown request id is never blindly re-dispatched."""
        return request_id not in self._unknown

    def unknown(self):
        return tuple(sorted(self._unknown))
