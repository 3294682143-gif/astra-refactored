"""Negative controls for the G2A method-read capability.

Only the injected public client or one Host callback is mutated; the real
``user_agent`` entry, the real Python Host, the real Node ``main.js
--agent-loop`` profile and the real read-only ``MethodCatalog`` reader all run.
The legacy Python solvers stay disabled, so a hidden fallback surfaces as a
failure. No guard is relaxed to make a case pass.
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
from python.astra_bridge import agent_host as host_module  # noqa: E402
from python.astra_bridge import agent_protocol  # noqa: E402
from python.astra_bridge.p0_probe import ProbeError  # noqa: E402
from python.astra_bridge.p0_protocol import ProtocolError  # noqa: E402
from python.astra_bridge.p2_methods import fixture_catalog, fixture_load  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)
from test_ts_methods import _MethodClient, spy_catalog  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

# The 1.2 manifest is a historical contract and must not drift silently.
# Two deliberate drifts are pinned here, both widening only what the shared
# registry already exposes: the P3 tool whitelist (4 -> 8 names) and the
# summary `effectCalls` bound (2 -> 3, the tool quota plus one method card).
# The legacy contract keeps its own `effect-1/2` id vocabulary: the six-id
# table belongs to the live 1.3 agent-host schema only.
LEGACY_SHA = "d21953e28965de0497f6dd186b716f388256dd4b95500351729a7dd7d9fe80dd"
LEGACY_PATH = ROOT / "packages" / "protocol" / "schema" / "agent-host.schema.json"


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def _method_kwargs():
    return dict(max_method_loads=1, max_model_calls=4, max_work_units=2,
                max_effects=1, max_reviews=1)


@pytest.mark.parametrize("field", ["title", "id", "body", "bodySha256"])
def test_tampered_method_asset_is_refused(field, monkeypatch, process_tracker, spy_catalog):
    """A forged asset field is refused before the client sees it."""
    method_id = spy_catalog.method_id
    real = host_module.perform_effect
    seen = []

    def forged(request, **kwargs):
        result = real(request, **kwargs)
        if request["action"]["action"] != "method":
            return result
        seen.append(request["effectId"])
        observation = json.loads(result["observation"])
        asset = observation["asset"]
        if field == "title":
            asset["title"] = "Forged title"
        elif field == "id":
            asset["id"] = "forged-id"
        elif field == "body":
            asset["body"] = asset["body"] + "\nforged"
            asset["bodyChars"] = len(asset["body"])
        else:
            asset["bodySha256"] = "0" * 64
        text = json.dumps(observation, ensure_ascii=False, separators=(",", ":"))
        result["observation"] = text
        result["observationHash"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return result

    monkeypatch.setattr(host_module, "perform_effect", forged)
    client = _MethodClient(method_id)
    result = _solve(client, **_method_kwargs())
    assert seen == ["effect-1"]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["method_loads"] == 1
    assert result["childReaped"] is True
    assert client.calls == 1
    assert process_tracker


def test_error_method_receipt_continues_without_asset(monkeypatch, process_tracker,
                                                      spy_catalog):
    """A fixed legal ERROR receipt continues; the next WORK carries no asset."""
    method_id = spy_catalog.method_id
    real = host_module.perform_effect
    seen = []

    def failing(request, **kwargs):
        if request["action"]["action"] != "method":
            return real(request, **kwargs)
        seen.append(request["effectId"])
        from python.astra_bridge.p3_effect_contract import failure_receipt

        return failure_receipt(request, "ERROR", "EFFECT_FAILED")

    monkeypatch.setattr(host_module, "perform_effect", failing)
    client = _MethodClient(method_id)
    result = _solve(client, **_method_kwargs())
    assert seen == ["effect-1"]
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["method_loads"] == 1
    second = json.loads(client.seen[1][0][1]["content"])
    assert second["methodAssets"] == []
    assert len(second["toolObservations"]) == 1
    assert second["toolObservations"][0]["status"] == "ERROR"
    assert second["toolObservations"][0]["source"] == "METHOD_REFERENCE"
    assert process_tracker


@pytest.mark.parametrize("mode", ["catalogtitle", "assetbody"])
def test_tampered_catalog_title_and_asset_are_refused(mode, monkeypatch, process_tracker,
                                                      spy_catalog):
    """A rewritten catalog title or asset body is refused before the client."""
    method_id = spy_catalog.method_id
    seen = []
    base = host_module.AgentHost.on_model

    def wrapper(self, frame_id, params):
        if params["request"]["requestId"] != "model-2":
            return base(self, frame_id, params)
        seen.append("model-2")
        altered = copy.deepcopy(params)
        request = altered["request"]
        body = json.loads(request["messages"][1]["content"])
        if mode == "catalogtitle":
            body["methodCatalog"][0]["title"] = "Rewritten title"
        elif body["methodAssets"]:
            body["methodAssets"][0]["body"] = body["methodAssets"][0]["body"] + "\nx"
        content = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        request["messages"][1]["content"] = content
        serialized = json.dumps(request["messages"], ensure_ascii=False,
                                separators=(",", ":"))
        encoded = serialized.encode("utf-8")
        request["contextHash"] = hashlib.sha256(encoded).hexdigest()
        request["contextBytes"] = len(encoded)
        return base(self, frame_id, altered)

    monkeypatch.setattr(host_module.AgentHost, "on_model", wrapper)
    client = _MethodClient(method_id)
    result = _solve(client, **_method_kwargs())
    assert seen == ["model-2"]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["client_method_calls"] == 1
    assert client.calls == 1
    assert result["childReaped"] is True
    assert process_tracker


@pytest.mark.parametrize("field", ["catalogCalls", "methodLoads"])
def test_tampered_summary_counters_are_refused(field, monkeypatch, process_tracker,
                                               spy_catalog):
    """Swapping the real catalog/method counters in the summary is refused."""
    method_id = spy_catalog.method_id
    seen = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        if not seen:
            seen.append(field)
            message = copy.deepcopy(message)
            summary = message["result"]["summary"]
            summary[field] = 1 - summary[field]
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    client = _MethodClient(method_id)
    result = _solve(client, **_method_kwargs())
    assert seen == [field]
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["childReaped"] is True
    assert process_tracker


def test_legacy_manifest_is_read_only_and_live_is_refused():
    """The frozen 1.2 manifest keeps its bytes and never becomes live."""
    raw = LEGACY_PATH.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == LEGACY_SHA
    legacy = agent_protocol.load_legacy_manifest()
    assert legacy["protocolVersion"] == agent_protocol.AGENT_HOST_LEGACY_VERSION
    stop = {
        "protocolVersion": agent_protocol.AGENT_HOST_LEGACY_VERSION,
        "sessionId": "legacy-session",
        "stopped": True,
    }
    agent_protocol.payload(legacy, "session.stop", "result", stop, "legacy-session")
    with pytest.raises(ProtocolError):
        agent_protocol.load_manifest(LEGACY_PATH)
    with pytest.raises(ProtocolError):
        agent_protocol.validate_manifest(legacy)
    active = agent_protocol.load_manifest()
    assert active["protocolVersion"] == agent_protocol.AGENT_HOST_VERSION
    assert active["protocolVersion"] == "1.3-agent-loop-preview"
    with pytest.raises(ProbeError):
        host_module.AgentHost(legacy, "legacy-session", None, PROBLEM, "0" * 64,
                              {"maxModelCalls": 0}, None)
