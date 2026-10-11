"""P3 Host admission negatives: real running Node session, no manual reset.

Every attack is injected into a live ``P3HostCallback`` while the real Node
child is running, by wrapping the original ``on_request``/``on_result`` and
mutating one field before delegating. No Host state is reset and no closed
Host is reused.
"""

from __future__ import annotations

import copy
import hashlib
import json
import socket
import subprocess
import time

import pytest

from python.astra_bridge import p3_host_callback as callback
from python.astra_bridge import p3_host_offline as runner
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_effect_contract import receipt as build_receipt
from python.astra_bridge.p3_host_context import strict_context

PRIVATE = "PRIVATE p"
POLY = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}


def tool(name="polynomial_expand_coefficients", args=None, scope="expand"):
    return json.dumps(
        {"action": "tool", "name": name, "args": POLY if args is None else args, "scope": scope}
    )


def final(answer="x=1"):
    return json.dumps({"action": "final", "answer": answer, "complete": True, "unresolved": []})


def reply(text, status="COMPLETE"):
    return {"deliveryStatus": status, "text": text}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("network access is forbidden")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)


@pytest.fixture
def probe(monkeypatch):
    """Capture the live Host and Popen, and fake the effect executor."""
    hosts = []
    procs = []
    calls = []
    real_init = callback.P3HostCallback.__init__
    real_popen = subprocess.Popen
    real_effect = callback.perform_effect

    def spy_init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        hosts.append(self)

    def spy_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        procs.append(proc)
        return proc

    def fake_effect(request, **kwargs):
        calls.append(request)
        return build_receipt(request, "COMPLETE", '{"private":"OBS"}')

    monkeypatch.setattr(callback.P3HostCallback, "__init__", spy_init)
    monkeypatch.setattr(runner.subprocess, "Popen", spy_popen)
    monkeypatch.setattr(callback, "perform_effect", fake_effect)
    yield hosts, procs, calls
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream is None or stream.closed
    for host in hosts:
        assert host.selector.get_map() is None
    assert real_effect is not None


def run(problem, receipts, **kwargs):
    return runner.run_p3_host(problem, receipts=receipts, **kwargs)


def test_live_control_and_strict_context(probe):
    result = run(PRIVATE, [reply(tool()), reply(final())])
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 1
    host = probe[0][-1]
    assert host.effect_calls == 1
    params = copy.deepcopy(host.history[1]["params"])
    strict_context(
        params, PRIVATE, host.session_id, host.problem_hash,
        host.history[:1], host.effects, host.anchor,
        ["PROPOSE_FINAL", "MARK_UNSOLVED", "CALL_REGISTERED_TOOL"],
    )
    mutations = []
    empty = copy.deepcopy(params)
    inner = json.loads(empty["messages"][1]["content"])
    inner["effects"] = []
    mutations.append((empty, inner))
    changed = copy.deepcopy(params)
    inner = json.loads(changed["messages"][1]["content"])
    inner["effects"][0]["observation"] = '{"private":"OTHER"}'
    inner["effects"][0]["observationHash"] = hashlib.sha256(
        inner["effects"][0]["observation"].encode("utf-8")
    ).hexdigest()
    mutations.append((changed, inner))
    boolver = copy.deepcopy(params)
    inner = json.loads(boolver["messages"][1]["content"])
    inner["effects"][0]["binding"]["contractVersion"] = True
    mutations.append((boolver, inner))
    hist = copy.deepcopy(params)
    inner = json.loads(hist["messages"][1]["content"])
    inner["history"][0]["text"] = final()
    mutations.append((hist, inner))
    histid = copy.deepcopy(params)
    inner = json.loads(histid["messages"][1]["content"])
    inner["history"][0]["requestId"] = "model-2"
    mutations.append((histid, inner))
    task = copy.deepcopy(params)
    inner = json.loads(task["messages"][1]["content"])
    inner["task"]["taskId"] = "other-task"
    mutations.append((task, inner))
    joint = copy.deepcopy(params)
    inner = json.loads(joint["messages"][1]["content"])
    new_scope = "c" * 64
    joint["scopeId"] = new_scope
    inner["scopeId"] = new_scope
    inner["scope"]["scopeId"] = new_scope
    inner["task"]["scopeId"] = new_scope
    inner["task"]["envelope"]["scopeId"] = new_scope
    inner["effects"][0]["binding"]["scopeId"] = new_scope
    for entry in inner["obligations"]:
        if entry["obligationId"] == inner["task"]["obligationId"]:
            entry["envelope"]["scopeId"] = new_scope
    mutations.append((joint, inner))
    for mutated, inner in mutations:
        mutated["messages"][1]["content"] = json.dumps(
            inner, ensure_ascii=False, separators=(",", ":")
        )
        serialized = json.dumps(
            mutated["messages"], ensure_ascii=False, separators=(",", ":")
        )
        mutated["contextHash"] = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        with pytest.raises(ProbeError):
            strict_context(
                mutated, PRIVATE, host.session_id, host.problem_hash,
                host.history[:1], host.effects, host.anchor,
                ["PROPOSE_FINAL", "MARK_UNSOLVED", "CALL_REGISTERED_TOOL"],
            )


@pytest.mark.parametrize(
    "field",
    ["args", "name", "scope", "taskId", "sourceRequestId", "effectId", "contractVersion"],
)
def test_tool_request_mutations_rejected(probe, monkeypatch, field):
    base = callback.P3HostCallback.on_request

    def wrapper(self, message):
        if message.get("method") == "tool.execute":
            altered = copy.deepcopy(message)
            request = altered["params"]["request"]
            if field == "args":
                request["action"]["args"] = {"expression": "x", "variables": ["x"], "parameters": []}
            elif field == "name":
                request["action"]["name"] = "linear_system_solution_set"
            elif field == "scope":
                request["action"]["scope"] = "other scope"
            elif field == "taskId":
                request["binding"]["taskId"] = "other-task"
            elif field == "sourceRequestId":
                request["binding"]["sourceRequestId"] = "model-2"
            elif field == "effectId":
                request["effectId"] = "effect-2"
            else:
                request["binding"]["contractVersion"] = True
            return base(self, altered)
        return base(self, message)

    monkeypatch.setattr(callback.P3HostCallback, "on_request", wrapper)
    with pytest.raises(ProbeError):
        run(PRIVATE, [reply(tool()), reply(final())])
    assert probe[2] == []
    host = probe[0][-1]
    assert host.effect_calls == 0
    assert host.model_calls == 1


@pytest.mark.parametrize(
    "field",
    ["answer", "candidateRequestId", "status", "modelCalls", "effectCalls", "contextHash", "verified"],
)
def test_solve_result_mutations_rejected(probe, monkeypatch, field):
    base = callback.P3HostCallback.on_result

    def wrapper(self, message):
        if message.get("id") == "host-2" and "result" in message:
            altered = copy.deepcopy(message)
            result = altered["result"]
            if field == "answer":
                result["finalResponse"] = "x=2"
            elif field == "candidateRequestId":
                result["candidateRequestId"] = "model-2"
            elif field == "status":
                result["status"] = "unsolved"
            elif field == "modelCalls":
                result["modelCalls"] = 2
            elif field == "effectCalls":
                result["effectCalls"] = 1
            elif field == "contextHash":
                result["contextHash"] = "d" * 64
            else:
                result["candidateVerified"] = True
            return base(self, altered)
        return base(self, message)

    monkeypatch.setattr(callback.P3HostCallback, "on_result", wrapper)
    with pytest.raises(ProbeError):
        run(PRIVATE, [reply(final())])


@pytest.mark.parametrize("mode", ["raise", "hash"])
def test_effect_failure_is_unknown(probe, monkeypatch, mode):
    def broken(request, **kwargs):
        probe[2].append(request)
        if mode == "raise":
            raise RuntimeError(PRIVATE)
        good = build_receipt(request, "COMPLETE", '{"private":"OBS"}')
        good["observationHash"] = hashlib.sha256(b"forged").hexdigest()
        return good

    monkeypatch.setattr(callback, "perform_effect", broken)
    result = run(PRIVATE, [reply(tool()), reply(final())])
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "EFFECT_UNKNOWN"
    assert result["effectCalls"] == 1
    assert result["modelCalls"] == 1
    assert len(probe[2]) == 1
    assert PRIVATE not in json.dumps(result)
    host = probe[0][-1]
    assert host.effect_records[-1]["state"] == "OUTCOME_UNKNOWN"


def test_duplicate_rpc_from_same_source_rejected(probe, monkeypatch):
    base = callback.P3HostCallback.on_request
    seen = []

    def wrapper(self, message):
        if message.get("method") == "model.generate":
            seen.append(message["params"]["requestId"])
            if len(seen) == 2:
                record = self.effect_records[0]
                forged = copy.deepcopy(record["request"])
                forged["effectId"] = "effect-2"
                frame = {
                    "jsonrpc": "2.0",
                    "id": "node-effect-2",
                    "method": "tool.execute",
                    "params": {
                        "protocolVersion": self.manifest["protocolVersion"],
                        "sessionId": self.session_id,
                        "request": forged,
                    },
                }
                return base(self, frame)
        return base(self, message)

    monkeypatch.setattr(callback.P3HostCallback, "on_request", wrapper)
    with pytest.raises(ProbeError):
        run(PRIVATE, [reply(tool()), reply(tool()), reply(final())])
    host = probe[0][-1]
    assert host.effect_calls == 1
    assert len(probe[2]) == 1


@pytest.mark.parametrize("status", ["COMPLETE", "UNKNOWN"])
def test_late_effect_after_deadline_is_not_complete(probe, monkeypatch, status):
    def late(request, **kwargs):
        probe[2].append(request)
        host = probe[0][-1]
        host.deadline = time.monotonic() - 0.001
        return build_receipt(request, status, '{"private":"OBS"}')

    monkeypatch.setattr(callback, "perform_effect", late)
    with pytest.raises(ProbeError):
        run(PRIVATE, [reply(tool()), reply(final())])
    host = probe[0][-1]
    assert host.effect_calls == 1
    assert len(probe[2]) == 1
    record = host.effect_records[0]
    assert record["receipt"]["status"] != "COMPLETE"
    if status == "UNKNOWN":
        assert record["receipt"]["status"] == "UNKNOWN"
        assert record["state"] == "OUTCOME_UNKNOWN"
    assert host.effects == []
    assert host.cache == {}


def test_context_full_cache_then_atomic_reject(probe, monkeypatch):
    """A full next context stops cleanly; a forged hash is rejected atomically."""
    big = "x" * 9000
    big_tool = tool(args={"expression": big, "variables": ["x"], "parameters": []})
    problem = "\U0001f600" * 8192

    def fake_effect(request, **kwargs):
        probe[2].append(request)
        return build_receipt(request, "COMPLETE", "x" * 16000)

    monkeypatch.setattr(callback, "perform_effect", fake_effect)
    result = run(problem, [reply(big_tool), reply(big_tool), reply(final())])
    assert result["status"] == "unsolved"
    assert result["modelCalls"] == 2
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == 1
    assert result["stopReason"] == "CONTEXT_REJECTED"
    assert result["candidateRequestId"] is None
    assert len(probe[2]) == 1
    host = probe[0][-1]
    assert host.cached_sources == {"model-2"}
    assert host.model_calls == 2
    assert host.effect_calls == 1

    base = callback.P3HostCallback.on_result

    def wrapper(self, message):
        if message.get("id") == "host-2" and "result" in message:
            if message["result"].get("stopReason") == "CONTEXT_REJECTED":
                altered = copy.deepcopy(message)
                altered["result"]["contextHash"] = "0" * 64
                return base(self, altered)
        return base(self, message)

    monkeypatch.setattr(callback.P3HostCallback, "on_result", wrapper)
    with pytest.raises(ProbeError):
        run(problem, [reply(big_tool), reply(big_tool), reply(final())])
    host = probe[0][-1]
    assert host.cached_sources == set()
    assert host.effect_calls == 1
    assert host.model_calls == 2
