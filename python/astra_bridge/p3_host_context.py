"""P3 Host pure context/action validators (no I/O, no execution).

These helpers only parse and cross-check data the Host already holds. They
spawn nothing, read no path and call no client. Failures are the fixed code
FIELD_VALUE and never echo raw input.
"""

from __future__ import annotations

import copy
import hashlib
import json

from .p0_probe import ProbeError
from .p3_effect_contract import TOOL_NAMES, validate_request
from .p2_host_fixture import _parse_inner

__all__ = [
    "parse_action",
    "effect_key",
    "validate_receipts",
    "strict_context",
    "same_json",
]

_MAX_ACTION_CHARS = 20000
_MAX_ACTION_BYTES = 65536
_MAX_ANSWER_CHARS = 4096
_MAX_REASON_CHARS = 256
_MAX_UNRESOLVED = 32
_MAX_UNRESOLVED_CHARS = 256
_MAX_RECEIPTS = 3
_MAX_CONTEXT_BYTES = 65536
_DELIVERY_STATUS = ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN")
_CONTEXT_SCHEMA_VERSION = "p3-action-context-v2"
_PROMPT_VERSION = "p3-actions-v1"
_REQUEST_IDS = ("model-1", "model-2", "model-3")
_EFFECT_IDS = ("effect-1", "effect-2")
_ALLOWED_ACTION_IDS = ("PROPOSE_FINAL", "MARK_UNSOLVED", "CALL_REGISTERED_TOOL", "LOAD_METHOD")
_HEX64 = frozenset("0123456789abcdef")


def _fail():
    raise ProbeError("FIELD_VALUE")


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


def _text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not value.strip():
        _fail()
    length = _code_points(value)
    if length is None or length > max_chars:
        _fail()
    _utf8(value)
    return value


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys) or len(value) != len(keys):
        _fail()


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def same_json(left, right):
    """Byte-exact JSON identity; Python ``True == 1`` never collapses here."""
    try:
        a = json.dumps(
            left, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        )
        b = json.dumps(
            right, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()
    return a == b


def _hash64(value):
    if not isinstance(value, str) or len(value) != 64:
        _fail()
    for ch in value:
        if ch not in _HEX64:
            _fail()
    return value


def parse_action(text, binding):
    """Strict parse of one model action bound to the trusted control binding."""
    if not isinstance(text, str):
        _fail()
    length = _code_points(text)
    if length is None or length > _MAX_ACTION_CHARS:
        _fail()
    if len(_utf8(text)) > _MAX_ACTION_BYTES:
        _fail()
    value = _parse_inner(text)
    if not isinstance(value, dict):
        _fail()
    kind = value.get("action")
    if kind == "tool":
        _exact_keys(value, ("action", "name", "args", "scope"))
        if value["name"] not in TOOL_NAMES:
            _fail()
        request = validate_request(
            {
                "effectId": "effect-1",
                "binding": binding,
                "action": value,
                "remainingMs": 1000,
            }
        )
        return request["action"]
    if kind == "method":
        _exact_keys(value, ("action", "id"))
        request = validate_request(
            {
                "effectId": "effect-1",
                "binding": binding,
                "action": value,
                "remainingMs": 1000,
            }
        )
        return request["action"]
    if kind == "final":
        _exact_keys(value, ("action", "answer", "complete", "unresolved"))
        answer = _text(value["answer"], _MAX_ANSWER_CHARS)
        if not isinstance(value["complete"], bool):
            _fail()
        unresolved = value["unresolved"]
        if not isinstance(unresolved, list) or len(unresolved) > _MAX_UNRESOLVED:
            _fail()
        for item in unresolved:
            _text(item, _MAX_UNRESOLVED_CHARS)
        return {
            "action": "final",
            "answer": answer,
            "complete": value["complete"],
            "unresolved": list(unresolved),
        }
    if kind == "unsolved":
        _exact_keys(value, ("action", "reason"))
        return {"action": "unsolved", "reason": _text(value["reason"], _MAX_REASON_CHARS)}
    _fail()


def effect_key(action):
    """Host-side identity of one tool/method action.

    For a tool the scope wording is excluded; for a method the canonical id is
    the whole identity. The action is re-validated through the strict effect
    contract, so no looser parse is introduced here.
    """
    if not isinstance(action, dict):
        _fail()
    kind = action.get("action")
    if kind == "method":
        checked = validate_request(
            {
                "effectId": "effect-1",
                "binding": {
                    "sessionId": "s",
                    "problemHash": "0" * 64,
                    "contractVersion": 1,
                    "taskId": "t",
                    "scopeId": "0" * 64,
                    "sourceRequestId": "model-1",
                },
                "action": action,
                "remainingMs": 1000,
            }
        )
        identity = ["method", checked["action"]["id"]]
    elif kind == "tool":
        name = action.get("name")
        if name not in TOOL_NAMES:
            _fail()
        args = action.get("args")
        if not isinstance(args, dict):
            _fail()
        identity = [name, args]
    else:
        _fail()
    try:
        encoded = json.dumps(
            identity, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()
    return hashlib.sha256(_utf8(encoded)).hexdigest()


def validate_receipts(value):
    """Validate the Host-side model receipt list; never parses the action."""
    if not isinstance(value, list) or len(value) > _MAX_RECEIPTS:
        _fail()
    out = []
    for entry in value:
        _exact_keys(entry, ("deliveryStatus", "text"))
        if entry["deliveryStatus"] not in _DELIVERY_STATUS:
            _fail()
        text = _text(entry["text"], _MAX_ACTION_CHARS, allow_empty=True)
        if len(_utf8(text)) > _MAX_ACTION_BYTES:
            _fail()
        out.append({"deliveryStatus": entry["deliveryStatus"], "text": text})
    return copy.deepcopy(out)


def _check_task(task, params, session_id, problem_hash, version):
    _exact_keys(
        task,
        (
            "envelope", "taskId", "goalId", "obligationId", "scopeId",
            "inputArtifactRefs", "dependencyTaskIds", "expectedResult",
            "acceptanceCriteria", "delivery",
        ),
    )
    if task["taskId"] != params.get("taskId"):
        _fail()
    if task["scopeId"] != params.get("scopeId"):
        _fail()
    if task["delivery"] != "RUNNING":
        _fail()
    if not isinstance(task["goalId"], str) or not isinstance(task["obligationId"], str):
        _fail()
    if not isinstance(task["expectedResult"], str) or not isinstance(task["acceptanceCriteria"], str):
        _fail()
    if task["inputArtifactRefs"] != [] or task["dependencyTaskIds"] != []:
        _fail()
    envelope = task["envelope"]
    if not isinstance(envelope, dict):
        _fail()
    if envelope.get("sourceModule") != "M1":
        _fail()
    if envelope.get("taskId") != task["taskId"]:
        _fail()
    if envelope.get("sessionId") != session_id:
        _fail()
    if envelope.get("problemHash") != problem_hash:
        _fail()
    if not _is_int(envelope.get("contractVersion")) or envelope.get("contractVersion") != version:
        _fail()
    if envelope.get("scopeId") != task["scopeId"]:
        _fail()


def _check_obligations(obligations, task, session_id, problem_hash, version):
    if not isinstance(obligations, list) or not obligations:
        _fail()
    found = False
    for entry in obligations:
        _exact_keys(
            entry,
            ("envelope", "obligationId", "goalId", "kind", "status", "acceptance"),
        )
        if entry["status"] not in ("OPEN", "IN_PROGRESS"):
            _fail()
        if entry["acceptance"] is not None:
            _fail()
        envelope = entry["envelope"]
        if not isinstance(envelope, dict):
            _fail()
        if envelope.get("sourceModule") != "M1":
            _fail()
        if envelope.get("sessionId") != session_id:
            _fail()
        if envelope.get("problemHash") != problem_hash:
            _fail()
        if not _is_int(envelope.get("contractVersion")) or envelope.get("contractVersion") != version:
            _fail()
        if entry["obligationId"] == task["obligationId"]:
            if entry["kind"] not in ("CANDIDATE_VALIDITY", "ANSWER_REQUEST"):
                _fail()
            if entry["goalId"] != task["goalId"]:
                _fail()
            found = True
    if not found:
        _fail()


def _check_history(history, inner_history, ordinal):
    if not isinstance(history, list) or len(history) != ordinal - 1:
        _fail()
    mapped = []
    for index, entry in enumerate(history):
        _exact_keys(entry, ("requestId", "params", "receipt"))
        if entry["requestId"] != _REQUEST_IDS[index]:
            _fail()
        receipt = entry["receipt"]
        _exact_keys(receipt, ("deliveryStatus", "text"))
        if receipt["deliveryStatus"] != "COMPLETE":
            _fail()
        mapped.append(
            {
                "requestId": entry["requestId"],
                "transportStatus": receipt["deliveryStatus"],
                "text": receipt["text"],
            }
        )
    if not same_json(inner_history, mapped):
        _fail()


def _check_effects(effects, inner_effects):
    if not isinstance(effects, list) or len(effects) > 2:
        _fail()
    seen = set()
    for entry in effects:
        if not isinstance(entry, dict) or entry.get("effectId") not in _EFFECT_IDS:
            _fail()
        if entry["effectId"] in seen:
            _fail()
        seen.add(entry["effectId"])
        if entry.get("status") == "UNKNOWN":
            _fail()
    if not same_json(inner_effects, effects):
        _fail()


def _check_method_catalog(inner_catalog, host_catalog):
    if host_catalog is None:
        host_catalog = []
    if not isinstance(host_catalog, list):
        _fail()
    if not isinstance(inner_catalog, list):
        _fail()
    if len(inner_catalog) != len(host_catalog):
        _fail()
    for entry in host_catalog:
        _exact_keys(entry, ("id", "title"))
        _text(entry["id"], 64)
        _text(entry["title"], 256)
    if not same_json(inner_catalog, host_catalog):
        _fail()


def strict_context(params, problem, session_id, problem_hash, history, effects, anchor=None, allowed=None, method_catalog=None):
    """Validate the P3 model context against the Host request and its records."""
    messages = params.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    system, user = messages[0], messages[1]
    _exact_keys(system, ("role", "content"))
    _exact_keys(user, ("role", "content"))
    if system["role"] != "system" or user["role"] != "user":
        _fail()
    _text(system["content"], _MAX_CONTEXT_BYTES)
    _text(user["content"], _MAX_CONTEXT_BYTES)
    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    encoded = _utf8(serialized)
    if len(encoded) > _MAX_CONTEXT_BYTES:
        _fail()
    if params.get("contextHash") != hashlib.sha256(encoded).hexdigest():
        _fail()
    inner = _parse_inner(user["content"])
    if not isinstance(inner, dict):
        _fail()
    required = (
        "schemaVersion", "promptVersion", "task", "problemFullText",
        "problemHash", "sessionId", "contractVersion", "taskId", "scopeId",
        "scope", "obligations", "sourceRequestId", "allowedActionIds",
        "effects", "history", "methodCatalog",
    )
    if set(inner.keys()) != set(required):
        _fail()
    if inner["schemaVersion"] != _CONTEXT_SCHEMA_VERSION:
        _fail()
    if inner["promptVersion"] != _PROMPT_VERSION:
        _fail()
    if inner["problemFullText"] != problem:
        _fail()
    if inner["problemHash"] != problem_hash or params.get("problemHash") != problem_hash:
        _fail()
    if inner["sessionId"] != session_id:
        _fail()
    version = inner["contractVersion"]
    if not _is_int(version) or version != 1:
        _fail()
    if not _is_int(params.get("contractVersion")) or params.get("contractVersion") != 1:
        _fail()
    request_id = params.get("requestId")
    if request_id not in _REQUEST_IDS:
        _fail()
    if inner["sourceRequestId"] != request_id:
        _fail()
    ordinal = _REQUEST_IDS.index(request_id) + 1
    if inner["taskId"] != params.get("taskId"):
        _fail()
    if inner["scopeId"] != params.get("scopeId"):
        _fail()
    _hash64(inner["scopeId"])
    scope = inner["scope"]
    if not isinstance(scope, dict) or scope.get("scopeId") != inner["scopeId"]:
        _fail()
    _check_task(inner["task"], params, session_id, problem_hash, version)
    _check_obligations(inner["obligations"], inner["task"], session_id, problem_hash, version)
    allowed_ids = inner["allowedActionIds"]
    if not isinstance(allowed_ids, list) or not allowed_ids:
        _fail()
    seen = set()
    for entry in allowed_ids:
        if entry not in _ALLOWED_ACTION_IDS or entry in seen:
            _fail()
        seen.add(entry)
    if allowed is not None and allowed_ids != list(allowed):
        _fail()
    _check_history(history, inner["history"], ordinal)
    _check_effects(effects, inner["effects"])
    _check_method_catalog(inner["methodCatalog"], method_catalog)
    if anchor is not None:
        for key in ("task", "scope", "obligations", "methodCatalog"):
            if not same_json(inner[key], anchor[key]):
                _fail()
    return copy.deepcopy(inner)
