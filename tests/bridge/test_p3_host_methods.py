"""P3 Host method catalog/load integration: real Node channel, real MethodCatalog."""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest

import user_agent
from mathagent.lite import methods as methods_module
from mathagent.lite.methods import MethodCatalog
from mathagent.lite.runtime import LiteRuntime

from python.astra_bridge import p2_methods
from python.astra_bridge import p3_host_callback as callback
from python.astra_bridge import p3_host_offline as runner
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_effect_contract import receipt as build_receipt

PRIVATE = "PRIVATE_METHOD_PROBLEM"
MID = "linearization-spectral"
POLY = {"expression": "(x+1)**2", "variables": ["x"], "parameters": []}


def method(mid=MID):
    return json.dumps({"action": "method", "id": mid})


def tool(name="polynomial_expand_coefficients", args=None, scope="expand"):
    return json.dumps({"action": "tool", "name": name, "args": POLY if args is None else args, "scope": scope})


def final(answer="x=1"):
    return json.dumps({"action": "final", "answer": answer, "complete": True, "unresolved": []})


def reply(text, status="COMPLETE"):
    return {"deliveryStatus": status, "text": text}


def go(actions, **opts):
    opts.setdefault("max_method_loads", 1)
    return runner.run_p3_host(PRIVATE, receipts=[reply(text) for text in actions], **opts)


def _real_root():
    return Path(methods_module.__file__).resolve().parents[1] / "resources" / "general_v11"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("network access is forbidden")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(user_agent.ReasoningAgent, "solve", refuse)
    monkeypatch.setattr(LiteRuntime, "solve", refuse)


@pytest.fixture
def capture(monkeypatch):
    hosts = []
    procs = []
    reads = []
    real_init = callback.P3HostCallback.__init__
    real_popen = subprocess.Popen
    real_read = methods_module._read_bytes

    def spy_init(self, *args, **kwargs):
        real_init(self, *args, **kwargs)
        hosts.append(self)

    def spy_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        procs.append(proc)
        return proc

    def spy_read(root, rel):
        reads.append(rel)
        return real_read(root, rel)

    monkeypatch.setattr(callback.P3HostCallback, "__init__", spy_init)
    monkeypatch.setattr(runner.subprocess, "Popen", spy_popen)
    monkeypatch.setattr(methods_module, "_read_bytes", spy_read)
    yield hosts, procs, reads
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream is None or stream.closed
    for host in hosts:
        assert host.selector.get_map() is None


def _inner(params):
    return json.loads(params["messages"][1]["content"])


@pytest.mark.parametrize("repeat", [False, True])
def test_method_load_then_final(capture, repeat):
    actions = [method(), method(), final()] if repeat else [method(), final()]
    result = go(actions)
    assert result["status"] == "candidate"
    assert result["candidateVerified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["catalogCalls"] == 1
    assert result["methodLoads"] == 1
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == (1 if repeat else 0)
    assert result["modelCalls"] == (3 if repeat else 2)
    assert result["frames"] == (16 if repeat else 14)
    assert capture[2] == ["SOURCE.json", "data/methods.json", f"references/{MID}.md"]
    host = capture[0][-1]
    first = _inner(host.history[0]["params"])
    assert len(first["methodCatalog"]) == 20
    assert all(set(row) == {"id", "title"} for row in first["methodCatalog"])
    assert MID in [row["id"] for row in first["methodCatalog"]]
    assert "LOAD_METHOD" in first["allowedActionIds"]
    assert "asset" not in json.dumps(first["methodCatalog"])
    second = _inner(host.history[1]["params"])
    assert second["effects"] == host.effects
    assert len(second["effects"]) == 1
    receipt = second["effects"][0]
    assert receipt["source"] == "METHOD_REFERENCE"
    assert receipt["level"] == "PROVISIONAL"
    assert receipt["checkResult"] == "UNKNOWN"
    assert receipt["status"] == "COMPLETE"
    observation = json.loads(receipt["observation"])
    assert observation["interpretation"] == "ADVISORY_NOT_PROOF"
    asset = observation["asset"]
    assert asset["id"] == MID
    assert asset["bodyChars"] == len(asset["body"])
    assert asset["bodySha256"] == hashlib.sha256(asset["body"].encode("utf-8")).hexdigest()
    assert asset["title"] == [row["title"] for row in first["methodCatalog"] if row["id"] == MID][0]
    public = json.dumps(result)
    assert PRIVATE not in public
    assert asset["body"] not in public


@pytest.mark.parametrize("order", ["method-tool", "tool-method"])
def test_method_and_tool_share_budget(capture, order):
    actions = [method(), tool(), final()] if order == "method-tool" else [tool(), method(), final()]
    result = go(actions)
    assert result["status"] == "candidate"
    assert result["effectCalls"] == 2
    assert result["methodLoads"] == 1
    assert result["catalogCalls"] == 1
    assert result["frames"] == 18
    host = capture[0][-1]
    assert [entry["source"] for entry in host.effects] == (
        ["METHOD_REFERENCE", "PROGRAM_OBSERVATION"] if order == "method-tool"
        else ["PROGRAM_OBSERVATION", "METHOD_REFERENCE"]
    )


def test_second_effect_and_second_method_refused(capture):
    one = go([method(), tool(), final()], max_effects=1)
    assert one["stopReason"] == "BUDGET_EXHAUSTED"
    assert one["effectCalls"] == 1
    assert one["methodLoads"] == 1
    assert capture[2] == ["SOURCE.json", "data/methods.json", f"references/{MID}.md"]
    capture[2].clear()

    host = capture[0][-1]
    other = [row["id"] for row in host.catalog_entries if row["id"] != MID][0]
    second = go([method(), method(other), final()])
    assert second["stopReason"] == "BUDGET_EXHAUSTED"
    assert second["methodLoads"] == 1
    assert second["effectCalls"] == 1
    assert capture[2].count(f"references/{other}.md") == 0
    capture[2].clear()

    last = go([method(), method()], max_model_calls=2)
    assert last["stopReason"] == "BUDGET_EXHAUSTED"
    assert last["methodLoads"] == 1
    assert capture[2].count(f"references/{MID}.md") == 1


@pytest.mark.parametrize("opts", [
    {"max_method_loads": 0},
    {"max_model_calls": 0},
    {"max_model_calls": 1},
    {"max_effects": 0},
])
def test_disabled_catalog_never_reads(capture, monkeypatch, opts):
    def refuse(*args, **kwargs):
        raise AssertionError("catalog must not be constructed")

    monkeypatch.setattr(p2_methods, "MethodCatalog", refuse)
    result = go([final()], **opts)
    assert result["catalogCalls"] == 0
    assert result["methodLoads"] == 0
    assert capture[2] == []
    if opts.get("max_model_calls") == 0:
        assert result["status"] == "unsolved"
        assert result["modelCalls"] == 0
    else:
        assert result["status"] == "candidate"


def test_unavailable_catalog_degrades(capture, monkeypatch, tmp_path):
    missing = tmp_path / "missing"
    monkeypatch.setattr(p2_methods, "MethodCatalog", lambda *a, **k: MethodCatalog(root=missing))
    result = go([final()])
    assert result["status"] == "candidate"
    assert result["catalogCalls"] == 1
    assert result["methodLoads"] == 0
    host = capture[0][-1]
    inner = _inner(host.history[0]["params"])
    assert inner["methodCatalog"] == []
    assert "LOAD_METHOD" not in inner["allowedActionIds"]
    assert capture[2] == ["SOURCE.json"]

    unknown = go([method("m-99"), final()])
    assert unknown["stopReason"] == "EFFECT_UNAVAILABLE"
    assert unknown["methodLoads"] == 0
    assert capture[2].count(f"references/{MID}.md") == 0

    path = go([method("../SOURCE.json"), final()])
    assert path["stopReason"] == "ACTION_REJECTED"
    assert path["methodLoads"] == 0
    assert capture[2].count("references/../SOURCE.json") == 0


def test_corrupt_body_is_error_not_complete(capture, monkeypatch, tmp_path):
    root = tmp_path / "general_v11"
    shutil.copytree(_real_root(), root)
    target = root / "references" / f"{MID}.md"
    target.write_text(target.read_text(encoding="utf-8") + "TAMPER", encoding="utf-8")
    monkeypatch.setattr(p2_methods, "MethodCatalog", lambda *a, **k: MethodCatalog(root=root))
    result = go([method(), method(), final()])
    assert result["status"] == "candidate"
    assert result["candidateVerified"] is False
    assert result["methodLoads"] == 1
    assert result["effectCalls"] == 1
    assert result["cachedEffects"] == 1
    host = capture[0][-1]
    receipt = host.effects[0]
    assert receipt["status"] == "ERROR"
    assert receipt["source"] == "METHOD_REFERENCE"
    assert "TAMPER" not in receipt["observation"]
    assert capture[2].count(f"references/{MID}.md") == 1


@pytest.mark.parametrize("value", [-1, 2, True, 1.0])
def test_bad_max_method_loads_rejected_before_spawn(capture, value):
    with pytest.raises(ProbeError) as excinfo:
        go([final()], max_method_loads=value)
    assert excinfo.value.code == "FIELD_VALUE"
    assert capture[1] == []
    assert capture[2] == []


def test_cli_max_method_loads(capsys):
    code = runner.main(["--problem", PRIVATE, "--action", method(), "--action", final(), "--max-method-loads", "1"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "candidate"
    assert payload["candidateVerified"] is False
    assert payload["catalogCalls"] == 1
    assert payload["methodLoads"] == 1


def _other_id(host):
    return [row["id"] for row in host.catalog_entries if row["id"] != MID][0]


def _wrap_request(monkeypatch, mutate):
    """Wrap the live on_request; mutate one deep-copied frame, then delegate."""
    base = callback.P3HostCallback.on_request

    def wrapper(self, message):
        altered = mutate(self, copy.deepcopy(message))
        if altered is None:
            return base(self, message)
        return base(self, altered)

    monkeypatch.setattr(callback.P3HostCallback, "on_request", wrapper)


def _wrap_result(monkeypatch, mutate):
    base = callback.P3HostCallback.on_result

    def wrapper(self, message):
        altered = mutate(self, copy.deepcopy(message))
        if altered is None:
            return base(self, message)
        return base(self, altered)

    monkeypatch.setattr(callback.P3HostCallback, "on_result", wrapper)


@pytest.mark.parametrize(
    "field",
    ["id", "sourceRequestId", "scopeId", "path", "effectId", "forced"],
)
def test_live_method_load_request_mutations_rejected(capture, monkeypatch, field):
    """A tampered method.load request is refused before any body read."""
    seen = []

    def mutate(self, message):
        if message.get("method") != "method.load":
            return None
        seen.append(field)
        request = message["params"]["request"]
        if field == "id":
            request["action"]["id"] = _other_id(self)
        elif field == "sourceRequestId":
            request["binding"]["sourceRequestId"] = "model-2"
        elif field == "scopeId":
            request["binding"]["scopeId"] = "0" * 64
        elif field == "path":
            request["action"]["path"] = f"references/{MID}.md"
        elif field == "effectId":
            request["effectId"] = "effect-2"
        else:
            message["method"] = "method.load"
        return message

    if field == "forced":
        # max_method_loads=0: Node never sends method.load, so inject one
        # forged frame while the real solve result is still pending.
        base_result = callback.P3HostCallback.on_result
        base_request = callback.P3HostCallback.on_request

        def wrapper_result(self, message):
            if message.get("id") == "host-2" and "result" in message:
                record = self.model_records[-1]
                params = record["params"]
                action = json.loads(record["receipt"]["text"])
                forged = {
                    "effectId": "effect-1",
                    "binding": {
                        "sessionId": self.session_id,
                        "problemHash": self.problem_hash,
                        "contractVersion": 1,
                        "taskId": params["taskId"],
                        "scopeId": params["scopeId"],
                        "sourceRequestId": record["requestId"],
                    },
                    "action": action,
                    "remainingMs": min(1000, self.remaining_ms()),
                }
                seen.append(field)
                base_request(
                    self,
                    {
                        "jsonrpc": "2.0",
                        "id": "node-effect-1",
                        "method": "method.load",
                        "params": {
                            "protocolVersion": self.manifest["protocolVersion"],
                            "sessionId": self.session_id,
                            "request": forged,
                        },
                    },
                )
            return base_result(self, message)

        monkeypatch.setattr(callback.P3HostCallback, "on_result", wrapper_result)
        with pytest.raises(ProbeError):
            go([method(), final()], max_method_loads=0)
    else:
        _wrap_request(monkeypatch, mutate)
        with pytest.raises(ProbeError):
            go([method(), final()])
    assert seen == [field]
    host = capture[0][-1]
    assert host.method_loads == 0
    assert host.effect_calls == 0
    if field == "forced":
        assert capture[2] == []
    else:
        assert capture[2] == ["SOURCE.json", "data/methods.json"]
    assert f"references/{MID}.md" not in capture[2]


def test_live_replayed_effect_and_catalog_rejected(capture, monkeypatch):
    """A replayed effect frame and a second catalog frame are both refused."""
    seen = []
    base_request = callback.P3HostCallback.on_request

    def mutate(self, message):
        if message.get("method") == "model.generate":
            seen.append(message["params"]["requestId"])
            if len(seen) == 2:
                forged = copy.deepcopy(self.effect_records[0]["request"])
                forged["effectId"] = "effect-2"
                return {
                    "jsonrpc": "2.0",
                    "id": "node-effect-2",
                    "method": "method.load",
                    "params": {
                        "protocolVersion": self.manifest["protocolVersion"],
                        "sessionId": self.session_id,
                        "request": forged,
                    },
                }
        return None

    def wrapper_replay(self, message):
        altered = mutate(self, copy.deepcopy(message))
        if altered is None:
            return base_request(self, message)
        return base_request(self, altered)

    with monkeypatch.context() as patch:
        patch.setattr(callback.P3HostCallback, "on_request", wrapper_replay)
        with pytest.raises(ProbeError):
            go([method(), method(), final()])
        host = capture[0][-1]
        assert host.method_loads == 1
        assert host.effect_calls == 1
        assert capture[2].count(f"references/{MID}.md") == 1

    capture[2].clear()
    seen.clear()

    def mutate_catalog(self, message):
        if message.get("method") == "model.generate" and not seen:
            seen.append(message["params"]["requestId"])
            return {
                "jsonrpc": "2.0",
                "id": "node-catalog-1",
                "method": "method.catalog",
                "params": {
                    "protocolVersion": self.manifest["protocolVersion"],
                    "sessionId": self.session_id,
                },
            }
        return None

    def wrapper_catalog(self, message):
        altered = mutate_catalog(self, copy.deepcopy(message))
        if altered is None:
            return base_request(self, message)
        return base_request(self, altered)

    with monkeypatch.context() as patch:
        patch.setattr(callback.P3HostCallback, "on_request", wrapper_catalog)
        with pytest.raises(ProbeError):
            go([method(), final()])
        host = capture[0][-1]
        assert host.catalog_calls == 1
        assert host.method_loads == 0
        assert capture[2] == ["SOURCE.json", "data/methods.json"]


@pytest.mark.parametrize(
    "field",
    ["dropCatalog", "title", "dropEffects", "body", "bindingVersion"],
)
def test_live_context_mutations_rejected(capture, monkeypatch, field):
    """A rewritten inner context is refused on the real recorded facts."""

    def mutate(self, message):
        if message.get("method") != "model.generate":
            return None
        if message["params"]["requestId"] != "model-2":
            return None
        params = message["params"]
        inner = json.loads(params["messages"][1]["content"])
        if field == "dropCatalog":
            del inner["methodCatalog"]
        elif field == "title":
            inner["methodCatalog"][0]["title"] = "Other"
        elif field == "dropEffects":
            inner["effects"] = []
        elif field == "body":
            observation = json.loads(inner["effects"][0]["observation"])
            observation["asset"]["body"] = observation["asset"]["body"] + "TAMPER"
            observation["asset"]["bodyChars"] = len(observation["asset"]["body"])
            observation["asset"]["bodySha256"] = hashlib.sha256(
                observation["asset"]["body"].encode("utf-8")
            ).hexdigest()
            text = json.dumps(observation, ensure_ascii=False, separators=(",", ":"))
            inner["effects"][0]["observation"] = text
            inner["effects"][0]["observationHash"] = hashlib.sha256(
                text.encode("utf-8")
            ).hexdigest()
        else:
            inner["effects"][0]["binding"]["contractVersion"] = True
        params["messages"][1]["content"] = json.dumps(
            inner, ensure_ascii=False, separators=(",", ":")
        )
        serialized = json.dumps(
            params["messages"], ensure_ascii=False, separators=(",", ":")
        )
        params["contextHash"] = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        return message

    _wrap_request(monkeypatch, mutate)
    with pytest.raises(ProbeError):
        go([method(), final()])
    host = capture[0][-1]
    assert capture[2].count(f"references/{MID}.md") == 1
    assert host.model_calls == 1
    assert len(host.history) == 1


@pytest.mark.parametrize("field", ["candidate", "catalogCalls", "methodLoads"])
def test_live_solve_result_mutations_rejected(capture, monkeypatch, field):
    """A forged solve result is refused against the real last action."""

    def mutate(self, message):
        if message.get("id") != "host-2" or "result" not in message:
            return None
        result = message["result"]
        if field == "candidate":
            result["status"] = "candidate"
            result["finalResponse"] = "x=1"
            result["candidateRequestId"] = "model-1"
        elif field == "catalogCalls":
            result["catalogCalls"] = 0
        else:
            result["methodLoads"] = 0
        return message

    _wrap_result(monkeypatch, mutate)
    with pytest.raises(ProbeError):
        go([method(), final()])
    host = capture[0][-1]
    assert capture[2].count(f"references/{MID}.md") == 1
    assert host.model_calls == 2
    assert len(host.history) == 2


@pytest.mark.parametrize("status", ["COMPLETE", "UNKNOWN"])
def test_live_late_method_effect_is_not_reusable(capture, monkeypatch, status):
    """A late method receipt is never COMPLETE and never cached."""
    real_effect = callback.perform_effect

    def late(request, **kwargs):
        result = real_effect(request, **kwargs)
        host = capture[0][-1]
        host.deadline = time.monotonic() - 0.001
        if status == "UNKNOWN":
            return build_receipt(request, "UNKNOWN", '{"code":"UNKNOWN_OUTCOME"}')
        return result

    monkeypatch.setattr(callback, "perform_effect", late)
    with pytest.raises(ProbeError):
        go([method(), final()])
    host = capture[0][-1]
    assert host.method_loads == 1
    assert host.effect_calls == 1
    record = host.effect_records[0]
    assert record["receipt"]["status"] != "COMPLETE"
    if status == "UNKNOWN":
        assert record["receipt"]["status"] == "UNKNOWN"
        assert record["state"] == "OUTCOME_UNKNOWN"
    assert host.effects == []
    assert host.cache == {}
    assert host.model_calls == 1
    assert capture[2].count(f"references/{MID}.md") == 1


def test_live_late_catalog_is_not_usable(capture, monkeypatch):
    """A catalog read that lands past the deadline never reaches the model."""
    real_catalog = p2_methods.fixture_catalog

    def late(catalog=None):
        result = real_catalog(catalog)
        capture[0][-1].deadline = time.monotonic() - 0.001
        return result

    monkeypatch.setattr(p2_methods, "fixture_catalog", late)
    with pytest.raises(ProbeError):
        go([method(), final()])
    host = capture[0][-1]
    assert host.catalog_calls == 1
    assert host.model_calls == 0
    assert capture[2] == ["SOURCE.json", "data/methods.json"]
    assert f"references/{MID}.md" not in capture[2]
