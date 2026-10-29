"""P2 Host downstream input-reference check against trusted Host history.

Pure reference reconciliation: every declared input artifact must correspond to
an artifact the Host itself already returned for an earlier request. No file
access, no Node-produced hash as a source of truth, no mathematical acceptance.
"""

from __future__ import annotations

import copy
import hashlib

from .p0_probe import ProbeError

__all__ = ["validate_inputs"]

_MAX_HISTORY = 3
_ARTIFACT_PREFIX = "artifact-"
_ROUTE_ID = "route-1"
_CONTEXT_SCHEMA_VERSION = "p2-fixture-context-v1"
_PROMPT_VERSION = "p2-workunit-v1"


def _fail():
    raise ProbeError("FIELD_VALUE")


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys):
        _fail()


def _short_string(value):
    if not isinstance(value, str) or not value or len(value) > 256:
        _fail()
    return value


def _exact_version(value):
    if isinstance(value, bool) or not isinstance(value, int) or value != 1:
        _fail()
    return value


def _exact_contract_version(value):
    if isinstance(value, bool) or not isinstance(value, int) or value != 1:
        _fail()
    return value


def _ordinal_of(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in ("1", "2", "3"):
        _fail()
    return int(suffix)


def _artifact_ordinal(artifact_id):
    if not isinstance(artifact_id, str) or not artifact_id.startswith(_ARTIFACT_PREFIX):
        _fail()
    suffix = artifact_id[len(_ARTIFACT_PREFIX):]
    if suffix not in ("1", "2", "3"):
        _fail()
    return int(suffix)


def _history_entry(history, request_id):
    if not isinstance(history, dict):
        _fail()
    entry = history.get(request_id)
    if not isinstance(entry, dict):
        _fail()
    params = entry.get("params")
    receipt = entry.get("receipt")
    if not isinstance(params, dict) or not isinstance(receipt, dict):
        _fail()
    text = receipt.get("text")
    if not isinstance(text, str):
        _fail()
    if receipt.get("deliveryStatus") not in ("COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"):
        _fail()
    return params, receipt


def _check_artifact(inner, ref, artifact, params, receipt, current_ordinal, scope_id):
    from .p2_host_fixture import _parse_inner

    _exact_keys(ref, ("artifactId", "artifactVersion"))
    artifact_id = _short_string(ref["artifactId"])
    version = _exact_version(ref["artifactVersion"])
    ordinal = _artifact_ordinal(artifact_id)
    if ordinal >= current_ordinal:
        _fail()
    request_id = "model-" + str(ordinal)
    if params.get("requestId") != request_id:
        _fail()
    if receipt.get("deliveryStatus") != "COMPLETE":
        _fail()
    if params.get("sessionId") != inner["sessionId"]:
        _fail()
    if params.get("problemHash") != inner["problemHash"]:
        _fail()
    if _exact_contract_version(params.get("contractVersion")) != _exact_contract_version(
        inner["contractVersion"]
    ):
        _fail()
    if params.get("scopeId") != scope_id:
        _fail()

    messages = params.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    user = messages[1]
    if not isinstance(user, dict) or not isinstance(user.get("content"), str):
        _fail()
    source_context = _parse_inner(user["content"])
    if not isinstance(source_context, dict):
        _fail()
    if source_context.get("schemaVersion") != _CONTEXT_SCHEMA_VERSION:
        _fail()
    if source_context.get("promptVersion") != _PROMPT_VERSION:
        _fail()
    if source_context.get("sessionId") != inner["sessionId"]:
        _fail()
    if source_context.get("problemHash") != inner["problemHash"]:
        _fail()
    if _exact_contract_version(source_context.get("contractVersion")) != _exact_contract_version(
        inner["contractVersion"]
    ):
        _fail()
    if source_context.get("sourceRequestId") != request_id:
        _fail()
    source_task = source_context.get("task")
    source_scope = source_context.get("scope")
    source_route = source_context.get("route")
    if not isinstance(source_task, dict) or not isinstance(source_scope, dict):
        _fail()
    if not isinstance(source_route, dict):
        _fail()
    if source_route.get("routeId") != _ROUTE_ID:
        _fail()
    if source_task.get("scopeId") != scope_id or source_scope.get("scopeId") != scope_id:
        _fail()
    source_refs = source_task.get("inputArtifactRefs")
    if not isinstance(source_refs, list):
        _fail()

    _exact_keys(
        artifact,
        (
            "envelope",
            "artifactId",
            "routeId",
            "scope",
            "dependencies",
            "sourceRequestId",
            "rawResponseHash",
            "rawResponseRef",
            "rawResponseText",
            "packet",
            "transportStatus",
            "deliveryStatus",
            "level",
            "checkResult",
            "provisionalDependency",
        ),
    )
    if artifact["artifactId"] != artifact_id:
        _fail()
    if artifact["sourceRequestId"] != request_id:
        _fail()
    if artifact["transportStatus"] != "COMPLETE":
        _fail()
    if artifact["deliveryStatus"] != "COMPLETE":
        _fail()
    if artifact["level"] != "PROVISIONAL" or artifact["checkResult"] != "UNKNOWN":
        _fail()
    if artifact["routeId"] != inner["route"]["routeId"]:
        _fail()
    if artifact["routeId"] != _ROUTE_ID:
        _fail()
    if artifact["rawResponseRef"] != f"{params['sessionId']}:raw:{request_id}":
        _fail()
    if not isinstance(artifact["dependencies"], list):
        _fail()
    if artifact["dependencies"] != source_refs:
        _fail()
    if not isinstance(artifact["provisionalDependency"], bool):
        _fail()
    if artifact["provisionalDependency"] is not bool(source_refs):
        _fail()

    envelope = artifact["envelope"]
    if not isinstance(envelope, dict):
        _fail()
    if envelope.get("sourceModule") != "M3":
        _fail()
    if envelope.get("artifactId") != artifact_id:
        _fail()
    if _exact_version(envelope.get("artifactVersion")) != version:
        _fail()
    if envelope.get("sessionId") != inner["sessionId"]:
        _fail()
    if envelope.get("problemHash") != inner["problemHash"]:
        _fail()
    if _exact_contract_version(envelope.get("contractVersion")) != _exact_contract_version(
        inner["contractVersion"]
    ):
        _fail()
    if envelope.get("taskId") != params.get("taskId"):
        _fail()
    if envelope.get("scopeId") != scope_id:
        _fail()

    scope = artifact["scope"]
    if not isinstance(scope, dict):
        _fail()
    if scope != inner["scope"]:
        _fail()
    if scope != source_scope:
        _fail()

    text = receipt["text"]
    if artifact["rawResponseText"] != text:
        _fail()
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if artifact["rawResponseHash"] != digest:
        _fail()

    packet = artifact["packet"]
    if not isinstance(packet, dict):
        _fail()
    if packet != _parse_inner(text):
        _fail()
    if packet.get("deliveryStatus") != "COMPLETE":
        _fail()
    if packet.get("sessionId") != inner["sessionId"]:
        _fail()
    if packet.get("problemHash") != inner["problemHash"]:
        _fail()
    if _exact_contract_version(packet.get("contractVersion")) != _exact_contract_version(
        inner["contractVersion"]
    ):
        _fail()
    if packet.get("taskId") != params.get("taskId"):
        _fail()
    if packet.get("scopeId") != scope_id:
        _fail()
    if packet.get("sourceRequestId") != request_id:
        _fail()


def validate_inputs(inner, history, expected_request_id):
    """Check declared input artifacts against the trusted Host history.

    `history` maps an earlier `model-N` request to the exact `model.generate`
    params and receipt the Host returned. Every declared ref must resolve to
    that earlier returned artifact, bound to the same session, problem,
    contract version, task, scope and route. A rejected call changes nothing.
    """
    try:
        if not isinstance(inner, dict):
            _fail()
        if inner.get("schemaVersion") != _CONTEXT_SCHEMA_VERSION:
            _fail()
        if inner.get("promptVersion") != _PROMPT_VERSION:
            _fail()
        _exact_contract_version(inner.get("contractVersion"))
        current_ordinal = _ordinal_of(expected_request_id)
        if not isinstance(history, dict) or len(history) > _MAX_HISTORY:
            _fail()
        task = inner.get("task")
        route = inner.get("route")
        scope = inner.get("scope")
        if not isinstance(task, dict) or not isinstance(route, dict) or not isinstance(scope, dict):
            _fail()
        if route.get("routeId") != _ROUTE_ID:
            _fail()
        scope_id = _short_string(scope.get("scopeId"))
        if task.get("scopeId") != scope_id:
            _fail()
        refs = task.get("inputArtifactRefs")
        artifacts = inner.get("inputArtifacts")
        if not isinstance(refs, list) or not isinstance(artifacts, list):
            _fail()
        if len(refs) != len(artifacts) or len(refs) > _MAX_HISTORY:
            _fail()
        dependencies = task.get("dependencyTaskIds")
        if not isinstance(dependencies, list):
            _fail()
        seen = set()
        for index, ref in enumerate(refs):
            if not isinstance(ref, dict):
                _fail()
            artifact_id = ref.get("artifactId")
            if artifact_id in seen:
                _fail()
            seen.add(artifact_id)
            ordinal = _artifact_ordinal(artifact_id)
            if ordinal >= current_ordinal:
                _fail()
            request_id = "model-" + str(ordinal)
            params, receipt = _history_entry(history, request_id)
            if params.get("taskId") not in dependencies:
                _fail()
            _check_artifact(
                inner, ref, artifacts[index], params, receipt, current_ordinal, scope_id
            )
        return None
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("FIELD_VALUE") from None
