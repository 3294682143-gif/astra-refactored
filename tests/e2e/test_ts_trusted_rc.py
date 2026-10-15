"""Trusted RC Package regressions (defect 1 budget + defect 2 STRICT/S1 gate).

The only fake is the injected public client. Every case runs the real
``user_agent.ReasoningAgent`` path, the real Python Host, the real registered
tool executor and the real Node ``main.js --agent-loop`` profile.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)
from test_ts_g3_flagship import (  # noqa: E402
    ANSWER_TASK,
    G3FlagshipClient,
)

__all__ = ["no_legacy_solver", "process_tracker"]

G3_PROBLEM = "Find all real solutions x(x-1)=0"
UNRELATED_TOOL_ARGS = {"expression": "2+2", "variables": ["x"], "parameters": []}


class UnrelatedRepair999Client(G3FlagshipClient):
    """An unrelated ``2+2`` checker plus a REPAIR proposal of unverified ``{999}``."""

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "2+2=4", "constant arithmetic, unrelated to the problem", "{999}")
        task = body["task"]
        on_answer = task["taskId"] == ANSWER_TASK
        if not self.tool_done and on_answer:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": UNRELATED_TOOL_ARGS,
                    "scope": "unrelated constant check (2+2)",
                }
            )
        if on_answer:
            return self._packet(body, "x=1 only", "Take the root x=1.", "{1}")
        return self._packet(body, "prerequisite", "prerequisite", None)


class RelatedRepair999Client(G3FlagshipClient):
    """A genuinely problem-bound checker, but the REPAIR proposes unverified ``{999}``."""

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "2+2=4", "constant arithmetic", "{999}")
        return super()._work(body)


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


# --- defect 1: long budget contract ---------------------------------------


def test_long_budget_initializes_and_solves(process_tracker):
    """6s / 60s root budgets must initialize and complete a real multi-turn run."""
    for seconds in (6, 60):
        client = FakeClient()
        result = _solve(client, PROBLEM, problem_seconds=seconds)
        assert result["engine"] == "ts", seconds
        assert result["status"] == "candidate", (seconds, result.get("code"))
        assert result["final_response"] == "4", seconds
        assert result["metrics"]["logical_model_calls"] >= 2, seconds
        assert process_tracker


# --- defect 2(a): S1 relevance --------------------------------------------


def test_unrelated_checker_cannot_ground_a_revision(process_tracker):
    """A valid-but-unrelated ``2+2=4`` observation must never ground a revision."""
    client = UnrelatedRepair999Client()
    result = _solve(
        client,
        G3_PROBLEM,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "{1}"
    assert result["reason"] == "BEST_EFFORT_CANDIDATE"
    assert result["candidate_verified"] is False
    assert process_tracker


# --- defect 2(b): STRICT final gate ---------------------------------------


def test_strict_never_returns_an_unverified_repair(process_tracker):
    """Under STRICT an unverified REPAIR revision must be blocked, never returned."""
    client = RelatedRepair999Client()
    result = _solve(
        client,
        G3_PROBLEM,
        policy="STRICT",
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "unsolved"
    assert result["final_response"] != "{999}"
    assert result["reason"] == "STRICT_NOT_VERIFIED"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert process_tracker


def test_strict_also_blocks_the_ordinary_candidate(process_tracker):
    """Without any verified scope check STRICT withholds even the first candidate."""
    client = G3FlagshipClient()
    result = _solve(
        client,
        G3_PROBLEM,
        policy="STRICT",
        max_reviews=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["status"] == "unsolved"
    assert result["final_response"] != "{0,1}"
    assert result["reason"] == "STRICT_NOT_VERIFIED"
    assert process_tracker


# --- Deep defect 1: a variable-but-unrelated expression must not ground {999} ---


class UnrelatedVarRepair999Client(G3FlagshipClient):
    """A checker on `x+999` (mentions x but is not the problem relation)."""

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "x+999", "unrelated variable expression", "{999}")
        task = body["task"]
        on_answer = task["taskId"] == ANSWER_TASK
        if not self.tool_done and on_answer:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": {"expression": "x+999", "variables": ["x"], "parameters": []},
                    "scope": "unrelated variable expression (x+999)",
                }
            )
        if on_answer:
            return self._packet(body, "x=1 only", "Take the root x=1.", "{1}")
        return self._packet(body, "prerequisite", "prerequisite", None)


def test_unrelated_variable_expression_is_rejected_best_effort(process_tracker):
    """BEST_EFFORT must NOT replace the protected {1} with an unverified {999}."""
    client = UnrelatedVarRepair999Client()
    result = _solve(
        client,
        G3_PROBLEM,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["final_response"] == "{1}"
    assert result["final_response"] != "{999}"
    assert result["stopReason"] == "REVISE_REJECTED"
    assert process_tracker


def test_unrelated_variable_expression_is_rejected_strict(process_tracker):
    client = UnrelatedVarRepair999Client()
    result = _solve(
        client,
        G3_PROBLEM,
        policy="STRICT",
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["final_response"] != "{999}"
    assert result["stopReason"] == "REVISE_REJECTED"
    assert process_tracker
