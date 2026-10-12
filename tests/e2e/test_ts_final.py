"""Real public ``engine="ts"`` entry E2E for the strict P3 ``final`` action.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run. The legacy Python solvers stay
disabled so a hidden fallback surfaces as a failure.
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
    PROBLEM,
    TOOL_ARGS,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]


class FinalClient(FakeClient):
    """FakeClient whose WORK reply is a strict ``final`` action.

    ``mode="good"`` confirms the protected candidate exactly. Every other mode
    changes exactly one field (or the finish reason) so a single guard is
    exercised. ``force_first`` makes the very first WORK turn a final action.
    """

    def __init__(self, mode="good", force_first=False, tool_first=False):
        super().__init__(tool_first=tool_first)
        self.mode = mode
        self.force_first = force_first
        self.texts = []

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") == "R2":
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        if not (self.force_first and self.calls == 0) and body.get("allowFinal") is not True:
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        candidate = body["protectedCandidate"]
        answer = "4" if candidate is None else candidate["answer"]
        action = {
            "action": "final",
            "answer": answer,
            "complete": True,
            "unresolved": [],
        }
        if self.mode == "answer":
            action["answer"] = "ATTACK"
        elif self.mode == "complete":
            action["complete"] = False
        elif self.mode == "unresolved":
            action["unresolved"] = ["still open"]
        text = json.dumps(action)
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


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def test_tool_work_final_r2_real_entry(process_tracker):
    client = FinalClient(tool_first=True)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=1)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert client.calls == 4
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["work_units"] == 1
    assert result["metrics"]["review_calls"] == 1
    # The raw final text exists only on the third model call.
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["action"] == "final"
    assert client.texts[0] not in json.dumps(result)
    # The final context is model-3 and its protected source is model-2.
    final_body = json.loads(client.seen[2][0][1]["content"])
    assert final_body["allowFinal"] is True
    assert final_body["protectedCandidate"]["binding"]["sourceRequestId"] == "model-2"
    assert final_body["protectedCandidate"]["binding"]["artifactId"] == "artifact-1"
    # The R2 target is the model-2 candidate, not the final turn.
    review_body = json.loads(client.seen[3][0][1]["content"])
    assert review_body["stage"] == "R2"
    assert review_body["target"]["sourceRequestId"] == "model-2"
    assert review_body["targetHash"] == final_body["protectedCandidate"]["targetHash"]
    # The real registered tool produced one COMPLETE observation.
    second = json.loads(client.seen[1][0][1]["content"])
    observations = second["toolObservations"]
    assert len(observations) == 1
    assert observations[0]["status"] == "COMPLETE"
    assert observations[0]["source"] == "PROGRAM_OBSERVATION"
    assert process_tracker


@pytest.mark.parametrize(
    "kwargs,expected_calls,expected_reviews,expected_status",
    [
        ({"max_model_calls": 2, "max_work_units": 2, "max_effects": 0, "max_reviews": 0}, 2, 0, "candidate"),
        ({"max_model_calls": 3, "max_work_units": 2, "max_effects": 0, "max_reviews": 1}, 3, 1, "candidate"),
        ({"max_model_calls": 3, "max_work_units": 2, "max_effects": 0, "max_reviews": 1, "policy": "STRICT"}, 3, 1, "unsolved"),
    ],
)
def test_work_then_final_budget_paths(kwargs, expected_calls, expected_reviews, expected_status, process_tracker):
    client = FinalClient()
    result = _solve(client, **kwargs)
    assert client.calls == expected_calls
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["action"] == "final"
    assert result["metrics"]["review_calls"] == expected_reviews
    assert result["metrics"]["work_units"] == 1
    assert result["status"] == expected_status
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    if expected_status == "unsolved":
        assert result["final_response"] == "Unsolved."
        assert result.get("code") is None
    else:
        assert result["final_response"] == "4"
    assert process_tracker


@pytest.mark.parametrize("mode", ["answer", "complete", "unresolved"])
def test_illegal_final_is_control_rejected(mode, process_tracker):
    client = FinalClient(mode=mode)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert client.calls == 2
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["action"] == "final"
    assert result["metrics"]["review_calls"] == 0
    assert result["metrics"]["work_units"] == 1
    assert result["stopReason"] == "CONTROL_REJECTED"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert "ATTACK" not in json.dumps(result)
    assert result["final_response"] == "4"
    assert process_tracker


def test_first_turn_final_is_refused(process_tracker):
    client = FinalClient(force_first=True)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert client.calls == 1
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["action"] == "final"
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["stopReason"] == "CONTROL_REJECTED"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("mode", ["length", "nofinish"])
def test_incomplete_final_keeps_old_candidate_and_blocks(mode, process_tracker):
    client = FinalClient(mode=mode)
    agent = user_agent.ReasoningAgent(client=client, engine="ts", max_model_calls=4, max_work_units=2, max_effects=0)
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert client.calls == 2
    assert len(client.texts) == 1
    assert json.loads(client.texts[0])["action"] == "final"
    assert result["metrics"]["review_calls"] == 0
    assert result["metrics"]["work_units"] == 1
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert result["final_response"] == "4"
    if mode == "nofinish":
        assert result["metrics"]["remote_outcome_unknown"] is True
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 2
    assert process_tracker


def _tamper_protected(monkeypatch, field):
    """Rewrite one protectedCandidate field on the real model-2 request."""
    import copy
    import hashlib

    from python.astra_bridge import agent_host as host_module

    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        request = params["request"]
        if request["requestId"] != "model-2":
            return base(self, frame_id, params)
        altered = copy.deepcopy(params)
        body = json.loads(altered["request"]["messages"][1]["content"])
        candidate = body.get("protectedCandidate")
        if candidate is None:
            return base(self, frame_id, params)
        seen.append(field)
        if field == "answer":
            candidate["answer"] = "ATTACK"
        elif field == "sourceRequestId":
            old = candidate["binding"]["sourceRequestId"]
            candidate["binding"]["sourceRequestId"] = "model-4"
            assert old != candidate["binding"]["sourceRequestId"]
        elif field == "targetHash":
            candidate["targetHash"] = "0" * 64
        else:
            candidate["binding"]["scopeId"] = "0" * 64
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


@pytest.mark.parametrize("field", ["answer", "sourceRequestId", "targetHash", "scopeId"])
def test_tampered_protected_candidate_is_refused(field, monkeypatch, process_tracker):
    seen = _tamper_protected(monkeypatch, field)
    client = FinalClient()
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=0)
    assert seen == [field]
    assert client.calls == 1
    assert result["code"] == "FIELD_VALUE"
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert "ATTACK" not in json.dumps(result)
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize(
    "legacy_version",
    [
        "agent-work-context-v2",
        "agent-work-context-v3",
        "agent-work-context-v4",
        "agent-work-context-v5",
        "agent-work-context-v6",
    ],
)
def test_legacy_context_is_read_only(legacy_version, monkeypatch, process_tracker):
    """A real legacy-shaped WORK request passes the legacy reader, not the active one."""
    import copy
    import hashlib

    from python.astra_bridge import agent_context as context_module
    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge.p0_probe import ProbeError

    captured = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        if not captured and params["request"]["requestId"] == "model-1":
            captured.append(copy.deepcopy(params))
        return base(self, frame_id, params)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    client = FakeClient()
    result = _solve(client)
    assert result["status"] == "candidate"
    assert captured
    params = captured[0]
    request = copy.deepcopy(params["request"])
    body = json.loads(request["messages"][1]["content"])
    assert body["schemaVersion"] == "agent-work-context-v7"
    assert "allowRouteProposal" in body
    assert "routeProvenance" in body
    assert "protectedCandidate" in body
    assert "allowTaskContinuation" in body
    assert "dependencyProvenance" in body
    assert "allowArtifactRedo" in body
    assert "revisionProvenance" in body
    assert "revisionTarget" in body
    assert "progressPolicy" in body
    body["schemaVersion"] = legacy_version
    del body["progressPolicy"]
    if legacy_version != "agent-work-context-v6":
        del body["allowArtifactRedo"]
        del body["revisionProvenance"]
        del body["revisionTarget"]
    if legacy_version in (
        "agent-work-context-v2", "agent-work-context-v3", "agent-work-context-v4",
    ):
        del body["allowTaskContinuation"]
        del body["dependencyProvenance"]
    if legacy_version in ("agent-work-context-v2", "agent-work-context-v3"):
        del body["allowRouteProposal"]
        del body["routeProvenance"]
    if legacy_version == "agent-work-context-v2":
        del body["allowFinal"]
        del body["protectedCandidate"]
    request["messages"][1]["content"] = json.dumps(
        body, ensure_ascii=False, separators=(",", ":")
    )
    serialized = json.dumps(request["messages"], ensure_ascii=False, separators=(",", ":"))
    encoded = serialized.encode("utf-8")
    request["contextHash"] = hashlib.sha256(encoded).hexdigest()
    request["contextBytes"] = len(encoded)
    session_id = request["sessionId"]
    problem_hash = request["problemHash"]
    legacy = context_module.validate_legacy_context(
        request, PROBLEM, session_id, problem_hash, {}, []
    )
    assert legacy["schemaVersion"] == legacy_version
    with pytest.raises(ProbeError):
        context_module.validate_context(
            request, PROBLEM, session_id, problem_hash, {}, []
        )
    assert process_tracker
