"""Negative controls for the explicit ``engine="ts"`` preview entry.

Every case reuses the real public entry, the real Python Host and the real Node
``main.js --agent-loop`` profile; only the injected public client or one Host
callback is mutated. The legacy Python solvers stay disabled, so a hidden
fallback surfaces as a failure. No guard is relaxed to make a case pass.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from python.astra_bridge import agent_host as host_module  # noqa: E402
from python.astra_bridge import agent_runtime as runtime_module  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    SENTINEL,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

TOOL_TEXT = json.dumps(
    {
        "action": "tool",
        "name": "polynomial_expand_coefficients",
        "args": {"expression": "2+2", "variables": ["x"], "parameters": []},
        "scope": "expand the supplied polynomial",
    }
)


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


class _MutatingClient(FakeClient):
    """FakeClient whose first reply is replaced by a fixed raw envelope."""

    def __init__(self, mode):
        super().__init__()
        self.mode = mode

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        if self.calls == 0:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            if self.mode == "raise":
                raise RuntimeError("public client failure")
            if self.mode == "bare":
                return "bare string reply"
            if self.mode == "nofinish":
                return {"choices": [{"index": 0, "message": {"role": "assistant", "content": TOOL_TEXT}}]}
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "length",
                        "message": {"role": "assistant", "content": TOOL_TEXT},
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


@pytest.mark.parametrize("mode", ["length", "bare", "nofinish", "raise"])
def test_incomplete_first_reply_blocks_tools_and_unknown(mode, process_tracker):
    client = _MutatingClient(mode)
    agent = user_agent.ReasoningAgent(client=client, engine="ts")
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["candidate_verified"] is False
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["client_method_calls"] == 1
    assert client.calls == 1
    blob = json.dumps(result)
    assert SENTINEL not in blob
    assert TOOL_TEXT not in blob
    assert result["metrics"]["known_http_attempts"] is None
    if mode in ("bare", "nofinish", "raise"):
        assert result["metrics"]["reported_tokens"] is None
        assert result["metrics"]["unknown_usage_requests"] >= 1
        assert result["metrics"]["remote_outcome_unknown"] is True
        # An unknown outcome permanently blocks this adapter instance.
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert second["final_response"] == "Unsolved."
        assert client.calls == 1
    else:
        # An explicit length is a returned terminal state, not a remote cancel.
        assert result["metrics"]["unknown_usage_requests"] >= 1
    assert process_tracker


def test_zero_cap_and_strict_are_unsolved(process_tracker):
    client = FakeClient()
    zero = _solve(client, max_model_calls=0)
    assert zero["status"] == "unsolved"
    assert zero["final_response"] == "Unsolved."
    assert zero["metrics"]["client_method_calls"] == 0
    assert client.calls == 0
    strict = _solve(FakeClient(), policy="STRICT", max_model_calls=4, max_work_units=2, problem_seconds=5)
    assert strict["status"] == "unsolved"
    assert strict["final_response"] == "Unsolved."
    assert strict["candidate_verified"] is False
    assert strict["metrics"]["client_method_calls"] == 3
    assert process_tracker


def test_missing_node_and_missing_dist_fail_closed(process_tracker, monkeypatch, tmp_path):
    # A missing Node binary never spawns a child and never calls the client.
    client = FakeClient()
    missing_node = _solve(client, node="astra-no-such-node")
    assert missing_node["status"] == "unsolved"
    assert missing_node["final_response"] == "Unsolved."
    assert missing_node["code"] == "SPAWN_FAILED"
    assert missing_node["childReaped"] is False
    assert missing_node["metrics"]["client_method_calls"] == 0
    assert client.calls == 0
    assert process_tracker == []
    # A missing dist script fails closed before spawn as well.
    absent = tmp_path / "absent-main.js"
    monkeypatch.setattr(runtime_module, "_default_script", lambda: absent)
    missing_dist = _solve(FakeClient())
    assert missing_dist["status"] == "unsolved"
    assert missing_dist["final_response"] == "Unsolved."
    assert missing_dist["code"] == "CHILD_FAILED"
    assert missing_dist["childReaped"] is False
    assert missing_dist["metrics"]["client_method_calls"] == 0
    assert process_tracker == []


def test_model_timeout_is_unknown_and_not_retried(process_tracker):
    import threading

    class SlowClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            body = json.loads(messages[1]["content"])
            text = self._review(body) if body.get("stage") == "R2" else self._work(body)
            # The reply lands well past the 1s root deadline: a late result
            # must never overwrite the fixed UNKNOWN record.
            threading.Event().wait(1.3)
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }

    client = SlowClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts", problem_seconds=1)
    started = time.monotonic()
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert time.monotonic() - started < 1.5
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert result["metrics"]["remote_outcome_unknown"] is True
    assert result["childReaped"] is True
    journal = agent._impl.last_journal
    second = agent.solve(PROBLEM, {"source": "e2e"})
    assert second["status"] == "unsolved"
    assert second["final_response"] == "Unsolved."
    assert client.calls == 1
    # Wait for the late worker to finish before asserting the fixed record.
    time.sleep(0.5)
    assert agent._impl.last_journal == journal
    assert agent._impl.client.blocked is True
    assert process_tracker


def _wrap_request(monkeypatch, mutate):
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        altered = mutate(self, copy.deepcopy(params))
        if altered is None:
            return base(self, frame_id, params)
        return base(self, frame_id, altered)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)


@pytest.mark.parametrize("field", ["hash", "session", "ORDER", "problem"])
def test_tampered_model_request_is_refused(field, monkeypatch, process_tracker):
    seen = []

    def mutate(self, params):
        if params["request"]["requestId"] != "model-1":
            return None
        seen.append(field)
        request = params["request"]
        if field == "hash":
            request["contextHash"] = "0" * 64
        elif field == "session":
            request["sessionId"] = "other-session"
        elif field == "ORDER":
            request["requestId"] = "model-2"
        else:
            body = json.loads(request["messages"][1]["content"])
            body["problemFullText"] = "Tampered problem"
            content = json.dumps(
                body, ensure_ascii=False, separators=(",", ":")
            )
            request["messages"][1]["content"] = content
            # Recompute the real context identity so the case tests the
            # problem binding itself, not only the stale-hash guard.
            serialized = json.dumps(
                request["messages"], ensure_ascii=False, separators=(",", ":")
            )
            encoded = serialized.encode("utf-8")
            request["contextHash"] = hashlib.sha256(encoded).hexdigest()
            request["contextBytes"] = len(encoded)
        return params

    _wrap_request(monkeypatch, mutate)
    client = FakeClient()
    result = _solve(client)
    assert seen == [field]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 0
    assert client.calls == 0
    assert result["childReaped"] is True
    assert process_tracker


def test_duplicate_model_request_id_is_refused(monkeypatch, process_tracker):
    """A second request reusing model-1 is refused after the first is served."""
    seen = []

    def mutate(self, params):
        if params["request"]["requestId"] != "model-2":
            return None
        seen.append("duplicate")
        params["request"]["requestId"] = "model-1"
        return params

    _wrap_request(monkeypatch, mutate)
    client = FakeClient()
    result = _solve(client)
    assert seen == ["duplicate"]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert client.calls == 1
    assert result["childReaped"] is True
    assert process_tracker


def test_tampered_tool_action_is_refused(monkeypatch, process_tracker):
    seen = []
    executed = []
    base = host_module.AgentHost.on_tool
    real_effect = host_module.perform_effect

    def spy_effect(*args, **kwargs):
        executed.append(1)
        raise AssertionError("must not execute")

    def wrapper(self, frame_id, params):
        if not seen:
            seen.append("tool")
            params = copy.deepcopy(params)
            params["request"]["action"]["scope"] = "tampered scope"
        return base(self, frame_id, params)

    monkeypatch.setattr(host_module.AgentHost, "on_tool", wrapper)
    monkeypatch.setattr(host_module, "perform_effect", spy_effect)
    client = FakeClient(tool_first=True)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=1)
    assert seen == ["tool"]
    assert executed == []
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert result["metrics"]["effect_calls"] == 0
    assert client.calls == 1
    assert result["childReaped"] is True
    assert process_tracker


def test_tampered_final_answer_is_refused(monkeypatch, process_tracker):
    seen = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        if not seen:
            seen.append("solve")
            message = copy.deepcopy(message)
            message["result"]["summary"]["finalResponse"] = "ATTACK"
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    client = FakeClient()
    result = _solve(client, max_model_calls=4, max_work_units=2, problem_seconds=5)
    assert seen == ["solve"]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert "ATTACK" not in json.dumps(result)
    assert result["metrics"]["client_method_calls"] == 3
    assert client.calls == 3
    assert result["childReaped"] is True
    assert process_tracker


def test_new_profile_invalid_frame_no_side_effect():
    from python.astra_bridge import agent_protocol
    from python.astra_bridge.p0_protocol import ProtocolError

    manifest = agent_protocol.load_manifest()
    for raw in (
        b'{"jsonrpc":"2.0","id":"x","id":"y","method":"session.solve","params":{}}',
        b"\xff",
        b"x" * 65537,
    ):
        with pytest.raises(ProtocolError):
            agent_protocol.parse_frame(raw, manifest)


def test_node_crash_preserves_spent_call(monkeypatch, process_tracker):
    class CrashClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            reply = super().chat(messages, temperature=temperature, max_tokens=max_tokens)
            process_tracker[0].kill()
            return reply

    client = CrashClient()
    result = _solve(client)
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert client.calls == 1
    assert result["childReaped"] is True
