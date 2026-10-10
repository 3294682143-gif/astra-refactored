"""P1 offline Host tests: real Node runtime, real six modules, fake model only.

The only fake is the in-memory fixture client. No network, no real provider and
no Python solver: the legacy solver entry points are monkeypatched to fail so a
hidden fallback would surface as a test failure.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge.p0_probe import ProbeError  # noqa: E402
from python.astra_bridge.p1_offline import OfflineClient, run_offline  # noqa: E402
from python.astra_bridge.p0_protocol import ProtocolError  # noqa: E402
from python.astra_bridge.p1_protocol import (  # noqa: E402
    P1_PROTOCOL_VERSION,
    load_p1_manifest,
    validate_p1_payload,
)

PROBLEM = "Compute 2 + 2 and explain the result."
REPLY = "The answer is 4 because 2 + 2 = 4."
SENTINEL = "SENTINEL-PRIVATE-9f3a"
SCRIPT = ROOT / "apps" / "stdio-runtime" / "dist" / "src" / "p1-main.js"


@pytest.fixture(autouse=True)
def no_legacy_solver(monkeypatch):
    """Any hidden fallback to the frozen Python solver must fail loudly."""
    import mathagent.lite.runtime as lite_runtime

    def boom(*args, **kwargs):
        raise AssertionError("legacy solver must not run in P1")

    monkeypatch.setattr(lite_runtime.LiteRuntime, "solve", boom, raising=False)
    import mathagent.entrypoint as entrypoint

    monkeypatch.setattr(entrypoint.ReasoningAgent, "solve", boom, raising=False)
    import user_agent

    monkeypatch.setattr(user_agent.ReasoningAgent, "solve", boom, raising=False)


@pytest.fixture(autouse=True)
def process_tracker(monkeypatch):
    """Track every real child process; every test must leave none behind."""
    procs = []
    real_popen = subprocess.Popen

    def tracking(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", tracking)
    yield procs
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                assert stream.closed


def _run(**kwargs):
    kwargs.setdefault("problem", PROBLEM)
    kwargs.setdefault("reply", REPLY)
    return run_offline(**kwargs)


def _assert_reaped(result):
    assert result["childReaped"] is True


def test_complete_candidate_positive_control():
    result = _run()
    assert result["status"] == "candidate"
    assert result["finalResponse"] == REPLY
    assert result["final_response"] == REPLY
    assert result["candidateVerified"] is False
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["mode"] == "MOCK_ONLY"
    assert result["targetEnvironment"] == "TARGET_UNVERIFIED"
    assert result["modelCalls"] == 1
    assert result["frames"] == 8
    trace = result["trace"]
    assert [event["seq"] for event in trace] == list(range(1, len(trace) + 1))
    modules = {event["sourceModule"] for event in trace}
    assert {"M1", "M2", "M3", "M4", "M5"} <= modules
    _assert_reaped(result)


def test_zero_budget_is_unsolved_with_no_call():
    result = _run(max_model_calls=0)
    assert result["status"] == "unsolved"
    assert result["modelCalls"] == 0
    assert result["frames"] == 6
    assert REPLY not in result["finalResponse"]
    _assert_reaped(result)


@pytest.mark.parametrize(
    "status,text",
    [
        ("TRUNCATED", REPLY),
        ("ERROR", REPLY),
        ("UNKNOWN", REPLY),
        ("COMPLETE", ""),
        ("COMPLETE", "   \n\t "),
    ],
)
def test_non_usable_receipts_never_leak_fixture_text(status, text):
    result = _run(reply=text, delivery_status=status)
    assert result["status"] == "unsolved"
    assert result["finalResponse"] != text or text.strip() == ""
    if text.strip():
        assert text not in result["finalResponse"]
    assert result["candidateVerified"] is False
    _assert_reaped(result)


def test_private_content_never_enters_trace():
    result = _run(problem=f"{PROBLEM} {SENTINEL}", reply=f"{REPLY} {SENTINEL}")
    blob = json.dumps(result["trace"])
    assert SENTINEL not in blob
    assert PROBLEM not in blob
    _assert_reaped(result)


def test_client_spy_confirms_public_call_shape(monkeypatch):
    seen = []
    real_chat = OfflineClient.chat

    def spy(self, messages, temperature=0, max_tokens=8192):
        seen.append((messages, temperature, max_tokens))
        return real_chat(self, messages, temperature=temperature, max_tokens=max_tokens)

    monkeypatch.setattr(OfflineClient, "chat", spy)
    result = _run()
    assert result["status"] == "candidate"
    assert len(seen) == 1
    messages, temperature, max_tokens = seen[0]
    assert temperature == 0
    assert max_tokens == 8192
    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == load_p1_manifest()["systemPrompt"]
    assert messages[1]["role"] == "user"
    assert messages[1]["content"] == PROBLEM
    _run(max_model_calls=0)
    assert len(seen) == 1


def test_repeated_sessions_do_not_share_state():
    session_ids = set()
    for index in range(10):
        marker = f"MARK-{index}-a1b2"
        result = _run(problem=f"{PROBLEM} {marker}", reply=f"{REPLY} {marker}")
        assert result["status"] == "candidate"
        assert result["modelCalls"] == 1
        assert result["finalResponse"] == f"{REPLY} {marker}"
        assert marker not in json.dumps(result["trace"])
        session_ids.add(result["sessionId"])
        _assert_reaped(result)
    assert len(session_ids) == 10


@pytest.mark.parametrize(
    "kwargs",
    [
        {"timeout": float("nan")},
        {"timeout": 0},
        {"timeout": 6},
        {"timeout": True},
        {"max_model_calls": 1.0},
        {"max_model_calls": 2},
        {"max_model_calls": -1},
        {"max_model_calls": True},
        {"problem": ""},
        {"problem": "x" * 8193},
        {"problem": "bad \ud800 lone"},
        {"reply": "y" * 12001},
        {"reply": "bad \ud800 lone"},
    ],
)
def test_parameter_negative_controls_fail_before_spawn(kwargs, process_tracker):
    with pytest.raises(ProbeError) as excinfo:
        _run(**kwargs)
    assert excinfo.value.code == "FIELD_VALUE"
    assert process_tracker == []


def _init_params(**overrides):
    params = {
        "protocolVersion": P1_PROTOCOL_VERSION,
        "sessionId": "s-1",
        "remainingMs": 1000,
        "maxModelCalls": 1,
        "maxTokens": 8192,
        "mode": "MOCK_ONLY",
    }
    params.update(overrides)
    return params


def _solve_result(**overrides):
    result = {
        "protocolVersion": P1_PROTOCOL_VERSION,
        "sessionId": "s-1",
        "status": "candidate",
        "finalResponse": "4",
        "candidateVerified": False,
        "strictAcceptance": "NOT_PERFORMED",
        "mode": "MOCK_ONLY",
        "trace": [],
        "modelCalls": 1,
    }
    result.update(overrides)
    return result


def test_p1_init_schema_rejects():
    manifest = load_p1_manifest()
    validate_p1_payload("runtime.initialize", "params", _init_params(), manifest)
    for bad in (
        _init_params(mode="LIVE"),
        _init_params(extra=1),
        _init_params(maxModelCalls=2),
        _init_params(maxTokens=8193),
    ):
        with pytest.raises(ProtocolError):
            validate_p1_payload("runtime.initialize", "params", bad, manifest)
    validate_p1_payload("session.solve", "result", _solve_result(), manifest)
    for bad in (
        _solve_result(candidateVerified=True),
        _solve_result(strictAcceptance="VERIFIED"),
    ):
        with pytest.raises(ProtocolError):
            validate_p1_payload("session.solve", "result", bad, manifest)


@pytest.mark.parametrize("field", ["problem", "reply"])
def test_lone_surrogate_pair_is_rejected_before_spawn(field, process_tracker):
    # Two lone surrogate code units, not a well-formed astral character.
    lone = "\ud83d\ude00"
    kwargs = {"problem": PROBLEM, "reply": REPLY}
    kwargs[field] = lone
    with pytest.raises(ProbeError) as excinfo:
        _run(**kwargs)
    assert excinfo.value.code == "FIELD_VALUE"
    assert process_tracker == []


def test_missing_node_and_missing_script():
    with pytest.raises(ProbeError) as excinfo:
        _run(node="definitely-not-a-real-node-binary")
    assert excinfo.value.code == "SPAWN_FAILED"
    with pytest.raises(ProbeError) as excinfo:
        _run(script=ROOT / "does-not-exist.js")
    assert excinfo.value.code == "CHILD_FAILED"


def _fake(tmp_path, body):
    path = tmp_path / "fake.js"
    path.write_text(body, encoding="utf-8")
    return path


def test_stdout_noise_and_invalid_utf8(tmp_path):
    noise = _fake(tmp_path, "process.stdout.write('not json\\n');\n")
    with pytest.raises(ProbeError) as excinfo:
        _run(script=noise)
    assert excinfo.value.code == "INVALID_JSON"
    bad = _fake(tmp_path, "process.stdout.write(Buffer.from([0xff,0xfe,0x0a]));\n")
    with pytest.raises(ProbeError) as excinfo:
        _run(script=bad)
    assert excinfo.value.code == "INVALID_UTF8"


def test_oversized_frame_and_crash(tmp_path):
    big = _fake(tmp_path, "process.stdout.write('x'.repeat(70000) + '\\n');\n")
    with pytest.raises(ProbeError) as excinfo:
        _run(script=big)
    assert excinfo.value.code == "FRAME_TOO_LARGE"
    crash = _fake(tmp_path, "process.exit(3);\n")
    with pytest.raises(ProbeError) as excinfo:
        _run(script=crash)
    # The base Host reads EOF before the exit status, so a child that dies
    # without answering fails closed as EOF. The Host/P0 behaviour is not
    # changed here; the reap assertion below still holds.
    assert excinfo.value.code == "EOF"


def test_silent_child_hits_short_deadline(tmp_path):
    silent = _fake(tmp_path, "setTimeout(() => {}, 60000);\n")
    started = time.monotonic()
    with pytest.raises(ProbeError) as excinfo:
        _run(script=silent, timeout=0.3)
    assert excinfo.value.code == "TIMEOUT"
    assert time.monotonic() - started < 1.5


def test_stderr_secret_never_reaches_parent(tmp_path, capsys):
    leaky = _fake(
        tmp_path,
        "process.stderr.write('SECRET-LEAK-123\\n');\nsetTimeout(() => {}, 60000);\n",
    )
    with pytest.raises(ProbeError) as excinfo:
        _run(script=leaky, timeout=0.3)
    assert "SECRET-LEAK-123" not in str(excinfo.value)
    assert excinfo.value.code in ("TIMEOUT", "CHILD_FAILED")
    captured = capsys.readouterr()
    assert "SECRET-LEAK-123" not in captured.out
    assert "SECRET-LEAK-123" not in captured.err


def test_real_child_processes_are_reaped_and_pipes_closed(process_tracker):
    _run()
    _run(max_model_calls=0)
    with pytest.raises(ProbeError):
        _run(node="definitely-not-a-real-node-binary")
    assert process_tracker
