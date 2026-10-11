"""P3 controlled effect adapter: one validated request, at most one execution.

This module is the only place where a P3 effect request reaches a real
registered operator or the existing fixture method catalog. It never evaluates
model-supplied code, never reads a path from the request and never retries: a
timeout, an exception or an unknown outcome ends the call. Every receipt is
PROVISIONAL/UNKNOWN; a successful execution is an observation, not a proof.

The executor, catalog and clock are injected by the trusted caller. The CLI
entry point accepts no argument and always uses the real registered executor.
"""

from __future__ import annotations

import json
import sys
import time

from math import isfinite

from .p3_effect_contract import (
    MAX_OBSERVATION_BYTES,
    ProtocolError,
    failure_receipt,
    parse_request,
    receipt,
    validate_request,
)

__all__ = ["perform_effect", "main"]

# Reserved for the final settle/cleanup of the shared window.
_SETTLE_SECONDS = 0.025
_MAX_STDIN_BYTES = 65537


def _utf8_len(text):
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return None


def _compact(value):
    """Compact JSON of JSON-shaped data; raises on non-serializable values."""
    return json.dumps(
        value, allow_nan=False, ensure_ascii=False, separators=(",", ":")
    )


def _observation(payload):
    """Serialize one observation or return None when it cannot be represented."""
    try:
        text = _compact(payload)
    except (ValueError, TypeError, RecursionError, OverflowError):
        return None
    length = _utf8_len(text)
    if length is None or length > MAX_OBSERVATION_BYTES:
        return None
    return text


def _tool_effect(request, executor, deadline):
    action = request["action"]
    name = action["name"]
    args = action["args"]
    scope = action["scope"]
    try:
        result = executor.execute(name, args, deadline=deadline, scope=scope)
    except Exception:  # noqa: BLE001 - the outcome is unknown, never a proof
        return failure_receipt(request, "UNKNOWN", "UNKNOWN_OUTCOME")
    status = getattr(result, "status", None)
    if status != "ok":
        code = "INVALID_INPUT" if status in ("invalid_input", "out_of_scope") else "EFFECT_FAILED"
        return failure_receipt(request, "ERROR", code)
    observation = _observation(
        {
            "tool": name,
            "result": getattr(result, "result", None),
            "interpretation": "OBSERVATION_NOT_PROOF",
        }
    )
    if observation is None:
        return failure_receipt(request, "ERROR", "OUTPUT_TOO_LARGE")
    return receipt(request, "COMPLETE", observation)


def _method_effect(request, catalog, deadline):
    action = request["action"]
    method_id = action["id"]
    try:
        from .p2_methods import fixture_load

        loaded = fixture_load(method_id, catalog)
    except Exception:  # noqa: BLE001 - a failed read is not a mathematical result
        return failure_receipt(request, "ERROR", "EFFECT_FAILED")
    if not isinstance(loaded, dict) or loaded.get("status") != "loaded":
        return failure_receipt(request, "ERROR", "INVALID_INPUT")
    asset = loaded.get("asset")
    if not isinstance(asset, dict):
        return failure_receipt(request, "ERROR", "INVALID_INPUT")
    observation = _observation(
        {
            "method": method_id,
            "asset": asset,
            "interpretation": "ADVISORY_NOT_PROOF",
        }
    )
    if observation is None:
        return failure_receipt(request, "ERROR", "OUTPUT_TOO_LARGE")
    return receipt(request, "COMPLETE", observation)


def perform_effect(request, *, executor=None, catalog=None, clock=time.monotonic):
    """Validate one request and perform at most one effect.

    The clock is read before validation, so no execution can start before the
    request has been accepted. A deadline that has already passed yields a
    fixed ERROR receipt; a late result never becomes COMPLETE.
    """
    try:
        started = clock()
    except Exception:  # noqa: BLE001 - a broken clock is a fixed failure
        return failure_receipt(request, "ERROR", "DEADLINE_EXCEEDED")
    if isinstance(started, bool) or not isinstance(started, (int, float)) or not isfinite(started):
        return failure_receipt(request, "ERROR", "DEADLINE_EXCEEDED")
    bound = validate_request(request)
    remaining_ms = bound["remainingMs"]
    deadline = started + remaining_ms / 1000.0 - _SETTLE_SECONDS
    try:
        now = clock()
    except Exception:  # noqa: BLE001
        return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
    if isinstance(now, bool) or not isinstance(now, (int, float)) or not isfinite(now) or now < started or now >= deadline:
        return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
    if bound["action"]["action"] == "tool":
        if executor is None:
            from mathagent.tools import RegisteredExecutor

            executor = RegisteredExecutor()
        try:
            after = clock()
        except Exception:  # noqa: BLE001
            return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
        if isinstance(after, bool) or not isinstance(after, (int, float)) or not isfinite(after) or after < now or after >= deadline:
            return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
        now = after
        result = _tool_effect(bound, executor, deadline)
    else:
        result = _method_effect(bound, catalog, deadline)
    try:
        settled = clock()
    except Exception:  # noqa: BLE001
        if result.get("status") == "UNKNOWN":
            return result
        return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
    if isinstance(settled, bool) or not isinstance(settled, (int, float)) or not isfinite(settled) or settled < now or settled >= deadline:
        if result.get("status") == "UNKNOWN":
            return result
        return failure_receipt(bound, "ERROR", "DEADLINE_EXCEEDED")
    return result


def main():
    """Read one request from stdin and write one receipt to stdout."""
    if len(sys.argv) > 1:
        sys.stderr.write("INVALID_REQUEST\n")
        return 2
    raw = sys.stdin.buffer.read(_MAX_STDIN_BYTES)
    try:
        request = parse_request(raw)
        result = perform_effect(request)
    except ProtocolError:
        sys.stderr.write("INVALID_REQUEST\n")
        return 2
    except Exception:  # noqa: BLE001 - fixed code only, never a traceback
        sys.stderr.write("INVALID_REQUEST\n")
        return 2
    sys.stdout.write(_compact(result) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
