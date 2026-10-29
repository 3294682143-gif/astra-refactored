"""Node/Host parity for the trusted WorkPacket binding and the artifact ballot.

Every case here reproduces a real 100-item A-group failure that used to end as
an unsolved ``FIELD_VALUE`` while the Node loop still held a usable candidate:

* a model packet whose ``problemHash`` is 63 or 65 characters long;
* a packet that reports a duplicate-free *subset* of the declared input refs;
* a malformed consensus/tool turn that must not erase an earlier candidate;
* a whitespace-only candidate that must never win the consensus ballot.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

PACKET_FIELDS = (
    "schemaVersion", "sessionId", "problemHash", "contractVersion", "taskId",
    "goalId", "scopeId", "routeId", "sourceRequestId", "claim", "derivation",
    "assumptions", "dependencies", "pendingObligations", "suggestedChecks",
    "deliveryStatus", "candidateProposal",
)


def _packet(body, candidate="4", dependencies=None, problem_hash=None):
    """Build one schema-shaped p2a-work-v1 packet from a real request body."""
    task = body["task"]
    packet = {
        "schemaVersion": "p2a-work-v1",
        "sessionId": body["sessionId"],
        "problemHash": body["problemHash"] if problem_hash is None else problem_hash,
        "contractVersion": body["contractVersion"],
        "taskId": task["taskId"],
        "goalId": task["goalId"],
        "scopeId": task["scopeId"],
        "routeId": body["route"]["routeId"],
        "sourceRequestId": body["sourceRequestId"],
        "claim": "2+2=4",
        "derivation": "2+2=4",
        "assumptions": [],
        "dependencies": (
            list(task["inputArtifactRefs"]) if dependencies is None else dependencies
        ),
        "pendingObligations": [],
        "suggestedChecks": [],
        "deliveryStatus": "COMPLETE",
        "candidateProposal": candidate,
    }
    assert set(packet) == set(PACKET_FIELDS)
    return json.dumps(packet)


def _solve(client, **kwargs):
    kwargs.setdefault("max_model_calls", 6)
    kwargs.setdefault("max_work_units", 4)
    kwargs.setdefault("max_effects", 0)
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


class HashClient(FakeClient):
    """Model that writes a truncated or padded ``problemHash`` every turn."""

    def __init__(self, length=63):
        super().__init__()
        self.length = length

    def _work(self, body):
        trusted = body["problemHash"]
        corrupt = (trusted + "0" * 64)[: self.length]
        return _packet(body, problem_hash=corrupt)


@pytest.mark.parametrize("length", [63, 65])
def test_corrupt_problem_hash_is_rebound_to_the_trusted_value(length, process_tracker):
    client = HashClient(length=length)
    result = _solve(client)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result.get("code") is None
    assert client.calls >= 2
    assert process_tracker


class DependencyClient(FakeClient):
    """Model that reports only part of the declared dependency set."""

    def __init__(self, mode):
        super().__init__()
        self.mode = mode
        self.declared = []

    def _work(self, body):
        refs = list(body["task"]["inputArtifactRefs"])
        self.declared.append(refs)
        if self.mode == "empty":
            chosen = []
        elif self.mode == "first":
            chosen = refs[:1]
        else:
            chosen = refs
        return _packet(body, dependencies=chosen)


@pytest.mark.parametrize("mode", ["empty", "first", "full"])
def test_duplicate_free_subset_of_declared_refs_stays_a_candidate(mode, process_tracker):
    client = DependencyClient(mode)
    result = _solve(client)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result.get("code") is None
    assert process_tracker


class MalformedTurnClient(FakeClient):
    """Model whose second turn is not parseable JSON at all."""

    def __init__(self, bad_turn=2):
        super().__init__()
        self.bad_turn = bad_turn

    def _work(self, body):
        if self.calls == self.bad_turn:
            return '{"schemaVersion": "p2a-work-v1", "claim": }'
        return _packet(body)


@pytest.mark.parametrize("bad_turn", [2, 3])
def test_unparseable_turn_never_erases_the_earlier_candidate(bad_turn, process_tracker):
    client = MalformedTurnClient(bad_turn=bad_turn)
    result = _solve(client, max_model_calls=8)
    assert result.get("code") != "FIELD_VALUE"
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert process_tracker


class BlankBallotClient(FakeClient):
    """Answer client whose middle blind attempt is whitespace only.

    Both sides must keep only non-empty candidates in the ballot, so the blank
    draft is neither a majority vote nor the latest tie-break winner.
    """

    def __init__(self, candidates):
        super().__init__()
        self.candidates = list(candidates)
        self.answer_calls = 0

    def _work(self, body):
        index = self.answer_calls
        self.answer_calls += 1
        candidate = self.candidates[index] if index < len(self.candidates) else "4"
        return _packet(body, candidate=candidate)


def test_whitespace_only_ballot_entry_never_wins_the_majority(process_tracker):
    client = BlankBallotClient(["4", "   ", "(B)"])
    result = _solve(
        client,
        max_model_calls=8,
        max_work_units=8,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    assert result.get("code") != "FIELD_VALUE"
    assert result["status"] == "candidate"
    # The whitespace draft never becomes the delivered candidate.
    assert result["final_response"] == "(B)"
    assert result["final_response"].strip() == result["final_response"]
    assert client.answer_calls >= 3
    assert process_tracker
