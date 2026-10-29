"""P0 bridge tests: shared corpus, real cross-process positive control, negative controls.

No network access, no real mathematical API. The positive control runs the real
Node probe and the real MethodCatalog; only process-level faults are simulated.
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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python.astra_bridge import p0_probe, p0_protocol  # noqa: E402

SCRIPT = ROOT / "apps" / "stdio-runtime" / "dist" / "src" / "main.js"
CASES = json.loads((ROOT / "tests" / "protocol" / "p0-cases.json").read_text("utf-8"))


def _require_node():
    if not SCRIPT.exists():
        pytest.skip("compiled Node probe not present")


def _frame(raw):
    return raw.encode("utf-8")


def test_shared_corpus_envelope():
    manifest = p0_protocol.load_manifest()
    for item in CASES:
        try:
            p0_protocol.parse_frame(_frame(item["raw"]), manifest)
            ok = True
            code = None
        except p0_protocol.ProtocolError as exc:
            ok = False
            code = exc.code
        assert ok is item["ok"], item["name"]
        if not ok:
            assert code == item["code"], item["name"]


def test_boundaries_and_manifest():
    manifest = p0_protocol.load_manifest()
    assert p0_protocol.LIMITS["maxFrameBytes"] == 65536
    pad = "a" * (65536 - 2)
    exact = ('"' + pad + '"').encode("utf-8")
    assert len(exact) == 65536
    assert p0_protocol.decode_frame(exact) == '"' + pad + '"'
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.decode_frame(exact + b"x")
    assert exc.value.code == "FRAME_TOO_LARGE"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.decode_frame(b"\xff\xfe")
    assert exc.value.code == "INVALID_UTF8"
    ok_depth = (
        '{"jsonrpc":"2.0","id":"a","result":{"v":'
        + "[" * 22
        + "]" * 22
        + "}}"
    ).encode("utf-8")
    assert p0_protocol.parse_frame(ok_depth, manifest)["id"] == "a"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(
            (
                '{"jsonrpc":"2.0","id":"a","result":{"v":'
                + "[" * 23
                + "]" * 23
                + "}}"
            ).encode("utf-8"),
            manifest,
        )
    assert exc.value.code == "DEPTH_EXCEEDED"
    id128 = "\U0001f600" * 128
    ok_id = json.dumps(
        {"jsonrpc": "2.0", "id": id128, "method": "session.stop", "params": {}}
    ).encode("utf-8")
    assert p0_protocol.parse_frame(ok_id, manifest)["id"] == id128
    bad_id = json.dumps(
        {"jsonrpc": "2.0", "id": "\U0001f600" * 129, "method": "session.stop", "params": {}}
    ).encode("utf-8")
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(bad_id, manifest)
    assert exc.value.code == "FIELD_VALUE"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(
            b'{"jsonrpc":"2.0","id":"a","\\u0069d":"b","method":"session.stop","params":{}}',
            manifest,
        )
    assert exc.value.code == "DUPLICATE_KEY"
    for name in ("__proto__", "toString"):
        with pytest.raises(p0_protocol.ProtocolError) as exc:
            p0_protocol.parse_frame(
                (
                    '{"jsonrpc":"2.0","id":"a","method":"session.stop","params":{},"'
                    + name
                    + '":1}'
                ).encode("utf-8"),
                manifest,
            )
        assert exc.value.code == "EXTRA_FIELD", name
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(b'{"jsonrpc":"2.0","id":"a","result":{"n":1.5}}', manifest)
    assert exc.value.code == "FLOAT_TOKEN"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(
            b'{"jsonrpc":"2.0","id":"a","result":{"n":9007199254740992}}', manifest
        )
    assert exc.value.code == "UNSAFE_INTEGER"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.classify_method("session.solve")
    assert exc.value.code == "REJECTED_METHOD"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.check_binding(
            {"protocolVersion": "1.0-p0", "sessionId": "other"}, "s1"
        )
    assert exc.value.code == "SESSION_MISMATCH"


def test_non_finite_tokens_share_one_code():
    manifest = p0_protocol.load_manifest()
    for raw in (
        b'{"jsonrpc":"2.0","id":"a","result":{"n":NaN}}',
        b'{"jsonrpc":"2.0","id":"a","result":{"n":Infinity}}',
        b'{"jsonrpc":"2.0","id":"a","result":{"n":-Infinity}}',
    ):
        with pytest.raises(p0_protocol.ProtocolError) as exc:
            p0_protocol.parse_frame(raw, manifest)
        assert exc.value.code == "NON_FINITE_NUMBER", raw
    inside = b'{"jsonrpc":"2.0","id":"a","method":"session.stop","params":{"x":"NaN Infinity -Infinity"}}'
    assert p0_protocol.parse_frame(inside, manifest)["id"] == "a"


def test_huge_integer_token_is_unsafe_not_float():
    manifest = p0_protocol.load_manifest()
    huge = b'{"jsonrpc":"2.0","id":"a","result":{"n":' + b"9" * 5000 + b"}}"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.parse_frame(huge, manifest)
    assert exc.value.code == "UNSAFE_INTEGER"


def test_scalar_schema_subset_matches_ts():
    for node in (
        {"type": None},
        {"items": None},
        {"additionalProperties": None},
        {"required": None},
        {"properties": None},
        {"title": None},
        {"description": None},
        {"minimum": None},
        {"maxLength": None},
        {"enum": None},
        {"type": "string", "maxLength": -1},
        {"type": "string", "minLength": 5, "maxLength": 2},
        {"type": "integer", "minimum": 9, "maximum": 1},
        {"enum": 1},
        {"enum": []},
        {"enum": [{"a": 1}]},
        {"const": {"a": 1}},
        {"const": [1]},
        {"type": "number"},
    ):
        with pytest.raises(p0_protocol.ProtocolError) as exc:
            p0_protocol.assert_supported_schema(node)
        assert exc.value.code == "UNKNOWN_SCHEMA_KEYWORD", node
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.validate_against_schema(9007199254740992, {"type": "integer"})
    assert exc.value.code == "FIELD_TYPE"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.validate_against_schema(False, {"const": 0})
    assert exc.value.code == "FIELD_VALUE"
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.validate_against_schema(False, {"enum": [0, 1]})
    assert exc.value.code == "FIELD_VALUE"
    p0_protocol.validate_against_schema(0, {"const": 0})
    p0_protocol.validate_against_schema(False, {"const": False})


def test_null_const_is_a_legal_scalar_literal():
    p0_protocol.assert_supported_schema({"const": None})
    p0_protocol.validate_against_schema(None, {"const": None})
    with pytest.raises(p0_protocol.ProtocolError) as exc:
        p0_protocol.validate_against_schema(False, {"const": None})
    assert exc.value.code == "FIELD_VALUE"


def test_real_positive_control(monkeypatch):
    _require_node()
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    result = p0_probe.run_probe(script=SCRIPT, timeout=5.0)
    assert result["catalogCount"] == 20
    assert result["frames"] == 8
    assert result["childReaped"] is True
    assert result["localVerification"] == "LOCAL_VERIFIED"
    assert result["targetEnvironment"] == "TARGET_UNVERIFIED"
    assert seen
    for proc in seen:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream.closed


def test_catalog_only_no_solver(monkeypatch):
    _require_node()
    import mathagent.lite.methods as methods

    def forbidden(*args, **kwargs):
        raise AssertionError("solver path must not be used")

    monkeypatch.setattr(methods.MethodCatalog, "load", forbidden)
    result = p0_probe.run_probe(script=SCRIPT, timeout=5.0)
    assert result["catalogCount"] == 20


def test_missing_node_reaped(monkeypatch):
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(node="astra-no-such-node", script=SCRIPT, timeout=1.0)
    assert exc.value.code == "SPAWN_FAILED"
    for proc in seen:
        assert proc.poll() is not None


def test_missing_script_reaped(monkeypatch, tmp_path):
    _require_node()
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    missing = tmp_path / "absent.js"
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=missing, timeout=1.0)
    assert exc.value.code == "CHILD_FAILED"
    assert seen == []


@pytest.mark.parametrize("bad", [0, -1, 6.0, float("nan"), True, "5"])
def test_invalid_timeout(bad):
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=SCRIPT, timeout=bad)
    assert exc.value.code == "FIELD_VALUE"


def test_eof_child_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "eof.js"
    script.write_text("process.exit(0);\n", encoding="utf-8")
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code in ("EOF", "CHILD_FAILED")
    for proc in seen:
        assert proc.poll() is not None


def test_crash_child_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "crash.js"
    script.write_text("process.stderr.write('boom\\n'); process.exit(3);\n", encoding="utf-8")
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code in ("EOF", "CHILD_FAILED")
    for proc in seen:
        assert proc.poll() is not None


def test_unresponsive_child_timeout(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "silent.js"
    script.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    started = time.monotonic()
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=0.3)
    elapsed = time.monotonic() - started
    assert exc.value.code == "TIMEOUT"
    assert elapsed < 1.5
    for proc in seen:
        assert proc.poll() is not None


def test_stdout_noise_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "noise.js"
    script.write_text(
        "process.stdout.write('not-json\\n'); setTimeout(() => {}, 60000);\n",
        encoding="utf-8",
    )
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code == "INVALID_JSON"
    for proc in seen:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream.closed


def test_invalid_utf8_stdout_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "badutf8.js"
    script.write_text(
        "process.stdout.write(Buffer.from([0x7b,0xff,0x7d,0x0a]));"
        "setTimeout(() => {}, 60000);\n",
        encoding="utf-8",
    )
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code == "INVALID_UTF8"
    for proc in seen:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream.closed


def test_oversized_no_newline_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "huge.js"
    script.write_text(
        "process.stdout.write('a'.repeat(70000)); setTimeout(() => {}, 60000);\n",
        encoding="utf-8",
    )
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code == "FRAME_TOO_LARGE"
    for proc in seen:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream.closed


def test_stderr_flood_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "flood.js"
    script.write_text(
        "process.stderr.write('x'.repeat(70000)); setTimeout(() => {}, 60000);\n",
        encoding="utf-8",
    )
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=1.0)
    assert exc.value.code == "FRAME_TOO_LARGE"
    for proc in seen:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream.closed


def test_child_ignoring_stdin_reaped(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "nostdin.js"
    script.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
    seen = []
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        seen.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    with pytest.raises(p0_probe.ProbeError) as exc:
        p0_probe.run_probe(script=script, timeout=0.3)
    assert exc.value.code == "TIMEOUT"
    for proc in seen:
        assert proc.poll() is not None


def test_child_secret_not_echoed(monkeypatch, tmp_path, capsys):
    _require_node()
    secret = "SECRET-TOKEN-DO-NOT-ECHO"
    script = tmp_path / "secret.js"
    script.write_text(
        f"process.stderr.write('{secret}\\n'); process.exit(4);\n", encoding="utf-8"
    )
    with pytest.raises(p0_probe.ProbeError):
        p0_probe.run_probe(script=script, timeout=1.0)
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


def test_env_allowlist(monkeypatch):
    _require_node()
    monkeypatch.setenv("ASTRA_FAKE_API_TOKEN", "tok")
    monkeypatch.setenv("NODE_OPTIONS", "--max-old-space-size=64")
    monkeypatch.setenv("PYTHONPATH", "/tmp/evil")
    captured = {}
    real_popen = subprocess.Popen

    def recording_popen(*args, **kwargs):
        captured["env"] = kwargs.get("env")
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", recording_popen)
    p0_probe.run_probe(script=SCRIPT, timeout=5.0)
    env = captured["env"]
    assert env is not None
    for name in ("ASTRA_FAKE_API_TOKEN", "NODE_OPTIONS", "PYTHONPATH"):
        assert name not in env


def test_timeout_elapsed_includes_cleanup(monkeypatch, tmp_path):
    _require_node()
    script = tmp_path / "hang.js"
    script.write_text("setTimeout(() => {}, 60000);\n", encoding="utf-8")
    started = time.monotonic()
    with pytest.raises(p0_probe.ProbeError):
        p0_probe.run_probe(script=script, timeout=0.3)
    assert time.monotonic() - started < 1.5


def test_backpressure_keeps_pending():
    manifest = p0_protocol.load_manifest()
    host = p0_probe._Host(manifest, "s1", "n1", time.monotonic() + 1.0)
    read_fd, write_fd = os.pipe()
    dup_fd = None
    try:
        os.set_blocking(write_fd, False)
        while True:
            try:
                os.write(write_fd, b"x" * 65536)
            except BlockingIOError:
                break
        dup_fd = os.dup(write_fd)
        proc = type("P", (), {})()
        proc.stdin = os.fdopen(dup_fd, "wb", buffering=0)
        dup_fd = None
        original = b'{"jsonrpc":"2.0"}\n'
        host.pending = original
        host.pending_is_callback = False
        host.flush_pending(proc)
        assert host.pending == original
        host.deadline = time.monotonic() - 1.0
        with pytest.raises(p0_probe.ProbeError) as exc:
            host.check_deadline()
        assert exc.value.code == "TIMEOUT"
        proc.stdin.close()
    finally:
        if dup_fd is not None:
            os.close(dup_fd)
        os.close(read_fd)
        try:
            os.close(write_fd)
        except OSError:
            pass
        host.selector.close()
