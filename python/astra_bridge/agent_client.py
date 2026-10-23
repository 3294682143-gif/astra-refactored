"""Thin Python Host model client for the unified AgentLoop preview.

One injected public client, one bounded synchronous call per request, one
private in-memory record per request. This module performs no mathematical
decision, no retry, no remote cancellation claim and no provider inspection:
it only captures the bound public ``chat`` callable once, validates the
request shape the Host already built, and normalizes the public response into
a fixed transport receipt.

Completeness rules (v4, overriding the older lossy-string contract):

* explicit ``stop``/``end_turn`` with legal text -> ``COMPLETE``;
* explicit ``length`` -> ``TRUNCATED``;
* explicit ``content_filter`` -> ``ERROR``;
* a bare string or an envelope without ``finish_reason`` -> ``UNKNOWN``
  completeness, which permanently blocks this adapter instance.

An unknown outcome is never retried and never becomes zero. A late result
never overwrites the fixed record and never clears ``blocked``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import time

from .p0_probe import ProbeError
from .p0_protocol import (
    LIMITS,
    ProtocolError,
    _object_pairs_hook,
    _parse_constant,
    _parse_float,
    _parse_int,
    _reject_surrogates,
    _scan_depth,
)

__all__ = ["AgentClient"]

_MAX_TOKENS = 8192
_TEMPERATURE = 0.2
_MAX_CONTEXT_BYTES = 65536
_MAX_TEXT_CHARS = 20000
_MAX_TEXT_BYTES = 65536
_SETTLE_SECONDS = 0.025
_MIN_REMAINING_MS = 25
_MAX_REMAINING_MS = 3600000
_REQUEST_IDS = tuple("model-" + str(n) for n in range(1, 257))
_PHASES = ("WORK", "CONSENSUS", "R2", "R4", "REPAIR", "R0", "R0_RECHECK")
_TRANSPORT = ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN")
_TERMINAL = ("stop", "end_turn", "length", "content_filter")
_USAGE_FIELDS = ("prompt_tokens", "completion_tokens", "total_tokens")
_HEX64 = frozenset("0123456789abcdef")
_LIFECYCLE = (
    "INTENT_RECORDED",
    "ADMITTED",
    "DISPATCHED",
    "LOCALLY_RETURNED",
    "REMOTE_TERMINAL_CONFIRMED",
    "OUTCOME_UNKNOWN",
)


def _fail(code="FIELD_VALUE"):
    raise ProbeError(code)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


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


def _utf8(value):
    try:
        return value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail()


def _hash64(value):
    if not isinstance(value, str) or len(value) != 64:
        _fail()
    for ch in value:
        if ch not in _HEX64:
            _fail()
    return value


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys) or len(value) != len(keys):
        _fail()


def _strict_text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not value.strip():
        _fail()
    length = _code_points(value)
    if length is None or length > max_chars:
        _fail()
    _utf8(value)
    return value


def _parse_inner(text):
    """Parse one inner JSON document with the shared P0 strict helpers only."""
    try:
        _scan_depth(text)
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs_hook,
            parse_int=_parse_int,
            parse_float=_parse_float,
            parse_constant=_parse_constant,
        )
        _reject_surrogates(value)
    except ProtocolError as exc:
        raise ProbeError(exc.code)
    except ProbeError:
        raise
    except Exception:
        _fail()
    return value


def _validate_request(request):
    """Validate the Host-built request shape; never a looser second parser."""
    _exact_keys(
        request,
        (
            "sessionId", "problemHash", "requestId", "phase", "taskId",
            "scopeId", "messages", "contextHash", "contextBytes",
            "remainingMs", "maxTokens",
        ),
    )
    _strict_text(request["sessionId"], 128)
    _hash64(request["problemHash"])
    request_id = request["requestId"]
    if request_id not in _REQUEST_IDS:
        _fail()
    if request["phase"] not in _PHASES:
        _fail()
    _strict_text(request["taskId"], 256)
    _hash64(request["scopeId"])
    messages = request["messages"]
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    for index, role in enumerate(("system", "user")):
        entry = messages[index]
        _exact_keys(entry, ("role", "content"))
        if entry["role"] != role:
            _fail()
        _strict_text(entry["content"], _MAX_CONTEXT_BYTES)
    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    encoded = _utf8(serialized)
    if len(encoded) > _MAX_CONTEXT_BYTES:
        _fail()
    if request["contextHash"] != hashlib.sha256(encoded).hexdigest():
        _fail()
    if not _is_int(request["contextBytes"]) or request["contextBytes"] != len(encoded):
        _fail()
    remaining_ms = request["remainingMs"]
    if not _is_int(remaining_ms) or not 1 <= remaining_ms <= _MAX_REMAINING_MS:
        _fail()
    if not _is_int(request["maxTokens"]) or request["maxTokens"] != _MAX_TOKENS:
        _fail()
    return request_id, copy.deepcopy(messages)


def _terminal_reason(choice):
    reason = choice.get("finish_reason")
    if reason in (None, ""):
        return None
    if not isinstance(reason, str) or reason not in _TERMINAL:
        _fail()
    return reason


def _public_choice(response):
    if not isinstance(response, dict):
        _fail()
    if response.get("error"):
        _fail()
    choices = response.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        _fail()
    choice = choices[0]
    if not isinstance(choice, dict):
        _fail()
    index = choice.get("index", 0)
    if not _is_int(index) or index != 0:
        _fail()
    return choice


def _usage(response):
    """Only publicly declared non-negative safe integers; missing stays None."""
    raw = response.get("usage")
    if not isinstance(raw, dict):
        return None
    usage = {}
    for key in _USAGE_FIELDS:
        value = raw.get(key)
        if _is_int(value) and 0 <= value <= LIMITS["maxSafeInteger"]:
            usage[key] = value
    return usage or None


def _normalize(response):
    """Map one public response to (transport, text, finish, usage, completeness)."""
    if isinstance(response, str):
        text = _strict_text(response, _MAX_TEXT_CHARS, allow_empty=True)
        return "UNKNOWN", text, None, None, "UNKNOWN"
    if not isinstance(response, dict):
        _fail()
    if response.get("error"):
        _fail()
    if "choices" in response:
        choice = _public_choice(response)
        finish = _terminal_reason(choice)
        message = choice.get("message")
        if not isinstance(message, dict):
            _fail()
        if message.get("role", "assistant") != "assistant":
            _fail()
        if message.get("tool_calls"):
            return "UNKNOWN", "", finish, None, "UNKNOWN"
        text = message.get("content")
        usage = _usage(response)
    else:
        message = response
        finish = _terminal_reason(message)
        if message.get("role", "assistant") != "assistant":
            _fail()
        if message.get("tool_calls"):
            return "UNKNOWN", "", finish, None, "UNKNOWN"
        text = message.get("content")
        usage = _usage(response)
    # The official provider may return a thinking-only reply with
    # ``content=null`` and an explicit ``finish_reason=length``.  Preserve that
    # terminal signal as TRUNCATED/ERROR instead of turning the whole call into
    # an unkeyed OUTCOME_UNKNOWN (the caller must still reject actions).
    if text is None:
        if finish == "length":
            return "TRUNCATED", "", finish, usage, "TRUNCATED"
        if finish == "content_filter":
            return "ERROR", "", finish, usage, "ERROR"
        return "UNKNOWN", "", finish, usage, "UNKNOWN"
    if not isinstance(text, str):
        _fail()
    if _code_points(text) is None:
        _fail()
    if finish is None:
        return "UNKNOWN", text, None, usage, "UNKNOWN"
    if finish == "length":
        return "TRUNCATED", text, finish, usage, "TRUNCATED"
    if finish == "content_filter":
        return "ERROR", text, finish, usage, "ERROR"
    return "COMPLETE", text, finish, usage, "COMPLETE"


def _bounded_text(text):
    """Return the text only when it is a legal bounded string, else ``None``."""
    if not isinstance(text, str):
        return None
    if _code_points(text) is None:
        return None
    if len(text) > _MAX_TEXT_CHARS:
        return None
    if len(_utf8(text)) > _MAX_TEXT_BYTES:
        return None
    return text


def _remaining_ms(deadline):
    """Real remaining milliseconds of the original deadline, clamped to 3600000."""
    left = int(max(0.0, deadline - time.monotonic()) * 1000)
    if left < 0:
        return 0
    if left > _MAX_REMAINING_MS:
        return _MAX_REMAINING_MS
    return left


class AgentClient:
    """One injected public client bound once, with a private request journal.

    ``generate`` is the only entry point. The adapter owns no global cap: the
    external Host admits requests and enforces the single root budget. This
    instance only counts the calls it actually dispatched, records one fixed
    lifecycle row per request, and permanently blocks itself after an unknown
    outcome so a later problem cannot wash the responsibility away.
    """

    def __init__(self, client):
        chat = getattr(client, "chat", None)
        if not callable(chat):
            _fail()
        self._chat = chat
        self._lock = threading.Lock()
        self.calls = 0
        self.blocked = False
        self.busy = False
        self.records = []

    # -- public surface ---------------------------------------------------

    def generate(self, request, deadline):
        """Dispatch at most one bounded public call for one Host request."""
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
            _fail()
        if deadline != deadline or deadline in (float("inf"), float("-inf")):
            _fail()
        captured = copy.deepcopy(request)
        request_id, messages = _validate_request(captured)
        session_id = captured["sessionId"]
        phase = captured["phase"]
        request_hash = captured["contextHash"]
        with self._lock:
            if self.blocked or self.busy:
                return self._record(
                    request_id, session_id, request_hash, phase, deadline,
                    "NOT_DISPATCHED", "UNKNOWN", None, None, "UNKNOWN", None,
                )
            if deadline - time.monotonic() <= _SETTLE_SECONDS:
                return self._record(
                    request_id, session_id, request_hash, phase, deadline,
                    "NOT_DISPATCHED", "UNKNOWN", None, None, "UNKNOWN", None,
                )
            self.busy = True
            self._record(
                request_id, session_id, request_hash, phase, deadline,
                "INTENT_RECORDED", None, None, None, None, None,
            )
            self._record(
                request_id, session_id, request_hash, phase, deadline,
                "ADMITTED", None, None, None, None, None,
            )
            self._record(
                request_id, session_id, request_hash, phase, deadline,
                "DISPATCHED", None, None, None, None, None,
            )
        box = {"done": False, "value": None, "error": False}
        event = threading.Event()

        def worker():
            try:
                with self._lock:
                    if self.blocked or time.monotonic() >= deadline - _SETTLE_SECONDS:
                        return
                    self.calls += 1
                box["value"] = self._chat(
                    messages=copy.deepcopy(messages),
                    temperature=_TEMPERATURE,
                    max_tokens=_MAX_TOKENS,
                )
            except BaseException:  # noqa: BLE001 - fixed code only, never text
                box["error"] = True
            finally:
                box["done"] = True
                event.set()

        thread = threading.Thread(target=worker, name="agent-public-call", daemon=True)
        try:
            thread.start()
        except RuntimeError:
            with self._lock:
                self.blocked = True
                self.busy = False
                return self._record(
                    request_id, session_id, request_hash, phase, deadline,
                    "OUTCOME_UNKNOWN", "UNKNOWN", None, None, "UNKNOWN", None,
                )
        try:
            wait = max(0.0, deadline - time.monotonic() - _SETTLE_SECONDS)
            if not event.wait(wait):
                with self._lock:
                    self.blocked = True
                    return self._record(
                        request_id, session_id, request_hash, phase, deadline,
                        "OUTCOME_UNKNOWN", "UNKNOWN", None, None, "UNKNOWN", None,
                    )
            if box["error"] or not box["done"]:
                with self._lock:
                    self.blocked = True
                    return self._record(
                        request_id, session_id, request_hash, phase, deadline,
                        "OUTCOME_UNKNOWN", "UNKNOWN", None, None, "UNKNOWN", None,
                    )
            try:
                transport, text, finish, usage, completeness = _normalize(box["value"])
                bounded = _bounded_text(text)
            except ProbeError:
                with self._lock:
                    self.blocked = True
                    return self._record(
                        request_id, session_id, request_hash, phase, deadline,
                        "OUTCOME_UNKNOWN", "UNKNOWN", None, None, "UNKNOWN", None,
                    )
            if bounded is None:
                with self._lock:
                    self.blocked = True
                    return self._record(
                        request_id, session_id, request_hash, phase, deadline,
                        "OUTCOME_UNKNOWN", "UNKNOWN", None, None, "UNKNOWN", None,
                    )
            text = bounded
            late = deadline - time.monotonic() <= _SETTLE_SECONDS
            with self._lock:
                if late and transport == "COMPLETE":
                    transport, completeness = "UNKNOWN", "UNKNOWN"
                if transport == "UNKNOWN":
                    self.blocked = True
                    return self._record(
                        request_id, session_id, request_hash, phase, deadline,
                        "OUTCOME_UNKNOWN", transport, text, finish, completeness, usage,
                    )
                self._record(
                    request_id, session_id, request_hash, phase, deadline,
                    "LOCALLY_RETURNED", transport, text, finish, completeness, usage,
                )
                return self._record(
                    request_id, session_id, request_hash, phase, deadline,
                    "REMOTE_TERMINAL_CONFIRMED", transport, text, finish, completeness, usage,
                )
        finally:
            with self._lock:
                self.busy = False

    def snapshot(self):
        """Deep copy of the private journal; no raw provider object escapes."""
        with self._lock:
            return copy.deepcopy(self.records)

    # -- private ----------------------------------------------------------

    def _record(self, request_id, session_id, request_hash, phase, deadline,
                state, transport, text, finish, completeness, usage):
        row = {
            "requestId": request_id,
            "sessionId": session_id,
            "requestHash": request_hash,
            "phase": phase,
            "state": state,
            "transportStatus": transport,
            "finishReason": finish,
            "usage": usage,
            "knownHttpAttempts": None,
            "completeness": completeness,
        }
        self.records.append(row)
        return {
            "transportStatus": transport if transport is not None else "UNKNOWN",
            "text": text if isinstance(text, str) else "",
            "remainingMs": _remaining_ms(deadline),
        }
