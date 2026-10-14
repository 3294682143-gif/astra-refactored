"""G3/PR4 negative controls at the real public ``engine="ts"`` entry.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. These lock the anti-degradation
semantics of PR4 §4.4 flagship negative control B:

- an unparseable R2 report is UNKNOWN, never a PASS / verified review;
- an upstream change without a valid counterexample is ``STALE``, never a
  refutation, and never releases a candidate;
- a bare second candidate claim without a scope/coverage basis is never
  upgraded to strict verification.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]


class UnparseableReviewClient(FakeClient):
    """FakeClient whose R2 report is not valid JSON."""

    def _review(self, body):
        return "{ this is not a review report"


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def test_r2_unparseable_review_is_unknown_not_pass(process_tracker):
    client = UnparseableReviewClient()
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=1)
    # An unparseable review never becomes a passing review and never upgrades
    # the candidate to a verified/ strict acceptance.
    assert result["stopReason"] == "REVIEW_STOP"
    assert result["reason"] == "BEST_EFFORT_CANDIDATE"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["metrics"]["review_calls"] == 1
    assert process_tracker


def _spy_projection(monkeypatch):
    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge.agent_history import project_artifacts

    captured = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        captured.append(project_artifacts(self.history, self.session_id, self.problem_hash))
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    return captured


class StaleRedoClient(FakeClient):
    """FakeClient: model-1 delivers a candidate, model-2 proposes a redo of it."""

    def __init__(self):
        super().__init__()
        self.mode = "parent"

    def _work(self, body):
        source_id = body["sourceRequestId"]
        packet = json.loads(super()._work(body))
        obligation_id = body["task"]["obligationId"]
        if source_id == "model-1":
            packet["schemaVersion"] = "p2a-work-v3"
            packet["pendingObligations"] = [obligation_id]
            packet["workflowProposal"] = {
                "kind": "DEPENDENT_TASK",
                "obligationId": obligation_id,
                "rationale": "one dependent task for the same obligation",
            }
        elif source_id == "model-2":
            packet["schemaVersion"] = "p2a-work-v5"
            packet["scopeProposal"] = None
            packet["pendingObligations"] = [obligation_id]
            packet["workflowProposal"] = {
                "kind": "REDO_ARTIFACT",
                "targetArtifactRef": dict(body["task"]["inputArtifactRefs"][0]),
                "rationale": "redo the artifact this work depends on",
            }
            packet["candidateProposal"] = "OTHER"
        elif source_id == "model-3":
            packet["claim"] = "2+2=4 (redone)"
            packet["derivation"] = "2+2=4 (redone)"
            packet["candidateProposal"] = "4"
        return json.dumps(packet)


def test_upstream_change_without_counterexample_is_stale_not_refuted(monkeypatch, process_tracker):
    captured = _spy_projection(monkeypatch)
    client = StaleRedoClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0, max_reviews=0)
    # The replaced version becomes STALE, never REFUTED, and no candidate is
    # released from the stale origin.
    assert result["reason"] == "STALE_CANDIDATE"
    assert result["status"] == "unsolved"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    rows = captured[0]["rows"]
    availabilities = [
        (row["artifactId"], row["envelope"]["artifactVersion"], row["availability"]) for row in rows
    ]
    assert ("artifact-1", 1, "STALE") in availabilities
    assert all(availability != "REFUTED" for _, _, availability in availabilities)
    assert process_tracker
