"""Trusted RC Package regressions (defect 1 budget + defect 2 STRICT/S1 gate).

The only fake is the injected public client. Every case runs the real
``user_agent.ReasoningAgent`` path, the real Python Host, the real registered
tool executor and the real Node ``main.js --agent-loop`` profile.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

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


# --- Step 1: format / empty-set / completeness bypasses -----------------------


class RepairProposalClient(G3FlagshipClient):
    """Flagship with the REPAIR answer freely chosen (to probe S1 semantics)."""

    def __init__(self, proposal):
        super().__init__()
        self.proposal = proposal

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "claim", "derivation", self.proposal)
        return super()._work(body)


BYPASS_PROPOSALS = ["999", "x = 999", "{}", "{0}", "{0, 999}"]


@pytest.mark.parametrize("proposal", BYPASS_PROPOSALS)
def test_s1_bypass_proposals_rejected_best_effort(process_tracker, proposal):
    client = RepairProposalClient(proposal)
    result = _solve(
        client, G3_PROBLEM,
        max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
    )
    assert result["final_response"] == "{1}"
    assert result["stopReason"] == "REVISE_REJECTED"
    assert process_tracker


@pytest.mark.parametrize("proposal", BYPASS_PROPOSALS)
def test_s1_bypass_proposals_rejected_strict(process_tracker, proposal):
    client = RepairProposalClient(proposal)
    result = _solve(
        client, G3_PROBLEM, policy="STRICT",
        max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
    )
    assert result["final_response"] != proposal
    assert result["stopReason"] == "REVISE_REJECTED"
    assert process_tracker


def test_s1_complete_revision_is_accepted_best_effort(process_tracker):
    client = RepairProposalClient("{0,1}")
    result = _solve(
        client, G3_PROBLEM,
        max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
    )
    assert result["final_response"] == "{0,1}"
    assert result["reason"] == "REVISED_CANDIDATE"
    assert process_tracker


# --- P0-1: exact solution-set acceptance (dedup, completeness, fail-closed) ---


class RepairCaseClient(G3FlagshipClient):
    """Flagship with a chosen checker expression, parent candidate and repair."""

    def __init__(self, expression, parent, proposal, answer_task="goal-1:EXHAUSTIVENESS"):
        super().__init__()
        self.expression = expression
        self.parent = parent
        self.proposal = proposal
        self.answer_task = answer_task

    def _review(self, body):
        obligation_id = self.answer_task
        derivation = body["derivation"]
        return json.dumps(
            {
                "schemaVersion": "p4-review-v1",
                "requestId": body["requestId"],
                "target": body["target"],
                "targetHash": body["targetHash"],
                "stage": "R2",
                "conclusion": "ISSUES",
                "reviewCoverage": [obligation_id],
                "issues": [
                    {
                        "stepLocator": {"start": 0, "end": 4, "quote": derivation[:4]},
                        "suspectedIssue": "MISSING_CASE",
                        "rationale": "a required case was omitted",
                        "requestedCheck": "substitute the missing value into the original equation",
                        "obligationIds": [obligation_id],
                    }
                ],
            }
        )

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "claim", "derivation", self.proposal)
        on_answer = body["task"]["taskId"] == self.answer_task
        if not self.tool_done and on_answer:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": {"expression": self.expression, "variables": ["x"], "parameters": []},
                    "scope": "check the supplied polynomial against the original problem",
                }
            )
        if on_answer:
            return self._packet(body, "claim", "derivation", self.parent)
        return self._packet(body, "prerequisite", "prerequisite", None)


def _solve_problem(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


_KW = dict(max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3)

# (problem, relation expression, parent, repair proposal, expected)
_EX = "goal-1:EXHAUSTIVENESS"
_OC = "goal-1:OUTPUT_COVERAGE"
_SOLUTION_CASES = [
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{0,1}", "candidate", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{1,0,1}", "candidate", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{1,1}", "reject", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{0}", "reject", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{}", "reject", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "{1}", "{0,1,1/2}", "reject", _EX),
    ("Find all real solutions x(x-1)=0", "x*(x-1)", "x=1", "999", "reject", _EX),
    ("Find all real solutions x(x-1)(x-2)=0", "x*(x-1)*(x-2)", "{1}", "{1,2}", "reject", _EX),
    ("Find all real solutions x(x-1)(x-2)=0", "x*(x-1)*(x-2)", "{1}", "{0,1,2}", "candidate", _EX),
    ("Find all real solutions 2x-1=0", "2*x-1", "{0}", "{1/2}", "candidate", _EX),
    ("Find all real solutions 2x-1=0", "2*x-1", "{0}", "{0.5}", "candidate", _EX),
    ("Find all real solutions 2x-1=0", "2*x-1", "{0}", "{1}", "reject", _EX),
    ("Find all real solutions x^2+1=0", "x^2+1", "{0}", "{0}", "reject", _EX),
]


@pytest.mark.parametrize("problem,expression,parent,proposal,expected,answer_task", _SOLUTION_CASES)
def test_solution_set_acceptance(process_tracker, problem, expression, parent, proposal, expected, answer_task):
    client = RepairCaseClient(expression, parent, proposal, answer_task)
    result = _solve_problem(client, problem, **_KW)
    if expected == "candidate":
        assert result["status"] == "candidate", (problem, proposal, result.get("stopReason"))
        assert result["reason"] == "REVISED_CANDIDATE"
    else:
        assert result["stopReason"] == "REVISE_REJECTED", (problem, proposal, result.get("reason"))
        assert result["final_response"] == parent
    # A repair never promotes the global verification level.
    assert result["candidate_verified"] is False
    assert process_tracker
