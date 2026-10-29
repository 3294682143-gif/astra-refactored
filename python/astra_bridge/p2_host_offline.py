"""P2 local Host single-work-unit runner over the Node stdio channel.

Mock-only local prototype: one pure in-memory fixture model call, at most one
method load, no network, no tool, no real provider. Nothing here is
mathematical acceptance.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import selectors
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .p0_probe import ProbeError, _child_env, _close_streams, _reap
from .p0_protocol import ProtocolError
from .p1_offline import _code_points, _strict_utf8
from .p2_host_callback import P2HostCallback
from .p2_host_fixture import OfflineP2Client
from .p2_host_protocol import P2_HOST_VERSION, load_manifest, payload

__all__ = ["run_p2_host"]

_MAX_TIMEOUT = 5.0
_REAP_SECONDS = 1.0
_MAX_PROBLEM_CHARS = 8192
_MAX_TOKENS = 8192
_HOST_IDS = ("host-1", "host-2", "host-3")
_METHOD_ID_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _default_script():
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "p2-host-main.js"


def _canonical_method_id(method_id):
    if method_id is None:
        return None
    if not isinstance(method_id, str) or not method_id or len(method_id) > 64:
        raise ProbeError("FIELD_VALUE")
    if _METHOD_ID_RE.fullmatch(method_id) is None:
        raise ProbeError("FIELD_VALUE")
    return method_id


def run_p2_host(
    problem,
    *,
    reply,
    delivery_status="COMPLETE",
    max_model_calls=1,
    max_method_loads=1,
    method_id=None,
    timeout=5,
    node="node",
    script=None,
):
    """Run one P2 local Host handshake against the Node stdio runtime."""
    started = time.monotonic()
    if not isinstance(problem, str) or not problem.strip():
        raise ProbeError("FIELD_VALUE")
    length = _code_points(problem)
    if length is None or length > _MAX_PROBLEM_CHARS:
        raise ProbeError("FIELD_VALUE")
    _strict_utf8(problem)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProbeError("FIELD_VALUE")
    if not math.isfinite(timeout) or not 0 < timeout <= _MAX_TIMEOUT:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_model_calls, bool) or not isinstance(max_model_calls, int) or not 0 <= max_model_calls <= 3:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_method_loads, bool) or not isinstance(max_method_loads, int) or not 0 <= max_method_loads <= 1:
        raise ProbeError("FIELD_VALUE")
    method_id = _canonical_method_id(method_id)
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
    client = OfflineP2Client(reply, delivery_status, max_calls=max_model_calls)
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    session_id = uuid.uuid4().hex
    host = P2HostCallback(
        manifest, session_id, deadline, problem, problem_hash, client,
        max_model_calls, max_method_loads, method_id,
    )
    proc = None
    reaped = False
    try:
        host.check_deadline()
        common = {"protocolVersion": P2_HOST_VERSION, "sessionId": session_id}
        init = {
            **common,
            "remainingMs": max(1, min(5000, int(host.remaining() * 1000))),
            "maxModelCalls": max_model_calls,
            "maxMethodLoads": max_method_loads,
            "maxTokens": _MAX_TOKENS,
            "mode": "MOCK_ONLY",
        }
        solve = {**common, "problem": problem, "problemHash": problem_hash, "methodId": method_id}
        stop = dict(common)
        payload(manifest, "runtime.initialize", "params", init, session_id)
        payload(manifest, "session.solve", "params", solve, session_id)
        payload(manifest, "session.stop", "params", stop, session_id)
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
        host.check_deadline()
        init["remainingMs"] = max(1, min(init["remainingMs"], int(host.remaining() * 1000)))
        steps = (
            ("runtime.initialize", _HOST_IDS[0], init, lambda: host.expected is None),
            ("session.solve", _HOST_IDS[1], solve, lambda: host.solve_result is not None),
            ("session.stop", _HOST_IDS[2], stop, lambda: host.stop_acked),
        )
        for method, frame_id, params, until in steps:
            host.send(proc, {"jsonrpc": "2.0", "id": frame_id, "method": method, "params": params}, method)
            host.pump(proc, until)
        host.drain_tail(proc)
        host.check_deadline()
        try:
            code = proc.wait(timeout=max(0.0, min(host.remaining(), _REAP_SECONDS)))
        except subprocess.TimeoutExpired:
            raise ProbeError("TIMEOUT")
        reaped = proc.poll() is not None
        if code != 0 or host.stderr_seen:
            raise ProbeError("CHILD_FAILED")
        result = host.solve_result
        if result is None:
            raise ProbeError("FIELD_VALUE")
        safe = dict(result)
        safe["candidateVerified"] = False
        safe["candidate_verified"] = False
        safe["final_response"] = result["finalResponse"]
        safe["strictAcceptance"] = "NOT_PERFORMED"
        safe["mode"] = "MOCK_ONLY"
        safe["targetEnvironment"] = "TARGET_UNVERIFIED"
        safe["frames"] = host.frames
        safe["childReaped"] = reaped
        return safe
    except ProtocolError as exc:
        raise ProbeError(exc.code)
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("FIELD_VALUE") from None
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
    args = list(sys.argv[1:] if argv is None else argv)
    options = {"problem": None, "reply": None, "delivery_status": "COMPLETE",
               "max_model_calls": 1, "max_method_loads": 1, "method_id": None,
               "timeout": 5.0}
    index = 0
    while index < len(args):
        flag = args[index]
        if flag in ("--problem", "--reply", "--delivery-status", "--method-id"):
            if index + 1 >= len(args):
                sys.stderr.write("FIELD_VALUE\n")
                return 2
            key = flag[2:].replace("-", "_")
            options[key] = args[index + 1]
            index += 2
            continue
        if flag in ("--max-model-calls", "--max-method-loads", "--timeout"):
            if index + 1 >= len(args):
                sys.stderr.write("FIELD_VALUE\n")
                return 2
            key = flag[2:].replace("-", "_")
            try:
                options[key] = int(args[index + 1]) if key != "timeout" else float(args[index + 1])
            except ValueError:
                sys.stderr.write("FIELD_VALUE\n")
                return 2
            index += 2
            continue
        sys.stderr.write("FIELD_VALUE\n")
        return 2
    if options["problem"] is None or options["reply"] is None:
        sys.stderr.write("FIELD_VALUE\n")
        return 2
    try:
        result = run_p2_host(
            options["problem"],
            reply=options["reply"],
            delivery_status=options["delivery_status"],
            max_model_calls=options["max_model_calls"],
            max_method_loads=options["max_method_loads"],
            method_id=options["method_id"],
            timeout=options["timeout"],
        )
    except ProbeError as exc:
        sys.stderr.write(f"{exc.code}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
