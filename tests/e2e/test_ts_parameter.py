"""Real public ``engine="ts"`` entry E2E for the PARAMETER goal class.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run; the legacy Python solvers are
replaced by raising stubs.

A parameter-classification problem must leave ``UNKNOWN`` and compile to
``PARAMETER`` with a real ``BOUNDARY_EXCEPTIONS`` duty (the parameter boundary
and special-value obligation). Non-parameter problems must keep their class.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

PARAMETER_PROBLEM = "Classify the parameter a in the equation a*x=1"

_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


def _work_bodies(client):
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


def _kinds(client):
    return [body["task"]["obligationId"].split(":", 1)[-1] for body in _work_bodies(client)]


def test_parameter_problem_has_a_boundary_duty(process_tracker):
    """A parameter problem runs a real BOUNDARY_EXCEPTIONS task, not UNKNOWN."""
    client = FakeClient()
    result = _solve(client, PARAMETER_PROBLEM, **_BUDGET)
    assert result["engine"] == "ts"
    assert result["childReaped"] is True
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    kinds = _kinds(client)
    assert kinds
    assert "BOUNDARY_EXCEPTIONS" in kinds
    assert "ANSWER_REQUEST" not in kinds


def test_non_parameter_problems_have_no_boundary_duty(process_tracker):
    """``Compute 2+2`` and a real multi-part problem never gain a boundary duty."""
    for problem in ("Compute 2+2", "Solve both parts: (a) compute 2+2 and (b) compute 3+3"):
        client = FakeClient()
        _solve(client, problem, **_BUDGET)
        kinds = _kinds(client)
        assert kinds
        assert "BOUNDARY_EXCEPTIONS" not in kinds
    assert process_tracker
