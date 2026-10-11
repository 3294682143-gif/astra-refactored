"""Real public ``engine="ts"`` entry E2E for the artifact-redo chain.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers stay
disabled so a hidden fallback surfaces as a failure.
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

SECOND_MECHANISM = {
    "representation": "auxiliary-parameter-space",
    "operation": "eliminate-and-substitute",
    "lemmas": ["rank-nullspace-identity"],
    "construction": "explicit-witness-construction",
}


class RevisionClient(FakeClient):
    """FakeClient whose WORK turns carry real v3/v2/v4 proposals."""

    def __init__(self, mode="parent"):
        super().__init__()
        self.mode = mode
        self.rawdict = {}

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        result = super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        if self.calls == 3 and self.mode in ("length", "nofinish"):
            choice = result["choices"][0]
            if self.mode == "length":
                choice["finish_reason"] = "length"
            else:
                choice.pop("finish_reason", None)
        return result

    def _work(self, body):
        source_id = body["sourceRequestId"]
        packet = json.loads(super()._work(body))
        obligation_id = body["task"]["obligationId"]
        if source_id == "model-1":
            if self.mode == "self":
                packet["schemaVersion"] = "p2a-work-v2"
                packet["pendingObligations"] = [obligation_id]
                packet["workflowProposal"] = {
                    "kind": "NEW_ROUTE",
                    "obligationId": obligation_id,
                    "mechanism": copy.deepcopy(SECOND_MECHANISM),
                    "rationale": "a second declared mechanism for the same obligation",
                }
            else:
                packet["schemaVersion"] = "p2a-work-v3"
                packet["pendingObligations"] = [obligation_id]
                packet["workflowProposal"] = {
                    "kind": "DEPENDENT_TASK",
                    "obligationId": obligation_id,
                    "rationale": "one dependent task for the same obligation",
                }
        elif source_id == "model-2":
            packet["schemaVersion"] = "p2a-work-v4"
            packet["pendingObligations"] = [obligation_id]
            refs = body["task"]["inputArtifactRefs"]
            target = None if self.mode == "self" else copy.deepcopy(refs[0])
            packet["workflowProposal"] = {
                "kind": "REDO_ARTIFACT",
                "targetArtifactRef": target,
                "rationale": "redo the artifact this work depends on",
            }
            packet["candidateProposal"] = "OTHER"
        elif source_id == "model-3":
            if self.mode == "noop":
                old = body["revisionTarget"]["packet"]
                packet = copy.deepcopy(old)
                packet["schemaVersion"] = "p2a-work-v4"
                packet["sourceRequestId"] = source_id
                packet["workflowProposal"] = None
            else:
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
    """Capture the real Host artifact projection before the base check runs."""
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


@pytest.mark.parametrize("mode", ["parent", "self"])
def test_real_redo_commits_new_version(mode, monkeypatch, process_tracker):
    captured = _spy_projection(monkeypatch)
    client = RevisionClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0, max_reviews=0)
    assert client.calls == 3
    assert result["childReaped"] is True
    assert result["candidate_verified"] is False
    assert result["metrics"]["work_units"] == 3
    assert result["metrics"]["review_calls"] == 0
    assert captured
    rows = captured[0]["rows"]
    by_source = captured[0]["bySourceRef"]
    if mode == "parent":
        assert result["reason"] == "STALE_CANDIDATE"
        assert result["status"] == "unsolved"
        assert [(row["artifactId"], row["envelope"]["artifactVersion"], row["availability"]) for row in rows] == [
            ("artifact-1", 1, "STALE"),
            ("artifact-2", 1, "STALE"),
            ("artifact-1", 2, "ACTIVE"),
        ]
        assert by_source["model-3"]["artifactId"] == "artifact-1"
        assert by_source["model-3"]["envelope"]["artifactVersion"] == 2
    else:
        assert result["status"] == "candidate"
        assert result["final_response"] == "4"
        assert [(row["artifactId"], row["envelope"]["artifactVersion"], row["availability"]) for row in rows] == [
            ("artifact-1", 1, "ACTIVE"),
            ("artifact-2", 1, "STALE"),
            ("artifact-2", 2, "ACTIVE"),
        ]
        assert by_source["model-3"]["artifactId"] == "artifact-2"
        assert by_source["model-3"]["envelope"]["artifactVersion"] == 2
    for source_id, text in client.rawdict.items():
        assert by_source[source_id]["rawResponseText"] == text
    third = json.loads(client.seen[2][0][1]["content"])
    assert third["revisionProvenance"] is not None
    assert third["revisionTarget"] is not None
    assert third["revisionProvenance"]["sourceRequestId"] == "model-2"
    expected_target = "model-1" if mode == "parent" else "model-2"
    assert third["revisionProvenance"]["targetSourceRequestId"] == expected_target
    assert process_tracker


@pytest.mark.parametrize("mode", ["noop", "length", "nofinish"])
def test_failed_redo_keeps_old_versions(mode, monkeypatch, process_tracker):
    captured = _spy_projection(monkeypatch)
    client = RevisionClient(mode=mode)
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts", max_model_calls=4, max_work_units=3,
        max_effects=0, max_reviews=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert client.calls == 3
    assert result["childReaped"] is True
    assert result["candidate_verified"] is False
    assert result["metrics"]["work_units"] == 2
    assert captured
    rows = captured[0]["rows"]
    assert [(row["artifactId"], row["envelope"]["artifactVersion"], row["availability"]) for row in rows] == [
        ("artifact-1", 1, "ACTIVE"),
        ("artifact-2", 1, "ACTIVE"),
    ]
    assert result["final_response"] == "4"
    if mode == "nofinish":
        assert result["metrics"]["remote_outcome_unknown"] is True
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 3
    assert process_tracker
