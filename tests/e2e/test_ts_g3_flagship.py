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
TOOL_ARGS = {"expression": "x*(x-1)", "variables": ["x"], "parameters": []}


class G3FlagshipClient(FakeClient):
    """FakeClient: one checker tool, ``{1}`` answer, R2 challenge, ``{0,1}`` repair.

    ``tool_on_candidate`` chooses whether the checker runs on the candidate task
    (S1 passes -> revision) or on a foreign task (S1 refuses -> E07 negative).
    """

    def __init__(self, tool_on_candidate=True):
        super().__init__()
        self.tool_done = False
        self.tool_on_candidate = tool_on_candidate

    def _work(self, body):
        # The bounded S2 repair arrives either as the R2-driven REPAIR stage or as
        # the redo WORK turn carrying revision provenance; both answer with the
        # revised candidate.
        if (body.get("stage") == "REPAIR" or body.get("revisionProvenance")
                or body.get("revisionTarget")):
            return self._packet(body, "the real solution set is {0,1}", "Split the zero product: x=0 or x=1.", "{0,1}")
        task = body["task"]
        on_answer = task["taskId"] == ANSWER_TASK
        # The S1 mapping gate requires the checker to be bound to the candidate
        # task; a checker on a foreign task is a proven E07 mapping failure.
        if not self.tool_done and on_answer == self.tool_on_candidate:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": TOOL_ARGS,
                    "scope": "check the supplied polynomial against the original problem",
                }
            )
        if on_answer:
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
        max_model_calls=7,
        max_work_units=4,
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
        max_model_calls=7,
        max_work_units=4,
    )
    assert result["status"] == "candidate"
    assert result["final_response"] == "{1}"
    assert result["reason"] == "BEST_EFFORT_CANDIDATE"
    assert result["candidate_verified"] is False
    assert process_tracker


def test_public_entry_e07_foreign_checker_cannot_ground_a_revision(process_tracker):
    """E07: the M5 S1 mapping gate refuses a checker bound to a foreign task.

    The checker returns a COMPLETE PROGRAM_OBSERVATION, but it is not bound to
    the candidate task, so S1 records no structural match: no REPAIR call is
    made, the candidate is not upgraded and strict acceptance is not performed.
    """
    client = G3FlagshipClient(tool_on_candidate=False)
    result = _solve(
        client,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        max_model_calls=7,
        max_work_units=4,
    )
    assert result["status"] == "candidate"
    assert result["final_response"] == "{1}"
    assert result["reason"] == "BEST_EFFORT_CANDIDATE"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert process_tracker


# ---------------------------------------------------------------------------
# G3/PR4 Slice 3c — the multi-gap (PARAMETER two-gap) public-entry flagship.
#
# DECISION-0150 ruling B3 (option b): the trusted gap source is a PARAMETER
# goal's trusted branches (`<p>=0`, `<p>!=0`). The single REPAIR call must
# restate EVERY trusted branch; a partial revision that leaves a proven branch
# open is refused (`REVISE_REJECTED`, parent candidate kept), a complete one is
# accepted (`REVISED_CANDIDATE`).
# ---------------------------------------------------------------------------

PARAM_PROBLEM = "Classify the number of solutions of x^2=p in terms of the parameter p"
PARAM_ANSWER_TASK = "goal-1:OUTPUT_COVERAGE"
PARAM_TOOL_ARGS = {"expression": "x^2-p", "variables": ["x"], "parameters": ["p"]}


class MultiGapParamClient(FakeClient):
    """FakeClient: one checker, a partial ``p=0`` candidate, R2 challenge, repair."""

    def __init__(self, repair_answer):
        super().__init__()
        self.tool_done = False
        self.repair_answer = repair_answer

    def _work(self, body):
        # The bounded S2 repair arrives either as the R2-driven REPAIR stage or as
        # the redo WORK turn carrying revision provenance; both answer with the
        # revised candidate.
        if (body.get("stage") == "REPAIR" or body.get("revisionProvenance")
                or body.get("revisionTarget")):
            return self._packet(
                body,
                "classification of x^2=p",
                "split on the parameter p",
                self.repair_answer,
            )
        task = body["task"]
        on_answer = task["taskId"] == PARAM_ANSWER_TASK
        if not self.tool_done and on_answer:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": PARAM_TOOL_ARGS,
                    "scope": "check the supplied polynomial against the original problem",
                }
            )
        if on_answer:
            # The initial answer covers only one trusted branch (partial).
            return self._packet(body, "classification", "branch analysis", "p=0: zero solutions")
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
        return json.dumps(
            {
                "schemaVersion": "p4-review-v1",
                "requestId": body["requestId"],
                "target": body["target"],
                "targetHash": body["targetHash"],
                "stage": "R2",
                "conclusion": "ISSUES",
                "reviewCoverage": [PARAM_ANSWER_TASK],
                "issues": [
                    {
                        "stepLocator": {"start": 0, "end": 4, "quote": body["derivation"][:4]},
                        "suspectedIssue": "MISSING_CASE",
                        "rationale": "the p!=0 branch is not classified",
                        "requestedCheck": "classify the parameter branch p!=0",
                        "obligationIds": [PARAM_ANSWER_TASK],
                    }
                ],
            }
        )


def _solve_param(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PARAM_PROBLEM, {"source": "e2e"})


def test_public_entry_multi_gap_complete_repair_revises_the_candidate(process_tracker):
    client = MultiGapParamClient("p!=0: two solutions; p=0: one solution")
    result = _solve_param(
        client,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        # The answer task is the fourth work unit, so the bounded redo needs a
        # fifth unit of its own plus the review and repair calls.
        max_model_calls=10,
        max_work_units=5,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "p!=0: two solutions; p=0: one solution"
    assert result["reason"] == "REVISED_CANDIDATE"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert process_tracker


def test_public_entry_multi_gap_partial_repair_is_refused(process_tracker):
    client = MultiGapParamClient("p=0: one solution only")
    result = _solve_param(
        client,
        max_reviews=1,
        max_repairs=1,
        max_effects=1,
        # The answer task is the fourth work unit, so the bounded redo needs a
        # fifth unit of its own plus the review and repair calls.
        max_model_calls=10,
        max_work_units=5,
    )
    assert result["engine"] == "ts"
    # The partial repair leaves the p!=0 branch uncovered: fail-closed, the
    # parent candidate is kept and strict acceptance is not performed.
    assert result["final_response"] == "p=0: zero solutions"
    assert result["reason"] == "REVISE_REJECTED"
    assert result["candidate_verified"] is False
    assert process_tracker
