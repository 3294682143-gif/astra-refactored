"""Real public ``engine="ts"`` entry E2E for scope-coverage semantics.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers are
replaced by raising stubs, so a hidden fallback surfaces as a failure.

The three problems below exercise the second-batch scope semantics:

1. a multi-part problem whose sub-answers must never masquerade as the whole
   answer;
2. a multi-part problem with a missing sub-goal, whose "all sub-goals" duty
   must stay open;
3. a parameter-classification problem whose boundary duty must be established
   and whose pseudo "all solutions" strict acceptance must be blocked.

Every reply is a plain COMPLETE packet. A declared ``scopeCoverage`` row is
carried by the WORK context as declared data only: it never closes an
obligation, never changes the ready set and is never a coverage proof.
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

# A MULTIPART root with two leaf sub-goals: the compiled contract carries one
# SUBGOAL_COVERAGE obligation per child plus the root OUTPUT_COVERAGE duty.
MULTIPART_PROBLEM = "Solve both parts: (a) compute 2+2 and (b) compute 3+3"

# A parameter-classification problem: the conservative template yields UNKNOWN,
# so the contract carries ANSWER_REQUEST plus OUTPUT_COVERAGE only.
PARAMETER_PROBLEM = "Classify the parameter a in the equation a*x=1"

_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


class ScopeClient(FakeClient):
    """FakeClient that answers one sub-goal and declares its scope coverage.

    ``mode`` selects which boundary the reply exercises:

    - ``subanswer``: one SUBGOAL_COVERAGE task carries a candidate while the
      root OUTPUT_COVERAGE duty stays open, so no whole-problem candidate may
      exist.
    - ``missing_subgoal``: the same, with the second sub-goal never answered.
    - ``boundary``: the ANSWER_REQUEST task carries a candidate that claims
      every parameter class, so the strict acceptance must be blocked.
    """

    def __init__(self, mode="subanswer"):
        super().__init__()
        self.mode = mode
        self.rawtexts = {}

    def _work(self, body):
        task = body["task"]
        obligation_kind = task["obligationId"].split(":", 1)[-1]
        is_subgoal = obligation_kind == "SUBGOAL_COVERAGE"
        is_answer = obligation_kind == "ANSWER_REQUEST"
        packet = {
            "schemaVersion": "p2a-work-v1",
            "sessionId": body["sessionId"],
            "problemHash": body["problemHash"],
            "contractVersion": body["contractVersion"],
            "taskId": task["taskId"],
            "goalId": task["goalId"],
            "scopeId": task["scopeId"],
            "routeId": body["route"]["routeId"],
            "sourceRequestId": body["sourceRequestId"],
            "claim": "local step: " + obligation_kind,
            "derivation": "local derivation: " + obligation_kind,
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": None,
        }
        if self.mode in ("subanswer", "missing_subgoal") and is_subgoal:
            packet["claim"] = "part (a) is 4"
            packet["derivation"] = "direct evaluation of the first part"
            packet["candidateProposal"] = "4"
        if self.mode == "boundary" and is_answer:
            packet["claim"] = "every parameter class is covered"
            packet["derivation"] = "the boundary case a=0 is excluded"
            packet["candidateProposal"] = "a=0 is excluded"
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.rawtexts[body["sourceRequestId"]] = text
        return text


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


def test_subanswer_never_masquerades_as_whole_answer(process_tracker):
    """One sub-answer must not become the whole-problem candidate."""
    client = ScopeClient(mode="subanswer")
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["engine"] == "ts"
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    assert process_tracker[0].args[2] == "--agent-loop"
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert body["scopeCoverage"] == []
        assert body["task"]["taskId"] != "goal-1:OUTPUT_COVERAGE" or body[
            "task"
        ]["delivery"] == "RUNNING"


def test_missing_subgoal_keeps_all_subgoals_duty_open(process_tracker):
    """A missing sub-goal must not close the all-sub-goals duty."""
    client = ScopeClient(mode="missing_subgoal")
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    # The root coverage duty is never delivered as a whole answer.
    for body in bodies:
        assert body["task"]["taskId"] != "goal-1:OUTPUT_COVERAGE" or body[
            "task"
        ]["delivery"] == "RUNNING"
        assert body["scopeCoverage"] == []


def test_parameter_boundary_duty_blocks_pseudo_all_solutions(process_tracker):
    """A boundary claim must not pass as a strict all-solutions acceptance."""
    client = ScopeClient(mode="boundary")
    result = _solve(client, PARAMETER_PROBLEM, policy="STRICT", **_BUDGET)
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["reason"] == "STRICT_NOT_VERIFIED"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert body["scopeCoverage"] == []


def test_declared_scope_coverage_never_closes_obligation(process_tracker):
    """A declared coverage row is data only: it never changes the outcome."""
    client = ScopeClient(mode="subanswer")
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert "scopeCoverage" in body
        assert isinstance(body["scopeCoverage"], list)
        assert body["scopeCoverage"] == []


def test_scope_coverage_rows_are_bound_to_their_own_task(process_tracker):
    """Every declared row must be bound to the exact task and scope."""
    client = ScopeClient(mode="boundary")
    result = _solve(client, PARAMETER_PROBLEM, **_BUDGET)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        task = body["task"]
        for row in body["scopeCoverage"]:
            assert row["taskId"] == task["taskId"]
            assert row["scopeId"] == task["scopeId"]
            assert len(row["coverage"]["coverageHash"]) == 64


@pytest.mark.parametrize("mode", ["subanswer", "missing_subgoal"])
def test_subgoal_modes_never_release_a_candidate(mode, process_tracker):
    """A sub-goal candidate never becomes the whole-problem candidate.

    Both modes answer a SUBGOAL_COVERAGE task, so the root answer obligation
    stays open and no whole-problem candidate may exist under any policy.
    """
    client = ScopeClient(mode=mode)
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker


def test_boundary_candidate_is_unverified_and_strict_withholds(process_tracker):
    """A boundary claim on the root answer duty is a legal but unverified candidate.

    The accepted BEST_EFFORT semantics (DECISION-0089/0093) deliver a legal but
    unverified candidate under the default policy; only STRICT withholds it.
    The ``boundary`` reply lands on the root ``ANSWER_REQUEST`` answer
    obligation, so the default policy must still return it with
    ``candidate_verified=False`` and ``strictAcceptance=NOT_PERFORMED``, while
    STRICT must withhold it. A declared ``scopeCoverage`` row never closes the
    obligation and never makes the claim verified.
    """
    client = ScopeClient(mode="boundary")
    result = _solve(client, PARAMETER_PROBLEM, **_BUDGET)
    assert result["status"] == "candidate"
    assert result["final_response"] == "a=0 is excluded"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert body["scopeCoverage"] == []
    strict_client = ScopeClient(mode="boundary")
    strict = _solve(strict_client, PARAMETER_PROBLEM, policy="STRICT", **_BUDGET)
    assert strict["status"] != "candidate"
    assert strict["final_response"] == "Unsolved."
    assert strict["reason"] == "STRICT_NOT_VERIFIED"
    assert strict["candidate_verified"] is False
    assert strict["strictAcceptance"] == "NOT_PERFORMED"
    assert strict["childReaped"] is True
    assert process_tracker
