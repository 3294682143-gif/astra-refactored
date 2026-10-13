"""Real public ``engine="ts"`` E2E: the complete whole-problem answer capability.

A two-part MULTIPART problem and a parameter-classification PARAMETER problem
must run to the ROOT aggregation task within a budget derived from the compiled
task graph (``derive_budget=True``), and the released whole-problem candidate
must be that aggregation -- never a single sub-answer or a local boundary step.
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
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

MULTIPART_PROBLEM = "Solve both parts: (a) compute 2+2 and (b) compute 3+3"
PARAMETER_PROBLEM = "Classify the parameter a in the equation a*x=1"
MULTIPART_ANSWER = "part (a): 4; part (b): 6"
PARAMETER_ANSWER = "a>0: one solution; a=0: no solution; a<0: one solution"


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


class AggregationClient(FakeClient):
    """FakeClient whose ROOT aggregation task carries the whole-problem answer.

    Every local step carries a plain COMPLETE packet with no candidate, so the
    only possible whole-problem candidate is the root OUTPUT_COVERAGE packet
    (which depends on every branch). ``incomplete_task`` can drop one branch to
    prove a missing branch never releases a candidate.
    """

    def __init__(self, answer, incomplete_task=None):
        super().__init__()
        self.answer = answer
        self.incomplete_task = incomplete_task

    def _work(self, body):
        text = super()._work(body)
        packet = json.loads(text)
        task = body["task"]["taskId"]
        packet["candidateProposal"] = (
            self.answer if task == "goal-1:OUTPUT_COVERAGE" else None
        )
        if self.incomplete_task is not None and task == self.incomplete_task:
            packet["deliveryStatus"] = "INCOMPLETE"
            packet["candidateProposal"] = None
        return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))


def test_multipart_returns_the_complete_two_part_answer(process_tracker):
    """A two-part problem releases the root aggregation as the whole answer."""
    client = AggregationClient(MULTIPART_ANSWER)
    result = _solve(client, MULTIPART_PROBLEM, derive_budget=True)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == MULTIPART_ANSWER
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    assert process_tracker[0].args[2] == "--agent-loop"
    # Every branch really ran to the aggregation.
    assert result["metrics"]["work_units"] >= 8


def test_parameter_returns_the_complete_classification(process_tracker):
    """A parameter-classification problem releases the root aggregation."""
    client = AggregationClient(PARAMETER_ANSWER)
    result = _solve(client, PARAMETER_PROBLEM, derive_budget=True)
    assert result["status"] == "candidate"
    assert result["final_response"] == PARAMETER_ANSWER
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


def test_preview_budget_cannot_finish_a_two_part_problem(process_tracker):
    """Without the derived budget the preview profile cannot reach aggregation."""
    client = AggregationClient(MULTIPART_ANSWER)
    result = _solve(client, MULTIPART_PROBLEM, max_model_calls=4, max_work_units=3)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


def test_missing_branch_never_releases_a_candidate(process_tracker):
    """A dropped branch keeps the aggregation unbound, so no candidate exists."""
    client = AggregationClient(
        MULTIPART_ANSWER, incomplete_task="goal-1-a:CANDIDATE_VALIDITY"
    )
    result = _solve(client, MULTIPART_PROBLEM, derive_budget=True)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
