"""Real public ``engine="ts"`` entry E2E for candidate-bearing goal kinds.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers are
replaced by raising stubs, so a hidden fallback surfaces as a failure.

Each problem below matches exactly one goal class of the conservative M1
keyword template, so the compiled contract carries that class's obligation
kinds. One obligation of a class carries the final answer and is named here as
its ``answer_kind``; the control-side ``P2_ANSWER_OBLIGATION_KINDS`` authority
admits every ``answer_kind`` across the classes and rejects the local steps --
premises, quantifier steps, domain-validity statements, feasible points,
attainment claims, coverage statements -- that must never become the
whole-problem candidate.

The reply is therefore typed: the answer obligation carries the class's real
candidate and derivation, every local step carries a plain COMPLETE packet with
no candidate. The candidate stays unverified and, under STRICT, is never
released.
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

# One problem per goal class; each hits exactly one keyword rule of the M1
# template. `answer_kind` is the single obligation that carries the answer.
CASES = {
    "count": {
        "problem": "How many integer solutions does x+y=3 have",
        "answer_kind": "COUNT_OBJECTS",
        "claim": "the equation x+y=3 has four integer solutions",
        "derivation": "x in {0,1,2,3} gives the non-negative integer y=3-x; no other pairs exist",
        "answer": "4",
    },
    "proof": {
        "problem": "Prove that the sum of two even integers is even",
        "answer_kind": "PROOF_GOAL",
        "claim": "the sum of two even integers is even",
        "derivation": "let a=2m and b=2n; then a+b=2(m+n), which is even",
        "answer": "a=2m and b=2n give a+b=2(m+n)",
    },
    "optimization": {
        "problem": "Find the maximum of f(x)=1-x^2 on the real line",
        "answer_kind": "GLOBAL_BOUND",
        "claim": "the global maximum of 1-x^2 on the real line is 1",
        "derivation": "x^2>=0 so 1-x^2<=1 with equality exactly at x=0",
        "answer": "1",
    },
    "value": {
        "problem": "Compute 2+2",
        "answer_kind": "CANDIDATE_VALIDITY",
        "claim": "2+2=4",
        "derivation": "direct evaluation of the supplied expression",
        "answer": "4",
    },
}

# Three work units plus one R2 review fit the unchanged 4-call profile. Every
# class reaches its answer obligation within three units (OPTIMIZATION sorts
# ATTAINMENT, FEASIBILITY, then GLOBAL_BOUND; PROOF sorts PREMISES, PROOF_GOAL,
# QUANTIFIERS; COUNT runs COUNT_OBJECTS first; VALUE runs CANDIDATE_VALIDITY).
_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


class CandidateClient(FakeClient):
    """FakeClient that only the answer obligation answers with a candidate.

    ``mode`` selects which boundary the reply exercises:

    - ``good`` (default): the answer task carries a COMPLETE packet with the
      class's candidate; local steps carry COMPLETE packets with no candidate.
    - ``partial``: the answer packet is INCOMPLETE, so no candidate may exist.
    - ``nonanswer_candidate``: a local step carries a candidate while the answer
      task carries none, so no whole-problem candidate may exist.
    - ``wrong_scope``: the answer packet is bound to a foreign scope.
    - ``missing_goal``: the answer packet is bound to an unknown goal.
    """

    def __init__(self, case, mode="good"):
        super().__init__()
        self.case = case
        self.mode = mode

    def _work(self, body):
        task = body["task"]
        obligation_kind = task["obligationId"].split(":", 1)[1]
        is_answer = obligation_kind == self.case["answer_kind"]
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
            "claim": self.case["claim"] if is_answer else f"local step: {obligation_kind}",
            "derivation": self.case["derivation"] if is_answer else f"local derivation: {obligation_kind}",
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": self.case["answer"] if is_answer else None,
        }
        if self.mode == "partial" and is_answer:
            packet["deliveryStatus"] = "INCOMPLETE"
        if self.mode == "nonanswer_candidate":
            # A candidate on a local step, and none on the answer task.
            packet["candidateProposal"] = None if is_answer else "local step result"
        if self.mode == "wrong_scope" and is_answer:
            packet["scopeId"] = "0" * 64
        if self.mode == "missing_goal" and is_answer:
            packet["goalId"] = "goal-absent"
        return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


@pytest.mark.parametrize("name", list(CASES))
def test_answer_obligation_delivers_typed_candidate(name, process_tracker):
    """A legal COMPLETE answer packet becomes the candidate for every class."""
    case = CASES[name]
    client = CandidateClient(case)
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == case["answer"]
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert client.calls >= 2
    assert process_tracker
    # The real Node agent-loop entry actually ran.
    assert process_tracker[0].args[1].endswith(("main.js", "stdio-runtime.bundle.mjs"))
    assert process_tracker[0].args[2] == "--agent-loop"


@pytest.mark.parametrize("name", list(CASES))
def test_strict_policy_never_releases_candidate(name, process_tracker):
    """Under STRICT the protected candidate is held, never delivered."""
    case = CASES[name]
    client = CandidateClient(case)
    result = _solve(client, case["problem"], policy="STRICT", **_BUDGET)
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["reason"] == "STRICT_NOT_VERIFIED"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("name", list(CASES))
def test_incomplete_delivery_is_not_a_candidate(name, process_tracker):
    """An INCOMPLETE answer packet never becomes a candidate."""
    case = CASES[name]
    client = CandidateClient(case, mode="partial")
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("name", ["value", "proof", "optimization"])
def test_local_step_candidate_is_not_the_answer(name, process_tracker):
    """A candidate on a local step must never masquerade as the whole answer.

    Covers the named prohibitions directly: a domain-validity statement
    (VALUE), a premise/quantifier step (PROOF) and a feasible point or
    attainment claim (OPTIMIZATION) all stay ineligible. COUNT is omitted here
    because its exhaustiveness step is itself an answer obligation for the
    all-solutions class, so a kind-only authority cannot exclude it without a
    goal-kind context; the count answer obligation stays COUNT_OBJECTS.
    """
    case = CASES[name]
    client = CandidateClient(case, mode="nonanswer_candidate")
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("name", list(CASES))
def test_wrong_scope_answer_packet_is_rejected(name, process_tracker):
    """An answer packet bound to a foreign scope is never a candidate."""
    case = CASES[name]
    client = CandidateClient(case, mode="wrong_scope")
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("name", list(CASES))
def test_missing_goal_answer_packet_is_rejected(name, process_tracker):
    """An answer packet bound to an unknown goal is never a candidate."""
    case = CASES[name]
    client = CandidateClient(case, mode="missing_goal")
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
