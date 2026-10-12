"""Real public ``engine="ts"`` entry E2E for candidate-bearing goal kinds.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers stay
disabled so a hidden fallback surfaces as a failure.

Each problem below matches exactly one goal class of the conservative M1
keyword template, so the compiled contract carries the obligation kinds of
that class. A legal COMPLETE WorkPacket with a non-null candidateProposal must
be deliverable as a candidate for every one of them.
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

# One problem per goal class; each hits exactly one keyword rule.
COUNT_PROBLEM = "How many integer solutions does x+y=3 have"
PROOF_PROBLEM = "Prove that the sum of two even integers is even"
OPTIMIZATION_PROBLEM = "Find the maximum of f(x)=1-x^2 on the real line"
VALUE_PROBLEM = "Compute 2+2"


class CandidateClient(FakeClient):
    """FakeClient whose WORK reply is a legal COMPLETE candidate packet.

    ``mode="good"`` delivers a COMPLETE packet with a non-null
    ``candidateProposal``. ``mode="partial"`` keeps the same packet but marks
    the delivery INCOMPLETE, so no candidate may be produced from it.
    """

    def __init__(self, mode="good"):
        super().__init__()
        self.mode = mode

    def _work(self, body):
        task = body["task"]
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
            "claim": "the requested result is 4",
            "derivation": "direct evaluation of the supplied expression",
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": "4",
        }
        if self.mode == "partial":
            packet["deliveryStatus"] = "INCOMPLETE"
        return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


@pytest.mark.parametrize(
    "problem",
    [COUNT_PROBLEM, PROOF_PROBLEM, OPTIMIZATION_PROBLEM, VALUE_PROBLEM],
)
def test_candidate_kind_delivers_candidate(problem, process_tracker):
    """A legal COMPLETE candidate packet is delivered for every goal class."""
    client = CandidateClient()
    result = _solve(client, problem)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert client.calls >= 2
    assert process_tracker


@pytest.mark.parametrize(
    "problem",
    [COUNT_PROBLEM, PROOF_PROBLEM, OPTIMIZATION_PROBLEM, VALUE_PROBLEM],
)
def test_partial_delivery_is_not_a_candidate(problem, process_tracker):
    """An INCOMPLETE delivery never becomes a candidate for any goal class."""
    client = CandidateClient(mode="partial")
    result = _solve(client, problem)
    assert result["engine"] == "ts"
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
