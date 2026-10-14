"""G7/PR7 Slice 7a — run carriers at the real public engine="ts" entry."""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]


def _solve(mode, problem):
    agent = user_agent.ReasoningAgent(client=FakeClient(), engine="ts", mode=mode)
    return agent.solve(problem, {"source": "e2e"})


def test_local_and_shared_carriers_run_and_isolate(process_tracker):
    local = _solve("local", "Compute 2+2")
    shared = _solve("shared_public", "Compute 3+5")
    assert local["engine"] == "ts" and local["carrier"] == "local"
    assert shared["engine"] == "ts" and shared["carrier"] == "shared_public"
    # Cross-problem isolation: each run binds its own session.
    assert local["sessionId"] != shared["sessionId"]
    assert process_tracker


def test_unknown_carrier_mode_is_rejected():
    with pytest.raises(ValueError):
        user_agent.ReasoningAgent(client=FakeClient(), engine="ts", mode="weird")
