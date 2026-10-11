"""P2 Host multi-work-unit offline tests: real Node child, no network."""

from __future__ import annotations

import copy
import hashlib
import json
import socket
import subprocess

import pytest

from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p2_host_callback import P2HostCallback
from python.astra_bridge.p2_host_fixture import OfflineP2Client
from python.astra_bridge.p2_host_offline import run_p2_host

PROBLEM = "求全部实数解 x(x-1)=0"


@pytest.fixture(autouse=True)
def _track(monkeypatch):
    children = []
    real_popen = subprocess.Popen

    def popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        children.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", popen)
    monkeypatch.setattr(
        socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(AssertionError("net"))
    )
    import mathagent.lite.runtime as lite_runtime
    import user_agent

    def _no_solve(*args, **kwargs):
        raise AssertionError("implicit fallback")

    monkeypatch.setattr(lite_runtime.LiteRuntime, "solve", _no_solve)
    monkeypatch.setattr(user_agent.ReasoningAgent, "solve", _no_solve)
    yield
    for proc in children:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                assert stream.closed


def _spy(monkeypatch, reply, status="COMPLETE"):
    seen = []
    receipts = []
    real_chat = OfflineP2Client.chat

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        from python.astra_bridge.p2_host_fixture import _parse_inner

        seen.append(_parse_inner(messages[1]["content"]))
        receipt = real_chat(self, messages, temperature, max_tokens)
        receipts.append(receipt)
        return receipt

    monkeypatch.setattr(OfflineP2Client, "chat", chat)
    return seen, receipts


@pytest.mark.parametrize("budget", [0, 1, 2, 3])
def test_budget_units(monkeypatch, budget):
    seen, receipts = _spy(monkeypatch, "CAND")
    result = run_p2_host(PROBLEM, reply="CAND", max_model_calls=budget)
    assert len(seen) == budget
    assert result["artifactCount"] == budget
    assert result["frames"] == 6 + 2 * budget
    assert result["candidateRequestId"] == (None if budget == 0 else "model-1")
    assert result["candidateVerified"] is False
    assert result["openObligations"] > 0
    ids = [inner["sourceRequestId"] for inner in seen]
    assert ids == ["model-" + str(i + 1) for i in range(budget)]
    if budget == 3:
        refs = seen[2]["task"]["inputArtifactRefs"]
        assert [ref["artifactId"] for ref in refs] == ["artifact-1", "artifact-2"]
        assert all(ref["artifactVersion"] == 1 for ref in refs)
        import json

        for index, art in enumerate(seen[2]["inputArtifacts"]):
            assert art["rawResponseText"] == receipts[index]["text"]
            assert art["packet"] == json.loads(receipts[index]["text"])


def test_three_units_with_method(monkeypatch):
    seen, _receipts = _spy(monkeypatch, "CAND")
    result = run_p2_host(
        PROBLEM, reply="CAND", max_model_calls=3, method_id="linearization-spectral"
    )
    assert result["frames"] == 16
    assert result["methodLoads"] == 1
    assert len(seen) == 3
    assert all(len(inner["methodAssets"]) == 1 for inner in seen)
    assert "body" not in str(result)
    assert result["candidateRequestId"] == "model-1"


@pytest.mark.parametrize("later", ["TRUNCATED", "ERROR", "UNKNOWN"])
def test_later_failure_keeps_first_candidate(monkeypatch, later):
    seen = []
    real_chat = OfflineP2Client.chat

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        from python.astra_bridge.p2_host_fixture import _parse_inner

        seen.append(_parse_inner(messages[1]["content"]))
        if self.calls == 1:
            self._delivery_status = later
            receipt = real_chat(self, messages, temperature, max_tokens)
            import json

            packet = json.loads(receipt["text"])
            packet["candidateProposal"] = "LATER_PRIVATE"
            receipt["text"] = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
            return receipt
        return real_chat(self, messages, temperature, max_tokens)

    monkeypatch.setattr(OfflineP2Client, "chat", chat)
    result = run_p2_host(PROBLEM, reply="FIRST_CANDIDATE", max_model_calls=3)
    assert len(seen) == 2
    assert result["finalResponse"] == "FIRST_CANDIDATE"
    assert result["candidateRequestId"] == "model-1"
    assert result["candidateVerified"] is False


def test_first_unknown_unsolved(monkeypatch):
    _spy(monkeypatch, "CAND")
    result = run_p2_host(PROBLEM, reply="CAND", delivery_status="UNKNOWN", max_model_calls=3)
    assert result["modelCalls"] == 1
    assert result["status"] == "unsolved"


def test_duplicate_node_id_rejected(monkeypatch):
    calls = []
    real_chat = OfflineP2Client.chat

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        calls.append(self.calls)
        return real_chat(self, messages, temperature, max_tokens)

    monkeypatch.setattr(OfflineP2Client, "chat", chat)
    real_on_request = P2HostCallback.on_request

    def on_request(self, message):
        if message.get("method") == "model.generate" and self.model_calls == 1:
            message = dict(message)
            message["id"] = "node-model-1"
        return real_on_request(self, message)

    monkeypatch.setattr(P2HostCallback, "on_request", on_request)
    with pytest.raises(ProbeError):
        run_p2_host(PROBLEM, reply="CAND", max_model_calls=3)
    assert len(calls) == 1


def _alter_third(inner, kind):
    if kind == "raw":
        inner["inputArtifacts"][0]["rawResponseText"] = "TAMPERED"
    elif kind == "version":
        inner["inputArtifacts"][0]["envelope"]["artifactVersion"] = True
    elif kind == "jointscope":
        extra = "extra-assumption"
        inner["scope"]["localAssumptions"] = list(inner["scope"]["localAssumptions"]) + [extra]
        inner["inputArtifacts"][0]["scope"]["localAssumptions"] = list(
            inner["inputArtifacts"][0]["scope"]["localAssumptions"]
        ) + [extra]
    else:
        inner["scope"]["localAssumptions"] = list(inner["scope"]["localAssumptions"]) + ["extra"]
    return json.dumps(inner, ensure_ascii=False, separators=(",", ":"))


@pytest.mark.parametrize("kind", ["raw", "version", "scope", "jointscope"])
def test_tampered_third_context_rejected(monkeypatch, kind):
    calls = []
    real_chat = OfflineP2Client.chat

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        calls.append(self.calls)
        return real_chat(self, messages, temperature, max_tokens)

    monkeypatch.setattr(OfflineP2Client, "chat", chat)
    real_on_request = P2HostCallback.on_request

    def on_request(self, message):
        if message.get("method") == "model.generate" and message.get("params", {}).get(
            "requestId"
        ) == "model-3":
            from python.astra_bridge.p2_host_fixture import _parse_inner

            tampered = copy.deepcopy(message)
            params = tampered["params"]
            inner = _parse_inner(params["messages"][1]["content"])
            text = _alter_third(inner, kind)
            messages = [params["messages"][0], {"role": "user", "content": text}]
            params["messages"] = messages
            params["contextHash"] = hashlib.sha256(
                json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            message = tampered
        return real_on_request(self, message)

    monkeypatch.setattr(P2HostCallback, "on_request", on_request)
    with pytest.raises(ProbeError):
        run_p2_host(PROBLEM, reply="CAND", max_model_calls=3)
    assert len(calls) == 2
