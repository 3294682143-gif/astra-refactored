"""Real public ``engine="ts"`` entry E2E for the finite ProgressPolicy yield.

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
from test_ts_methods import spy_catalog  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker", "spy_catalog"]


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


class _UnsolvedClient(FakeClient):
    """First WORK of the session answers ``unsolved``; later WORK is ordinary."""

    def __init__(self, mode="unsolved"):
        super().__init__()
        self.mode = mode
        self.first_raw = None

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and body.get("sourceRequestId") == "model-1":
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            if self.mode == "unsolved":
                text = json.dumps({"action": "unsolved", "reason": "no route"})
            else:
                packet = json.loads(super()._work(body))
                packet["deliveryStatus"] = "INCOMPLETE"
                text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
            self.first_raw = text
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


@pytest.mark.parametrize("mode", ["unsolved", "partial"])
def test_unsolved_or_partial_yields_to_another_domain_task(mode, process_tracker):
    client = _UnsolvedClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 2
    bodies = _work_bodies(client)
    assert len(bodies) == 2
    assert bodies[0]["task"]["taskId"] != bodies[1]["task"]["taskId"]
    assert bodies[1]["task"]["taskId"].startswith("dep-task-") is False
    if mode == "unsolved":
        assert result["metrics"]["work_units"] == 1
    else:
        assert result["metrics"]["work_units"] == 2
    assert process_tracker


def _capture_projection(monkeypatch):
    """Capture the Host's own artifact projection at solve-result time."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        seen.append(host_module.project_artifacts(
            self.history, self.session_id, self.problem_hash,
        ))
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    return seen


def test_partial_keeps_raw_and_numbers_next_artifact(monkeypatch, process_tracker):
    seen = _capture_projection(monkeypatch)
    client = _UnsolvedClient(mode="partial")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert seen
    rows = seen[0]["rows"]
    assert len(rows) == 2
    first, second = rows
    assert first["deliveryStatus"] == "INCOMPLETE"
    assert first["artifactId"] == "artifact-1"
    assert second["artifactId"] == "artifact-2"
    assert client.first_raw is not None
    assert first["rawResponseText"] == client.first_raw
    assert first["rawResponseHash"] == hashlib.sha256(
        first["rawResponseText"].encode("utf-8")
    ).hexdigest()
    assert json.loads(first["rawResponseText"])["deliveryStatus"] == "INCOMPLETE"
    assert process_tracker


def test_unsolved_first_has_no_artifact(monkeypatch, process_tracker):
    seen = _capture_projection(monkeypatch)
    client = _UnsolvedClient(mode="unsolved")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert seen
    rows = seen[0]["rows"]
    assert len(rows) == 1
    assert rows[0]["artifactId"] == "artifact-1"
    assert process_tracker


class _CachedToolClient(FakeClient):
    """First three WORK turns repeat one registered tool; the fourth is real."""

    def __init__(self):
        super().__init__()
        self.tool_text = json.dumps({
            "action": "tool",
            "name": "polynomial_expand_coefficients",
            "args": TOOL_ARGS,
            "scope": "expand the supplied polynomial",
        })

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and self.calls < 3:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": self.tool_text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_second_cached_repeat_yields_and_next_task_works(process_tracker):
    client = _CachedToolClient()
    result = _solve(client, max_model_calls=4, max_work_units=3,
                    max_effects=1, max_reviews=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 4
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["work_units"] == 1
    bodies = _work_bodies(client)
    assert len(bodies) == 4
    assert bodies[3]["task"]["taskId"] != bodies[0]["task"]["taskId"]
    assert bodies[3]["toolObservations"] == []
    assert process_tracker


class _CandidateThenUnsolvedClient(FakeClient):
    """First WORK is a real candidate; the second WORK is ``unsolved``."""

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and body.get("sourceRequestId") == "model-2":
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant",
                                 "content": json.dumps(
                                     {"action": "unsolved", "reason": "no route"})}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


@pytest.mark.parametrize("policy,status", [("BEST_EFFORT", "candidate"),
                                           ("STRICT", "unsolved")])
def test_candidate_survives_other_task_unsolved(policy, status, process_tracker):
    client = _CandidateThenUnsolvedClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0,
                    max_reviews=1, policy=policy)
    assert result["status"] == status
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 3
    assert result["metrics"]["work_units"] == 1
    assert result["metrics"]["review_calls"] == 1
    assert process_tracker


@pytest.mark.parametrize("mode", ["length", "nofinish"])
def test_incomplete_unsolved_never_yields(mode, process_tracker):
    text = json.dumps({"action": "unsolved", "reason": "no route"})

    class _IncompleteClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            if self.calls == 0:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                if mode == "length":
                    return {"choices": [{"index": 0, "finish_reason": "length",
                                         "message": {"role": "assistant", "content": text}}]}
                return {"choices": [{"index": 0,
                                     "message": {"role": "assistant", "content": text}}]}
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _IncompleteClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts",
                                      max_model_calls=4, max_work_units=3,
                                      max_effects=0)
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "unsolved"
    assert result["childReaped"] is True
    assert client.calls == 1
    if mode == "nofinish":
        assert result["metrics"]["remote_outcome_unknown"] is True
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 1
    assert process_tracker


def _tamper_policy(monkeypatch, mutate):
    """Rewrite the fixed progressPolicy on the real model-1 WORK request."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-1":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        body = json.loads(altered["request"]["messages"][1]["content"])
        mutate(body["progressPolicy"])
        content = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        altered["request"]["messages"][1]["content"] = content
        serialized = json.dumps(
            altered["request"]["messages"], ensure_ascii=False, separators=(",", ":")
        )
        encoded = serialized.encode("utf-8")
        altered["request"]["contextHash"] = hashlib.sha256(encoded).hexdigest()
        altered["request"]["contextBytes"] = len(encoded)
        seen.append("policy")
        return base(self, frame_id, altered)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    return seen


@pytest.mark.parametrize("field", ["limit", "flag"])
def test_forged_progress_policy_is_refused_before_client(field, monkeypatch, process_tracker):
    def mutate(policy):
        if field == "limit":
            policy["cachedRepeatLimit"] = 99
        else:
            policy["partialYield"] = 1

    seen = _tamper_policy(monkeypatch, mutate)
    client = FakeClient()
    result = _solve(client)
    assert seen == ["policy"]
    assert client.calls == 0
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["childReaped"] is True
    assert process_tracker


class _ThreeMethodClient(FakeClient):
    """First three WORK turns of the session repeat one real method action."""

    def __init__(self, method_id):
        super().__init__()
        self.method_id = method_id

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and self.calls < 3:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant",
                                 "content": json.dumps(
                                     {"action": "method", "id": self.method_id})}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_second_cached_method_repeat_yields_to_next_task(process_tracker, spy_catalog):
    method_id = spy_catalog.method_id
    client = _ThreeMethodClient(method_id)
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=3, max_effects=1, max_reviews=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 4
    assert result["metrics"]["catalog_calls"] == 1
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert spy_catalog.loads == 1
    bodies = _work_bodies(client)
    assert len(bodies) == 4
    assert bodies[3]["task"]["taskId"] != bodies[0]["task"]["taskId"]
    assert bodies[3]["toolObservations"] == []
    assert len(bodies[3]["methodAssets"]) == 1
    assert bodies[3]["methodAssets"][0]["id"] == method_id
    second = bodies[1]
    assert len(second["toolObservations"]) == 1
    observation = second["toolObservations"][0]
    assert observation["status"] == "COMPLETE"
    assert observation["source"] == "METHOD_REFERENCE"
    assert process_tracker


def _tamper_yielded_task(monkeypatch):
    """Re-dispatch the already yielded task on the real model-2 request."""
    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-2":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        first = self.history["model-1"]["request"]["taskId"]
        altered["request"]["taskId"] = first
        seen.append("taskId")
        return base(self, frame_id, altered)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    return seen


def test_redispatch_of_yielded_task_is_refused_before_client(monkeypatch, process_tracker):
    seen = _tamper_yielded_task(monkeypatch)
    client = _UnsolvedClient(mode="unsolved")
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert seen == ["taskId"]
    assert client.calls == 1
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["childReaped"] is True
    assert process_tracker


class _BomClaimClient(FakeClient):
    """First WORK is a legal-shape partial packet whose claim is BOM-only."""

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and body.get("sourceRequestId") == "model-1":
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            packet = json.loads(super()._work(body))
            packet["claim"] = "\ufeff"
            packet["deliveryStatus"] = "INCOMPLETE"
            text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def _capture_progress(monkeypatch):
    """Capture the Host's own progress projection at solve-result time."""
    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge import agent_progress as progress_module

    seen = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        seen.append(progress_module.progress_events(self.history, self.effects))
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    return seen


def test_bom_only_claim_partial_is_rejected_and_never_yields(monkeypatch, process_tracker):
    seen = _capture_progress(monkeypatch)
    client = _BomClaimClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 1
    assert result["stopReason"] == "PACKET_REJECTED"
    assert result["metrics"]["work_units"] == 0
    assert seen == [[]]
    assert process_tracker
