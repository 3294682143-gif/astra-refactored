"""Fixture-only P2 Host context validator and pure in-memory model client.

No network, no thread, no tool, no real provider. The only model source is a
pure data fixture; every failure is the fixed code FIELD_VALUE and never echoes
raw input.
"""

from __future__ import annotations

import hashlib
import json

from .p0_protocol import (
    ProtocolError,
    _object_pairs_hook,
    _parse_constant,
    _parse_float,
    _parse_int,
    _reject_surrogates,
    _scan_depth,
)
from .p0_probe import ProbeError

__all__ = ["strict_context", "OfflineP2Client"]

_MAX_CONTEXT_BYTES = 65536
_MAX_REPLY_CHARS = 4096
_MAX_CATALOG_ITEMS = 20
_DELIVERY_STATUS = ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN")
_CONTEXT_SCHEMA_VERSION = "p2-fixture-context-v1"
_PROMPT_VERSION = "p2-workunit-v1"
_REQUEST_ID = "model-1"
_ROUTE_ID = "route-1"


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


def _strict_utf8(value):
    try:
        return value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail()


def _canonical(messages):
    return json.dumps(messages, ensure_ascii=False, separators=(",", ":"))


def _parse_inner(text):
    """Parse the inner user JSON with the shared P0 strict helpers only."""
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
    except Exception:
        _fail()
    return value


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys):
        _fail()


def strict_context(messages, params, problem, session_id, problem_hash, allowed_asset=None):
    """Validate the two-message fixture context against the Host request.

    The inner user JSON is parsed with the shared P0 strict helpers; the
    problem text, method bodies and artifacts stay untrusted data. A method
    asset is accepted only when it deep-equals the Host-side allowed asset.
    """
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    system, user = messages[0], messages[1]
    _exact_keys(system, ("role", "content"))
    _exact_keys(user, ("role", "content"))
    if system["role"] != "system" or user["role"] != "user":
        _fail()
    if not isinstance(system["content"], str) or not isinstance(user["content"], str):
        _fail()
    if not system["content"] or not user["content"]:
        _fail()
    _strict_utf8(system["content"])
    _strict_utf8(user["content"])
    serialized = _strict_utf8(_canonical(messages))
    if len(serialized) > _MAX_CONTEXT_BYTES:
        _fail()
    digest = hashlib.sha256(serialized).hexdigest()
    if params.get("contextHash") != digest:
        _fail()
    inner = _parse_inner(user["content"])
    required = (
        "schemaVersion",
        "promptVersion",
        "problemFullText",
        "problemHash",
        "sessionId",
        "contractVersion",
        "obligations",
        "sourceRequestId",
        "task",
        "route",
        "scope",
        "inputArtifacts",
        "methodAssets",
    )
    if not isinstance(inner, dict):
        _fail()
    keys = set(inner.keys())
    if not set(required) <= keys or not keys <= set(required) | {"methodCatalog"}:
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
    if isinstance(version, bool) or not isinstance(version, int) or version != 1:
        _fail()
    if params.get("contractVersion") != 1:
        _fail()
    if inner["sourceRequestId"] != _REQUEST_ID:
        _fail()
    task = inner["task"]
    _exact_keys(
        task,
        (
            "envelope",
            "taskId",
            "goalId",
            "obligationId",
            "scopeId",
            "inputArtifactRefs",
            "dependencyTaskIds",
            "expectedResult",
            "acceptanceCriteria",
            "delivery",
        ),
    )
    if task["taskId"] != params.get("taskId"):
        _fail()
    if task["scopeId"] != params.get("scopeId"):
        _fail()
    if task["delivery"] != "RUNNING":
        _fail()
    if not isinstance(task["inputArtifactRefs"], list) or task["inputArtifactRefs"]:
        _fail()
    if not isinstance(task["dependencyTaskIds"], list):
        _fail()
    if not isinstance(task["expectedResult"], str) or not isinstance(task["acceptanceCriteria"], str):
        _fail()
    if not isinstance(task["goalId"], str) or not isinstance(task["obligationId"], str):
        _fail()
    envelope = task["envelope"]
    if not isinstance(envelope, dict):
        _fail()
    if envelope.get("sessionId") != session_id:
        _fail()
    if envelope.get("problemHash") != problem_hash:
        _fail()
    if envelope.get("contractVersion") != version:
        _fail()
    if envelope.get("scopeId") != task["scopeId"]:
        _fail()
    route = inner["route"]
    _exact_keys(route, ("routeId", "representation", "operation", "lemmas", "construction", "signature"))
    if route["routeId"] != _ROUTE_ID:
        _fail()
    for key in ("representation", "operation", "construction", "signature"):
        if not isinstance(route[key], str):
            _fail()
    if not isinstance(route["lemmas"], list):
        _fail()
    scope = inner["scope"]
    if not isinstance(scope, dict) or scope.get("scopeId") != params.get("scopeId"):
        _fail()
    if scope.get("scopeId") != task["scopeId"]:
        _fail()
    if scope.get("scopeId") != envelope.get("scopeId"):
        _fail()
    if not isinstance(inner["inputArtifacts"], list) or inner["inputArtifacts"]:
        _fail()
    if not isinstance(inner["obligations"], list):
        _fail()
    catalog = inner.get("methodCatalog", [])
    if not isinstance(catalog, list) or len(catalog) > _MAX_CATALOG_ITEMS:
        _fail()
    for entry in catalog:
        _exact_keys(entry, ("id", "title"))
        if not isinstance(entry["id"], str) or not isinstance(entry["title"], str):
            _fail()
    assets = inner["methodAssets"]
    if not isinstance(assets, list) or len(assets) > 1:
        _fail()
    if assets:
        asset = assets[0]
        _exact_keys(asset, ("id", "title", "version", "body", "bodySha256", "bodyChars"))
        if allowed_asset is None or asset != allowed_asset:
            _fail()
        body = asset["body"]
        if not isinstance(body, str) or not body:
            _fail()
        if hashlib.sha256(body.encode("utf-8")).hexdigest() != asset["bodySha256"]:
            _fail()
        if asset["bodyChars"] != len(body):
            _fail()
    return inner


class OfflineP2Client:
    """Pure data fixture client. No sleep, no network, no thread, no tool."""

    def __init__(self, reply, delivery_status="COMPLETE"):
        if not isinstance(reply, str):
            _fail()
        length = _code_points(reply)
        if length is None or length > _MAX_REPLY_CHARS:
            _fail()
        _strict_utf8(reply)
        if delivery_status not in _DELIVERY_STATUS:
            _fail()
        self._reply = reply
        self._delivery_status = delivery_status
        self.calls = 0

    @property
    def delivery_status(self):
        return self._delivery_status

    @property
    def reply(self):
        return self._reply

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        if self.calls >= 1:
            _fail()
        if not isinstance(messages, list) or len(messages) != 2:
            _fail()
        user = messages[1]
        if not isinstance(user, dict) or not isinstance(user.get("content"), str):
            _fail()
        inner = _parse_inner(user["content"])
        task = inner.get("task")
        route = inner.get("route")
        scope = inner.get("scope")
        if not isinstance(task, dict) or not isinstance(route, dict) or not isinstance(scope, dict):
            _fail()
        candidate = self._reply
        packet = {
            "schemaVersion": "p2a-work-v1",
            "sessionId": inner.get("sessionId"),
            "problemHash": inner.get("problemHash"),
            "contractVersion": inner.get("contractVersion"),
            "taskId": task.get("taskId"),
            "goalId": task.get("goalId"),
            "scopeId": task.get("scopeId"),
            "routeId": route.get("routeId"),
            "sourceRequestId": inner.get("sourceRequestId"),
            "claim": "Offline fixture claim",
            "derivation": "Synthetic fixture, not a proof",
            "assumptions": [],
            "dependencies": [],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": candidate if candidate.strip() else None,
        }
        self.calls += 1
        return {
            "text": json.dumps(packet, ensure_ascii=False, separators=(",", ":")),
            "deliveryStatus": self._delivery_status,
        }
