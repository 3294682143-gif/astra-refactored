"""Strict typed JSON action protocol for the lightweight solver path.

The model emits exactly one JSON object per turn. Parsing is total and
conservative: no eval/exec, no duplicate keys, no NaN/Infinity, no extra
fields, no implicit defaults. A malformed or oversized payload is a protocol
failure, never an answer.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass

__all__ = [
    "LiteProtocolError",
    "FinalAction",
    "MethodAction",
    "ToolAction",
    "UnsolvedAction",
    "parse_action",
    "parse_lite_delivery",
    "TOOL_WHITELIST",
    "MAX_ACTION_CHARS",
    "METHOD_ID_RE",
    "MAX_METHOD_ID_CHARS",
]

# Only these two existing registered operators may be requested. The runtime
# still re-validates names and arguments through RegisteredExecutor.
TOOL_WHITELIST = ("polynomial_expand_coefficients", "linear_system_solution_set")

MAX_ACTION_CHARS = 20000
_MAX_UNRESOLVED = 32
_MAX_STRING = 8000
_MAX_DEPTH = 24

# A method request carries only a short canonical id: lowercase letters, digits
# and single hyphens. Paths, slashes, whitespace and overlong values are refused
# before any catalog lookup, so the model can never name a file.
MAX_METHOD_ID_CHARS = 64
METHOD_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class LiteProtocolError(ValueError):
    """Fixed-code protocol failure; never carries raw model text."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ToolAction:
    name: str
    args: dict
    scope: str


@dataclass(frozen=True)
class MethodAction:
    method_id: str


@dataclass(frozen=True)
class FinalAction:
    answer: str
    complete: bool
    unresolved: tuple


@dataclass(frozen=True)
class UnsolvedAction:
    reason: str


def _no_constant(token):
    raise LiteProtocolError("non_finite_number")


def _finite_float(token):
    # json's default float parser accepts 1e999 as inf; reject non-finite values.
    value = float(token)
    if not math.isfinite(value):
        raise LiteProtocolError("non_finite_number")
    return value


def _no_duplicates(pairs):
    seen = set()
    for key, _ in pairs:
        if key in seen:
            raise LiteProtocolError("duplicate_field")
        seen.add(key)
    return dict(pairs)


def _check_depth(value, depth=0):
    if depth > _MAX_DEPTH:
        raise LiteProtocolError("nesting_too_deep")
    if isinstance(value, dict):
        for key, item in value.items():
            _check_depth(key, depth + 1)
            _check_depth(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _check_depth(item, depth + 1)


def _check_numbers(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise LiteProtocolError("non_finite_number")
    if isinstance(value, dict):
        for key, item in value.items():
            _check_numbers(key)
            _check_numbers(item)
    elif isinstance(value, list):
        for item in value:
            _check_numbers(item)


def _loads(text):
    if not isinstance(text, str):
        raise LiteProtocolError("action_not_text")
    if len(text) > MAX_ACTION_CHARS:
        raise LiteProtocolError("action_too_large")
    try:
        payload = json.loads(
            text,
            parse_constant=_no_constant,
            parse_float=_finite_float,
            object_pairs_hook=_no_duplicates,
        )
    except LiteProtocolError:
        raise
    except (ValueError, TypeError, RecursionError):
        raise LiteProtocolError("malformed_json") from None
    _check_depth(payload)
    _check_numbers(payload)
    return payload


def _bounded_str(value, code, *, allow_empty=False):
    if not isinstance(value, str) or len(value) > _MAX_STRING:
        raise LiteProtocolError(code)
    if not allow_empty and not value.strip():
        raise LiteProtocolError(code)
    return value


def parse_action(text):
    """Parse one model turn into a typed action or raise LiteProtocolError."""
    payload = _loads(text)
    if not isinstance(payload, dict):
        raise LiteProtocolError("action_not_object")
    action = payload.get("action")
    if not isinstance(action, str):
        raise LiteProtocolError("missing_action")
    if action == "tool":
        if set(payload) != {"action", "name", "args", "scope"}:
            raise LiteProtocolError("unexpected_fields")
        name = payload["name"]
        if not isinstance(name, str) or name not in TOOL_WHITELIST:
            raise LiteProtocolError("tool_not_allowed")
        args = payload["args"]
        if not isinstance(args, dict):
            raise LiteProtocolError("tool_args_not_object")
        scope = _bounded_str(payload["scope"], "invalid_scope")
        return ToolAction(name, args, scope)
    if action == "method":
        if set(payload) != {"action", "id"}:
            raise LiteProtocolError("unexpected_fields")
        method_id = payload["id"]
        if not isinstance(method_id, str):
            raise LiteProtocolError("invalid_method_id")
        if len(method_id) > MAX_METHOD_ID_CHARS:
            raise LiteProtocolError("invalid_method_id")
        if not METHOD_ID_RE.fullmatch(method_id):
            raise LiteProtocolError("invalid_method_id")
        return MethodAction(method_id)
    if action == "final":
        if set(payload) != {"action", "answer", "complete", "unresolved"}:
            raise LiteProtocolError("unexpected_fields")
        answer = _bounded_str(payload["answer"], "empty_answer")
        complete = payload["complete"]
        if type(complete) is not bool:
            raise LiteProtocolError("complete_not_bool")
        unresolved = payload["unresolved"]
        if not isinstance(unresolved, list) or len(unresolved) > _MAX_UNRESOLVED:
            raise LiteProtocolError("unresolved_not_list")
        items = tuple(
            _bounded_str(item, "invalid_unresolved") for item in unresolved
        )
        return FinalAction(answer, complete, items)
    if action == "unsolved":
        if set(payload) != {"action", "reason"}:
            raise LiteProtocolError("unexpected_fields")
        reason = _bounded_str(payload["reason"], "invalid_reason")
        return UnsolvedAction(reason)
    raise LiteProtocolError("unknown_action")


def parse_lite_delivery(
    raw,
    *,
    finish_reason,
    prefill=False,
    transport_complete=True,
    complete_public_return=False,
):
    """Transport-integrity view for protocol='lite'.

    Mirrors the L3 delivery boundary: a raw string return with no explicit
    finish metadata is accepted only when the public method returned normally.
    Explicit truncation, late or unfinished transport is never delivered.
    """
    from ..runtime.protocol import ParsedResponse

    delivered = bool(transport_complete) and (
        finish_reason in {"stop", "end_turn"}
        or (finish_reason is None and complete_public_return)
    )
    text = raw if isinstance(raw, str) else ""
    valid = bool(text.strip()) and delivered
    return ParsedResponse(
        text,
        "COMPLETED" if valid else "INCOMPLETE",
        text,
        "NONE" if valid else "delivery",
        valid,
        delivered,
        () if valid else ("incomplete_lite_delivery",),
    )
