"""P3 effect boundary contract: strict request/receipt data only.

This module parses and validates the control-side effect request and builds
receipts. It reads no directory, no tool registry, spawns nothing and executes
no method or tool. Failures are fixed codes; raw input and exception messages
are never carried.
"""

from __future__ import annotations

import hashlib
import json

from .p0_protocol import (
    LIMITS,
    ProtocolError,
    _object_pairs_hook,
    _parse_constant,
    _parse_float,
    _parse_int,
    _reject_surrogates,
    _scan_depth,
    decode_frame,
)
from .text_contract import js_nonempty

__all__ = [
    "TOOL_NAMES",
    "MAX_REQUEST_BYTES",
    "MAX_ARGS_BYTES",
    "MAX_OBSERVATION_BYTES",
    "MIN_REMAINING_MS",
    "MAX_REMAINING_MS",
    "EFFECT_IDS",
    "REQUEST_IDS",
    "FAILURE_CODES",
    "parse_request",
    "validate_request",
    "receipt",
    "failure_receipt",
]

TOOL_NAMES = (
    "polynomial_expand_coefficients",
    "linear_system_solution_set",
    "exact_check_expr",
    "bounded_enumeration",
    "real_root_count_expr",
    "splitting_field_degree_expr",
    "circle_laplacian_expr",
    "planar_laplacian_expr",
    "interpolation_fit_check",
    "stats_ols_check",
    "finite_group_structure",
)
MAX_REQUEST_BYTES = 65536
MAX_ARGS_BYTES = 10000
MAX_OBSERVATION_BYTES = 16000
MIN_REMAINING_MS = 26
MAX_REMAINING_MS = 3600000
# Effect id capacity is six: up to four method cards and two tool effects can
# coexist in one window. The public `maxEffects` option still caps grantable
# tool effects at two; the remaining slots are the bounded method-load quota.
EFFECT_IDS = ("effect-1", "effect-2", "effect-3", "effect-4", "effect-5", "effect-6")
# Root model request ids the session can produce. The previous three-entry
# tuple made every tool call on the fourth or later model request a fixed
# validation failure once the M1 contract grew past three obligations.
REQUEST_IDS = tuple("model-" + str(n) for n in range(1, 257))
FAILURE_CODES = (
    "EFFECT_FAILED",
    "INVALID_INPUT",
    "DEADLINE_EXCEEDED",
    "OUTPUT_TOO_LARGE",
    "UNKNOWN_OUTCOME",
)
_MAX_SAFE = LIMITS["maxSafeInteger"]
_HEX64 = frozenset("0123456789abcdef")
_BINDING_KEYS = (
    "sessionId",
    "problemHash",
    "contractVersion",
    "taskId",
    "scopeId",
    "sourceRequestId",
)
_METHOD_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


def _fail(code):
    raise ProtocolError(code)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _exact_keys(value, expected):
    return isinstance(value, dict) and set(value) == set(expected) and len(value) == len(expected)


def _utf8_bytes(value):
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        _fail("FIELD_VALUE")


def _strict_text(value, code, max_chars=None, allow_empty=False):
    if not isinstance(value, str):
        _fail(code)
    if not allow_empty and not js_nonempty(value):
        _fail(code)
    if max_chars is not None and len(value) > max_chars:
        _fail("FIELD_VALUE")
    _utf8_bytes(value)
    return value


def _hash64(value):
    if not isinstance(value, str) or len(value) != 64:
        _fail("FIELD_VALUE")
    for ch in value:
        if ch not in _HEX64:
            _fail("FIELD_VALUE")
    return value


def _binding(value):
    if not _exact_keys(value, _BINDING_KEYS):
        _fail("FIELD_VALUE")
    session_id = _strict_text(value["sessionId"], "FIELD_VALUE", 128)
    problem_hash = _hash64(value["problemHash"])
    version = value["contractVersion"]
    if not _is_int(version) or version < 1 or version > _MAX_SAFE:
        _fail("FIELD_VALUE")
    task_id = _strict_text(value["taskId"], "FIELD_VALUE", 256)
    scope_id = _hash64(value["scopeId"])
    request_id = value["sourceRequestId"]
    if not isinstance(request_id, str) or request_id not in REQUEST_IDS:
        _fail("FIELD_VALUE")
    return {
        "sessionId": session_id,
        "problemHash": problem_hash,
        "contractVersion": version,
        "taskId": task_id,
        "scopeId": scope_id,
        "sourceRequestId": request_id,
    }


def _method_id(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        _fail("FIELD_VALUE")
    if value[0] == "-" or value[-1] == "-" or "--" in value:
        _fail("FIELD_VALUE")
    for ch in value:
        if ch not in _METHOD_ID_CHARS:
            _fail("FIELD_VALUE")
    return value


def _action(value):
    if not isinstance(value, dict):
        _fail("FIELD_VALUE")
    kind = value.get("action")
    if kind == "method":
        if not _exact_keys(value, ("action", "id")):
            _fail("FIELD_VALUE")
        return {"action": "method", "id": _method_id(value["id"])}
    if kind == "tool":
        if not _exact_keys(value, ("action", "name", "args", "scope")):
            _fail("FIELD_VALUE")
        name = value["name"]
        if not isinstance(name, str) or name not in TOOL_NAMES:
            _fail("FIELD_VALUE")
        args = value["args"]
        if not isinstance(args, dict):
            _fail("FIELD_VALUE")
        try:
            encoded = json.dumps(args, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
        except (ValueError, TypeError, RecursionError, OverflowError):
            _fail("FIELD_VALUE")
        if _utf8_bytes(encoded) > MAX_ARGS_BYTES:
            _fail("FIELD_VALUE")
        scope = _strict_text(value["scope"], "FIELD_VALUE", 256)
        return {"action": "tool", "name": name, "args": args, "scope": scope}
    _fail("FIELD_VALUE")


def parse_request(raw):
    """Strict parse of one effect request from raw bytes."""
    if not isinstance(raw, (bytes, bytearray)):
        _fail("FIELD_VALUE")
    if len(raw) > MAX_REQUEST_BYTES:
        _fail("FRAME_TOO_LARGE")
    text = decode_frame(bytes(raw))
    _scan_depth(text)
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs_hook,
            parse_int=_parse_int,
            parse_float=_parse_float,
            parse_constant=_parse_constant,
        )
    except ProtocolError:
        raise
    except ValueError:
        _fail("INVALID_JSON")
    _reject_surrogates(value)
    if not _exact_keys(value, ("effectId", "binding", "action", "remainingMs")):
        _fail("FIELD_VALUE")
    effect_id = value["effectId"]
    if not isinstance(effect_id, str) or effect_id not in EFFECT_IDS:
        _fail("FIELD_VALUE")
    binding = _binding(value["binding"])
    action = _action(value["action"])
    remaining_ms = value["remainingMs"]
    if not _is_int(remaining_ms) or remaining_ms < MIN_REMAINING_MS or remaining_ms > MAX_REMAINING_MS:
        _fail("FIELD_VALUE")
    return {
        "effectId": effect_id,
        "binding": binding,
        "action": action,
        "remainingMs": remaining_ms,
    }


def validate_request(value):
    """Validate an already-parsed request through a JSON round trip."""
    try:
        encoded = json.dumps(value, allow_nan=False, ensure_ascii=False, separators=(",", ":"))
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValueError("INVALID_REQUEST") from None
    try:
        return parse_request(encoded.encode("utf-8"))
    except ProtocolError:
        raise
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ValueError("INVALID_REQUEST") from None


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def receipt(request, status, observation):
    """Build one provisional receipt bound to an already-validated request."""
    bound = validate_request(request)
    if status not in ("COMPLETE", "ERROR", "UNKNOWN"):
        _fail("FIELD_VALUE")
    if not isinstance(observation, str) or not js_nonempty(observation):
        _fail("FIELD_VALUE")
    if _utf8_bytes(observation) > MAX_OBSERVATION_BYTES:
        _fail("FIELD_VALUE")
    action = bound["action"]
    source = "PROGRAM_OBSERVATION" if action["action"] == "tool" else "METHOD_REFERENCE"
    return {
        "effectId": bound["effectId"],
        "binding": bound["binding"],
        "status": status,
        "source": source,
        "observation": observation,
        "observationHash": _sha256(observation),
        "level": "PROVISIONAL",
        "checkResult": "UNKNOWN",
    }


def failure_receipt(request, status="ERROR", code="EFFECT_FAILED"):
    """Fixed non-echoing failure receipt; never carries the original exception."""
    if status not in ("ERROR", "UNKNOWN"):
        _fail("FIELD_VALUE")
    if code not in FAILURE_CODES:
        _fail("FIELD_VALUE")
    return receipt(request, status, json.dumps({"code": code}))
