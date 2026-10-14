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
from .agent_workflow import (
    check_dependency_provenance,
    check_route_provenance,
    checked_packet,
)
from .agent_history import check_revision_context
from .agent_history import artifact_view, project_artifacts
from .agent_progress import PROGRESS_POLICY
from .text_contract import js_nonempty

__all__ = [
    "canonical_scope",
    "candidate_packet",
    "check_inputs",
    "validate_context",
    "validate_legacy_context",
]

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
_CONTEXT_SCHEMA_VERSION = "agent-work-context-v4"
_ACTIVE_CONTEXT_SCHEMA_VERSION = "agent-work-context-v7"
_DEPENDENCY_CONTEXT_SCHEMA_VERSION = "agent-work-context-v5"
_REVISION_CONTEXT_SCHEMA_VERSION = "agent-work-context-v6"
_PROGRESS_CONTEXT_SCHEMA_VERSION = "agent-work-context-v7"
_FINAL_CONTEXT_SCHEMA_VERSION = "agent-work-context-v3"
_LEGACY_CONTEXT_SCHEMA_VERSION = "agent-work-context-v2"
_PROMPT_VERSION = "p2-workunit-v1"
_R2_SCHEMA_VERSION = "p4-r2-context-v1"
_REPAIR_SCHEMA_VERSION = "p4-repair-context-v1"
_REPAIR_FIELDS = (
    "schemaVersion", "stage", "requestId", "sessionId", "problemHash",
    "contractVersion", "problemFullText", "task", "route", "sourceRequestId",
    "answerObligationId", "challenge", "parentCandidate",
)
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
_DEPENDENCY_PROVENANCE_FIELDS = (
    "sourceRequestId", "sourceArtifactRef", "obligationId", "routeSignature",
)
_SCOPE_COVERAGE_FIELDS = (
    "quantifiers", "branchConditions", "boundaryCases", "goalExhaustion",
    "coverageHash",
)
_TASK_SCOPE_COVERAGE_FIELDS = ("taskId", "scopeId", "coverage")
_MAX_COVERAGE_ITEMS = 32
_MAX_COVERAGE_CHARS = 256

# B1 (DECISION-0150): the Host accepts both contract versions. A default run
# compiles ``contractVersion`` 1 and stays 100% byte-identical; an explicit,
# bounded R0 planning revision may raise it to 2 exactly once via M1
# ``reviseGoals``. The version referenced inside one round must still agree,
# which the existing ``same_json`` projections already enforce.
_ACCEPTED_CONTRACT_VERSIONS = (1, 2)


def _contract_version_ok(value):
    return _is_int(value) and value in _ACCEPTED_CONTRACT_VERSIONS

def _is_hash64(value):
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(char in "0123456789abcdef" for char in value)
    )


def _fail():
    raise ProbeError("FIELD_VALUE")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not js_nonempty(value):
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


def _coverage_item(value):
    if not isinstance(value, str):
        _fail()
    if not js_nonempty(value):
        _fail()
    if len(value) > _MAX_COVERAGE_CHARS:
        _fail()
    _strict_utf8(value)
    return value


def _coverage_list(value):
    if not isinstance(value, list) or len(value) > _MAX_COVERAGE_ITEMS:
        _fail()
    seen = set()
    out = []
    for item in value:
        text = _coverage_item(item)
        if text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _scope_coverage(value):
    """Re-check one declared coverage record; the hash must be self-consistent."""
    _exact_keys(value, _SCOPE_COVERAGE_FIELDS)
    quantifiers = _coverage_list(value["quantifiers"])
    branch_conditions = _coverage_list(value["branchConditions"])
    boundary_cases = _coverage_list(value["boundaryCases"])
    goal_exhaustion = _coverage_list(value["goalExhaustion"])
    payload = [quantifiers, branch_conditions, boundary_cases, goal_exhaustion]
    try:
        encoded = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()
    expected = hashlib.sha256(encoded).hexdigest()
    if value["coverageHash"] != expected:
        _fail()
    return {
        "quantifiers": quantifiers,
        "branchConditions": branch_conditions,
        "boundaryCases": boundary_cases,
        "goalExhaustion": goal_exhaustion,
        "coverageHash": expected,
    }


def _check_scope_coverage(body, task):
    """Optional declared coverage rows; absent means empty, never a failure.

    A row may be the current task's own declaration or the declaration of one of
    the task's declared upstream tasks (the tasks it consumes). Each row is
    re-checked by the shared guard and stays declared data: it never closes an
    obligation, never changes the ready set and is never a coverage proof.
    """
    if "scopeCoverage" not in body:
        return
    rows = body["scopeCoverage"]
    if not isinstance(rows, list) or len(rows) > _MAX_COVERAGE_ITEMS:
        _fail()
    upstream = task.get("dependencyTaskIds")
    if not isinstance(upstream, list):
        _fail()
    allowed = set(upstream)
    for row in rows:
        _exact_keys(row, _TASK_SCOPE_COVERAGE_FIELDS)
        task_id = _text(row["taskId"], 256)
        scope_id = _hash64(row["scopeId"])
        coverage = _scope_coverage(row["coverage"])
        if task_id != task["taskId"] and task_id not in allowed:
            _fail()
        if scope_id != task["scopeId"]:
            _fail()
        if not same_json(row["coverage"], coverage):
            _fail()


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


def candidate_packet(history, request_id, problem, session_id, problem_hash,
                     source_schema=_ACTIVE_CONTEXT_SCHEMA_VERSION):
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
        if not isinstance(entry, dict):
            return None
        request = entry.get("request")
        receipt = entry.get("receipt")
        if not isinstance(request, dict) or not isinstance(receipt, dict):
            return None
        try:
            source_id, messages = _validate_request(copy.deepcopy(request))
        except ProbeError:
            return None
        if source_id != request_id:
            return None
        # The revised candidate (G3/PR4) comes from a REPAIR request; the
        # ordinary candidate from a WORK request. `_validate_request` already
        # accepted the phase, so only these two shapes reach the packet check.
        if request.get("phase") not in ("WORK", "REPAIR"):
            return None
        body = _parse_inner(messages[1]["content"])
        if not isinstance(body, dict):
            return None
        if request["sessionId"] != session_id or request["problemHash"] != problem_hash:
            return None
        version = body.get("schemaVersion")
        if version != source_schema and version != _REPAIR_SCHEMA_VERSION:
            return None
        if body.get("problemFullText") != problem:
            return None
        packet = checked_packet(receipt["text"])
        if packet["sessionId"] != session_id or packet["problemHash"] != problem_hash:
            return None
        if not _contract_version_ok(packet["contractVersion"]):
            return None
        if packet["sourceRequestId"] != request_id:
            return None
        if packet["deliveryStatus"] != "COMPLETE":
            return None
        task = body.get("task")
        route = body.get("route")
        if not isinstance(task, dict) or not isinstance(route, dict):
            return None
        # Declared dependencies are admitted only when they are exactly this
        # task's own declared input refs; a foreign, unknown or tampered ref is
        # still a fixed rejection. Node decides candidate eligibility; the Host
        # only re-checks the structural binding.
        refs = task.get("inputArtifactRefs")
        if not isinstance(refs, list) or packet["dependencies"] != refs:
            return None
        if packet["taskId"] != task.get("taskId") or packet["goalId"] != task.get("goalId"):
            return None
        if packet["routeId"] != route.get("routeId"):
            return None
        candidate = packet["candidateProposal"]
        if not isinstance(candidate, str) or not js_nonempty(candidate):
            return None
        _text(candidate, _MAX_TEXT_CHARS)
        if version == _REPAIR_SCHEMA_VERSION:
            # A G3/PR4 revised candidate: the repair context was already checked
            # by ``_check_repair``; here the Host only re-checks the packet
            # binding and returns the parsed packet.
            _text(packet["claim"], _MAX_TEXT_CHARS)
            _text(packet["derivation"], _MAX_TEXT_CHARS)
            return copy.deepcopy(packet)
        scope = body.get("scope")
        if not isinstance(scope, dict):
            return None
        if packet["scopeId"] != scope.get("scopeId"):
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
        obligations = body.get("obligations")
        if not isinstance(obligations, list):
            return None
        # Candidate eligibility is decided by the Node control side only. The
        # Host re-checks the structural binding of the task obligation row and
        # never derives, widens or narrows the kind-based decision itself.
        for entry_row in obligations:
            if not isinstance(entry_row, dict):
                return None
            if entry_row.get("obligationId") != task.get("obligationId"):
                continue
            return copy.deepcopy(packet)
        return None
    except ProbeError:
        return None
    except Exception:  # noqa: BLE001 - a malformed record is not a candidate
        return None


def _work_packet(entry, problem, session_id, problem_hash,
                 source_schema=_ACTIVE_CONTEXT_SCHEMA_VERSION):
    """Strict parse of one real COMPLETE WORK receipt into its WorkPacket.

    Returns ``None`` unless the record is a COMPLETE WORK request whose receipt
    text is exactly one well-formed ``p2a-work-v1`` or ``p2a-work-v2`` packet
    bound to this session/problem and to the task/scope/route of its own request
    body. Tool, method, review and malformed records are never counted as work.
    """
    try:
        request_id, request, receipt, body = _source_body(entry)
        if request["sessionId"] != session_id or request["problemHash"] != problem_hash:
            return None
        if body.get("schemaVersion") != source_schema:
            return None
        if body.get("problemFullText") != problem:
            return None
        packet = checked_packet(receipt["text"])
        if packet["sessionId"] != session_id or packet["problemHash"] != problem_hash:
            return None
        if not _contract_version_ok(packet["contractVersion"]):
            return None
        if packet["sourceRequestId"] != request_id:
            return None
        if packet["deliveryStatus"] != "COMPLETE":
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
        refs = task.get("inputArtifactRefs")
        if not isinstance(refs, list):
            return None
        declared = []
        for ref in refs:
            if not isinstance(ref, dict):
                return None
            _exact_keys(ref, ("artifactId", "artifactVersion"))
            artifact_id = _text(ref["artifactId"], 256)
            if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
                return None
            if artifact_id in declared:
                return None
            declared.append(artifact_id)
        dependencies = packet["dependencies"]
        if not isinstance(dependencies, list):
            return None
        seen = []
        for ref in dependencies:
            if not isinstance(ref, dict):
                return None
            _exact_keys(ref, ("artifactId", "artifactVersion"))
            artifact_id = _text(ref["artifactId"], 256)
            if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
                return None
            if artifact_id in seen or artifact_id not in declared:
                return None
            seen.append(artifact_id)
        _text(packet["claim"], _MAX_TEXT_CHARS)
        _text(packet["derivation"], _MAX_TEXT_CHARS)
        return packet
    except ProbeError:
        return None
    except Exception:  # noqa: BLE001 - a malformed record is not a work packet
        return None


def _work_ordinals(history, problem, session_id, problem_hash,
                   source_schema=_ACTIVE_CONTEXT_SCHEMA_VERSION):
    """Ordered ``(ordinal, request_id)`` of every real COMPLETE WORK record."""
    if not isinstance(history, dict):
        return []
    ordered = []
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in tuple(str(n) for n in range(1, 33)):
            continue
        ordered.append((int(suffix), request_id))
    ordered.sort()
    kept = []
    for ordinal, request_id in ordered:
        if _work_packet(
            history.get(request_id), problem, session_id, problem_hash, source_schema,
        ) is not None:
            kept.append((ordinal, request_id))
    return kept


def _projection_for_source(history, problem, session_id, problem_hash, source_id,
                           source_schema=_ACTIVE_CONTEXT_SCHEMA_VERSION):
    """Rebuild the exact candidate projection of one named source request.

    Used only to VERIFY the projection the Node control side selected; the Host
    never chooses a source itself. Returns None when the named source is not a
    real eligible candidate."""
    try:
        if not isinstance(history, dict) or not isinstance(source_id, str):
            return None
        packet = candidate_packet(
            history, source_id, problem, session_id, problem_hash, source_schema,
        )
        if packet is None:
            return None
        entry = history.get(source_id)
        if not isinstance(entry, dict):
            return None
        _, request, receipt, body = _source_body(entry)
        raw_text = receipt["text"]
        if not isinstance(raw_text, str):
            return None
        task = body.get("task")
        scope = body.get("scope")
        if not isinstance(task, dict) or not isinstance(scope, dict):
            return None
        projection = project_artifacts(history, session_id, problem_hash)
        row = projection["bySourceRef"].get(source_id)
        if not isinstance(row, dict) or row["availability"] != "ACTIVE":
            return None
        binding = {
            "sessionId": session_id,
            "problemHash": problem_hash,
            "contractVersion": packet["contractVersion"],
            "artifactId": row["artifactId"],
            "artifactVersion": row["envelope"]["artifactVersion"],
            "taskId": task.get("taskId"),
            "goalId": task.get("goalId"),
            "scopeId": scope.get("scopeId"),
            "sourceRequestId": source_id,
        }
        ordered = {}
        for name in _TARGET_FIELDS:
            ordered[name] = binding[name]
        raw_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
        payload = json.dumps([ordered, raw_hash], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        target_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        answer = packet["candidateProposal"]
        if not isinstance(answer, str) or not js_nonempty(answer):
            return None
        return {"binding": ordered, "targetHash": target_hash, "answer": answer}
    except ProbeError:
        return None
    except Exception:  # noqa: BLE001
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
    projection = project_artifacts(history, inner["sessionId"], inner["problemHash"])
    by_source = projection["bySourceRef"]
    seen = set()
    for index, ref in enumerate(refs):
        _exact_keys(ref, ("artifactId", "artifactVersion"))
        artifact_id = _text(ref["artifactId"], 256)
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
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
        actual_row = by_source.get(source_id)
        if not isinstance(actual_row, dict):
            _fail()
        if actual_row["availability"] != "ACTIVE":
            _fail()
        if not same_json(artifact_view(actual_row), artifact):
            _fail()
        if actual_row["artifactId"] != artifact_id:
            _fail()
        if actual_row["envelope"]["artifactVersion"] != ref["artifactVersion"]:
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
        if not _contract_version_ok(source_packet.get("contractVersion")):
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
        if not _is_int(envelope.get("artifactVersion")) or envelope["artifactVersion"] < 1:
            _fail()
        if not _contract_version_ok(envelope.get("contractVersion")):
            _fail()
    return None


def _ordinal(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in tuple(str(n) for n in range(1, 33)):
        _fail()
    return int(suffix)


def _check_work(body, request_id, problem, session_id, problem_hash, history, effects,
                catalog=None, method_assets=None, version=_ACTIVE_CONTEXT_SCHEMA_VERSION,
                allow_final=False):
    """Validate one WORK context body against the Host request and records."""
    keys = set(body.keys())
    required = (
        "schemaVersion", "promptVersion", "problemFullText", "problemHash",
        "sessionId", "contractVersion", "task", "scope", "obligations",
        "route", "sourceRequestId", "inputArtifacts", "methodAssets",
        "allowTools", "allowMethods", "toolObservations",
    )
    extra = {"methodCatalog", "scopeCoverage"}
    if version in (
        _FINAL_CONTEXT_SCHEMA_VERSION, _CONTEXT_SCHEMA_VERSION,
        _DEPENDENCY_CONTEXT_SCHEMA_VERSION, _ACTIVE_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION,
    ):
        required = required + ("allowFinal", "protectedCandidate")
        extra = extra | {"allowFinal", "protectedCandidate"}
    if version in (
        _CONTEXT_SCHEMA_VERSION, _DEPENDENCY_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION,
        _PROGRESS_CONTEXT_SCHEMA_VERSION,
    ):
        required = required + ("allowRouteProposal", "routeProvenance")
        extra = extra | {"allowRouteProposal", "routeProvenance"}
    if version in (
        _DEPENDENCY_CONTEXT_SCHEMA_VERSION, _REVISION_CONTEXT_SCHEMA_VERSION,
        _PROGRESS_CONTEXT_SCHEMA_VERSION,
    ):
        required = required + ("allowTaskContinuation", "dependencyProvenance")
        extra = extra | {"allowTaskContinuation", "dependencyProvenance"}
    if version in (_REVISION_CONTEXT_SCHEMA_VERSION, _PROGRESS_CONTEXT_SCHEMA_VERSION):
        required = required + (
            "allowArtifactRedo", "revisionProvenance", "revisionTarget",
        )
        extra = extra | {"allowArtifactRedo", "revisionProvenance", "revisionTarget"}
    if version == _PROGRESS_CONTEXT_SCHEMA_VERSION:
        required = required + ("progressPolicy",)
        extra = extra | {"progressPolicy"}
    if not set(required) <= keys or not keys <= set(required) | extra:
        _fail()
    if body["schemaVersion"] != version:
        _fail()
    if body["promptVersion"] != _PROMPT_VERSION:
        _fail()
    if body["problemFullText"] != problem:
        _fail()
    if body["problemHash"] != problem_hash or body["sessionId"] != session_id:
        _fail()
    if not _contract_version_ok(body["contractVersion"]):
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
    if not _contract_version_ok(envelope.get("contractVersion")):
        _fail()
    scope = body["scope"]
    if not isinstance(scope, dict) or scope.get("scopeId") != task["scopeId"]:
        _fail()
    if canonical_scope(scope) != scope["scopeId"]:
        _fail()
    obligations = body["obligations"]
    if not isinstance(obligations, list) or not obligations:
        _fail()
    expected_obligation_task_id = task["taskId"]
    provenance = None
    if version in (
        _CONTEXT_SCHEMA_VERSION, _DEPENDENCY_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION,
        _PROGRESS_CONTEXT_SCHEMA_VERSION,
    ):
        route_prov = check_route_provenance(body, history, version)
        dep_prov = None
        if version in (
            _DEPENDENCY_CONTEXT_SCHEMA_VERSION, _REVISION_CONTEXT_SCHEMA_VERSION,
            _PROGRESS_CONTEXT_SCHEMA_VERSION,
        ):
            dep_prov = check_dependency_provenance(body, history, version)
        if route_prov is not None and dep_prov is not None:
            _fail()
        provenance = dep_prov if dep_prov is not None else route_prov
        if provenance is not None:
            source_entry = history.get(provenance["sourceRequestId"])
            if not isinstance(source_entry, dict):
                _fail()
            source_body = _parse_inner(source_entry["request"]["messages"][1]["content"])
            if not isinstance(source_body, dict):
                _fail()
            source_scope = source_body.get("scope")
            source_obligations = source_body.get("obligations")
            if not isinstance(source_scope, dict) or not isinstance(source_obligations, list):
                _fail()
            if not same_json(source_scope, scope):
                _fail()
            row_task_id = None
            for row in source_obligations:
                if not isinstance(row, dict):
                    _fail()
                if row.get("obligationId") != task["obligationId"]:
                    continue
                row_envelope = row.get("envelope")
                if not isinstance(row_envelope, dict):
                    _fail()
                if row_envelope.get("scopeId") != task["scopeId"]:
                    _fail()
                row_task_id = row_envelope.get("taskId")
            if not isinstance(row_task_id, str):
                _fail()
            expected_obligation_task_id = row_task_id
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
        if row_envelope.get("taskId") != expected_obligation_task_id:
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
    if version == _LEGACY_CONTEXT_SCHEMA_VERSION:
        if "allowFinal" in body or "protectedCandidate" in body:
            _fail()
    if version in (
        _FINAL_CONTEXT_SCHEMA_VERSION, _CONTEXT_SCHEMA_VERSION,
        _DEPENDENCY_CONTEXT_SCHEMA_VERSION, _ACTIVE_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION,
    ):
        if not isinstance(body["allowFinal"], bool):
            _fail()
        projection = body["protectedCandidate"]
        if projection is not None:
            _exact_keys(projection, ("binding", "targetHash", "answer"))
            binding = projection["binding"]
            _exact_keys(binding, _TARGET_FIELDS)
            if binding["sessionId"] != session_id or binding["problemHash"] != problem_hash:
                _fail()
            if not _contract_version_ok(binding["contractVersion"]):
                _fail()
            _text(binding["artifactId"], 256)
            if not _is_int(binding["artifactVersion"]) or binding["artifactVersion"] < 1:
                _fail()
            _text(binding["taskId"], 256)
            _text(binding["goalId"], 256)
            _hash64(binding["scopeId"])
            _ordinal(binding["sourceRequestId"])
            if _ordinal(binding["sourceRequestId"]) >= _ordinal(request_id):
                _fail()
            _hash64(projection["targetHash"])
            _text(projection["answer"], _MAX_TEXT_CHARS)
            expected = _projection_for_source(
                history, problem, session_id, problem_hash,
                binding["sourceRequestId"], version,
            )
            if expected is None or not same_json(projection, expected):
                _fail()
        if body["allowFinal"] and projection is None:
            _fail()
    if version in (
        _CONTEXT_SCHEMA_VERSION, _DEPENDENCY_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION, _PROGRESS_CONTEXT_SCHEMA_VERSION,
    ):
        if not isinstance(body["allowRouteProposal"], bool):
            _fail()
        route_prov = check_route_provenance(body, history, version)
        if route_prov is None and body["routeProvenance"] is not None:
            _fail()
        if route_prov is not None and not same_json(body["routeProvenance"], route_prov):
            _fail()
    if version in (
        _DEPENDENCY_CONTEXT_SCHEMA_VERSION, _REVISION_CONTEXT_SCHEMA_VERSION,
        _PROGRESS_CONTEXT_SCHEMA_VERSION,
    ):
        if not isinstance(body["allowTaskContinuation"], bool):
            _fail()
        dep_prov = check_dependency_provenance(body, history, version)
        if dep_prov is None and body["dependencyProvenance"] is not None:
            _fail()
        if dep_prov is not None and not same_json(body["dependencyProvenance"], dep_prov):
            _fail()
    if version in (_REVISION_CONTEXT_SCHEMA_VERSION, _PROGRESS_CONTEXT_SCHEMA_VERSION):
        if not isinstance(body["allowArtifactRedo"], bool):
            _fail()
        revision_prov = check_revision_context(
            body, history, session_id, problem_hash, version,
        )
        if revision_prov is None and body["revisionProvenance"] is not None:
            _fail()
        if revision_prov is not None and not same_json(
            body["revisionProvenance"], revision_prov,
        ):
            _fail()
    if version == _PROGRESS_CONTEXT_SCHEMA_VERSION:
        # The fixed policy is control data: an exact four-field identity, never
        # a model-supplied threshold. ``same_json`` is byte-exact, so a JSON
        # ``true`` never collapses into ``1``.
        policy = body["progressPolicy"]
        if not isinstance(policy, dict):
            _fail()
        if set(policy.keys()) != set(PROGRESS_POLICY) or len(policy) != len(PROGRESS_POLICY):
            _fail()
        if not same_json(policy, PROGRESS_POLICY):
            _fail()
    _check_scope_coverage(body, task)
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
    if not _contract_version_ok(target["contractVersion"]):
        _fail()
    if not _is_int(target["artifactVersion"]) or target["artifactVersion"] < 1:
        _fail()
    source_id = target["sourceRequestId"]
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    packet = candidate_packet(history, source_id, problem, session_id, problem_hash)
    if packet is None:
        _fail()
    # The Host only VERIFIES the source the Node recorded; it never re-selects
    # "the first" candidate. The projection is rebuilt for the named source and
    # must match the Node binding and hash exactly.
    expected_final = _projection_for_source(
        history, problem, session_id, problem_hash, source_id,
    )
    if expected_final is None:
        _fail()
    if not same_json(target, expected_final["binding"]):
        _fail()
    if body["targetHash"] != expected_final["targetHash"]:
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


def _check_repair(body, request_id, problem, session_id, problem_hash, history):
    """Validate one G3/PR4 REPAIR context body (additive, control-side shape).

    The body is Node-built control data: it names the challenged task binding,
    the answer obligation and the review challenge. The Host only checks that it
    is internally consistent and bound to the same session/problem/task; it makes
    no mathematical decision and never promotes evidence.
    """
    _exact_keys(body, _REPAIR_FIELDS)
    if body["schemaVersion"] != _REPAIR_SCHEMA_VERSION:
        _fail()
    if body["stage"] != "REPAIR" or body["requestId"] != request_id:
        _fail()
    if body["problemFullText"] != problem:
        _fail()
    if body["sessionId"] != session_id or body["problemHash"] != problem_hash:
        _fail()
    if not _contract_version_ok(body["contractVersion"]):
        _fail()
    if body["sourceRequestId"] != request_id:
        _fail()
    task = body["task"]
    _exact_keys(task, ("taskId", "goalId", "scopeId", "inputArtifactRefs"))
    if not isinstance(task["taskId"], str) or not task["taskId"]:
        _fail()
    if not isinstance(task["goalId"], str) or not task["goalId"]:
        _fail()
    _hash64(task["scopeId"])
    if not isinstance(task["inputArtifactRefs"], list):
        _fail()
    route = body["route"]
    _exact_keys(route, ("routeId",))
    if not isinstance(route["routeId"], str) or not route["routeId"]:
        _fail()
    if not isinstance(body["answerObligationId"], str) or not body["answerObligationId"]:
        _fail()
    challenge = body["challenge"]
    if not isinstance(challenge, dict):
        _fail()
    _exact_keys(
        challenge,
        ("challengeId", "target", "targetHash", "issue", "requestIds", "status", "availability"),
    )
    if challenge["status"] != "CHALLENGED" or challenge["availability"] != "ACTIVE":
        _fail()
    _hash64(challenge["targetHash"])
    if not isinstance(challenge["challengeId"], str) or not challenge["challengeId"]:
        _fail()
    if body["parentCandidate"] is not None and not isinstance(body["parentCandidate"], str):
        _fail()
    return copy.deepcopy(body)


def _check_r0(body, request_id, problem, session_id, problem_hash):
    """Validate one bounded R0 planning-review context (identity only).

    The R0 review and its single bounded revision are parsed and settled by the
    Node ``P4R0ReviewSession``/``P4R0PlanRevisionSession``; the Host only
    re-checks the identity binding (session/problem/contract version) and never
    makes a mathematical decision, dispatches a tool or promotes evidence.
    """
    if not isinstance(body, dict):
        _fail()
    if body.get("stage") != "R0":
        _fail()
    if body.get("requestId") != request_id:
        _fail()
    if body.get("problemFullText") != problem:
        _fail()
    binding = body.get("target")
    if not isinstance(binding, dict):
        binding = body.get("parent")
    if not isinstance(binding, dict):
        _fail()
    if binding.get("sessionId") != session_id or binding.get("problemHash") != problem_hash:
        _fail()
    if not _contract_version_ok(binding.get("contractVersion")):
        _fail()
    plan_hash = binding.get("planHash")
    if not _is_hash64(plan_hash):
        _fail()
    if body.get("planHash") is not None and body.get("planHash") != plan_hash:
        _fail()
    review_hash = body.get("reviewHash")
    if review_hash is not None and not _is_hash64(review_hash):
        _fail()
    return copy.deepcopy(body)


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
        if body.get("schemaVersion") != _PROGRESS_CONTEXT_SCHEMA_VERSION:
            _fail()
        _check_work(
            body, request_id, problem, session_id, problem_hash, history, effects,
            catalog, method_assets, _PROGRESS_CONTEXT_SCHEMA_VERSION, True,
        )
    elif request["phase"] == "R2":
        target = body.get("target")
        if not isinstance(target, dict):
            _fail()
        if target.get("taskId") != request["taskId"] or target.get("scopeId") != request["scopeId"]:
            _fail()
        _check_r2(body, request_id, problem, session_id, problem_hash, history)
    elif request["phase"] == "REPAIR":
        task = body.get("task")
        if not isinstance(task, dict):
            _fail()
        if task.get("taskId") != request["taskId"] or task.get("scopeId") != request["scopeId"]:
            _fail()
        _check_repair(body, request_id, problem, session_id, problem_hash, history)
    elif request["phase"] == "R0":
        _check_r0(body, request_id, problem, session_id, problem_hash)
    else:
        _fail()
    return copy.deepcopy(body)


def validate_legacy_context(request, problem, session_id, problem_hash, history,
                            effects, catalog=None, method_assets=None):
    """Read-only validation of one legacy v2..v6 WORK context.

    Only the older ``agent-work-context-v2`` .. ``agent-work-context-v6``
    shapes are accepted here; the active v7 shape is never accepted through
    this read-only path. A v2 body must not carry the
    ``allowFinal``/``protectedCandidate`` fields; a v3 body is checked with the
    same shared final-projection guard as the active shape, but never with the
    later proposal fields. The active Host entry never calls this function; it
    exists so a historical record can still be re-checked without being
    rewritten into a newer shape.
    """
    request_id, messages = _validate_request(copy.deepcopy(request))
    if request["sessionId"] != session_id or request["problemHash"] != problem_hash:
        _fail()
    body = _parse_inner(messages[1]["content"])
    if not isinstance(body, dict):
        _fail()
    if body.get("problemFullText") != problem:
        _fail()
    if request["phase"] != "WORK":
        _fail()
    version = body.get("schemaVersion")
    if version not in (
        _LEGACY_CONTEXT_SCHEMA_VERSION, _FINAL_CONTEXT_SCHEMA_VERSION,
        _CONTEXT_SCHEMA_VERSION, _DEPENDENCY_CONTEXT_SCHEMA_VERSION,
        _REVISION_CONTEXT_SCHEMA_VERSION,
    ):
        _fail()
    task = body.get("task")
    if not isinstance(task, dict):
        _fail()
    if task.get("taskId") != request["taskId"] or task.get("scopeId") != request["scopeId"]:
        _fail()
    _check_work(
        body, request_id, problem, session_id, problem_hash, history, effects,
        catalog, method_assets, version, False,
    )
    return copy.deepcopy(body)
