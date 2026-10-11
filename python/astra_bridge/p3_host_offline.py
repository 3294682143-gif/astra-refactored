"""P3 local Host runner over the Node stdio channel (fixture model only).

One literal receipt list, at most three model turns and two tool effects, no
network, no real provider, no arbitrary code. Nothing here is mathematical
acceptance: every receipt stays PROVISIONAL/UNKNOWN.
"""

from __future__ import annotations

import hashlib
import json
import math
import selectors
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .p0_probe import ProbeError, _child_env, _close_streams, _reap
from .p0_protocol import ProtocolError
from .p3_host_callback import P3HostCallback
from .p3_host_context import validate_receipts
from .p3_host_protocol import P3_HOST_VERSION, load_manifest, payload

__all__ = ["run_p3_host"]

_MAX_TIMEOUT = 5.0
_REAP_SECONDS = 1.0
_MAX_PROBLEM_CHARS = 8192
_MAX_TOKENS = 8192
_HOST_IDS = ("host-1", "host-2", "host-3")


def _default_script():
    root = Path(__file__).resolve().parents[2]
    return root / "apps" / "stdio-runtime" / "dist" / "src" / "p3-host-main.js"


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


def run_p3_host(
    problem,
    *,
    receipts,
    max_model_calls=3,
    max_effects=2,
    max_method_loads=0,
    timeout=5,
    node="node",
    script=None,
):
    """Run one P3 local Host handshake against the Node stdio runtime."""
    started = time.monotonic()
    if not isinstance(problem, str) or not problem.strip():
        raise ProbeError("FIELD_VALUE")
    length = _code_points(problem)
    if length is None or length > _MAX_PROBLEM_CHARS:
        raise ProbeError("FIELD_VALUE")
    try:
        problem.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ProbeError("FIELD_VALUE") from None
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProbeError("FIELD_VALUE")
    if not math.isfinite(timeout) or not 0 < timeout <= _MAX_TIMEOUT:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_model_calls, bool) or not isinstance(max_model_calls, int) or not 0 <= max_model_calls <= 3:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_effects, bool) or not isinstance(max_effects, int) or not 0 <= max_effects <= 2:
        raise ProbeError("FIELD_VALUE")
    if isinstance(max_method_loads, bool) or not isinstance(max_method_loads, int) or not 0 <= max_method_loads <= 1:
        raise ProbeError("FIELD_VALUE")
    checked_receipts = validate_receipts(receipts)
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
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    session_id = uuid.uuid4().hex
    host = P3HostCallback(
        manifest, session_id, deadline, problem, problem_hash,
        checked_receipts, max_model_calls, max_effects, max_method_loads,
    )
    proc = None
    reaped = False
    try:
        host.check_deadline()
        common = {"protocolVersion": P3_HOST_VERSION, "sessionId": session_id}
        init = {
            **common,
            "remainingMs": max(1, min(5000, int(host.remaining() * 1000))),
            "maxModelCalls": max_model_calls,
            "maxEffects": max_effects,
            "maxMethodLoads": max_method_loads,
            "maxTokens": _MAX_TOKENS,
            "mode": "MOCK_ONLY",
        }
        solve = {**common, "problem": problem, "problemHash": problem_hash}
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
    problem = None
    receipts = []
    max_model_calls = 3
    max_effects = 2
    max_method_loads = 0
    timeout = 5.0
    index = 0
    while index < len(args):
        flag = args[index]
        if flag == "--problem" and index + 1 < len(args):
            problem = args[index + 1]
            index += 2
            continue
        if flag == "--action" and index + 1 < len(args):
            receipts.append({"deliveryStatus": "COMPLETE", "text": args[index + 1]})
            index += 2
            continue
        if flag in ("--max-model-calls", "--max-effects", "--max-method-loads") and index + 1 < len(args):
            try:
                value = int(args[index + 1])
            except ValueError:
                sys.stderr.write("FIELD_VALUE\n")
                return 2
            if flag == "--max-model-calls":
                max_model_calls = value
            elif flag == "--max-effects":
                max_effects = value
            else:
                max_method_loads = value
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
        sys.stderr.write("FIELD_VALUE\n")
        return 2
    if problem is None or not 1 <= len(receipts) <= 3:
        sys.stderr.write("FIELD_VALUE\n")
        return 2
    try:
        result = run_p3_host(
            problem,
            receipts=receipts,
            max_model_calls=max_model_calls,
            max_effects=max_effects,
            max_method_loads=max_method_loads,
            timeout=timeout,
        )
    except ProbeError as exc:
        sys.stderr.write(f"{exc.code}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
