"""Real public ``engine="ts"`` entry E2E for the E01 ``{1} -> {0,1}`` slice.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers are
replaced by raising stubs, so a hidden fallback surfaces as a failure.

The flagship scenario is one ``ALL_SOLUTIONS`` problem. The compiled contract
carries ``DOMAIN_VALIDITY``, ``CANDIDATE_VALIDITY``, ``BOUNDARY_EXCEPTIONS``,
``EXHAUSTIVENESS`` and ``OUTPUT_COVERAGE``; only ``EXHAUSTIVENESS`` is the
answer obligation of that goal kind. The first WORK turn answers a local
``CANDIDATE_VALIDITY`` step with the incomplete set ``{1}``; a later WORK turn
answers the ``EXHAUSTIVENESS`` answer obligation with ``{0,1}``. The final
delivered candidate must be ``{0,1}`` and the valid local ``x=1`` material must
stay in the history.

The scope negatives below exercise the v5 ``scopeProposal`` boundary: a
malformed or out-of-scope proposal and a missing field. Every rejection happens
before any artifact is saved or any delivery recorded, leaves no candidate and a
fixed stop reason. (A WORK turn starts its task ledger row before the model
call, so a rejection is not a claim that the whole ledger is untouched.)
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

# One ALL_SOLUTIONS problem: the conservative M1 template matches exactly the
# "all solutions" rule, so the contract carries the all-solutions obligation
# set and EXHAUSTIVENESS is the single answer obligation of the goal.
E01_PROBLEM = "Find all real solutions of x(x-1)=0"

_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


class E01Client(FakeClient):
    """FakeClient that answers a local step with ``{1}`` and the answer with ``{0,1}``.

    ``mode`` selects which boundary the reply exercises:

    - ``good`` (default): the local ``CANDIDATE_VALIDITY`` step carries the
      incomplete set ``{1}`` and the ``EXHAUSTIVENESS`` answer obligation
      carries ``{0,1}``.
    - ``scope_out``: the first WORK turn carries a v5 ``scopeProposal`` whose
      declared quantifier ``x=1`` is not part of the task's trusted scope, so
      the declared coverage is out of scope.
    - ``scope_bad_list``: the first WORK turn's v5 ``scopeProposal`` carries a
      ``boundaryCases`` field that is not a list.
    - ``scope_empty_item``: the first WORK turn's v5 ``scopeProposal`` carries an
      empty item in ``goalExhaustion``.
    - ``scope_missing``: the first WORK turn carries a v5 packet whose
      ``scopeProposal`` field is absent.
    """

    def __init__(self, mode="good"):
        super().__init__()
        self.mode = mode
        self.rawtexts = {}

    def _work(self, body):
        task = body["task"]
        obligation_kind = task["obligationId"].split(":", 1)[-1]
        is_answer = obligation_kind == "EXHAUSTIVENESS"
        is_local = obligation_kind == "CANDIDATE_VALIDITY"
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
        if is_local:
            packet["claim"] = "x=1 is a solution of x(x-1)=0"
            packet["derivation"] = "substituting x=1 gives 1*(1-1)=0"
            packet["candidateProposal"] = "{1}"
        if is_answer:
            packet["claim"] = "the real solution set of x(x-1)=0 is {0,1}"
            packet["derivation"] = (
                "a product is zero exactly when one factor is zero, so x=0 or x=1"
            )
            packet["candidateProposal"] = "{0,1}"
        if (
            self.mode in ("scope_out", "scope_bad_list", "scope_empty_item", "scope_missing")
            and body["sourceRequestId"] == "model-1"
        ):
            packet["schemaVersion"] = "p2a-work-v5"
            packet["workflowProposal"] = None
            if self.mode == "scope_out":
                packet["scopeProposal"] = {
                    "kind": "SCOPE_REFINEMENT",
                    "quantifiers": ["x=1"],
                    "branchConditions": [],
                    "boundaryCases": [],
                    "goalExhaustion": [],
                    "rationale": "declared coverage of one factor only",
                }
            elif self.mode == "scope_bad_list":
                packet["scopeProposal"] = {
                    "kind": "SCOPE_REFINEMENT",
                    "quantifiers": [],
                    "branchConditions": [],
                    "boundaryCases": "x=0",
                    "goalExhaustion": [],
                    "rationale": "coverage",
                }
            elif self.mode == "scope_empty_item":
                packet["scopeProposal"] = {
                    "kind": "SCOPE_REFINEMENT",
                    "quantifiers": [],
                    "branchConditions": [],
                    "boundaryCases": [],
                    "goalExhaustion": ["x=1", ""],
                    "rationale": "coverage",
                }
            else:
                packet.pop("scopeProposal", None)
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.rawtexts[body["sourceRequestId"]] = text
        return text


def _solve(client, problem=E01_PROBLEM, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


def _work_bodies(client):
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


def _body_of(client, source_id):
    for body in _work_bodies(client):
        if body["sourceRequestId"] == source_id:
            return body
    raise AssertionError("no WORK body for " + source_id)


def test_e01_local_then_exhaustive_answer_delivers_full_set(process_tracker):
    """The flagship E01 regression: ``{1}`` first, ``{0,1}`` as the answer.

    The first WORK turn answers a local ``CANDIDATE_VALIDITY`` step with the
    incomplete set ``{1}``; the ``EXHAUSTIVENESS`` answer obligation later
    carries ``{0,1}``. The delivered candidate must be ``{0,1}`` and the valid
    local ``x=1`` material must still be present in the real history.
    """
    client = E01Client()
    result = _solve(client, **_BUDGET)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "{0,1}"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    assert process_tracker[0].args[2] == "--agent-loop"
    bodies = _work_bodies(client)
    assert bodies
    kinds = [body["task"]["obligationId"].split(":", 1)[-1] for body in bodies]
    assert "CANDIDATE_VALIDITY" in kinds
    assert "EXHAUSTIVENESS" in kinds
    # The local ``{1}`` material is a real earlier WORK receipt and is kept.
    local_raw = client.rawtexts["model-1"]
    assert json.loads(local_raw)["candidateProposal"] == "{1}"
    assert local_raw not in json.dumps(result)
    # The answer turn is the one that carries the full set.
    answer_raw = None
    for source_id, raw in client.rawtexts.items():
        if json.loads(raw).get("candidateProposal") == "{0,1}":
            answer_raw = raw
    assert answer_raw is not None
    assert json.loads(answer_raw)["deliveryStatus"] == "COMPLETE"


def test_e01_strict_policy_withholds_the_full_set(process_tracker):
    """Under STRICT the ``{0,1}`` candidate is held, never delivered."""
    client = E01Client()
    result = _solve(client, policy="STRICT", **_BUDGET)
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["reason"] == "STRICT_NOT_VERIFIED"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker


def test_e01_local_only_never_becomes_the_whole_answer(process_tracker):
    """Without the answer turn the local ``{1}`` never becomes the candidate."""
    client = E01Client()
    result = _solve(client, max_model_calls=1, max_work_units=1, max_effects=0)
    assert result["status"] != "candidate"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert body["task"]["obligationId"].split(":", 1)[-1] != "EXHAUSTIVENESS"


@pytest.mark.parametrize(
    "mode",
    ["scope_out", "scope_bad_list", "scope_empty_item"],
)
def test_tampered_scope_proposal_is_refused(mode, process_tracker):
    """A malformed or out-of-scope v5 ``scopeProposal`` is a fixed rejection."""
    client = E01Client(mode=mode)
    result = _solve(client, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    # The refused first turn never wrote an artifact: no WORK unit is counted
    # and no review follows.
    assert result["metrics"]["work_units"] == 0
    assert result["metrics"]["review_calls"] == 0


def test_missing_scope_proposal_field_is_refused(process_tracker):
    """A v5 packet without ``scopeProposal`` is a fixed rejection with no write."""
    client = E01Client(mode="scope_missing")
    result = _solve(client, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["stopReason"] == "PACKET_REJECTED"
    assert result["final_response"] == "Unsolved."
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    assert result["metrics"]["work_units"] == 0


def test_rejected_scope_proposal_leaves_no_side_effect(process_tracker):
    """An out-of-scope v5 proposal is fail-closed before any store write.

    The first turn really carries a v5 ``scopeProposal`` whose declared coverage
    is out of the task's trusted scope. It must be refused BEFORE any artifact is
    saved or any delivery recorded: no candidate exists and the stop reason is
    the fixed control rejection -- never a later ``REVIEWS_COMPLETE`` overwrite.
    (The task ledger row itself is started before the model call, as for every
    WORK turn, so this is not a claim that the entire ledger is untouched.)
    """
    client = E01Client(mode="scope_out")
    result = _solve(client, **_BUDGET)
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "CONTROL_REJECTED"
    assert result["reason"] == "NO_CANDIDATE"
    assert result["final_response"] == "Unsolved."
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert process_tracker
    # No artifact was accepted for the refused turn and no review followed.
    assert result["metrics"]["work_units"] == 0
    assert result["metrics"]["review_calls"] == 0
    assert result["reason"] != "REVIEWS_COMPLETE"


