"""Real public ``engine="ts"`` entry E2E for trusted parameter boundaryCases.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run.

A PARAMETER problem carries trusted parameter branches (the special value and
the ordinary case) in its goal scope. A declared ``boundaryCases`` set must name
exactly those trusted branches; a missing, forged, partial or extra boundary set
is a fixed rejection, and the model's own claim never establishes coverage.
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

PARAMETER_PROBLEM = "Classify the parameter a in the equation a*x=1"
PARAMETER_ANSWER = "a>0: one solution; a=0: no solution; a<0: one solution"


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


class BoundaryClient(FakeClient):
    """FakeClient whose first WORK turn declares a v5 parameter coverage row."""

    def __init__(self, boundary):
        super().__init__()
        self.boundary = boundary

    def _work(self, body):
        text = super()._work(body)
        packet = json.loads(text)
        task = body["task"]["taskId"]
        if body["sourceRequestId"] == "model-1":
            packet["schemaVersion"] = "p2a-work-v5"
            packet["workflowProposal"] = None
            packet["scopeProposal"] = {
                "kind": "SCOPE_REFINEMENT",
                "quantifiers": [],
                "branchConditions": [],
                "boundaryCases": list(self.boundary),
                "goalExhaustion": [],
                "rationale": "declared parameter branches",
            }
        if task == "goal-1:OUTPUT_COVERAGE":
            packet["candidateProposal"] = PARAMETER_ANSWER
        return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))


def test_trusted_boundary_cases_complete_the_parameter_answer(process_tracker):
    """Exactly the trusted parameter branches are accepted."""
    client = BoundaryClient(["a=0", "a!=0"])
    result = _solve(client, PARAMETER_PROBLEM, derive_budget=True)
    assert result["status"] == "candidate"
    assert result["final_response"] == PARAMETER_ANSWER
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize(
    "boundary",
    [[], ["bogus"], ["a=0"], ["a=0", "a!=0", "extra"]],
)
def test_missing_or_forged_boundary_cases_never_release_a_candidate(
    boundary, process_tracker
):
    """A missing, forged, partial or extra boundary set is refused."""
    client = BoundaryClient(boundary)
    result = _solve(client, PARAMETER_PROBLEM, derive_budget=True)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
