"""Real public ``engine="ts"`` entry E2E for the dependent-task chain.

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
    TOOL_ARGS,
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


class DependencyClient(FakeClient):
    """FakeClient whose WORK turns carry real v3 DEPENDENT_TASK proposals."""

    def __init__(self, mode="ordinary", tool_first=False):
        super().__init__(tool_first=tool_first)
        self.mode = mode
        self.rawtexts = {}

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        result = super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        if self.calls == 1 and self.mode in ("length", "nofinish"):
            choice = result["choices"][0]
            if self.mode == "length":
                choice["finish_reason"] = "length"
            else:
                choice.pop("finish_reason", None)
        return result

    def _work(self, body):
        source_id = body["sourceRequestId"]
        packet = json.loads(super()._work(body))
        if self.mode == "route_first" and source_id == "model-1":
            packet["schemaVersion"] = "p2a-work-v2"
            obligation_id = body["task"]["obligationId"]
            packet["pendingObligations"] = [obligation_id]
            packet["workflowProposal"] = {
                "kind": "NEW_ROUTE",
                "obligationId": obligation_id,
                "mechanism": copy.deepcopy(SECOND_MECHANISM),
                "rationale": "a second declared mechanism for the same obligation",
            }
            text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
            self.rawtexts[source_id] = text
            return text
        if source_id == "model-3":
            packet["candidateProposal"] = "OTHER"
        if source_id == "model-2":
            packet["candidateProposal"] = "OTHER"
        obligation_id = body["task"]["obligationId"]
        packet["schemaVersion"] = "p2a-work-v3"
        packet["pendingObligations"] = [obligation_id]
        packet["workflowProposal"] = {
            "kind": "DEPENDENT_TASK",
            "obligationId": obligation_id,
            "rationale": "one dependent task for the same obligation",
        }
        if self.mode == "pending_missing":
            packet["pendingObligations"] = []
        elif self.mode == "foreign_obligation":
            packet["pendingObligations"] = ["obligation-foreign"]
            packet["workflowProposal"]["obligationId"] = "obligation-foreign"
        elif self.mode == "partial":
            packet["deliveryStatus"] = "INCOMPLETE"
        text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.rawtexts[source_id] = text
        return text


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


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


@pytest.mark.parametrize("mode", ["ordinary", "route_first"])
def test_dependent_chain_real_entry(mode, process_tracker):
    client = DependencyClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 3
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 1
    assert client.calls == 4
    first = _body_of(client, "model-1")
    second = _body_of(client, "model-2")
    third = _body_of(client, "model-3")
    assert first["allowTaskContinuation"] is True
    if mode == "ordinary":
        assert second["task"]["taskId"] == "dep-task-model-1"
        assert second["task"]["dependencyTaskIds"] == [first["task"]["taskId"]]
        assert second["task"]["inputArtifactRefs"] == [
            {"artifactId": "artifact-1", "artifactVersion": 1}
        ]
        assert second["dependencyProvenance"]["sourceRequestId"] == "model-1"
        assert second["dependencyProvenance"]["sourceArtifactRef"] == {
            "artifactId": "artifact-1", "artifactVersion": 1,
        }
        assert second["routeProvenance"] is None
    else:
        assert second["task"]["taskId"] == "route-task-model-1"
        assert second["task"]["dependencyTaskIds"] == []
        assert second["task"]["inputArtifactRefs"] == []
        assert second["routeProvenance"] is not None
        assert second["routeProvenance"]["sourceRequestId"] == "model-1"
        assert second["dependencyProvenance"] is None
    assert third["task"]["taskId"] == "dep-task-model-2"
    assert third["task"]["dependencyTaskIds"] == [second["task"]["taskId"]]
    assert third["task"]["inputArtifactRefs"] == [
        {"artifactId": "artifact-2", "artifactVersion": 1}
    ]
    assert third["dependencyProvenance"]["sourceRequestId"] == "model-2"
    assert third["dependencyProvenance"]["sourceArtifactRef"] == {
        "artifactId": "artifact-2", "artifactVersion": 1,
    }
    assert third["routeProvenance"] is None
    assert third["scope"] == second["scope"] == first["scope"]
    if mode == "ordinary":
        assert second["route"]["routeId"] == first["route"]["routeId"]
        assert third["route"]["routeId"] == first["route"]["routeId"]
        assert third["inputArtifacts"][0]["packet"]["dependencies"] == [
            {"artifactId": "artifact-1", "artifactVersion": 1}
        ]
    else:
        assert second["route"]["routeId"] != first["route"]["routeId"]
        assert third["route"]["routeId"] == second["route"]["routeId"]
        assert third["route"]["routeId"] != first["route"]["routeId"]
        assert all(
            artifact["artifactId"] != "artifact-1" for artifact in third["inputArtifacts"]
        )
    for body in (first, second, third):
        source_id = body["sourceRequestId"]
        raw = client.rawtexts[source_id]
        assert raw not in json.dumps(result)
        for artifact in body["inputArtifacts"]:
            expected_raw = client.rawtexts[artifact["sourceRequestId"]]
            assert artifact["rawResponseText"] == expected_raw
            assert artifact["rawResponseHash"] == hashlib.sha256(
                expected_raw.encode("utf-8")
            ).hexdigest()
            assert artifact["packet"] == json.loads(expected_raw)
    assert process_tracker


def test_low_budget_never_admits_dependency(process_tracker):
    client = DependencyClient()
    result = _solve(client, max_model_calls=1, max_work_units=1, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 1
    first = _body_of(client, "model-1")
    assert first["allowTaskContinuation"] is False
    assert json.loads(client.rawtexts["model-1"])["schemaVersion"] == "p2a-work-v3"
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("dep-task-")
        assert body["dependencyProvenance"] is None
    assert process_tracker


@pytest.mark.parametrize("mode", ["pending_missing", "foreign_obligation"])
def test_rejected_dependency_keeps_original_work(mode, process_tracker):
    client = DependencyClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    first = _body_of(client, "model-1")
    raw = client.rawtexts["model-1"]
    packet = json.loads(raw)
    assert packet["schemaVersion"] == "p2a-work-v3"
    assert packet["workflowProposal"]["kind"] == "DEPENDENT_TASK"
    if mode == "pending_missing":
        assert packet["pendingObligations"] == []
    else:
        assert packet["workflowProposal"]["obligationId"] == "obligation-foreign"
        assert packet["pendingObligations"] == ["obligation-foreign"]
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("dep-task-")
        assert body["dependencyProvenance"] is None
    assert process_tracker


def test_partial_v3_never_starts_child(process_tracker):
    client = DependencyClient(mode="partial")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert json.loads(client.rawtexts["model-1"])["deliveryStatus"] == "INCOMPLETE"
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("dep-task-")
        assert body["dependencyProvenance"] is None
    assert process_tracker


def _tamper_route(monkeypatch):
    """Rewrite the model-3 WORK route to the real old route of model-1."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-3":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        body = json.loads(altered["request"]["messages"][1]["content"])
        old_route = json.loads(
            self.history["model-1"]["request"]["messages"][1]["content"]
        )["route"]
        if body["route"] == old_route:
            return base(self, frame_id, params)
        seen.append("route")
        body["route"] = old_route
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


def test_cross_route_dependency_context_is_refused(monkeypatch, process_tracker):
    seen = _tamper_route(monkeypatch)
    client = DependencyClient(mode="route_first")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert seen == ["route"]
    assert client.calls == 2
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("mode", ["length", "nofinish"])
def test_incomplete_v3_never_starts_child(mode, process_tracker):
    client = DependencyClient(mode=mode)
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts", max_model_calls=4, max_work_units=3, max_effects=0
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 1
    for body in _work_bodies(client):
        assert not body["task"]["taskId"].startswith("dep-task-")
    if mode == "nofinish":
        assert result["metrics"]["remote_outcome_unknown"] is True
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 1
    assert process_tracker


def _tamper_dependency(monkeypatch, field):
    """Rewrite one field of the real model-2 dependent-task WORK body."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-2":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        body = json.loads(altered["request"]["messages"][1]["content"])
        if body.get("dependencyProvenance") is None:
            return base(self, frame_id, params)
        seen.append(field)
        if field == "artifactVersion":
            old = body["dependencyProvenance"]["sourceArtifactRef"]["artifactVersion"]
            body["dependencyProvenance"]["sourceArtifactRef"]["artifactVersion"] = 2
            assert old != body["dependencyProvenance"]["sourceArtifactRef"]["artifactVersion"]
        elif field == "sourceRequestId":
            old = body["dependencyProvenance"]["sourceRequestId"]
            body["dependencyProvenance"]["sourceRequestId"] = "model-4"
            assert old != body["dependencyProvenance"]["sourceRequestId"]
        elif field == "rawResponseText":
            artifact = body["inputArtifacts"][0]
            old = artifact["rawResponseText"]
            artifact["rawResponseText"] = old + " "
            artifact["rawResponseHash"] = hashlib.sha256(
                artifact["rawResponseText"].encode("utf-8")
            ).hexdigest()
            assert old != artifact["rawResponseText"]
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
    "field", ["artifactVersion", "sourceRequestId", "rawResponseText", "dependencyTaskIds"]
)
def test_tampered_dependency_context_is_refused(field, monkeypatch, process_tracker):
    seen = _tamper_dependency(monkeypatch, field)
    client = DependencyClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert seen == [field]
    assert client.calls == 1
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["childReaped"] is True
    assert process_tracker


def test_two_solves_same_agent_keep_sessions_apart(process_tracker):
    """One agent, two solves: the second run never reuses the first run's raw."""
    client = DependencyClient()
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts", max_model_calls=4, max_work_units=3, max_effects=0
    )
    first = agent.solve(PROBLEM, {"source": "e2e"})
    second = agent.solve(PROBLEM + " (second session)", {"source": "e2e"})
    for result in (first, second):
        assert result["status"] == "candidate"
        assert result["final_response"] == "4"
        assert result["candidate_verified"] is False
        assert result["childReaped"] is True
        assert result["metrics"]["work_units"] == 3
        assert result["metrics"]["effect_calls"] == 0
        assert result["metrics"]["review_calls"] == 1
    assert client.calls == 8
    runs = []
    for start in (0, 4):
        bodies = []
        for messages, _temperature, _max_tokens in client.seen[start:start + 4]:
            body = json.loads(messages[1]["content"])
            if body.get("stage") != "R2":
                bodies.append(body)
        assert len(bodies) == 3
        runs.append(bodies)
    first_bodies, second_bodies = runs
    assert first_bodies[0]["sessionId"] != second_bodies[0]["sessionId"]
    assert first_bodies[0]["problemHash"] != second_bodies[0]["problemHash"]
    for bodies in runs:
        session_id = bodies[0]["sessionId"]
        problem_hash = bodies[0]["problemHash"]
        assert bodies[0]["task"]["inputArtifactRefs"] == []
        assert bodies[0]["dependencyProvenance"] is None
        for body in bodies[1:]:
            assert body["sessionId"] == session_id
            assert body["problemHash"] == problem_hash
            assert body["task"]["inputArtifactRefs"]
            for artifact in body["inputArtifacts"]:
                assert artifact["envelope"]["sessionId"] == session_id
                assert artifact["envelope"]["problemHash"] == problem_hash
                assert artifact["packet"]["sessionId"] == session_id
                assert artifact["packet"]["problemHash"] == problem_hash
    first_raw = first_bodies[1]["inputArtifacts"][0]["rawResponseText"]
    second_raw = second_bodies[1]["inputArtifacts"][0]["rawResponseText"]
    assert first_raw != second_raw
    assert hashlib.sha256(first_raw.encode("utf-8")).hexdigest() != hashlib.sha256(
        second_raw.encode("utf-8")
    ).hexdigest()
    assert process_tracker
    assert len(process_tracker) == 2


class ToolChildClient(DependencyClient):
    """DependencyClient whose real child WORK turn first issues one tool action."""

    def __init__(self, mode="ordinary"):
        super().__init__(mode=mode)
        self.tool_texts = []

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        task = body.get("task")
        if (
            body.get("stage") != "R2"
            and body.get("sourceRequestId") == "model-2"
            and isinstance(task, dict)
            and task.get("taskId") == "dep-task-model-1"
        ):
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            text = json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": TOOL_ARGS,
                    "scope": "expand the supplied polynomial",
                }
            )
            self.tool_texts.append(text)
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_child_tool_shares_root_budget(process_tracker):
    """A real tool inside the child task consumes the one shared root effect."""
    client = ToolChildClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=1)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 4
    assert len(client.tool_texts) == 1
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["review_calls"] == 1
    child = _body_of(client, "model-2")
    assert child["task"]["taskId"] == "dep-task-model-1"
    assert child["task"]["inputArtifactRefs"] == [
        {"artifactId": "artifact-1", "artifactVersion": 1}
    ]
    third = _body_of(client, "model-3")
    assert third["task"]["taskId"] == "dep-task-model-1"
    assert third["task"]["inputArtifactRefs"] == [
        {"artifactId": "artifact-1", "artifactVersion": 1}
    ]
    observations = third["toolObservations"]
    assert len(observations) == 1
    assert observations[0]["status"] == "COMPLETE"
    assert observations[0]["source"] == "PROGRAM_OBSERVATION"
    assert observations[0]["binding"]["sourceRequestId"] == "model-2"
    assert observations[0]["binding"]["taskId"] == "dep-task-model-1"
    review = json.loads(client.seen[3][0][1]["content"])
    assert review["stage"] == "R2"
    assert review["requestId"] == "model-4"
    assert process_tracker
