"""P0 Python Host probe for the Astra TS stdio runtime.

Process and protocol host only: starts the Node probe, speaks the frozen P0
NDJSON protocol, answers the read-only ``method.catalog`` callback from the
existing :class:`MethodCatalog`, and reaps the child on every exit path.

No model call, no tool call, no mathematical solve, no remote cancellation
claim. Nothing here changes the frozen Python entry point or default engine.
"""

from __future__ import annotations

import json
import math
import os
import re
import selectors
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .p0_protocol import (
    ERROR_CODES,
    LIMITS,
    PROTOCOL_VERSION,
    ProtocolError,
    check_binding,
    classify_method,
    load_manifest,
    parse_frame,
    validate_against_schema,
)

__all__ = ["ProbeError", "ProbeResult", "run_probe", "main"]

_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT")
_EXPECTED_CATALOG = 20
_MAX_TIMEOUT = 5.0
_REAP_SECONDS = 1.0
_READ_CHUNK = 65536
_NORMAL_FRAMES = 8
_MAX_STDERR_BYTES = 65536
_CALLBACK_ID = "node-1"
# The child writes one fixed code on stderr and nothing else. Only a token that
# matches this bounded shape is retained, so a child that ever wrote something
# else could not smuggle text into a reported code.
_STDERR_CODE = re.compile(r"\A[A-Z][A-Z0-9_]{0,31}\Z")
_STDERR_CODE_BYTES = 64


def _fixed_stderr_code(chunk):
    """First bounded fixed code in one stderr chunk, or ``None``.

    The result is either ``None`` or a short upper-case token. A line break, a
    space or any punctuation means the child wrote something that is not a fixed
    code, and nothing is retained in that case.
    """
    if not isinstance(chunk, (bytes, bytearray)):
        return None
    head = bytes(chunk[:_STDERR_CODE_BYTES]).split(b"\n", 1)[0].strip()
    try:
        text = head.decode("ascii")
    except UnicodeDecodeError:
        return None
    if not _STDERR_CODE.match(text):
        return None
    return text


class ProbeError(Exception):
    """Fixed-code probe failure; never carries raw input or a path."""

    def __init__(self, code, origin=None):
        if code not in ERROR_CODES and code not in ("CHILD_FAILED", "TIMEOUT", "SPAWN_FAILED"):
            code = "FIELD_VALUE"
        super().__init__(code)
        self.code = code
        # Diagnostic only: the file:line that raised the failure, never any
        # input, path or model text. It is written to stderr so an operator can
        # tell WHICH guard rejected a frame, and it never enters a returned
        # object or a protocol frame.
        self.origin = origin


class ProbeResult(dict):
    """Safe result mapping; only fixed, non-sensitive fields are exposed."""


def _default_script():
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "main.js"


def _child_env():
    env = {}
    for name in _ENV_ALLOWLIST:
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    return env


class _Host:
    def __init__(self, manifest, session_id, nonce, deadline):
        self.manifest = manifest
        self.session_id = session_id
        self.nonce = nonce
        self.deadline = deadline
        self.selector = selectors.DefaultSelector()
        self.buffers = {"stdout": b"", "stderr": b""}
        self.frames = 0
        self.proc = None
        self.pending = None
        self.pending_is_callback = False
        self.expected = None
        self.callback_id = None
        self.callback_done = False
        self.probe_result = None
        self.stop_acked = False
        self.stderr_seen = False
        self.stderr_bytes = 0
        # First bounded stderr line of the child. The child writes exactly one
        # fixed code there and nothing else, so keeping the first line turns an
        # otherwise opaque failure into an auditable one without storing any
        # message, traceback, problem text or model text.
        self.stderr_code = None
        self.eof = {"stdout": False, "stderr": False}
        self.registered = {"stdout": False, "stderr": False, "stdin": False}

    # -- deadline ---------------------------------------------------------

    def remaining(self):
        return self.deadline - time.monotonic()

    def check_deadline(self):
        if self.remaining() <= 0:
            raise ProbeError("TIMEOUT")

    # -- registration -----------------------------------------------------

    def register(self, name, stream, events):
        if sys.platform != "win32":
            os.set_blocking(stream.fileno(), False)
            if self.registered[name]:
                self.selector.modify(stream, events, data=name)
            else:
                self.selector.register(stream, events, data=name)
        self.registered[name] = True

    def unregister(self, name, stream):
        if not self.registered[name]:
            return
        if sys.platform != "win32":
            try:
                self.selector.unregister(stream)
            except (KeyError, ValueError):
                pass
        self.registered[name] = False

    def sync_stdin(self, proc):
        if self.pending is None:
            self.unregister("stdin", proc.stdin)
        else:
            self.register("stdin", proc.stdin, selectors.EVENT_WRITE)

    # -- framing ----------------------------------------------------------

    def send(self, proc, message, method):
        self.check_deadline()
        if self.pending is not None:
            raise ProbeError("FIELD_VALUE")
        spec = self.manifest["methods"].get(method)
        if not isinstance(spec, dict):
            raise ProbeError("MANIFEST_INVALID")
        if "method" in message:
            payload = message["params"]
            node = spec["params"]
        else:
            payload = message["result"]
            node = spec["result"]
        validate_against_schema(payload, node)
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        data = line.encode("utf-8")
        if len(data) - 1 > LIMITS["maxFrameBytes"]:
            raise ProbeError("FRAME_TOO_LARGE")
        parse_frame(data[:-1], self.manifest)
        self.frames += 1
        if self.frames > LIMITS["maxFramesPerSession"]:
            raise ProbeError("FRAME_LIMIT_EXCEEDED")
        self.pending = data
        self.pending_is_callback = method == "method.catalog"
        if "method" in message:
            self.expected = (message["id"], method)
        self.sync_stdin(proc)

    def flush_pending(self, proc):
        if self.pending is None:
            return
        try:
            written = os.write(proc.stdin.fileno(), self.pending)
        except BlockingIOError:
            return
        except (BrokenPipeError, ValueError, OSError):
            raise ProbeError("EOF")
        if written < len(self.pending):
            self.pending = self.pending[written:]
            return
        was_callback = self.pending_is_callback
        self.pending = None
        self.pending_is_callback = False
        if was_callback:
            self.callback_done = True
        self.sync_stdin(proc)

    # -- inbound ----------------------------------------------------------

    def feed(self, name, chunk):
        if name == "stderr":
            if chunk:
                self.stderr_seen = True
                self.stderr_bytes += len(chunk)
                if self.stderr_code is None:
                    self.stderr_code = _fixed_stderr_code(chunk)
                if self.stderr_bytes > _MAX_STDERR_BYTES:
                    raise ProbeError("FRAME_TOO_LARGE")
            return
        self.buffers["stdout"] += chunk
        while True:
            index = self.buffers["stdout"].find(b"\n")
            if index < 0:
                if len(self.buffers["stdout"]) > LIMITS["maxFrameBytes"]:
                    raise ProbeError("FRAME_TOO_LARGE")
                return
            line = self.buffers["stdout"][:index]
            self.buffers["stdout"] = self.buffers["stdout"][index + 1:]
            if not line:
                raise ProbeError("INVALID_JSON")
            self.frames += 1
            if self.frames > LIMITS["maxFramesPerSession"]:
                raise ProbeError("FRAME_LIMIT_EXCEEDED")
            self.handle(parse_frame(line, self.manifest))

    def handle(self, message):
        if "method" in message:
            self.on_request(message)
            return
        if "result" in message:
            self.on_result(message)
            return
        raise ProbeError("FIELD_VALUE")

    def on_request(self, message):
        method = message["method"]
        classify_method(method)
        if method != "method.catalog":
            raise ProbeError("UNKNOWN_METHOD")
        if message["id"] != _CALLBACK_ID:
            raise ProbeError("ID_MISMATCH")
        if self.expected is None or self.expected[1] != "runtime.probe":
            raise ProbeError("ID_MISMATCH")
        if self.callback_id is not None or self.pending is not None:
            raise ProbeError("ID_MISMATCH")
        spec = self.manifest["methods"]["method.catalog"]
        validate_against_schema(message["params"], spec["params"])
        check_binding(message["params"], self.session_id)
        self.callback_id = message["id"]
        self.send(
            self.proc,
            {
                "jsonrpc": "2.0",
                "id": _CALLBACK_ID,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "sessionId": self.session_id,
                    "entries": _catalog_entries(),
                },
            },
            "method.catalog",
        )

    def on_result(self, message):
        if self.expected is None:
            raise ProbeError("ID_MISMATCH")
        # A result may only be consumed once the previous outbound frame has
        # been fully written; otherwise the peer answered a frame we have not
        # finished sending.
        if self.pending is not None:
            raise ProbeError("ID_MISMATCH")
        expected_id, method = self.expected
        if message["id"] != expected_id:
            raise ProbeError("ID_MISMATCH")
        if method == "runtime.initialize":
            spec = self.manifest["methods"]["runtime.initialize"]
            validate_against_schema(message["result"], spec["result"])
            check_binding(message["result"], self.session_id)
            self.expected = None
            return
        if method == "runtime.probe":
            self.on_probe_result(message)
            return
        if method == "session.stop":
            self.on_stop_result(message)
            return
        raise ProbeError("ID_MISMATCH")

    def on_probe_result(self, message):
        if not self.callback_done:
            raise ProbeError("ID_MISMATCH")
        spec = self.manifest["methods"]["runtime.probe"]
        validate_against_schema(message["result"], spec["result"])
        check_binding(message["result"], self.session_id)
        result = message["result"]
        if result["nonce"] != self.nonce:
            raise ProbeError("FIELD_VALUE")
        if result["catalogCount"] != _EXPECTED_CATALOG:
            raise ProbeError("FIELD_VALUE")
        if result["catalogAcknowledged"] is not True:
            raise ProbeError("FIELD_VALUE")
        self.probe_result = result
        self.expected = None

    def on_stop_result(self, message):
        spec = self.manifest["methods"]["session.stop"]
        validate_against_schema(message["result"], spec["result"])
        check_binding(message["result"], self.session_id)
        if message["result"]["stopped"] is not True:
            raise ProbeError("FIELD_VALUE")
        self.stop_acked = True
        self.expected = None

    # -- pump -------------------------------------------------------------

    def pump(self, proc, until):
        if sys.platform == "win32":
            import msvcrt
            import ctypes
            import time

            def _peek(s):
                try:
                    h = msvcrt.get_osfhandle(s.fileno())
                    avail = ctypes.c_ulong()
                    res = ctypes.windll.kernel32.PeekNamedPipe(h, None, 0, None, ctypes.byref(avail), None)
                    if not res:
                        return -1
                    return avail.value
                except (OSError, ValueError):
                    return -1

            while not until():
                self.check_deadline()
                had_activity = False
                if self.pending is not None and self.registered.get("stdin"):
                    self.flush_pending(proc)
                    had_activity = True
                for name, stream in [("stdout", proc.stdout), ("stderr", proc.stderr)]:
                    if not self.registered.get(name):
                        continue
                    avail = _peek(stream)
                    if avail < 0:
                        self.eof[name] = True
                        self.unregister(name, stream)
                        if name == "stdout":
                            if self.buffers["stdout"]:
                                raise ProbeError("INVALID_JSON")
                            if not self.stop_acked:
                                raise ProbeError("EOF")
                        had_activity = True
                        continue
                    if avail > 0:
                        try:
                            chunk = os.read(stream.fileno(), min(_READ_CHUNK, avail))
                        except (BlockingIOError, InterruptedError):
                            continue
                        except OSError:
                            chunk = b""
                        if not chunk:
                            self.eof[name] = True
                            self.unregister(name, stream)
                            if name == "stdout":
                                if self.buffers["stdout"]:
                                    raise ProbeError("INVALID_JSON")
                                if not self.stop_acked:
                                    raise ProbeError("EOF")
                        else:
                            self.feed(name, chunk)
                        had_activity = True
                if not had_activity:
                    time.sleep(0.005)
            return

        while not until():
            self.check_deadline()
            events = self.selector.select(min(self.remaining(), 0.05))
            if not events:
                continue
            for key, mask in events:
                name = key.data
                if name == "stdin":
                    self.flush_pending(proc)
                    continue
                stream = key.fileobj
                if mask & selectors.EVENT_READ:
                    try:
                        chunk = os.read(stream.fileno(), _READ_CHUNK)
                    except (BlockingIOError, InterruptedError):
                        continue
                    except OSError:
                        chunk = b""
                    if not chunk:
                        self.eof[name] = True
                        self.unregister(name, stream)
                        if name == "stdout":
                            if self.buffers["stdout"]:
                                raise ProbeError("INVALID_JSON")
                            if not self.stop_acked:
                                raise ProbeError("EOF")
                        continue
                    self.feed(name, chunk)

    def drain_tail(self, proc):
        """After the stop ack, only EOF or a clean exit is acceptable."""
        if sys.platform == "win32":
            import msvcrt
            import ctypes
            import time

            def _peek(s):
                try:
                    h = msvcrt.get_osfhandle(s.fileno())
                    avail = ctypes.c_ulong()
                    res = ctypes.windll.kernel32.PeekNamedPipe(h, None, 0, None, ctypes.byref(avail), None)
                    if not res:
                        return -1
                    return avail.value
                except (OSError, ValueError):
                    return -1

            while not (self.eof["stdout"] and self.eof["stderr"]):
                self.check_deadline()
                had_activity = False
                if self.pending is not None and self.registered.get("stdin"):
                    self.flush_pending(proc)
                    had_activity = True
                for name, stream in [("stdout", proc.stdout), ("stderr", proc.stderr)]:
                    if not self.registered.get(name):
                        continue
                    avail = _peek(stream)
                    if avail <= 0:
                        self.eof[name] = True
                        self.unregister(name, stream)
                        had_activity = True
                        continue
                    try:
                        chunk = os.read(stream.fileno(), min(_READ_CHUNK, avail))
                    except (BlockingIOError, InterruptedError):
                        continue
                    except OSError:
                        chunk = b""
                    if not chunk:
                        self.eof[name] = True
                        self.unregister(name, stream)
                    else:
                        self.feed(name, chunk)
                    had_activity = True
                if not had_activity:
                    time.sleep(0.005)
            if self.buffers["stdout"]:
                raise ProbeError("INVALID_JSON")
            if self.pending is not None:
                raise ProbeError("EOF")
            return

        while not (self.eof["stdout"] and self.eof["stderr"]):
            self.check_deadline()
            events = self.selector.select(min(self.remaining(), 0.05))
            if not events:
                continue
            for key, mask in events:
                name = key.data
                if name == "stdin":
                    self.flush_pending(proc)
                    continue
                stream = key.fileobj
                if not mask & selectors.EVENT_READ:
                    continue
                try:
                    chunk = os.read(stream.fileno(), _READ_CHUNK)
                except (BlockingIOError, InterruptedError):
                    continue
                except OSError:
                    chunk = b""
                if not chunk:
                    self.eof[name] = True
                    self.unregister(name, stream)
                    continue
                self.feed(name, chunk)
        if self.buffers["stdout"]:
            raise ProbeError("INVALID_JSON")
        if self.pending is not None:
            raise ProbeError("EOF")


def _reap(proc):
    """Kill and reap the child; return True only when it was actually reaped."""
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=_REAP_SECONDS)
    except subprocess.TimeoutExpired:
        return False
    return proc.poll() is not None


def _close_streams(proc):
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream is None:
            continue
        try:
            stream.close()
        except OSError:
            pass


def run_probe(node="node", script=None, timeout=5.0, nonce="p0-local-probe"):
    """Run one P0 handshake against the Node stdio probe.

    ``timeout`` is the root deadline, started before the manifest is loaded and
    before the child is spawned. Every exit path reaps the child this call
    started. No remote model cancellation is claimed: this probe makes no model
    call at all.
    """
    started = time.monotonic()
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProbeError("FIELD_VALUE")
    if not math.isfinite(timeout) or not 0 < timeout <= _MAX_TIMEOUT:
        raise ProbeError("FIELD_VALUE")
    if not isinstance(nonce, str) or not nonce:
        raise ProbeError("FIELD_VALUE")
    if script is None:
        script = _default_script()
    else:
        script = Path(script)
    if not script.is_file():
        raise ProbeError("CHILD_FAILED")
    deadline = started + float(timeout)
    try:
        manifest = load_manifest()
    except ProtocolError as exc:
        raise ProbeError(exc.code)
    session_id = uuid.uuid4().hex
    host = _Host(manifest, session_id, nonce, deadline)
    proc = None
    reaped = False
    try:
        host.check_deadline()
        try:
            proc = subprocess.Popen(
                [node, str(script)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=_child_env(),
                bufsize=0,
            )
        except OSError:
            raise ProbeError("SPAWN_FAILED")
        host.proc = proc
        host.register("stdout", proc.stdout, selectors.EVENT_READ)
        host.register("stderr", proc.stderr, selectors.EVENT_READ)
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": "host-1",
                "method": "runtime.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "clientCapabilities": {
                        "modelGenerate": "UNAVAILABLE",
                        "toolExecute": "UNAVAILABLE",
                        "methodCatalog": "AVAILABLE",
                        "maxTokens": {"configured": 8192, "verified": False},
                    },
                },
            },
            "runtime.initialize",
        )
        host.pump(proc, lambda: host.expected is None)
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": "host-2",
                "method": "runtime.probe",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "nonce": nonce,
                },
            },
            "runtime.probe",
        )
        host.pump(proc, lambda: host.probe_result is not None)
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": "host-3",
                "method": "session.stop",
                "params": {"protocolVersion": PROTOCOL_VERSION, "sessionId": session_id},
            },
            "session.stop",
        )
        host.pump(proc, lambda: host.stop_acked)
        host.drain_tail(proc)
        host.check_deadline()
        try:
            code = proc.wait(timeout=max(0.0, min(host.remaining(), _REAP_SECONDS)))
        except subprocess.TimeoutExpired:
            raise ProbeError("TIMEOUT")
        reaped = proc.poll() is not None
        if code != 0:
            raise ProbeError("CHILD_FAILED")
        if host.stderr_seen:
            raise ProbeError("CHILD_FAILED")
        if host.frames != _NORMAL_FRAMES:
            raise ProbeError("FRAME_LIMIT_EXCEEDED")
        result = ProbeResult()
        result["protocolVersion"] = PROTOCOL_VERSION
        result["sessionId"] = session_id
        result["nonce"] = nonce
        result["catalogCount"] = _EXPECTED_CATALOG
        result["catalogAcknowledged"] = True
        result["frames"] = host.frames
        result["localVerification"] = "LOCAL_VERIFIED"
        result["targetEnvironment"] = "TARGET_UNVERIFIED"
        result["childReaped"] = reaped
        return result
    except ProtocolError as exc:
        raise ProbeError(exc.code)
    finally:
        try:
            host.selector.close()
        except OSError:
            pass
        if proc is not None:
            reaped = _reap(proc)
            _close_streams(proc)
            if not reaped:
                raise ProbeError("CHILD_FAILED")


def _catalog_entries():
    from mathagent.lite.methods import MethodCatalog

    catalog = MethodCatalog()
    entries, diagnostic = catalog.catalog()
    if diagnostic is not None:
        raise ProbeError("FIELD_VALUE")
    if len(entries) != _EXPECTED_CATALOG:
        raise ProbeError("FIELD_VALUE")
    # The frozen P0 probe catalog is id/title only. Routing metadata belongs to
    # the live Agent Host 1.3 path, so project it away here.
    return [
        {"id": entry["id"], "title": entry["title"]}
        for entry in entries
    ]


def main(argv=None):
    """CLI entry point: ``python -m python.astra_bridge.p0_probe``."""
    args = list(sys.argv[1:] if argv is None else argv)
    node = "node"
    script = None
    timeout = 5.0
    nonce = "p0-local-probe"
    index = 0
    while index < len(args):
        flag = args[index]
        if flag == "--node" and index + 1 < len(args):
            node = args[index + 1]
            index += 2
            continue
        if flag == "--script" and index + 1 < len(args):
            script = args[index + 1]
            index += 2
            continue
        if flag == "--timeout" and index + 1 < len(args):
            try:
                timeout = float(args[index + 1])
            except ValueError:
                sys.stderr.write("FIELD_VALUE\n")
                return 2
            index += 2
            continue
        if flag == "--nonce" and index + 1 < len(args):
            nonce = args[index + 1]
            index += 2
            continue
        sys.stderr.write("FIELD_VALUE\n")
        return 2
    try:
        result = run_probe(node=node, script=script, timeout=timeout, nonce=nonce)
    except ProbeError as exc:
        sys.stderr.write(f"{exc.code}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
