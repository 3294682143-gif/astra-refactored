"""Real public ``engine="ts"`` entry E2E for the p2a-work-v5 artifact redo.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run.

A v5 WorkPacket carries the same ``workflowProposal`` REDO_ARTIFACT suggestion
as v4 plus a nullable ``scopeProposal``. A legal v5 redo must be admitted and
commit version+1 with the replaced version invalidated; an illegal / cross-task
redo must be refused with no side effect.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

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


class V5RedoClient(FakeClient):
    """FakeClient: model-1 adds a dependent task, model-2 carries a v5 redo."""

    def __init__(self, mode="parent"):
        super().__init__()
        self.mode = mode
        self.rawdict = {}

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
            refs = body["task"]["inputArtifactRefs"]
            if self.mode == "cross_task":
                target = {"artifactId": "artifact-not-a-ref", "artifactVersion": 1}
            else:
                target = copy.deepcopy(refs[0])
            packet["workflowProposal"] = {
                "kind": "NOT_A_REDO" if self.mode == "wrong_kind" else "REDO_ARTIFACT",
                "targetArtifactRef": target,
                "rationale": "redo the artifact this work depends on",
            }
            packet["candidateProposal"] = "OTHER"
        elif source_id == "model-3":
            packet["claim"] = "2+2=4 (redone)"
            packet["derivation"] = "2+2=4 (redone)"
            packet["candidateProposal"] = "4"
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.rawdict[source_id] = text
        return text


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def _spy_projection(monkeypatch):
    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge.agent_history import project_artifacts

    captured = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        captured.append(
            project_artifacts(self.history, self.session_id, self.problem_hash)
        )
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    return captured


def test_legal_v5_redo_commits_new_version(monkeypatch, process_tracker):
    """A legal v5 REDO_ARTIFACT commits version+1 and invalidates the old bytes."""
    captured = _spy_projection(monkeypatch)
    client = V5RedoClient(mode="parent")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0, max_reviews=0)
    assert client.calls == 3
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 3
    assert captured
    rows = captured[0]["rows"]
    by_source = captured[0]["bySourceRef"]
    assert result["reason"] == "STALE_CANDIDATE"
    assert result["status"] == "unsolved"
    assert by_source["model-3"]["artifactId"] == "artifact-1"
    assert by_source["model-3"]["envelope"]["artifactVersion"] == 2
    assert ("artifact-1", 1, "STALE") in [
        (row["artifactId"], row["envelope"]["artifactVersion"], row["availability"])
        for row in rows
    ]
    third = json.loads(client.seen[2][0][1]["content"])
    assert third["revisionProvenance"] is not None
    assert third["revisionProvenance"]["sourceRequestId"] == "model-2"
    assert third["revisionProvenance"]["targetSourceRequestId"] == "model-1"
    assert process_tracker


@pytest.mark.parametrize("mode", ["cross_task", "wrong_kind"])
def test_illegal_v5_redo_is_refused_without_side_effect(mode, monkeypatch, process_tracker):
    """A cross-task or wrong-kind v5 proposal never schedules a redo."""
    captured = _spy_projection(monkeypatch)
    client = V5RedoClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0, max_reviews=0)
    assert result["childReaped"] is True
    assert captured
    rows = captured[0]["rows"]
    versions = [(row["artifactId"], row["envelope"]["artifactVersion"]) for row in rows]
    # No version+1 for artifact-1: the redo was refused.
    assert ("artifact-1", 2) not in versions
    assert process_tracker
