"""Offline tests for the a2 short-path capture bridge (research only)."""

from __future__ import annotations

import hashlib
import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from python.astra_bridge import a2_capture

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCK_PATH = _REPO_ROOT / "packages" / "protocol" / "schema" / "a2-source-lock.json"
_SCENARIOS = ("direct", "method", "repeat", "truncated", "final-turn-method")
_COUNTS = {"direct": 1, "method": 2, "repeat": 3, "truncated": 1, "final-turn-method": 1}
_LOADS = {"direct": 0, "method": 1, "repeat": 1, "truncated": 0, "final-turn-method": 0}
_UNSOLVED = ("truncated", "final-turn-method")


def _lock():
    return json.loads(_LOCK_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("scenario", _SCENARIOS)
def test_capture_scenario(scenario):
    bundle = a2_capture.capture(scenario)
    assert bundle["scenario"] == scenario
    assert len(bundle["requests"]) == _COUNTS[scenario]
    assert len(bundle["receipts"]) == _COUNTS[scenario]
    assert bundle["methodLoads"] == _LOADS[scenario]
    assert bundle["toolExecutions"] == 0
    assert bundle["result"]["candidateVerified"] is False
    expected = "unsolved" if scenario in _UNSOLVED else "candidate"
    assert bundle["result"]["status"] == expected
    assert bundle["profileHash"] == a2_capture.canonical_hash(bundle["profile"])
    for request, digest in zip(bundle["requests"], bundle["requestHashes"]):
        assert digest == a2_capture.canonical_hash(request)
        assert request["temperature"] == "0.2"
        assert request["maxTokens"] == 8192
        assert request["messages"][0]["role"] == "system"
        assert request["messages"][0]["content"] == bundle["profile"]["systemPrompt"]
        assert request["messages"][1]["role"] == "user"
        assert request["messages"][1]["content"] == bundle["problem"]
    asset = bundle["profile"]["methodAsset"]
    assert asset["version"] == "1.1.0"
    assert asset["bodySha256"] == hashlib.sha256(asset["body"].encode("utf-8")).hexdigest()
    assert asset["bodyChars"] == len(asset["body"])


def test_repeat_is_deterministic_and_loads_body_once():
    first = a2_capture.capture("repeat")
    second = a2_capture.capture("repeat")
    assert first == second
    body = first["profile"]["methodAsset"]["body"]
    counts = [
        sum(1 for m in request["messages"] if body in m["content"])
        for request in first["requests"]
    ]
    assert counts == [0, 1, 1]
    assert first["methodLoads"] == 1
    third = first["requests"][2]["messages"]
    assert any(m["content"] == a2_capture.lite_runtime._FORCE_CLOSEOUT_NOTE for m in third)
    assert any(m["content"] == first["profile"]["closeoutNotes"][0] for m in third)


def test_source_lock_matches_real_files():
    lock = _lock()
    assert set(lock) == set(a2_capture._SOURCE_NAMES)
    for name in a2_capture._SOURCE_NAMES:
        data = (_REPO_ROOT / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == lock[name]


def _fake_root(tmp_path, tamper=None, extra=None):
    lock = dict(_lock())
    if extra is not None:
        lock.update(extra)
    if tamper is not None:
        lock[tamper] = "0" * 64
    (tmp_path / "packages" / "protocol" / "schema").mkdir(parents=True)
    (tmp_path / "packages" / "protocol" / "schema" / "a2-source-lock.json").write_text(
        json.dumps(lock), encoding="utf-8"
    )
    for name in a2_capture._SOURCE_NAMES:
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((_REPO_ROOT / name).read_bytes())
    return tmp_path


def test_lock_digest_drift(tmp_path, monkeypatch):
    monkeypatch.setattr(a2_capture, "_root", lambda: _fake_root(tmp_path, tamper="mathagent/__init__.py"))
    with pytest.raises(ValueError, match="SOURCE_MISMATCH"):
        a2_capture.capture("direct")


def test_source_file_drift(tmp_path, monkeypatch):
    root = _fake_root(tmp_path)
    (root / "mathagent" / "__init__.py").write_bytes(b"TAMPER")
    calls = []

    def _refuse(*args, **kwargs):
        calls.append(1)
        raise AssertionError("DISPATCH_FORBIDDEN")

    monkeypatch.setattr(a2_capture, "_root", lambda: root)
    monkeypatch.setattr(a2_capture._FakeClient, "chat", _refuse)
    with pytest.raises(ValueError, match="SOURCE_MISMATCH"):
        a2_capture.capture("direct")
    assert calls == []


def test_lock_escape_key_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(a2_capture, "_root", lambda: _fake_root(tmp_path, extra={"../escape": "0" * 64}))
    with pytest.raises(ValueError, match="SOURCE_MISMATCH"):
        a2_capture.capture("direct")


def test_guard_executor_refuses():
    executor = a2_capture._GuardExecutor()
    with pytest.raises(RuntimeError):
        executor.execute("polynomial_expand_coefficients", {})
    assert executor.count == 1


def test_capture_uses_no_network(monkeypatch):
    def _refuse(*args, **kwargs):
        raise AssertionError("network")

    monkeypatch.setattr(socket, "create_connection", _refuse)
    assert a2_capture.capture("direct")["toolExecutions"] == 0


def _run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "python.astra_bridge.a2_capture", *args],
        cwd=_REPO_ROOT,
        capture_output=True,
        encoding="utf-8",
        timeout=5,
        env={
            **dict(sys.modules["os"].environ),
            "PATH": "",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
        },
    )


@pytest.mark.parametrize("args", [["--scenario", "unknown"], ["--root", "secret-path"], ["--sce", "direct"]])
def test_cli_rejects_bad_args(args):
    run = _run_cli(*args)
    assert run.returncode == 2
    assert run.stdout == '{"error": "CAPTURE_FAILED"}\n'
    assert run.stderr == ""
    assert "secret-path" not in run.stdout


def test_cli_direct_matches_capture():
    run = _run_cli("--scenario", "direct")
    assert run.returncode == 0
    assert run.stderr == ""
    assert json.loads(run.stdout) == a2_capture.capture("direct")
