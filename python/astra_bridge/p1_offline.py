"""P1 offline Host: one mock model callback over the local stdio Node runtime.

Mock-only local prototype. No real provider, no network, no tool execution and
no Python solver. The only model source is a pure in-memory fixture client.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import selectors
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .p0_probe import (
    ProbeError,
    _Host,
    _child_env,
    _close_streams,
    _reap,
)
from .p0_protocol import ProtocolError
from .p1_protocol import (
    P1_MAX_MODEL_CALLS,
    P1_MAX_REMAINING_MS,
    P1_MAX_TOKENS,
    P1_MODE,
    P1_MODEL_REQUEST_ID,
    P1_PROTOCOL_VERSION,
    P1_TARGET_ENVIRONMENT,
    check_p1_binding,
    load_p1_manifest,
    parse_p1_frame,
    validate_p1_payload,
)

__all__ = ["OfflineClient", "run_offline", "main"]

_MAX_TIMEOUT = 5.0
_REAP_SECONDS = 1.0
_READ_CHUNK = 65536
_MAX_STDERR_BYTES = 65536
_CALLBACK_ID = "node-model-1"
_HOST_IDS = ("host-1", "host-2", "host-3")
_DELIVERY_STATUS = ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN")
_MAX_REPLY_CHARS = 12000
_MAX_PROBLEM_CHARS = 8192


def _code_points(value):
    count = 0
    index = 0
    length = len(value)
    while index < length:
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= length:
                return None
            if not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                return None
            index += 2
        elif 0xDC00 <= unit <= 0xDFFF:
            return None
        else:
            index += 1
        count += 1
    return count


def _strict_utf8(value):
    """Encode with strict UTF-8; a lone surrogate is a fixed FIELD_VALUE."""
    try:
        return value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ProbeError("FIELD_VALUE")


class OfflineClient:
    """Pure data fixture client. No sleep, no network, no thread, no callback."""

    def __init__(self, reply, delivery_status="COMPLETE"):
        if not isinstance(reply, str):
            raise ProbeError("FIELD_VALUE")
        length = _code_points(reply)
        if length is None or length > _MAX_REPLY_CHARS:
            raise ProbeError("FIELD_VALUE")
        _strict_utf8(reply)
        if delivery_status not in _DELIVERY_STATUS:
            raise ProbeError("FIELD_VALUE")
        self._reply = reply
        self._delivery_status = delivery_status
        self.calls = 0

    @property
    def delivery_status(self):
        return self._delivery_status

    @property
    def reply(self):
        return self._reply

    def chat(self, messages, temperature=0, max_tokens=P1_MAX_TOKENS):
        self.calls += 1
        return {"text": self._reply, "deliveryStatus": self._delivery_status}


class _P1Host(_Host):
    """P1 Host: reuses the P0 selector/pump/send, overrides the callbacks."""

    def __init__(self, manifest, session_id, deadline, problem, problem_hash, client, max_calls):
        super().__init__(manifest, session_id, None, deadline)
        self.problem = problem
        self.problem_hash = problem_hash
        self.client = client
        self.max_calls = max_calls
        self.model_calls = 0
        self.solve_result = None
        self.solve_id = None
        self.callback_used = False

    def on_request(self, message):
        method = message["method"]
        if method != "model.generate":
            raise ProbeError("UNKNOWN_METHOD")
        if message["id"] != _CALLBACK_ID:
            raise ProbeError("ID_MISMATCH")
        if self.expected is None or self.expected[1] != "session.solve":
            raise ProbeError("ID_MISMATCH")
        if self.pending is not None or self.callback_used:
            raise ProbeError("ID_MISMATCH")
        params = message["params"]
        validate_p1_payload("model.generate", "params", params, self.manifest)
        check_p1_binding(params, self.session_id)
        if params["requestId"] != P1_MODEL_REQUEST_ID:
            raise ProbeError("ID_MISMATCH")
        if params["problemHash"] != self.problem_hash:
            raise ProbeError("FIELD_VALUE")
        if params["contractVersion"] != 1 or params["maxTokens"] != P1_MAX_TOKENS:
            raise ProbeError("FIELD_VALUE")
        messages = params["messages"]
        if len(messages) != 2:
            raise ProbeError("FIELD_VALUE")
        if messages[0]["role"] != "system" or messages[0]["content"] != self.manifest["systemPrompt"]:
            raise ProbeError("FIELD_VALUE")
        if messages[1]["role"] != "user" or messages[1]["content"] != self.problem:
            raise ProbeError("FIELD_VALUE")
        for entry in messages:
            _strict_utf8(entry["content"])
        if self.model_calls >= self.max_calls or self.model_calls >= P1_MAX_MODEL_CALLS:
            raise ProbeError("FIELD_VALUE")
        if self.remaining() * 1000 <= 25:
            raise ProbeError("TIMEOUT")
        self.model_calls += 1
        receipt = self.client.chat(messages, temperature=0, max_tokens=P1_MAX_TOKENS)
        if not isinstance(receipt, dict):
            raise ProbeError("FIELD_VALUE")
        if receipt.get("deliveryStatus") not in _DELIVERY_STATUS:
            raise ProbeError("FIELD_VALUE")
        text = receipt.get("text")
        if not isinstance(text, str):
            raise ProbeError("FIELD_VALUE")
        length = _code_points(text)
        if length is None or length > _MAX_REPLY_CHARS:
            raise ProbeError("FIELD_VALUE")
        _strict_utf8(text)
        result = {
            "protocolVersion": P1_PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "requestId": P1_MODEL_REQUEST_ID,
            "mode": P1_MODE,
            "deliveryStatus": receipt["deliveryStatus"],
            "text": text,
            "remainingMs": max(0, min(P1_MAX_REMAINING_MS, int(self.remaining() * 1000))),
        }
        validate_p1_payload("model.generate", "result", result, self.manifest)
        self.callback_used = True
        self.send(
            self.proc,
            {"jsonrpc": "2.0", "id": _CALLBACK_ID, "result": result},
            "model.generate",
        )
        self.pending_is_callback = True

    def on_result(self, message):
        if self.expected is None:
            raise ProbeError("ID_MISMATCH")
        if self.pending is not None:
            raise ProbeError("ID_MISMATCH")
        expected_id, method = self.expected
        if message["id"] != expected_id:
            raise ProbeError("ID_MISMATCH")
        if method == "runtime.initialize":
            validate_p1_payload("runtime.initialize", "result", message["result"], self.manifest)
            check_p1_binding(message["result"], self.session_id)
            if message["result"]["mode"] != P1_MODE:
                raise ProbeError("FIELD_VALUE")
            if message["result"]["targetEnvironment"] != P1_TARGET_ENVIRONMENT:
                raise ProbeError("FIELD_VALUE")
            self.expected = None
            return
        if method == "session.solve":
            self.on_solve_result(message)
            return
        if method == "session.stop":
            validate_p1_payload("session.stop", "result", message["result"], self.manifest)
            check_p1_binding(message["result"], self.session_id)
            if message["result"]["stopped"] is not True:
                raise ProbeError("FIELD_VALUE")
            self.stop_acked = True
            self.expected = None
            return
        raise ProbeError("ID_MISMATCH")

    def on_solve_result(self, message):
        result = message["result"]
        validate_p1_payload("session.solve", "result", result, self.manifest)
        check_p1_binding(result, self.session_id)
        if result["candidateVerified"] is not False:
            raise ProbeError("FIELD_VALUE")
        if result["strictAcceptance"] != "NOT_PERFORMED":
            raise ProbeError("FIELD_VALUE")
        if result["mode"] != P1_MODE:
            raise ProbeError("FIELD_VALUE")
        trace = result["trace"]
        for index, event in enumerate(trace):
            if event["seq"] != index + 1:
                raise ProbeError("FIELD_VALUE")
        if result["modelCalls"] != self.model_calls:
            raise ProbeError("FIELD_VALUE")
        if self.model_calls == 0 and result["status"] != "unsolved":
            raise ProbeError("FIELD_VALUE")
        if self.model_calls == 1 and not self.callback_done:
            raise ProbeError("FIELD_VALUE")
        self.solve_result = result
        self.solve_id = message["id"]
        self.expected = None


def _default_script():
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "p1-main.js"


def run_offline(
    problem,
    *,
    reply,
    delivery_status="COMPLETE",
    max_model_calls=1,
    timeout=5,
    node="node",
    script=None,
):
    """Run one P1 offline handshake against the local Node runtime."""
    started = time.monotonic()
    if not isinstance(problem, str) or not problem:
        raise ProbeError("FIELD_VALUE")
    length = _code_points(problem)
    if length is None or length > _MAX_PROBLEM_CHARS:
        raise ProbeError("FIELD_VALUE")
    _strict_utf8(problem)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProbeError("FIELD_VALUE")
    if not math.isfinite(timeout) or not 0 < timeout <= _MAX_TIMEOUT:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_model_calls, bool) or not isinstance(max_model_calls, int):
        raise ProbeError("FIELD_VALUE")
    if max_model_calls not in (0, 1):
        raise ProbeError("FIELD_VALUE")
    if script is None:
        script = _default_script()
    else:
        script = Path(script)
    if not script.is_file():
        raise ProbeError("CHILD_FAILED")
    deadline = started + float(timeout)
    try:
        manifest = load_p1_manifest()
    except ProtocolError as exc:
        raise ProbeError(exc.code)
    try:
        client = OfflineClient(reply, delivery_status)
    except ProbeError:
        raise
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    session_id = uuid.uuid4().hex
    host = _P1Host(manifest, session_id, deadline, problem, problem_hash, client, max_model_calls)
    proc = None
    reaped = False
    try:
        host.check_deadline()
        # Validate both directions against the same manifest before spawning, so
        # a non-conforming fixture fails with zero child processes.
        validate_p1_payload(
            "session.solve",
            "params",
            {
                "protocolVersion": P1_PROTOCOL_VERSION,
                "sessionId": session_id,
                "problem": problem,
                "problemHash": problem_hash,
            },
            manifest,
        )
        validate_p1_payload(
            "model.generate",
            "result",
            {
                "protocolVersion": P1_PROTOCOL_VERSION,
                "sessionId": session_id,
                "requestId": P1_MODEL_REQUEST_ID,
                "mode": P1_MODE,
                "deliveryStatus": client.delivery_status,
                "text": client.reply,
                "remainingMs": max(0, min(P1_MAX_REMAINING_MS, int(host.remaining() * 1000))),
            },
            manifest,
        )
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
        remaining = max(1, min(P1_MAX_REMAINING_MS, int(host.remaining() * 1000)))
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": _HOST_IDS[0],
                "method": "runtime.initialize",
                "params": {
                    "protocolVersion": P1_PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "remainingMs": remaining,
                    "maxModelCalls": max_model_calls,
                    "maxTokens": P1_MAX_TOKENS,
                    "mode": P1_MODE,
                },
            },
            "runtime.initialize",
        )
        host.pump(proc, lambda: host.expected is None)
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": _HOST_IDS[1],
                "method": "session.solve",
                "params": {
                    "protocolVersion": P1_PROTOCOL_VERSION,
                    "sessionId": session_id,
                    "problem": problem,
                    "problemHash": problem_hash,
                },
            },
            "session.solve",
        )
        host.pump(proc, lambda: host.solve_result is not None)
        host.send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": _HOST_IDS[2],
                "method": "session.stop",
                "params": {"protocolVersion": P1_PROTOCOL_VERSION, "sessionId": session_id},
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
        result = host.solve_result
        if result is None:
            raise ProbeError("FIELD_VALUE")
        safe = {
            "protocolVersion": P1_PROTOCOL_VERSION,
            "sessionId": session_id,
            "status": result["status"],
            "finalResponse": result["finalResponse"],
            "final_response": result["finalResponse"],
            "candidateVerified": False,
            "candidate_verified": False,
            "strictAcceptance": "NOT_PERFORMED",
            "mode": P1_MODE,
            "targetEnvironment": P1_TARGET_ENVIRONMENT,
            "trace": result["trace"],
            "modelCalls": result["modelCalls"],
            "frames": host.frames,
            "childReaped": reaped,
        }
        return safe
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


def main(argv=None):
    parser = argparse.ArgumentParser(prog="p1_offline")
    parser.add_argument("--problem", required=True)
    parser.add_argument("--reply", required=True)
    parser.add_argument("--delivery-status", default="COMPLETE")
    parser.add_argument("--max-model-calls", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--node", default="node")
    parser.add_argument("--script", default=None)
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = run_offline(
            args.problem,
            reply=args.reply,
            delivery_status=args.delivery_status,
            max_model_calls=args.max_model_calls,
            timeout=args.timeout,
            node=args.node,
            script=args.script,
        )
    except ProbeError as exc:
        sys.stderr.write(f"{exc.code}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
