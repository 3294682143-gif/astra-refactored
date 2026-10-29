"""P1 Node state-machine negative controls against the real compiled runtime.

Each case drives the real ``p1-main.js`` over stdio with a hand-written frame
sequence and asserts the fixed stderr code. No model call, no network and no
Python solver: the Node side is the real artifact under test.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

SCRIPT = ROOT / "apps" / "stdio-runtime" / "dist" / "src" / "p1-main.js"
SESSION = "s1"
PROBLEM = "fixture problem"
HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
VERSION = "1.0-p1-local"


def _frame(message):
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _init(**overrides):
    params = {
        "protocolVersion": VERSION,
        "sessionId": SESSION,
        "remainingMs": 5000,
        "maxModelCalls": 1,
        "maxTokens": 8192,
        "mode": "MOCK_ONLY",
    }
    params.update(overrides)
    return {"jsonrpc": "2.0", "id": "host-1", "method": "runtime.initialize", "params": params}


def _solve(**overrides):
    params = {
        "protocolVersion": VERSION,
        "sessionId": SESSION,
        "problem": PROBLEM,
        "problemHash": HASH,
    }
    params.update(overrides)
    return {"jsonrpc": "2.0", "id": "host-2", "method": "session.solve", "params": params}


def _receipt(**overrides):
    result = {
        "protocolVersion": VERSION,
        "sessionId": SESSION,
        "requestId": "model-1",
        "mode": "MOCK_ONLY",
        "deliveryStatus": "COMPLETE",
        "text": "fixture",
        "remainingMs": 4000,
    }
    result.update(overrides)
    return {"jsonrpc": "2.0", "id": "node-model-1", "result": result}


def _stop():
    return {
        "jsonrpc": "2.0",
        "id": "host-3",
        "method": "session.stop",
        "params": {"protocolVersion": VERSION, "sessionId": SESSION},
    }


def _run(frames, timeout=2.0):
    """Send frames, close stdin, and return (code, stdout, stderr)."""
    proc = subprocess.Popen(
        ["node", str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    try:
        payload = b"".join(_frame(message) for message in frames)
        out, err = proc.communicate(payload, timeout=timeout)
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=1.0)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None and not stream.closed:
                stream.close()


def _code(stderr):
    lines = [line for line in stderr.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def _candidate_count(stdout):
    count = 0
    for line in stdout.splitlines():
        if not line.strip():
            continue
        message = json.loads(line)
        result = message.get("result")
        if isinstance(result, dict) and result.get("status") == "candidate":
            count += 1
    return count


@pytest.mark.parametrize(
    "frames,expected",
    [
        ([_init(protocolVersion="1.0-p0")], "FIELD_VALUE"),
        ([_init(extra="x")], "EXTRA_FIELD"),
        ([_init(), _solve(sessionId="other")], "SESSION_MISMATCH"),
        ([_init(), _solve(problemHash="0" * 64)], "FIELD_VALUE"),
        (
            [
                {
                    "jsonrpc": "2.0",
                    "id": "host-1",
                    "method": "tool.execute",
                    "params": {"protocolVersion": VERSION, "sessionId": SESSION},
                }
            ],
            "UNKNOWN_METHOD",
        ),
        ([_init(), _solve(), _receipt(requestId="model-2")], "FIELD_VALUE"),
        ([_init(), _solve(), dict(_receipt(), id="node-wrong")], "ID_MISMATCH"),
        ([_init(), _solve(), _receipt(sessionId="other")], "SESSION_MISMATCH"),
        ([_init(), _solve(), _receipt(remainingMs=0)], "DEADLINE_EXCEEDED"),
        ([_init(), _solve(), _stop()], "P1_STATE_INVALID"),
        ([_init(), _init()], "ID_MISMATCH"),
        ([_init(), _solve(), _receipt(), _receipt()], "ID_MISMATCH"),
    ],
)
def test_node_state_negative_controls(frames, expected):
    code, stdout, stderr = _run(frames)
    assert code == 1
    assert _code(stderr) == expected
    if expected == "ID_MISMATCH" and len(frames) == 4:
        assert _candidate_count(stdout) == 1
    else:
        assert _candidate_count(stdout) == 0


def test_initialize_ack_then_eof_is_eof():
    code, stdout, stderr = _run([_init()])
    assert code == 1
    assert _code(stderr) == "EOF"
    assert "MOCK_ONLY" in stdout


def test_root_deadline_is_really_tightened():
    proc = subprocess.Popen(
        ["node", str(SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    started = time.monotonic()
    try:
        proc.stdin.write(_frame(_init(remainingMs=30)))
        proc.stdin.flush()
        # stdin stays open: the child must fail on its own deadline, not on EOF.
        code = proc.wait(timeout=1.0)
        elapsed = time.monotonic() - started
        stderr = proc.stderr.read().decode("utf-8", "replace")
        assert code == 1
        assert _code(stderr) == "DEADLINE_EXCEEDED"
        assert elapsed < 0.8
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=1.0)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None and not stream.closed:
                stream.close()
