"""Real public ``engine="ts"`` entry E2E for the dynamic second route.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers stay
disabled so a hidden fallback surfaces as a failure.
"""

from __future__ import annotations

import copy
import hashlib
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


class WorkflowClient(FakeClient):
    """FakeClient whose first normal WORK turn carries one NEW_ROUTE proposal."""

    def __init__(self, mode="good", tool_first=False):
        super().__init__(tool_first=tool_first)
        self.mode = mode
        self.texts = []
        self.proposed = False

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") == "R2":
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        if self.tool_first and self.calls == 0:
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        if self.proposed:
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        self.proposed = True
        packet = json.loads(super()._work(body))
        packet["schemaVersion"] = "p2a-work-v2"
        obligation_id = body["task"]["obligationId"]
        mechanism = copy.deepcopy(SECOND_MECHANISM)
        proposal = {
            "kind": "NEW_ROUTE",
            "obligationId": obligation_id,
            "mechanism": mechanism,
            "rationale": "a second declared mechanism for the same obligation",
        }
        packet["pendingObligations"] = [obligation_id]
        if self.mode == "same_mechanism":
            proposal["mechanism"] = {
                "representation": body["route"]["representation"],
                "operation": body["route"]["operation"],
                "lemmas": list(body["route"]["lemmas"]),
                "construction": body["route"]["construction"],
            }
        elif self.mode == "representation_only":
            proposal["mechanism"] = {
                "representation": "renamed-representation",
                "operation": body["route"]["operation"],
                "lemmas": list(body["route"]["lemmas"]),
                "construction": body["route"]["construction"],
            }
        elif self.mode == "pending_missing":
            packet["pendingObligations"] = []
        elif self.mode == "foreign_obligation":
            proposal["obligationId"] = "obligation-foreign"
        elif self.mode == "extra_key":
            proposal["routeId"] = "route-attack"
        packet["workflowProposal"] = proposal
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.texts.append(text)
        finish = "length" if self.mode == "length" else "stop"
        if self.mode == "nofinish":
            return {"choices": [{"index": 0, "message": {"role": "assistant", "content": text}}]}
        return {
            "choices": [
                {"index": 0, "finish_reason": finish,
                 "message": {"role": "assistant", "content": text}}
            ]
        }

    def _work(self, body):
        if self.proposed:
            packet = json.loads(super()._work(body))
            packet["candidateProposal"] = "OTHER"
            return json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        return super()._work(body)


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def _spy_source(monkeypatch):
    """Record the real source WORK request/receipt without changing control."""
    from python.astra_bridge import agent_host as host_module

    captured = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] == "model-1":
            captured.append(copy.deepcopy(params))
        return base(self, frame_id, params)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    return captured


def _work_bodies(client):
    """Every real WORK request body the client actually saw, in order."""
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


def _source_body(client):
    """The real WORK body of the source request that carried the proposal."""
    source_id = json.loads(client.texts[0])["sourceRequestId"]
    for body in _work_bodies(client):
        if body["sourceRequestId"] == source_id:
            return body
    raise AssertionError("no WORK body for the proposal source request was seen")


def test_dynamic_second_route_real_entry(monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient()
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 1
    assert client.calls == 3
    assert len(client.texts) == 1
    # The raw source V2 text keeps its full proposal and its own hash.
    source_text = client.texts[0]
    source_packet = json.loads(source_text)
    assert source_packet["schemaVersion"] == "p2a-work-v2"
    assert source_packet["workflowProposal"]["kind"] == "NEW_ROUTE"
    assert source_packet["workflowProposal"]["obligationId"] in source_packet["pendingObligations"]
    assert source_text not in json.dumps(result)
    assert captured
    source_body = _source_body(client)
    assert source_body["allowRouteProposal"] is True
    # The second WORK runs a genuinely different task on a different route.
    second = json.loads(client.seen[1][0][1]["content"])
    assert second["task"]["taskId"] == "route-task-model-1"
    assert second["task"]["taskId"] != source_body["task"]["taskId"]
    assert second["task"]["inputArtifactRefs"] == []
    assert second["task"]["dependencyTaskIds"] == []
    assert second["inputArtifacts"] == []
    assert second["allowRouteProposal"] is False
    assert second["route"]["routeId"] != source_body["route"]["routeId"]
    assert second["route"]["routeId"].startswith("route-")
    assert second["route"]["signature"] == hashlib.sha256(
        json.dumps(
            [
                second["route"]["representation"],
                second["route"]["operation"],
                second["route"]["lemmas"],
                second["route"]["construction"],
            ],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert second["route"]["routeId"] == "route-" + second["route"]["signature"][:16]
    provenance = second["routeProvenance"]
    assert provenance["sourceRequestId"] == "model-1"
    assert provenance["sourceArtifactRef"] == {"artifactId": "artifact-1", "artifactVersion": 1}
    assert provenance["obligationId"] == source_body["task"]["obligationId"]
    assert provenance["routeSignature"] == second["route"]["signature"]
    # The protected candidate stays the first one; the second work never replaces it.
    review = json.loads(client.seen[2][0][1]["content"])
    assert review["stage"] == "R2"
    assert review["target"]["sourceRequestId"] == "model-1"
    assert review["targetHash"] == hashlib.sha256(
        json.dumps(
            [review["target"], hashlib.sha256(source_text.encode("utf-8")).hexdigest()],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert process_tracker


def test_dynamic_second_route_after_tool(monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient(tool_first=True)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=1)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["review_calls"] == 1
    assert client.calls == 4
    assert len(client.texts) == 1
    assert captured
    source_body = _source_body(client)
    assert source_body["allowRouteProposal"] is True
    # The real registered tool produced one COMPLETE observation on the source.
    tool_body = json.loads(client.seen[1][0][1]["content"])
    observations = tool_body["toolObservations"]
    assert len(observations) == 1
    assert observations[0]["status"] == "COMPLETE"
    assert observations[0]["source"] == "PROGRAM_OBSERVATION"
    second = json.loads(client.seen[2][0][1]["content"])
    assert second["task"]["taskId"] == "route-task-model-2"
    assert second["task"]["inputArtifactRefs"] == []
    assert second["inputArtifacts"] == []
    assert second["route"]["routeId"] != source_body["route"]["routeId"]
    assert second["routeProvenance"]["sourceRequestId"] == "model-2"
    assert second["routeProvenance"]["sourceArtifactRef"] == {
        "artifactId": "artifact-1", "artifactVersion": 1,
    }
    review = json.loads(client.seen[3][0][1]["content"])
    assert review["target"]["sourceRequestId"] == "model-2"
    assert process_tracker


@pytest.mark.parametrize(
    "mode",
    ["same_mechanism", "representation_only", "pending_missing", "foreign_obligation"],
)
def test_rejected_proposal_keeps_original_candidate(mode, monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    # A legal-shape proposal that is refused keeps the original work and the
    # original candidate, and the run continues on the original route.
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 1
    assert client.calls == 3
    assert len(client.texts) == 1
    assert captured
    source_body = _source_body(client)
    assert source_body["allowRouteProposal"] is True
    # No second route was opened: every real WORK body stays on the original
    # task and carries no route provenance.
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("route-task-")
        assert body["routeProvenance"] is None
    assert process_tracker


def test_extra_key_proposal_is_packet_rejected(monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient(mode="extra_key")
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    # An extra key violates the strict v2 packet schema: the packet is refused
    # before any artifact is accepted, so no candidate exists yet.
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "PACKET_REJECTED"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 0
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 0
    assert client.calls == 1
    assert len(client.texts) == 1
    assert captured
    assert process_tracker


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_model_calls": 2, "max_work_units": 2, "max_effects": 0},
        {"max_model_calls": 4, "max_work_units": 1, "max_effects": 0},
    ],
)
def test_low_budget_never_admits_route(kwargs, monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient()
    result = _solve(client, **kwargs)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 1
    assert result["metrics"]["effect_calls"] == 0
    assert client.calls <= 2
    assert captured
    # The client still sends a real v2 proposal; the control side must refuse
    # admission on budget alone, not because the model stayed silent.
    source_body = _source_body(client)
    assert source_body["allowRouteProposal"] is False
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["schemaVersion"] == "p2a-work-v2"
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("route-task-")
        assert body["routeProvenance"] is None
    assert process_tracker


@pytest.mark.parametrize("mode", ["length", "nofinish"])
def test_incomplete_v2_never_opens_route(mode, monkeypatch, process_tracker):
    captured = _spy_source(monkeypatch)
    client = WorkflowClient(mode=mode)
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts", max_model_calls=4, max_work_units=2, max_effects=0
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 0
    assert result["metrics"]["effect_calls"] == 0
    assert client.calls == 1
    assert len(client.texts) == 1
    assert captured
    source_body = _source_body(client)
    assert source_body["allowRouteProposal"] is True
    if mode == "nofinish":
        assert result["metrics"]["remote_outcome_unknown"] is True
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 1
    assert process_tracker


def _tamper_route(monkeypatch, field):
    """Rewrite one field of the real model-2 new-route WORK body."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-2":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        body = json.loads(altered["request"]["messages"][1]["content"])
        if body.get("routeProvenance") is None:
            return base(self, frame_id, params)
        seen.append(field)
        if field == "operation":
            old = body["route"]["operation"]
            body["route"]["operation"] = "tampered-operation"
            assert old != body["route"]["operation"]
        elif field == "sourceRequestId":
            old = body["routeProvenance"]["sourceRequestId"]
            body["routeProvenance"]["sourceRequestId"] = "model-4"
            assert old != body["routeProvenance"]["sourceRequestId"]
        elif field == "artifactVersion":
            old = body["routeProvenance"]["sourceArtifactRef"]["artifactVersion"]
            body["routeProvenance"]["sourceArtifactRef"]["artifactVersion"] = 2
            assert old != body["routeProvenance"]["sourceArtifactRef"]["artifactVersion"]
        elif field == "taskId":
            old = body["task"]["taskId"]
            body["task"]["taskId"] = "route-task-model-4"
            assert old != body["task"]["taskId"]
        else:
            old = body["task"]["dependencyTaskIds"]
            body["task"]["dependencyTaskIds"] = ["model-1"]
            assert old != body["task"]["dependencyTaskIds"]
        content = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        altered["request"]["messages"][1]["content"] = content
        serialized = json.dumps(
            altered["request"]["messages"], ensure_ascii=False, separators=(",", ":")
        )
        encoded = serialized.encode("utf-8")
        altered["request"]["contextHash"] = hashlib.sha256(encoded).hexdigest()
        altered["request"]["contextBytes"] = len(encoded)
        return base(self, frame_id, altered)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    return seen


@pytest.mark.parametrize(
    "field", ["operation", "sourceRequestId", "artifactVersion", "taskId", "dependencyTaskIds"]
)
def test_tampered_new_route_context_is_refused(field, monkeypatch, process_tracker):
    seen = _tamper_route(monkeypatch, field)
    client = WorkflowClient()
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert seen == [field]
    assert client.calls == 1
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["childReaped"] is True
    assert process_tracker
