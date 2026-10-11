"""P2 local Host single-work-unit tests against the real Node child process.

The Node runtime is never mocked: every case spawns the compiled entry point
and the tracker asserts the child and its three pipes are cleaned up. Legacy
solver entry points and network access are refused for the whole module.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p2_host_fixture import OfflineP2Client
from python.astra_bridge.p2_host_offline import run_p2_host

PROBLEM = "Solve x^2 - 5x + 6 = 0 for x."
METHOD = "linearization-spectral"
REPLY = "x = 2 or x = 3"


@pytest.fixture(autouse=True)
def tracker(monkeypatch):
    procs = []
    real = subprocess.Popen

    def spy(*args, **kwargs):
        proc = real(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", spy)

    def no_solve(*args, **kwargs):
        raise AssertionError("legacy solver must not run")

    import mathagent.entrypoint as legacy
    import mathagent.lite.runtime as lite
    import user_agent

    monkeypatch.setattr(lite.LiteRuntime, "solve", no_solve)
    monkeypatch.setattr(legacy.ReasoningAgent, "solve", no_solve)
    monkeypatch.setattr(user_agent.ReasoningAgent, "solve", no_solve)
    monkeypatch.setattr(socket, "create_connection", no_solve)
    yield procs
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream is None or stream.closed


def _run(**kwargs):
    kwargs.setdefault("problem", PROBLEM)
    kwargs.setdefault("reply", REPLY)
    return run_p2_host(**kwargs)


def test_no_method_candidate(tracker):
    result = _run()
    assert result["status"] == "candidate"
    assert result["frames"] == 8
    assert result["modelCalls"] == 1
    assert result["methodLoads"] == 0
    assert result["methodStatus"] == "NONE"
    assert result["artifactCount"] == 1
    assert result["openObligations"] > 0
    assert len(result["contextHash"]) == 64
    assert result["childReaped"] is True
    assert result["candidateVerified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["mode"] == "MOCK_ONLY"
    assert result["targetEnvironment"] == "TARGET_UNVERIFIED"
    assert result["final_response"] == REPLY
    assert len(tracker) == 1


def test_method_loaded_and_private_context(tracker, monkeypatch):
    seen = []
    real_chat = OfflineP2Client.chat

    def spy(self, messages, temperature=0.2, max_tokens=8192):
        seen.append((messages, temperature, max_tokens))
        return real_chat(self, messages, temperature=temperature, max_tokens=max_tokens)

    monkeypatch.setattr(OfflineP2Client, "chat", spy)
    result = _run(method_id=METHOD)
    assert result["frames"] == 12
    assert result["modelCalls"] == 1
    assert result["methodLoads"] == 1
    assert result["methodStatus"] == "LOADED"
    assert len(seen) == 1
    messages, temperature, max_tokens = seen[0]
    assert temperature == 0.2 and max_tokens == 8192
    assert [item["role"] for item in messages] == ["system", "user"]
    inner = json.loads(messages[1]["content"])
    assert inner["problemFullText"] == PROBLEM
    assert inner["sourceRequestId"] == "model-1"
    assets = inner["methodAssets"]
    assert len(assets) == 1
    asset = assets[0]
    assert asset["id"] == METHOD
    assert len(asset["bodySha256"]) == 64
    assert asset["bodyChars"] == len(asset["body"])
    assert hashlib.sha256(asset["body"].encode("utf-8")).hexdigest() == asset["bodySha256"]
    public = json.dumps(result)
    assert "messages" not in public
    assert asset["body"] not in public
    assert PROBLEM not in public


def test_zero_model_budget_with_method(tracker):
    result = _run(method_id=METHOD, max_model_calls=0)
    assert result["frames"] == 6
    assert result["modelCalls"] == 0
    assert result["methodLoads"] == 0
    assert result["status"] == "unsolved"
    assert result["contextHash"] is None


def test_zero_method_budget_refused(tracker):
    result = _run(method_id=METHOD, max_method_loads=0)
    assert result["frames"] == 8
    assert result["methodStatus"] == "REFUSED"
    assert result["methodLoads"] == 0


def test_unknown_method_id_refused(tracker):
    result = _run(method_id="not-a-real-method")
    assert result["frames"] == 10
    assert result["methodStatus"] == "REFUSED"
    assert result["methodLoads"] == 0
    assert result["status"] == "candidate"


@pytest.mark.parametrize("status,reply,expected", [
    ("TRUNCATED", "x = 2 or x = 3", "TRUNCATED"),
    ("ERROR", "x = 2 or x = 3", "ERROR"),
    ("UNKNOWN", "x = 2 or x = 3", "INCOMPLETE"),
    ("COMPLETE", "", "COMPLETE"),
    ("COMPLETE", "   ", "COMPLETE"),
])
def test_non_complete_delivery_never_candidate(tracker, status, reply, expected):
    result = _run(reply=reply, delivery_status=status)
    assert result["status"] == "unsolved"
    assert result["artifactCount"] == 1
    assert result["deliveryStatus"] == expected
    assert result["modelCalls"] == 1


@pytest.mark.parametrize("timeout", [float("nan"), 0, 6, True])
def test_invalid_timeout_rejected_before_spawn(tracker, timeout):
    with pytest.raises(ProbeError):
        _run(timeout=timeout)
    assert tracker == []


@pytest.mark.parametrize("kwargs", [
    {"max_model_calls": 1.0},
    {"max_model_calls": True},
    {"max_model_calls": 4},
    {"max_method_loads": 1.0},
    {"max_method_loads": 2},
])
def test_invalid_budgets_rejected_before_spawn(tracker, kwargs):
    with pytest.raises(ProbeError):
        _run(**kwargs)
    assert tracker == []


@pytest.mark.parametrize("method_id", ["../etc/passwd", "Linearization", "a/b", ""])
def test_invalid_method_id_rejected_before_spawn(tracker, method_id):
    with pytest.raises(ProbeError):
        _run(method_id=method_id)
    assert tracker == []


def test_lone_surrogate_problem_rejected_before_spawn(tracker):
    with pytest.raises(ProbeError):
        _run(problem="bad \ud800 text")
    assert tracker == []


def test_oversized_reply_rejected_before_spawn(tracker):
    with pytest.raises(ProbeError):
        _run(reply="x" * 4097)
    assert tracker == []


def test_missing_node_spawn_failed(tracker):
    with pytest.raises(ProbeError) as excinfo:
        _run(node="astra-no-such-node-binary")
    assert excinfo.value.code == "SPAWN_FAILED"


def test_missing_script_child_failed(tracker):
    with pytest.raises(ProbeError) as excinfo:
        _run(script=ROOT / "apps" / "stdio-runtime" / "dist" / "no-such-main.js")
    assert excinfo.value.code == "CHILD_FAILED"


@pytest.mark.parametrize("body", [
    "setInterval(() => {}, 1000);",
    "process.stdout.write('not json\\n');",
    "process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));",
    "process.stdout.write('x'.repeat(70000) + '\\n');",
    "process.stderr.write('PRIVATE-SECRET\\n');",
    "process.exit(3);",
])
def test_broken_child_is_fixed_error_and_reaped(tracker, tmp_path, body):
    script = tmp_path / "child.js"
    script.write_text(body, encoding="utf-8")
    with pytest.raises(ProbeError) as excinfo:
        _run(script=script, timeout=0.3)
    assert "PRIVATE" not in str(excinfo.value)
    assert excinfo.value.code in {
        "TIMEOUT", "CHILD_FAILED", "INVALID_JSON", "INVALID_UTF8",
        "FRAME_TOO_LARGE", "EOF", "FIELD_VALUE",
    }
    assert len(tracker) == 1


def test_repeated_sessions_are_isolated(tracker):
    fd_dir = Path("/proc/self/fd")
    before = len(os.listdir(fd_dir)) if fd_dir.is_dir() else None
    sessions = set()
    for _ in range(5):
        result = _run()
        assert result["status"] == "candidate"
        assert result["modelCalls"] == 1
        sessions.add(result["sessionId"])
    assert len(sessions) == 5
    assert len(tracker) == 5
    if before is not None:
        assert len(os.listdir(fd_dir)) == before
