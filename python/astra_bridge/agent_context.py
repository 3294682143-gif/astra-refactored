"""Unified AgentLoop Host context helpers: candidate packet and input refs.

Reuses the shared P0 strict parser and the existing P2/P3 guards. No I/O, no
client call, no mathematical selection: a candidate packet is only the exact
source work packet the Host already returned, and an input reference must
resolve to a real earlier Host record.
"""

from __future__ import annotations

import copy
import hashlib
import json

from .agent_client import _validate_request
from .p0_probe import ProbeError
from .p2_host_fixture import _exact_keys, _parse_inner, _strict_utf8
from .p3_host_methods import checked_catalog
from .p3_host_context import same_json

__all__ = ["canonical_scope", "candidate_packet", "check_inputs", "validate_context"]

_MAX_REFS = 3
_MAX_TEXT_CHARS = 4096
_WORK_SCHEMA = "p2a-work-v1"
_PACKET_FIELDS = (
    "schemaVersion", "sessionId", "problemHash", "contractVersion", "taskId",
    "goalId", "scopeId", "routeId", "sourceRequestId", "claim", "derivation",
    "assumptions", "dependencies", "pendingObligations", "suggestedChecks",
    "deliveryStatus", "candidateProposal",
)
_ARTIFACT_FIELDS = (
    "envelope", "artifactId", "routeId", "scope", "dependencies",
    "sourceRequestId", "rawResponseHash", "rawResponseRef", "rawResponseText",
    "packet", "transportStatus", "deliveryStatus", "level", "checkResult",
    "provisionalDependency",
)
_SCOPE_FIELDS = (
    "scopeId", "domain", "variableBindings", "quantifiers", "localAssumptions",
    "branchConditions", "referenceablePremises",
)
_CANDIDATE_KINDS = ("CANDIDATE_VALIDITY", "ANSWER_REQUEST")
_CONTEXT_SCHEMA_VERSION = "agent-work-context-v2"
_PROMPT_VERSION = "p2-workunit-v1"
_R2_SCHEMA_VERSION = "p4-r2-context-v1"
_TASK_FIELDS = (
    "envelope", "taskId", "goalId", "obligationId", "scopeId",
    "inputArtifactRefs", "dependencyTaskIds", "expectedResult",
    "acceptanceCriteria", "delivery",
)
_R2_FIELDS = (
    "schemaVersion", "stage", "requestId", "target", "targetHash",
    "problemFullText", "scope", "obligations", "claim", "derivation",
    "assumptions",
)
_TARGET_FIELDS = (
    "sessionId", "problemHash", "contractVersion", "artifactId",
    "artifactVersion", "taskId", "goalId", "scopeId", "sourceRequestId",
)


def _fail():
    raise ProbeError("FIELD_VALUE")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not value.strip():
        _fail()
    if len(value) > max_chars:
        _fail()
    _strict_utf8(value)
    return value


def _hash64(value):
    if not isinstance(value, str) or len(value) != 64:
        _fail()
    for ch in value:
        if ch not in "0123456789abcdef":
            _fail()
    return value


def canonical_scope(scope):
    """Canonical scope hash: JSON array, bindings sorted by UTF-16 bytes.

    The second element is a JSON object, not a list of pairs: the real default
    scope canonicalizes to ``["UNKNOWN",{},[],[],[],[]]``. Insertion order is
    the UTF-16 byte order of the keys, so the serialized bytes are stable.
    """
    if not isinstance(scope, dict):
        _fail()
    _exact_keys(scope, _SCOPE_FIELDS)
    bindings = scope["variableBindings"]
    if not isinstance(bindings, dict):
        _fail()
    ordered = {}
    for key in sorted(bindings.keys(), key=lambda name: name.encode("utf-16-be")):
        ordered[key] = _text(bindings[key], _MAX_TEXT_CHARS, allow_empty=True)
    parts = [scope["domain"]]
    for name in ("quantifiers", "localAssumptions", "branchConditions", "referenceablePremises"):
        value = scope[name]
        if not isinstance(value, list):
            _fail()
        parts.append([_text(item, _MAX_TEXT_CHARS, allow_empty=True) for item in value])
    payload = [parts[0], ordered, parts[1], parts[2], parts[3], parts[4]]
    try:
        encoded = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()
    return hashlib.sha256(encoded).hexdigest()


def _source_body(entry):
    """Strict parse of the source WORK body; returns (request, receipt, body)."""
    if not isinstance(entry, dict):
        _fail()
    _exact_keys(entry, ("request", "receipt"))
    request = entry["request"]
    receipt = entry["receipt"]
    if not isinstance(receipt, dict):
        _fail()
    keys = set(receipt.keys())
    if not {"transportStatus", "text"} <= keys:
        _fail()
    if not keys <= {"transportStatus", "text", "remainingMs"}:
        _fail()
    if receipt["transportStatus"] != "COMPLETE":
        _fail()
    request_id, messages = _validate_request(copy.deepcopy(request))
    if request["phase"] != "WORK":
        _fail()
    body = _parse_inner(messages[1]["content"])
    if not isinstance(body, dict):
        _fail()
    return request_id, request, receipt, body


def candidate_packet(history, request_id, problem, session_id, problem_hash):
    """Return the exact source work packet, or None when it is not a candidate.

    The packet is the strict parse of the Host-returned receipt text, not a
    field of the work context. Every guard is a rejection, never a repair.
    """
    try:
        if not isinstance(history, dict):
            return None
        entry = history.get(request_id)
        if entry is None:
            return None
        source_id, request, receipt, body = _source_body(entry)
        if source_id != request_id:
            return None
        if request["sessionId"] != session_id or request["problemHash"] != problem_hash:
            return None
        if body.get("schemaVersion") != _CONTEXT_SCHEMA_VERSION:
            return None
        if body.get("problemFullText") != problem:
            return None
        packet = _parse_inner(receipt["text"])
        if not isinstance(packet, dict):
            return None
        _exact_keys(packet, _PACKET_FIELDS)
        if packet["schemaVersion"] != _WORK_SCHEMA:
            return None
        if packet["sessionId"] != session_id or packet["problemHash"] != problem_hash:
            return None
        if not _is_int(packet["contractVersion"]) or packet["contractVersion"] != 1:
            return None
        if packet["sourceRequestId"] != request_id:
            return None
        if packet["deliveryStatus"] != "COMPLETE":
            return None
        if packet["dependencies"] != []:
            return None
        task = body.get("task")
        scope = body.get("scope")
        route = body.get("route")
        if not isinstance(task, dict) or not isinstance(scope, dict) or not isinstance(route, dict):
            return None
        if packet["taskId"] != task.get("taskId") or packet["goalId"] != task.get("goalId"):
            return None
        if packet["scopeId"] != scope.get("scopeId") or packet["routeId"] != route.get("routeId"):
            return None
        if canonical_scope(scope) != packet["scopeId"]:
            return None
        assumptions = packet["assumptions"]
        if not isinstance(assumptions, list):
            return None
        allowed = scope.get("localAssumptions")
        if not isinstance(allowed, list):
            return None
        for item in assumptions:
            _text(item, _MAX_TEXT_CHARS, allow_empty=True)
            if item not in allowed:
                return None
        _text(packet["claim"], _MAX_TEXT_CHARS)
        _text(packet["derivation"], _MAX_TEXT_CHARS)
        candidate = packet["candidateProposal"]
        if not isinstance(candidate, str) or not candidate.strip():
            return None
        _text(candidate, _MAX_TEXT_CHARS)
        obligations = body.get("obligations")
        if not isinstance(obligations, list):
            return None
        for entry_row in obligations:
            if not isinstance(entry_row, dict):
                return None
            if entry_row.get("obligationId") != task.get("obligationId"):
                continue
            if entry_row.get("kind") in _CANDIDATE_KINDS:
                return copy.deepcopy(packet)
            return None
        return None
    except ProbeError:
        return None
    except Exception:  # noqa: BLE001 - a malformed record is not a candidate
        return None


def check_inputs(inner, history, current_request_id):
    """Check declared input artifacts against the trusted Host history."""
    if not isinstance(inner, dict) or not isinstance(history, dict):
        _fail()
    task = inner.get("task")
    scope = inner.get("scope")
    route = inner.get("route")
    if not isinstance(task, dict) or not isinstance(scope, dict) or not isinstance(route, dict):
        _fail()
    refs = task.get("inputArtifactRefs")
    artifacts = inner.get("inputArtifacts")
    dependencies = task.get("dependencyTaskIds")
    if not isinstance(refs, list) or not isinstance(artifacts, list):
        _fail()
    if not isinstance(dependencies, list) or len(refs) != len(artifacts) or len(refs) > _MAX_REFS:
        _fail()
    current_ordinal = _ordinal(current_request_id)
    seen = set()
    for index, ref in enumerate(refs):
        _exact_keys(ref, ("artifactId", "artifactVersion"))
        artifact_id = _text(ref["artifactId"], 256)
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
            _fail()
        if artifact_id in seen:
            _fail()
        seen.add(artifact_id)
        artifact = artifacts[index]
        _exact_keys(artifact, _ARTIFACT_FIELDS)
        if artifact["artifactId"] != artifact_id:
            _fail()
        source_id = artifact["sourceRequestId"]
        if not isinstance(source_id, str) or source_id not in history:
            _fail()
        if _ordinal(source_id) >= current_ordinal:
            _fail()
        source_id, request, receipt, body = _source_body(history[source_id])
        if request["sessionId"] != inner["sessionId"] or request["problemHash"] != inner["problemHash"]:
            _fail()
        source_task = body.get("task")
        source_scope = body.get("scope")
        source_route = body.get("route")
        if not isinstance(source_task, dict) or not isinstance(source_scope, dict):
            _fail()
        if not isinstance(source_route, dict):
            _fail()
        if source_task.get("taskId") not in dependencies:
            _fail()
        if source_route.get("routeId") != route.get("routeId"):
            _fail()
        if not same_json(source_scope, scope):
            _fail()
        if artifact["routeId"] != route.get("routeId"):
            _fail()
        if not same_json(artifact["scope"], scope):
            _fail()
        if artifact["rawResponseRef"] != f"{inner['sessionId']}:raw:{source_id}":
            _fail()
        if artifact["transportStatus"] != "COMPLETE" or artifact["deliveryStatus"] != "COMPLETE":
            _fail()
        if artifact["level"] != "PROVISIONAL" or artifact["checkResult"] != "UNKNOWN":
            _fail()
        if artifact["dependencies"] != source_task.get("inputArtifactRefs"):
            _fail()
        if not isinstance(artifact["provisionalDependency"], bool):
            _fail()
        if artifact["provisionalDependency"] is not bool(source_task.get("inputArtifactRefs")):
            _fail()
        if artifact["rawResponseText"] != receipt["text"]:
            _fail()
        digest = hashlib.sha256(receipt["text"].encode("utf-8")).hexdigest()
        if artifact["rawResponseHash"] != digest:
            _fail()
        source_packet = _parse_inner(receipt["text"])
        if not same_json(artifact["packet"], source_packet):
            _fail()
        if not isinstance(source_packet, dict):
            _fail()
        if source_packet.get("sourceRequestId") != source_id:
            _fail()
        if source_packet.get("sessionId") != inner["sessionId"]:
            _fail()
        if source_packet.get("problemHash") != inner["problemHash"]:
            _fail()
        if not _is_int(source_packet.get("contractVersion")) or source_packet["contractVersion"] != 1:
            _fail()
        if source_packet.get("taskId") != source_task.get("taskId"):
            _fail()
        if source_packet.get("goalId") != source_task.get("goalId"):
            _fail()
        if source_packet.get("scopeId") != scope.get("scopeId"):
            _fail()
        if source_packet.get("routeId") != route.get("routeId"):
            _fail()
        if source_packet.get("deliveryStatus") != "COMPLETE":
            _fail()
        envelope = artifact["envelope"]
        if not isinstance(envelope, dict):
            _fail()
        if envelope.get("sourceModule") != "M3" or envelope.get("artifactId") != artifact_id:
            _fail()
        if envelope.get("sessionId") != inner["sessionId"]:
            _fail()
        if envelope.get("problemHash") != inner["problemHash"]:
            _fail()
        if envelope.get("taskId") != source_task.get("taskId"):
            _fail()
        if envelope.get("scopeId") != scope.get("scopeId"):
            _fail()
        if not _is_int(envelope.get("artifactVersion")) or envelope["artifactVersion"] != 1:
            _fail()
        if not _is_int(envelope.get("contractVersion")) or envelope["contractVersion"] != 1:
            _fail()
    return None


def _ordinal(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in ("1", "2", "3", "4"):
        _fail()
    return int(suffix)


def _check_work(body, request_id, problem, session_id, problem_hash, history, effects,
                catalog=None, method_assets=None):
    """Validate one WORK context body against the Host request and records."""
    keys = set(body.keys())
    required = (
        "schemaVersion", "promptVersion", "problemFullText", "problemHash",
        "sessionId", "contractVersion", "task", "scope", "obligations",
        "route", "sourceRequestId", "inputArtifacts", "methodAssets",
        "allowTools", "allowMethods", "toolObservations",
    )
    if not set(required) <= keys or not keys <= set(required) | {"methodCatalog"}:
        _fail()
    if body["schemaVersion"] != _CONTEXT_SCHEMA_VERSION:
        _fail()
    if body["promptVersion"] != _PROMPT_VERSION:
        _fail()
    if body["problemFullText"] != problem:
        _fail()
    if body["problemHash"] != problem_hash or body["sessionId"] != session_id:
        _fail()
    if not _is_int(body["contractVersion"]) or body["contractVersion"] != 1:
        _fail()
    if body["sourceRequestId"] != request_id:
        _fail()
    task = body["task"]
    _exact_keys(task, _TASK_FIELDS)
    if task["delivery"] != "RUNNING":
        _fail()
    if not isinstance(task["goalId"], str) or not isinstance(task["obligationId"], str):
        _fail()
    if not isinstance(task["expectedResult"], str) or not isinstance(task["acceptanceCriteria"], str):
        _fail()
    if not isinstance(task["inputArtifactRefs"], list) or not isinstance(task["dependencyTaskIds"], list):
        _fail()
    envelope = task["envelope"]
    if not isinstance(envelope, dict):
        _fail()
    if envelope.get("sourceModule") != "M1":
        _fail()
    if envelope.get("sessionId") != session_id or envelope.get("problemHash") != problem_hash:
        _fail()
    if envelope.get("taskId") != task["taskId"] or envelope.get("scopeId") != task["scopeId"]:
        _fail()
    if not _is_int(envelope.get("contractVersion")) or envelope["contractVersion"] != 1:
        _fail()
    scope = body["scope"]
    if not isinstance(scope, dict) or scope.get("scopeId") != task["scopeId"]:
        _fail()
    if canonical_scope(scope) != scope["scopeId"]:
        _fail()
    obligations = body["obligations"]
    if not isinstance(obligations, list) or not obligations:
        _fail()
    found = False
    for row in obligations:
        if not isinstance(row, dict):
            _fail()
        if row.get("obligationId") != task["obligationId"]:
            continue
        if row.get("goalId") != task["goalId"]:
            _fail()
        row_envelope = row.get("envelope")
        if not isinstance(row_envelope, dict):
            _fail()
        if row_envelope.get("scopeId") != task["scopeId"]:
            _fail()
        if row_envelope.get("taskId") != task["taskId"]:
            _fail()
        found = True
    if not found:
        _fail()
    entries = [] if catalog is None else checked_catalog(catalog)["entries"]
    if "methodCatalog" not in body:
        _fail()
    if not same_json(body["methodCatalog"], entries):
        _fail()
    assets = [] if method_assets is None else method_assets
    if not same_json(body["methodAssets"], assets):
        _fail()
    if not isinstance(body["allowTools"], bool):
        _fail()
    if not isinstance(body["allowMethods"], bool):
        _fail()
    if body["allowMethods"] and catalog is None:
        _fail()
    if body["allowMethods"] and not entries:
        _fail()
    check_inputs(body, history, request_id)
    expected = [
        entry["receipt"]
        for entry in effects
        if isinstance(entry, dict)
        and isinstance(entry.get("request"), dict)
        and isinstance(entry["request"].get("binding"), dict)
        and entry["request"]["binding"].get("taskId") == task["taskId"]
    ]
    if not same_json(body["toolObservations"], expected):
        _fail()


def _check_r2(body, request_id, problem, session_id, problem_hash, history):
    """Validate one R2 context body against the real candidate packet."""
    _exact_keys(body, _R2_FIELDS)
    if body["schemaVersion"] != _R2_SCHEMA_VERSION:
        _fail()
    if body["stage"] != "R2" or body["requestId"] != request_id:
        _fail()
    if body["problemFullText"] != problem:
        _fail()
    target = body["target"]
    _exact_keys(target, _TARGET_FIELDS)
    if target["sessionId"] != session_id or target["problemHash"] != problem_hash:
        _fail()
    if not _is_int(target["contractVersion"]) or target["contractVersion"] != 1:
        _fail()
    if not _is_int(target["artifactVersion"]) or target["artifactVersion"] != 1:
        _fail()
    source_id = target["sourceRequestId"]
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    packet = candidate_packet(history, source_id, problem, session_id, problem_hash)
    if packet is None:
        _fail()
    if target["taskId"] != packet["taskId"] or target["goalId"] != packet["goalId"]:
        _fail()
    if target["scopeId"] != packet["scopeId"]:
        _fail()
    entry = history.get(source_id)
    source_body = _parse_inner(entry["request"]["messages"][1]["content"])
    source_scope = source_body.get("scope")
    if not isinstance(source_scope, dict):
        _fail()
    if not same_json(body["scope"], source_scope):
        _fail()
    if body["claim"] != packet["claim"] or body["derivation"] != packet["derivation"]:
        _fail()
    if not same_json(body["assumptions"], packet["assumptions"]):
        _fail()
    _hash64(body["targetHash"])
    # The target hash is recomputed from the real source history: the ordered
    # binding rebuilt in the manifest field order plus the sha256 of the exact
    # raw receipt text. A Node-supplied hash is never trusted on its own.
    ordered = {}
    for name in _TARGET_FIELDS:
        ordered[name] = target[name]
    raw_text = entry["receipt"]["text"]
    if not isinstance(raw_text, str):
        _fail()
    raw_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    try:
        payload = json.dumps(
            [ordered, raw_hash], ensure_ascii=False, separators=(",", ":"),
            allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()
    if body["targetHash"] != hashlib.sha256(payload.encode("utf-8")).hexdigest():
        _fail()
    source_obligations = source_body.get("obligations")
    if not isinstance(source_obligations, list):
        _fail()
    expected = []
    for row in source_obligations:
        if not isinstance(row, dict):
            _fail()
        if row.get("goalId") != target["goalId"]:
            continue
        row_envelope = row.get("envelope")
        if not isinstance(row_envelope, dict):
            _fail()
        if row_envelope.get("scopeId") != target["scopeId"]:
            continue
        expected.append({"obligationId": row.get("obligationId"), "kind": row.get("kind")})
    if not same_json(body["obligations"], expected):
        _fail()


def validate_context(request, problem, session_id, problem_hash, history, effects,
                     catalog=None, method_assets=None):
    """Validate one Host-built model request against its own records.

    The outer request shape, message bytes and context hash are checked by
    ``_validate_request``; this function only reconciles the inner context with
    the trusted Host history. It performs no mathematical decision.
    """
    request_id, messages = _validate_request(copy.deepcopy(request))
    if request["sessionId"] != session_id or request["problemHash"] != problem_hash:
        _fail()
    body = _parse_inner(messages[1]["content"])
    if not isinstance(body, dict):
        _fail()
    if body.get("problemFullText") != problem:
        _fail()
    if request["phase"] == "WORK":
        task = body.get("task")
        if not isinstance(task, dict):
            _fail()
        if task.get("taskId") != request["taskId"] or task.get("scopeId") != request["scopeId"]:
            _fail()
        _check_work(
            body, request_id, problem, session_id, problem_hash, history, effects,
            catalog, method_assets,
        )
    elif request["phase"] == "R2":
        target = body.get("target")
        if not isinstance(target, dict):
            _fail()
        if target.get("taskId") != request["taskId"] or target.get("scopeId") != request["scopeId"]:
            _fail()
        _check_r2(body, request_id, problem, session_id, problem_hash, history)
    else:
        _fail()
    return copy.deepcopy(body)
