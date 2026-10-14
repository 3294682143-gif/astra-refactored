"""G3/PR4 flagship at the real public ``engine="ts"`` entry: evidence-gated revision.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run.

One ALL_SOLUTIONS problem ``x(x-1)=0``: the model first answers the answer
(EXHAUSTIVENESS) obligation with ``{1}``, an independent ``R2`` review raises a
missing-case challenge, and the single authorized ``REPAIR`` call re-states the
answer as ``{0,1}``. The protected candidate is replaced ONLY because a
Host-accepted checker observation (a real registered tool bound to the original
problem) grounds the revision; the valid ``x=1`` material stays in history.
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

PROBLEM = "Find all real solutions x(x-1)=0"
ANSWER_TASK = "goal-1:EXHAUSTIVENESS"
TOOL_ARGS = {"expression": "2+2", "variables": ["x"], "parameters": []}


class G3FlagshipClient(FakeClient):
    """FakeClient: one checker tool, ``{1}`` answer, R2 challenge, ``{0,1}`` repair."""

    def __init__(self):
        super().__init__()
        self.tool_done = False

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return self._packet(body, "the real solution set is {0,1}", "Split the zero product: x=0 or x=1.", "{0,1}")
        if not self.tool_done:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": TOOL_ARGS,
                    "scope": "check the supplied polynomial at the zero branch",
                }
            )
        task = body["task"]
        if task["taskId"] == ANSWER_TASK:
            return self._packet(body, "x=1 only", "Take the root x=1.", "{1}")
        return self._packet(body, "prerequisite", "prerequisite", None)

    def _packet(self, body, claim, derivation, candidate):
        return json.dumps(
            {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": body["task"]["taskId"],
                "goalId": body["task"]["goalId"],
                "scopeId": body["task"]["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": claim,
                "derivation": derivation,
                "assumptions": [],
                "dependencies": body["task"]["inputArtifactRefs"],
                "pendingObligations": [],
                "suggestedChecks": [],
                "deliveryStatus": "COMPLETE",
                "candidateProposal": candidate,
            }
        )

    def _review(self, body):
        derivation = body["derivation"]
        return json.dumps(
            {
                "schemaVersion": "p4-review-v1",
                "requestId": body["requestId"],
                "target": body["target"],
                "targetHash": body["targetHash"],
                "stage": "R2",
                "conclusion": "ISSUES",
                "reviewCoverage": [ANSWER_TASK],
                "issues": [
                    {
                        "stepLocator": {"start": 0, "end": 4, "quote": derivation[:4]},
                        "suspectedIssue": "MISSING_CASE",
                        "rationale": "x=0 satisfies the zero product and was not reported",
                        "requestedCheck": "substitute x=0 into the original equation",
                        "obligationIds": [ANSWER_TASK],
                    }
                ],
            }
        )


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def test_public_entry_evidence_gated_revision_releases_the_complete_answer(process_tracker):
    client = G3FlagshipClient()
    result = _solve(
        client,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "{0,1}"
    assert result["reason"] == "REVISED_CANDIDATE"
    assert result["stopReason"] == "REVISED_CANDIDATE"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["metrics"]["review_calls"] == 1
    assert process_tracker


def test_public_entry_without_repair_budget_keeps_the_first_candidate(process_tracker):
    client = G3FlagshipClient()
    # max_repairs defaults to 0: the challenge can never replace the candidate.
    result = _solve(
        client,
        max_reviews=1,
        max_effects=1,
        max_model_calls=6,
        max_work_units=3,
    )
    assert result["status"] == "candidate"
    assert result["final_response"] == "{1}"
    assert result["reason"] == "BEST_EFFORT_CANDIDATE"
    assert result["candidate_verified"] is False
    assert process_tracker
