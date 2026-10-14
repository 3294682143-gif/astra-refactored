"""G7/PR7 Slice 7a — run carrier + recovery discipline unit tests."""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import host_carriers as c  # noqa: E402

H = "a" * 64
H2 = "b" * 64


def _bind(mode="local", problem_hash=H, session="s1"):
    return c.bind_carrier(
        mode, problem_hash, session, "math-lite",
        max_model_calls=8, max_work_units=3, max_effects=1, root_deadline_ms=5000,
    )


def test_bind_rejects_unknown_mode_and_bad_hash():
    with pytest.raises(c.CarrierError) as e:
        _bind(mode="weird")
    assert e.value.code == "MODE"
    with pytest.raises(c.CarrierError):
        _bind(problem_hash="short")


def test_modes_include_local_and_shared_public():
    assert set(c.MODES) == {"platform", "local", "shared_public"}
    for mode in c.MODES:
        assert _bind(mode=mode).mode == mode


def test_recovery_keeps_authorization_and_never_widens_budget():
    prior = _bind()
    # Same profile/problem, new session, equal-or-tighter budget is allowed.
    tighter = c.recover_carrier(prior, session_id="s2", max_model_calls=4, root_deadline_ms=3000)
    assert tighter.problem_hash == prior.problem_hash
    assert tighter.profile_id == prior.profile_id
    assert tighter.session_id == "s2"
    assert tighter.max_model_calls == 4 and tighter.root_deadline_ms == 3000
    # Widening the root budget on recovery is a fixed error.
    for kwargs in ({"max_model_calls": 9}, {"max_work_units": 4}, {"root_deadline_ms": 5001}):
        with pytest.raises(c.CarrierError) as e:
            c.recover_carrier(prior, session_id="s3", **kwargs)
        assert e.value.code == "BUDGET_WIDENED"


def test_cross_problem_isolation():
    a = _bind(problem_hash=H, session="shared")
    b = _bind(problem_hash=H2, session="shared")
    with pytest.raises(c.CarrierError) as e:
        c.check_isolation(a, b)
    assert e.value.code == "CROSS_PROBLEM_SESSION"
    # The same problem may reuse a session; different sessions are always fine.
    c.check_isolation(a, _bind(problem_hash=H, session="other"))


def test_unknown_outcome_is_never_auto_replayed():
    guard = c.UnknownOutcomeGuard()
    assert guard.may_dispatch("model-1") is True
    guard.record_unknown("model-1")
    assert guard.may_dispatch("model-1") is False
    assert guard.unknown() == ("model-1",)
