"""Pure Host-side route/dependency-proposal helpers for the unified AgentLoop.

Strictly re-parses one raw WorkPacket (v1/v2/v3) with the shared P0 inner
parser and derives the canonical route identity of one untrusted NEW_ROUTE
mechanism or the control provenance of one untrusted DEPENDENT_TASK suggestion.
No I/O, no client call, no budget change, no mathematical selection: a route
signature is an identity of declared data, never a proof of independence.
"""

from __future__ import annotations

import copy
import hashlib
import json

from .p0_probe import ProbeError
from .p2_host_fixture import _parse_inner, _strict_utf8
from .p3_host_context import same_json
from .text_contract import JS_WHITESPACE, js_nonempty, js_trim

__all__ = [
    "checked_packet",
    "trusted_packet_binding",
    "normalize_route",
    "default_route",
    "check_route_provenance",
    "check_control_route_provenance",
    "check_dependency_provenance",
]

# Must stay byte-identical to AGENT_CONTROL_SECOND_ROUTE_MECHANISM in the TS
# workflow module. It is control data, not model data; the Host re-derives the
# route identity from this fixed mechanism.
_CONTROL_SECOND_MECHANISM = {
    "representation": "independent-recomputation",
    "operation": "second-derivation",
    "lemmas": [],
    "construction": "empty-dependency-independent-route",
}

_WORK_V1 = "p2a-work-v1"
_WORK_V2 = "p2a-work-v2"
_WORK_V3 = "p2a-work-v3"
_WORK_V4 = "p2a-work-v4"
_WORK_V5 = "p2a-work-v5"
_CONTEXT_V4 = "agent-work-context-v4"
_CONTEXT_V5 = "agent-work-context-v5"
_CONTEXT_V6 = "agent-work-context-v6"
_CONTEXT_V7 = "agent-work-context-v7"
_MAX_TEXT = 4096
_MAX_SHORT = 256
_MAX_LEMMAS = 32
_MAX_REF = 256
_MAX_COVERAGE_ITEMS = 32
_MAX_COVERAGE_CHARS = 256
_REQUEST_IDS = ("model-1", "model-2", "model-3")
_PACKET_FIELDS = (
    "schemaVersion", "sessionId", "problemHash", "contractVersion", "taskId",
    "goalId", "scopeId", "routeId", "sourceRequestId", "claim", "derivation",
    "assumptions", "dependencies", "pendingObligations", "suggestedChecks",
    "deliveryStatus", "candidateProposal",
)
_PROPOSAL_FIELDS = ("kind", "obligationId", "mechanism", "rationale")
_DEPENDENT_FIELDS = ("kind", "obligationId", "rationale")
_REDO_FIELDS = ("kind", "targetArtifactRef", "rationale")
_SCOPE_PROPOSAL_FIELDS = (
    "kind", "quantifiers", "branchConditions", "boundaryCases", "goalExhaustion",
    "rationale",
)
_MECHANISM_FIELDS = ("representation", "operation", "lemmas", "construction")
_PROVENANCE_FIELDS = (
    "sourceRequestId", "sourceArtifactRef", "obligationId", "routeSignature",
)
_REF_FIELDS = ("artifactId", "artifactVersion")
_DEFAULT_MECHANISM = {
    "representation": "original-problem",
    "operation": "direct-reasoning",
    "lemmas": [],
    "construction": "unified-agent-loop",
}
_HEX64 = frozenset("0123456789abcdef")
_WS = JS_WHITESPACE


def _fail():
    raise ProbeError("FIELD_VALUE")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _exact_keys(value, keys):
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(keys) or len(value) != len(keys):
        _fail()


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


def _text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not js_nonempty(value):
        _fail()
    length = _code_points(value)
    if length is None or length > max_chars:
        _fail()
    _strict_utf8(value)
    return value


def _short_shape(value):
    """Non-empty SHORT shape check: 1..256 code points, no trimming."""
    if not isinstance(value, str) or not value:
        _fail()
    length = _code_points(value)
    if length is None or length > _MAX_SHORT:
        _fail()
    _strict_utf8(value)
    return value


def _hash64(value):
    if not isinstance(value, str) or len(value) != 64:
        _fail()
    for ch in value:
        if ch not in _HEX64:
            _fail()
    return value


def _coverage_item(value):
    """One declared coverage item: non-empty, bounded, no lone surrogate."""
    if not isinstance(value, str):
        _fail()
    if not js_nonempty(value):
        _fail()
    length = _code_points(value)
    if length is None or length > _MAX_COVERAGE_CHARS:
        _fail()
    _strict_utf8(value)
    return value


def _coverage_list(value):
    """One declared coverage list: at most 32 items, deduplicated by bytes."""
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


def _check_scope_proposal(proposal):
    """Strict shape of one untrusted SCOPE_REFINEMENT suggestion.

    Exactly the six declared fields are accepted; the four lists are declared
    data only and the rationale is a TEXT field the schema allows to be empty.
    Nothing here derives a task id, scope id, coverage hash or authority, and
    nothing here marks any obligation covered.
    """
    _exact_keys(proposal, _SCOPE_PROPOSAL_FIELDS)
    if proposal["kind"] != "SCOPE_REFINEMENT":
        _fail()
    _coverage_list(proposal["quantifiers"])
    _coverage_list(proposal["branchConditions"])
    _coverage_list(proposal["boundaryCases"])
    _coverage_list(proposal["goalExhaustion"])
    _text(proposal["rationale"], _MAX_TEXT, allow_empty=True)


def _ordinal(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in tuple(str(n) for n in range(1, 257)):
        _fail()
    return int(suffix)


def _is_ws(ch):
    return ch in _WS


def _trim(value):
    return js_trim(value)


def _collapse(value):
    """Trim, then collapse every ECMAScript whitespace run to one space."""
    text = _trim(value)
    out = []
    index = 0
    length = len(text)
    while index < length:
        ch = text[index]
        if _is_ws(ch):
            out.append(" ")
            while index < length and _is_ws(text[index]):
                index += 1
            continue
        out.append(ch)
        index += 1
    return "".join(out)


def _normalized(value):
    text = _collapse(_text(value, _MAX_SHORT))
    if not text:
        _fail()
    return text


def _lemma_list(value):
    if not isinstance(value, list) or len(value) > _MAX_LEMMAS:
        _fail()
    normalized = [_normalized(item) for item in value]
    normalized.sort(key=lambda item: item.encode("utf-16-be"))
    unique = []
    for lemma in normalized:
        if not unique or unique[-1] != lemma:
            unique.append(lemma)
    return unique


def _compact(value):
    try:
        return json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail()


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


_TRUSTED_BINDING_FIELDS = (
    "sessionId", "problemHash", "contractVersion", "taskId", "goalId",
    "scopeId", "routeId", "sourceRequestId",
)


def trusted_packet_binding(body, source_request_id):
    """Build the eight trusted WorkPacket identity values from a request body.

    This is control data only. It never supplies claim, derivation, candidate,
    dependencies or any mathematical field. Callers that do not have a trusted
    body must keep using the strict ``checked_packet(text)`` path.
    """
    if not isinstance(body, dict) or not isinstance(source_request_id, str):
        return None
    task = body.get("task")
    scope = body.get("scope")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(route, dict):
        return None
    scope_id = None
    if isinstance(scope, dict):
        scope_id = scope.get("scopeId")
    if not isinstance(scope_id, str):
        scope_id = task.get("scopeId")
    route_id = route.get("routeId")
    if not isinstance(route_id, str):
        route_id = task.get("routeId")
    values = {
        "sessionId": body.get("sessionId"),
        "problemHash": body.get("problemHash"),
        "contractVersion": body.get("contractVersion"),
        "taskId": task.get("taskId"),
        "goalId": task.get("goalId"),
        "scopeId": scope_id,
        "routeId": route_id,
        "sourceRequestId": source_request_id,
    }
    if not all(isinstance(values[name], str) and values[name] for name in (
        "sessionId", "problemHash", "taskId", "goalId", "scopeId", "routeId",
        "sourceRequestId",
    )):
        return None
    if not _is_int(values["contractVersion"]) or values["contractVersion"] < 1:
        return None
    return values


def checked_packet(text, binding=None):
    """Strict parse of one raw WorkPacket of either accepted version.

    The raw text is parsed once with the shared P0 inner parser; a v2 packet
    keeps its full proposal and is never rewritten into a v1 shape. Only the
    structural packet shape is checked here: binding, scope and dependency
    legality stay with the existing ``agent_context`` guards.

    This is a *shape* check only. ``claim``/``derivation``/``rationale`` are
    TEXT fields that the schema allows to be empty, and a mechanism field is a
    SHORT string that may be whitespace; the M3 delivery guard and the route
    admission guard reject those later. Rejecting them here would turn a legal
    low-budget packet with an empty rationale into a shape error.
    """
    if not isinstance(text, str):
        _fail()
    packet = _parse_inner(text)
    if not isinstance(packet, dict):
        _fail()
    if binding is not None:
        if not isinstance(binding, dict):
            _fail()
        # Only the eight control-identity keys are replaced. Every
        # mathematical field and every extra-key check below stays strict.
        for field in _TRUSTED_BINDING_FIELDS:
            if field not in binding:
                _fail()
            packet[field] = binding[field]
    version = packet.get("schemaVersion")
    if version == _WORK_V1:
        _exact_keys(packet, _PACKET_FIELDS)
    elif version == _WORK_V2:
        _exact_keys(packet, _PACKET_FIELDS + ("workflowProposal",))
        proposal = packet["workflowProposal"]
        if proposal is not None:
            _exact_keys(proposal, _PROPOSAL_FIELDS)
            if proposal["kind"] != "NEW_ROUTE":
                _fail()
            _short_shape(proposal["obligationId"])
            _exact_keys(proposal["mechanism"], _MECHANISM_FIELDS)
            _short_shape(proposal["mechanism"]["representation"])
            _short_shape(proposal["mechanism"]["operation"])
            lemmas = proposal["mechanism"]["lemmas"]
            if not isinstance(lemmas, list) or len(lemmas) > _MAX_LEMMAS:
                _fail()
            for lemma in lemmas:
                _short_shape(lemma)
            _short_shape(proposal["mechanism"]["construction"])
            _text(proposal["rationale"], _MAX_TEXT, allow_empty=True)
    elif version == _WORK_V3:
        _exact_keys(packet, _PACKET_FIELDS + ("workflowProposal",))
        proposal = packet["workflowProposal"]
        if proposal is not None:
            _exact_keys(proposal, _DEPENDENT_FIELDS)
            if proposal["kind"] != "DEPENDENT_TASK":
                _fail()
            _short_shape(proposal["obligationId"])
            _text(proposal["rationale"], _MAX_TEXT, allow_empty=True)
    elif version == _WORK_V4:
        _exact_keys(packet, _PACKET_FIELDS + ("workflowProposal",))
        proposal = packet["workflowProposal"]
        if proposal is not None:
            _exact_keys(proposal, _REDO_FIELDS)
            if proposal["kind"] != "REDO_ARTIFACT":
                _fail()
            target = proposal["targetArtifactRef"]
            if target is not None:
                _exact_keys(target, _REF_FIELDS)
                _text(target["artifactId"], _MAX_REF)
                if not _is_int(target["artifactVersion"]) or target["artifactVersion"] < 1:
                    _fail()
            _text(proposal["rationale"], _MAX_TEXT, allow_empty=True)
    elif version == _WORK_V5:
        _exact_keys(packet, _PACKET_FIELDS + ("workflowProposal", "scopeProposal"))
        proposal = packet["workflowProposal"]
        if proposal is not None:
            _exact_keys(proposal, _REDO_FIELDS)
            if proposal["kind"] != "REDO_ARTIFACT":
                _fail()
            target = proposal["targetArtifactRef"]
            if target is not None:
                _exact_keys(target, _REF_FIELDS)
                _text(target["artifactId"], _MAX_REF)
                if not _is_int(target["artifactVersion"]) or target["artifactVersion"] < 1:
                    _fail()
            _text(proposal["rationale"], _MAX_TEXT, allow_empty=True)
        scope_proposal = packet["scopeProposal"]
        if scope_proposal is not None:
            _check_scope_proposal(scope_proposal)
    else:
        _fail()
    _short_shape(packet["sessionId"])
    _hash64(packet["problemHash"])
    if not _is_int(packet["contractVersion"]) or packet["contractVersion"] < 1:
        _fail()
    _short_shape(packet["taskId"])
    _short_shape(packet["goalId"])
    _short_shape(packet["scopeId"])
    _short_shape(packet["routeId"])
    _short_shape(packet["sourceRequestId"])
    _text(packet["claim"], _MAX_TEXT, allow_empty=True)
    _text(packet["derivation"], _MAX_TEXT, allow_empty=True)
    for name in ("assumptions", "pendingObligations", "suggestedChecks"):
        rows = packet[name]
        if not isinstance(rows, list) or len(rows) > 32:
            _fail()
        for item in rows:
            _short_shape(item)
    dependencies = packet["dependencies"]
    if not isinstance(dependencies, list) or len(dependencies) > 32:
        _fail()
    for ref in dependencies:
        _exact_keys(ref, _REF_FIELDS)
        _text(ref["artifactId"], _MAX_REF)
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
            _fail()
    if packet["deliveryStatus"] not in ("COMPLETE", "INCOMPLETE", "TRUNCATED", "ERROR"):
        _fail()
    candidate = packet["candidateProposal"]
    if candidate is not None:
        _text(candidate, _MAX_TEXT, allow_empty=True)
    return copy.deepcopy(packet)


def normalize_route(mechanism):
    """Canonical route identity of one declared mechanism.

    The signature is sha256 over the compact JSON of the normalized
    ``[representation, operation, lemmas, construction]``; the route id is the
    first 16 hex chars of that signature. Case is never rewritten.
    """
    _exact_keys(mechanism, _MECHANISM_FIELDS)
    representation = _normalized(mechanism["representation"])
    operation = _normalized(mechanism["operation"])
    lemmas = _lemma_list(mechanism["lemmas"])
    construction = _normalized(mechanism["construction"])
    signature = _sha256(_compact([representation, operation, lemmas, construction]))
    return {
        "routeId": "route-" + signature[:16],
        "representation": representation,
        "operation": operation,
        "lemmas": lemmas,
        "construction": construction,
        "signature": signature,
    }


def default_route():
    """The canonical default route of the unified AgentLoop."""
    return normalize_route(copy.deepcopy(_DEFAULT_MECHANISM))


def _source_record(history, source_id, session_id, problem_hash, *,
                   require_complete=True, phases=("WORK",)):
    """Strict read of one real COMPLETE WORK record; returns (body, packet).

    The request body and the raw receipt packet are cross-checked against each
    other: the packet must be bound to the body's own task/goal/scope/route and
    to this session/problem, its declared dependencies must be a duplicate-free
    subset of the body's own ``inputArtifactRefs``, and every declared
    assumption must already be a declared scope assumption. A record that fails
    any of these is not a source, never a repaired one.

    ``require_complete`` defaults to ``True`` and keeps the original behaviour:
    only a COMPLETE delivery is a source for route, dependency and redo
    provenance. The optional ``False`` form is a projection-only relaxation
    that still requires a COMPLETE transport and every original binding,
    dependency, scope and non-empty claim/derivation check; it never widens the
    provenance callers, which all keep the default.
    """
    if not isinstance(history, dict):
        _fail()
    entry = history.get(source_id)
    if not isinstance(entry, dict):
        _fail()
    _exact_keys(entry, ("request", "receipt"))
    request = entry["request"]
    receipt = entry["receipt"]
    if not isinstance(request, dict) or not isinstance(receipt, dict):
        _fail()
    if set(receipt.keys()) != {"transportStatus", "text"}:
        _fail()
    if receipt["transportStatus"] != "COMPLETE":
        _fail()
    if request.get("phase") not in phases or request.get("requestId") != source_id:
        _fail()
    if request.get("sessionId") != session_id or request.get("problemHash") != problem_hash:
        _fail()
    messages = request.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    body = _parse_inner(messages[1]["content"])
    if not isinstance(body, dict):
        _fail()
    text = receipt["text"]
    if not isinstance(text, str):
        _fail()
    binding = trusted_packet_binding(body, source_id)
    if binding is None:
        _fail()
    packet = checked_packet(text, binding)
    if require_complete:
        if packet["deliveryStatus"] != "COMPLETE":
            _fail()
    elif packet["deliveryStatus"] not in ("COMPLETE", "INCOMPLETE", "TRUNCATED", "ERROR"):
        _fail()
    # A real M3 delivery must carry non-empty material; the shape check above
    # allows an empty TEXT field, so the acceptance layer rejects it here for
    # both the COMPLETE source path and the projection-only partial path.
    if not _trim(packet["claim"]) or not _trim(packet["derivation"]):
        _fail()
    if not _is_int(packet["contractVersion"]) or packet["contractVersion"] not in (1, 2):
        _fail()
    if not _is_int(body.get("contractVersion")) or body["contractVersion"] not in (1, 2):
        _fail()
    if packet["contractVersion"] != body["contractVersion"]:
        _fail()
    if packet["sessionId"] != session_id or packet["problemHash"] != problem_hash:
        _fail()
    if packet["sourceRequestId"] != source_id:
        _fail()
    task = body.get("task")
    scope = body.get("scope")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(scope, dict) or not isinstance(route, dict):
        _fail()
    if packet["taskId"] != task.get("taskId") or packet["goalId"] != task.get("goalId"):
        _fail()
    if packet["scopeId"] != scope.get("scopeId") or packet["routeId"] != route.get("routeId"):
        _fail()
    refs = task.get("inputArtifactRefs")
    if not isinstance(refs, list):
        _fail()
    declared = []
    for ref in refs:
        _exact_keys(ref, _REF_FIELDS)
        artifact_id = _text(ref["artifactId"], _MAX_REF)
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
            _fail()
        pair = (artifact_id, ref["artifactVersion"])
        if pair in declared:
            _fail()
        declared.append(pair)
    seen = []
    for ref in packet["dependencies"]:
        pair = (ref["artifactId"], ref["artifactVersion"])
        if pair in seen or pair not in declared:
            _fail()
        seen.append(pair)
    allowed = scope.get("localAssumptions")
    if not isinstance(allowed, list):
        _fail()
    for assumption in packet["assumptions"]:
        if assumption not in allowed:
            _fail()
    return body, packet


def _source_artifact_ref(history, source_id, session_id, problem_hash,
                         phases=("WORK",)):
    """``artifact-N`` where N counts real COMPLETE valid WorkPackets up to source."""
    if not isinstance(history, dict):
        _fail()
    source_ordinal = _ordinal(source_id)
    # The source must itself be a real referenceable COMPLETE delivery before
    # the projection is queried; the projection then reports the actual
    # artifact id and version, counting every real accepted M3 work including
    # partial deliveries, so a skipped partial never shifts a later id.
    _, packet = _source_record(
        history, source_id, session_id, problem_hash, phases=phases,
    )
    if packet["deliveryStatus"] != "COMPLETE":
        _fail()
    prior = {}
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in tuple(str(n) for n in range(1, 257)):
            continue
        if int(suffix) > source_ordinal:
            continue
        prior[request_id] = history[request_id]
    from .agent_history import project_artifacts

    projection = project_artifacts(prior, session_id, problem_hash)
    row = projection["bySourceRef"].get(source_id)
    if not isinstance(row, dict):
        _fail()
    if row["availability"] != "ACTIVE":
        _fail()
    if row["deliveryStatus"] != "COMPLETE":
        _fail()
    return {
        "artifactId": row["artifactId"],
        "artifactVersion": row["envelope"]["artifactVersion"],
    }


def _check_source_body(body, source_id, session_id, problem_hash,
                       source_schema=_CONTEXT_V7, require_route_proposal=True):
    """Strict shape of the source WORK context body of a NEW_ROUTE proposal.

    ``source_schema`` is explicit: the active v5 context passes ``v5`` and the
    read-only v4 entry point passes ``v4``. A body of any other version is never
    accepted here, so a v5 source can never be read through the legacy path and
    a v4 source can never be read through the active path.
    """
    if source_schema not in (_CONTEXT_V4, _CONTEXT_V5, _CONTEXT_V6, _CONTEXT_V7):
        _fail()
    if body.get("schemaVersion") != source_schema:
        _fail()
    if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
        _fail()
    if body.get("sourceRequestId") != source_id:
        _fail()
    if require_route_proposal and body.get("allowRouteProposal") is not True:
        _fail()
    task = body.get("task")
    scope = body.get("scope")
    route = body.get("route")
    obligations = body.get("obligations")
    if not isinstance(task, dict) or not isinstance(scope, dict):
        _fail()
    if not isinstance(route, dict) or not isinstance(obligations, list):
        _fail()
    return task, scope, route, obligations


def _check_dependency_source_body(body, source_id, session_id, problem_hash,
                                  source_schema=_CONTEXT_V7):
    """Strict shape of the source WORK context body of a dependent task (v5).

    The active v5 shape is the only one accepted here: a v4 body never carries
    ``allowTaskContinuation``/``dependencyProvenance``, so it can never be the
    source of a dependent task. The older read-only entry points keep their own
    explicit version parameter and are not widened by this helper.
    """
    if source_schema not in (_CONTEXT_V5, _CONTEXT_V6, _CONTEXT_V7):
        _fail()
    if body.get("schemaVersion") != source_schema:
        _fail()
    if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
        _fail()
    if body.get("sourceRequestId") != source_id:
        _fail()
    if body.get("allowTaskContinuation") is not True:
        _fail()
    task = body.get("task")
    scope = body.get("scope")
    route = body.get("route")
    obligations = body.get("obligations")
    if not isinstance(task, dict) or not isinstance(scope, dict):
        _fail()
    if not isinstance(route, dict) or not isinstance(obligations, list):
        _fail()
    return task, scope, route, obligations


def _completed_work_count(history, session_id, problem_hash, upto_ordinal):
    """Count real COMPLETE valid WorkPackets at or before one ordinal."""
    count = 0
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in tuple(str(n) for n in range(1, 257)):
            continue
        if int(suffix) > upto_ordinal:
            continue
        try:
            _, packet = _source_record(history, request_id, session_id, problem_hash)
        except ProbeError:
            continue
        if packet["deliveryStatus"] != "COMPLETE":
            continue
        count += 1
    return count


def _admitted_task_count(history, session_id, problem_hash, upto_ordinal):
    """Distinct real dynamic tasks already admitted at or before one ordinal.

    A task counts once when its own WORK body declares a ``route-task-`` or
    ``dep-task-`` task id and the matching provenance field is non-null. The
    count is over distinct task ids, never over model rounds: a source child
    that issues several tool calls is still one admitted task. This is a
    profile-local derivation, not a general event-sequence recovery.
    """
    seen = set()
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in tuple(str(n) for n in range(1, 257)):
            continue
        if int(suffix) > upto_ordinal:
            continue
        entry = history.get(request_id)
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict) or request.get("phase") != "WORK":
            continue
        if request.get("sessionId") != session_id:
            continue
        if request.get("problemHash") != problem_hash:
            continue
        messages = request.get("messages")
        if not isinstance(messages, list) or len(messages) != 2:
            continue
        try:
            body = _parse_inner(messages[1]["content"])
        except ProbeError:
            continue
        if not isinstance(body, dict):
            continue
        if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
            continue
        if not _is_int(body.get("contractVersion")) or body["contractVersion"] not in (1, 2):
            continue
        if body.get("sourceRequestId") != request_id:
            continue
        task = body.get("task")
        if not isinstance(task, dict):
            continue
        task_id = task.get("taskId")
        if not isinstance(task_id, str):
            continue
        if task_id.startswith("route-task-"):
            provenance = body.get("routeProvenance")
            if provenance is None or body.get("dependencyProvenance") is not None:
                continue
        elif task_id.startswith("dep-task-"):
            provenance = body.get("dependencyProvenance")
            if provenance is None or body.get("routeProvenance") is not None:
                continue
        else:
            continue
        if not isinstance(provenance, dict):
            continue
        source_id = provenance.get("sourceRequestId")
        if not isinstance(source_id, str) or source_id not in history:
            continue
        try:
            if _ordinal(source_id) >= int(suffix):
                continue
        except ProbeError:
            continue
        seen.add(task_id)
    return len(seen)


def _expected_event_seq(history, session_id, problem_hash, source_ordinal):
    """Derived ``eventSeq`` of the next appended task in this profile.

    ``2*N + A + 2`` where ``N`` is the number of real COMPLETE valid
    WorkPackets at or before the source and ``A`` is the number of distinct
    dynamic tasks already admitted at or before the source. The first child of
    a one-work source is ``2*1 + 0 + 2 = 4``; its grandchild is
    ``2*2 + 1 + 2 = 7``. This holds only for this slice, which has no goal
    revision and no timeout continuation; it is not a general replay rule.
    """
    if not isinstance(history, dict):
        _fail()
    if not _is_int(source_ordinal) or source_ordinal < 1:
        _fail()
    prior = {}
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in tuple(str(n) for n in range(1, 257)):
            continue
        if int(suffix) > source_ordinal:
            continue
        entry = history.get(request_id)
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict):
            continue
        if request.get("sessionId") != session_id:
            continue
        if request.get("problemHash") != problem_hash:
            continue
        prior[request_id] = entry
    # Imported lazily: ``agent_history`` imports ``agent_workflow``, so a
    # top-level import here would create a cycle. The projection is pure and
    # reads only the filtered prior history, which never contains the source
    # request currently being validated.
    from .agent_history import project_artifacts

    projection = project_artifacts(prior, session_id, problem_hash)
    next_seq = projection["nextEventSeq"]
    if not _is_int(next_seq) or next_seq < 1:
        _fail()
    return next_seq


def _check_child_envelope(envelope, source_envelope, session_id, source_id, task_id, event_seq):
    """The child envelope clones the source envelope except three fields."""
    if not isinstance(envelope, dict) or not isinstance(source_envelope, dict):
        _fail()
    if envelope.get("recordId") != session_id + ":m1:dep-task:" + source_id:
        _fail()
    if envelope.get("taskId") != task_id:
        _fail()
    if envelope.get("eventSeq") != event_seq:
        _fail()
    for name in source_envelope:
        if name in ("recordId", "taskId", "eventSeq"):
            continue
        if envelope.get(name) != source_envelope[name]:
            _fail()
    if len(envelope) != len(source_envelope):
        _fail()


def _target_obligation(obligations, obligation_id, scope_id):
    """The real same-scope obligation row of the source body, or a rejection."""
    found = None
    for row in obligations:
        if not isinstance(row, dict):
            _fail()
        if row.get("obligationId") != obligation_id:
            continue
        envelope = row.get("envelope")
        if not isinstance(envelope, dict):
            _fail()
        if envelope.get("scopeId") != scope_id:
            _fail()
        if row.get("status") in ("BLOCKED", "SATISFIED"):
            _fail()
        found = row
    if found is None:
        _fail()
    return found


def check_route_provenance(body, history, source_schema=_CONTEXT_V7):
    """Re-derive the control provenance of one WORK context body.

    Returns the validated provenance dict for a real second route, or ``None``
    for a legal default-route body. Every illegal shape is a fixed rejection;
    nothing here mutates the history, the budget or any file.

    The new task's ``envelope.eventSeq`` is derived from the count ``N`` of real
    COMPLETE valid WorkPackets up to and including the source: the source task
    was compiled at seq 1 and started at seq 2, so the appended task is added at
    ``2*N + 2``. This holds only because this slice admits at most one new route
    and only after a complete work packet, with no goal revision in between; it
    is not a general event-sequence recovery algorithm.
    """
    if not isinstance(body, dict):
        _fail()
    session_id = body.get("sessionId")
    problem_hash = body.get("problemHash")
    request_id = body.get("sourceRequestId")
    _text(session_id, _MAX_SHORT)
    _hash64(problem_hash)
    _ordinal(request_id)
    task = body.get("task")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(route, dict):
        _fail()
    task_id = task.get("taskId")
    _text(task_id, _MAX_SHORT)
    # A legal dependent task inherits the real route of its source; the
    # dependency checker owns that proof, so this checker must not reject it as
    # a non-default route. The dependency checker never calls back here.
    if body.get("dependencyProvenance") is not None:
        if check_dependency_provenance(body, history, source_schema) is None:
            _fail()
        return None
    provenance = body.get("routeProvenance")
    if provenance is None:
        if route != default_route():
            _fail()
        if task_id.startswith("route-task-"):
            _fail()
        if task_id.startswith("dep-task-"):
            _fail()
        return None
    _exact_keys(provenance, _PROVENANCE_FIELDS)
    source_id = provenance["sourceRequestId"]
    _ordinal(source_id)
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    ref = provenance["sourceArtifactRef"]
    _exact_keys(ref, _REF_FIELDS)
    if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
        _fail()
    obligation_id = provenance["obligationId"]
    _text(obligation_id, _MAX_SHORT)
    route_signature = provenance["routeSignature"]
    _hash64(route_signature)
    if task_id != "route-task-" + source_id:
        _fail()
    source_body, source_packet = _source_record(
        history, source_id, session_id, problem_hash,
    )
    source_task, source_scope, source_route, source_obligations = _check_source_body(
        source_body, source_id, session_id, problem_hash, source_schema,
    )
    if source_packet["schemaVersion"] != _WORK_V2:
        _fail()
    proposal = source_packet["workflowProposal"]
    if proposal is None:
        _fail()
    if source_packet["deliveryStatus"] != "COMPLETE":
        _fail()
    if proposal["obligationId"] not in source_packet["pendingObligations"]:
        _fail()
    if proposal["obligationId"] != obligation_id:
        _fail()
    if obligation_id != source_task.get("obligationId"):
        _fail()
    scope_id = source_scope.get("scopeId")
    _hash64(scope_id)
    _target_obligation(source_obligations, obligation_id, scope_id)
    if source_packet["sessionId"] != session_id:
        _fail()
    if source_packet["problemHash"] != problem_hash:
        _fail()
    if source_packet["taskId"] != source_task.get("taskId"):
        _fail()
    if source_packet["goalId"] != source_task.get("goalId"):
        _fail()
    if source_packet["scopeId"] != scope_id:
        _fail()
    if source_packet["routeId"] != source_route.get("routeId"):
        _fail()
    if source_packet["sourceRequestId"] != source_id:
        _fail()
    expected_ref = _source_artifact_ref(history, source_id, session_id, problem_hash)
    if ref != expected_ref:
        _fail()
    derived = normalize_route(proposal["mechanism"])
    if derived["signature"] != route_signature:
        _fail()
    if route != derived:
        _fail()
    if (
        derived["operation"] == source_route.get("operation")
        and derived["construction"] == source_route.get("construction")
    ):
        _fail()
    if task.get("goalId") != source_task.get("goalId"):
        _fail()
    if task.get("obligationId") != obligation_id:
        _fail()
    if obligation_id != source_task.get("obligationId"):
        _fail()
    if task.get("scopeId") != scope_id:
        _fail()
    if task.get("inputArtifactRefs") != [] or task.get("dependencyTaskIds") != []:
        _fail()
    if task.get("expectedResult") != source_task.get("expectedResult"):
        _fail()
    if task.get("acceptanceCriteria") != source_task.get("acceptanceCriteria"):
        _fail()
    envelope = task.get("envelope")
    source_envelope = source_task.get("envelope")
    if not isinstance(envelope, dict) or not isinstance(source_envelope, dict):
        _fail()
    if envelope.get("recordId") != session_id + ":m1:route-task:" + source_id:
        _fail()
    if envelope.get("taskId") != task_id:
        _fail()
    if envelope.get("eventSeq") != _expected_event_seq(
        history, session_id, problem_hash, _ordinal(source_id),
    ):
        _fail()
    for name in source_envelope:
        if name in ("recordId", "taskId", "eventSeq"):
            continue
        if envelope.get(name) != source_envelope[name]:
            _fail()
    if len(envelope) != len(source_envelope):
        _fail()
    return {
        "sourceRequestId": source_id,
        "sourceArtifactRef": {
            "artifactId": ref["artifactId"],
            "artifactVersion": ref["artifactVersion"],
        },
        "obligationId": obligation_id,
        "routeSignature": route_signature,
    }


def check_control_route_provenance(body, history, source_schema=_CONTEXT_V7):
    """Re-derive the control-originated G2 route provenance of one WORK body.

    This is deliberately disjoint from a model ``NEW_ROUTE``: there is no v2
    proposal packet to trust. The mechanism is the fixed control mechanism, the
    source is a real COMPLETE source WORK record, the obligation is real and
    open in that source scope, and the child is the empty-dependency
    ``route-task-<source>`` task. Returns the four-field provenance or ``None``
    when the body carries no control-route marker. The Host repeats every
    derivation; it never trusts the Node-supplied route object.
    """
    if not isinstance(body, dict):
        _fail()
    provenance = body.get("controlRouteProvenance")
    if provenance is None:
        return None
    if source_schema not in (_CONTEXT_V5, _CONTEXT_V6, _CONTEXT_V7):
        _fail()
    if body.get("schemaVersion") != source_schema:
        _fail()
    if body.get("routeProvenance") is not None:
        _fail()
    if body.get("dependencyProvenance") is not None:
        _fail()
    _exact_keys(provenance, _PROVENANCE_FIELDS)
    session_id = body.get("sessionId")
    problem_hash = body.get("problemHash")
    request_id = body.get("sourceRequestId")
    _text(session_id, _MAX_SHORT)
    _hash64(problem_hash)
    _ordinal(request_id)
    task = body.get("task")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(route, dict):
        _fail()
    task_id = task.get("taskId")
    _text(task_id, _MAX_SHORT)
    source_id = provenance["sourceRequestId"]
    _ordinal(source_id)
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    ref = provenance["sourceArtifactRef"]
    _exact_keys(ref, _REF_FIELDS)
    if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
        _fail()
    obligation_id = provenance["obligationId"]
    _text(obligation_id, _MAX_SHORT)
    route_signature = provenance["routeSignature"]
    _hash64(route_signature)
    if task_id != "route-task-" + source_id:
        _fail()
    # A full-capability G2 route may be sourced from the selected CONSENSUS
    # packet as well as a direct WORK packet: both are real complete model
    # packets in the same trusted context. The other route checks still apply.
    source_body, source_packet = _source_record(
        history, source_id, session_id, problem_hash,
        phases=("WORK", "CONSENSUS"),
    )
    source_task, source_scope, source_route, source_obligations = _check_source_body(
        source_body, source_id, session_id, problem_hash, source_schema,
        require_route_proposal=False,
    )
    if source_packet["deliveryStatus"] != "COMPLETE":
        _fail()
    if source_packet["sessionId"] != session_id or source_packet["problemHash"] != problem_hash:
        _fail()
    if source_packet["taskId"] != source_task.get("taskId"):
        _fail()
    if source_packet["routeId"] != source_route.get("routeId"):
        _fail()
    if source_packet["sourceRequestId"] != source_id:
        _fail()
    scope_id = source_scope.get("scopeId")
    _hash64(scope_id)
    _target_obligation(source_obligations, obligation_id, scope_id)
    expected_ref = _source_artifact_ref(
        history, source_id, session_id, problem_hash,
        phases=("WORK", "CONSENSUS"),
    )
    if ref != expected_ref:
        _fail()
    expected_route = normalize_route(copy.deepcopy(_CONTROL_SECOND_MECHANISM))
    if route != expected_route or route_signature != expected_route["signature"]:
        _fail()
    if task.get("goalId") != source_task.get("goalId"):
        _fail()
    if task.get("obligationId") != obligation_id:
        _fail()
    if task.get("scopeId") != scope_id:
        _fail()
    if task.get("inputArtifactRefs") != [] or task.get("dependencyTaskIds") != []:
        _fail()
    _text(task.get("expectedResult"), _MAX_TEXT)
    _text(task.get("acceptanceCriteria"), _MAX_SHORT)
    envelope = task.get("envelope")
    source_envelope = source_task.get("envelope")
    if not isinstance(envelope, dict) or not isinstance(source_envelope, dict):
        _fail()
    if envelope.get("recordId") != session_id + ":m1:g2-route:" + source_id:
        _fail()
    if envelope.get("taskId") != task_id:
        _fail()
    if envelope.get("eventSeq") != _expected_event_seq(
        history, session_id, problem_hash, _ordinal(source_id),
    ):
        _fail()
    for name in source_envelope:
        if name in ("recordId", "taskId", "eventSeq"):
            continue
        if envelope.get(name) != source_envelope[name]:
            _fail()
    if len(envelope) != len(source_envelope):
        _fail()
    return {
        "sourceRequestId": source_id,
        "sourceArtifactRef": {
            "artifactId": ref["artifactId"],
            "artifactVersion": ref["artifactVersion"],
        },
        "obligationId": obligation_id,
        "routeSignature": route_signature,
    }


def check_dependency_provenance(body, history, source_schema=_CONTEXT_V7):
    """Re-derive the control provenance of one dependent-task WORK body.

    Returns the validated four-field provenance dict for a real dependent task,
    or ``None`` for a legal body that is not one. Every illegal shape is a
    fixed rejection. The source is a real COMPLETE v3 WorkPacket whose own v5
    context already passed the earlier guards; the child definition, route,
    scope, obligation, envelope and refs are all re-derived from that source
    history, never from the model's own claims. This function reads only
    already-verified source history and never calls the route checker, so the
    two checks cannot recurse.
    """
    if not isinstance(body, dict):
        _fail()
    session_id = body.get("sessionId")
    problem_hash = body.get("problemHash")
    request_id = body.get("sourceRequestId")
    _text(session_id, _MAX_SHORT)
    _hash64(problem_hash)
    _ordinal(request_id)
    task = body.get("task")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(route, dict):
        _fail()
    task_id = task.get("taskId")
    _text(task_id, _MAX_SHORT)
    provenance = body.get("dependencyProvenance")
    if provenance is None:
        # Without a proof a dependent-looking task id is never legal.
        if task_id.startswith("dep-task-"):
            _fail()
        return None
    if source_schema not in (_CONTEXT_V5, _CONTEXT_V6, _CONTEXT_V7):
        _fail()
    if body.get("schemaVersion") != source_schema:
        _fail()
    if body.get("routeProvenance") is not None:
        _fail()
    _exact_keys(provenance, _PROVENANCE_FIELDS)
    source_id = provenance["sourceRequestId"]
    _ordinal(source_id)
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    ref = provenance["sourceArtifactRef"]
    _exact_keys(ref, _REF_FIELDS)
    if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] != 1:
        _fail()
    obligation_id = provenance["obligationId"]
    _text(obligation_id, _MAX_SHORT)
    route_signature = provenance["routeSignature"]
    _hash64(route_signature)
    if task_id != "dep-task-" + source_id:
        _fail()
    source_body, source_packet = _source_record(
        history, source_id, session_id, problem_hash,
    )
    source_task, source_scope, source_route, source_obligations = (
        _check_dependency_source_body(
            source_body, source_id, session_id, problem_hash, source_schema,
        )
    )
    if source_packet["schemaVersion"] != _WORK_V3:
        _fail()
    proposal = source_packet["workflowProposal"]
    if proposal is None:
        _fail()
    if source_packet["deliveryStatus"] != "COMPLETE":
        _fail()
    if proposal["obligationId"] not in source_packet["pendingObligations"]:
        _fail()
    if proposal["obligationId"] != obligation_id:
        _fail()
    if obligation_id != source_task.get("obligationId"):
        _fail()
    scope_id = source_scope.get("scopeId")
    _hash64(scope_id)
    _target_obligation(source_obligations, obligation_id, scope_id)
    if source_packet["sessionId"] != session_id:
        _fail()
    if source_packet["problemHash"] != problem_hash:
        _fail()
    if source_packet["taskId"] != source_task.get("taskId"):
        _fail()
    if source_packet["goalId"] != source_task.get("goalId"):
        _fail()
    if source_packet["scopeId"] != scope_id:
        _fail()
    if source_packet["routeId"] != source_route.get("routeId"):
        _fail()
    if source_packet["sourceRequestId"] != source_id:
        _fail()
    expected_ref = _source_artifact_ref(history, source_id, session_id, problem_hash)
    if ref != expected_ref:
        _fail()
    if route_signature != source_route.get("signature"):
        _fail()
    # The child inherits the real route of its source, including a second
    # route; the old artifact route is never relabelled.
    if route != source_route:
        _fail()
    if not same_json(body.get("scope"), source_scope):
        _fail()
    if task.get("goalId") != source_task.get("goalId"):
        _fail()
    if task.get("obligationId") != obligation_id:
        _fail()
    if task.get("scopeId") != scope_id:
        _fail()
    if task.get("expectedResult") != source_task.get("expectedResult"):
        _fail()
    if task.get("acceptanceCriteria") != source_task.get("acceptanceCriteria"):
        _fail()
    if task.get("dependencyTaskIds") != [source_task.get("taskId")]:
        _fail()
    if task.get("inputArtifactRefs") != [expected_ref]:
        _fail()
    artifacts = body.get("inputArtifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 1:
        _fail()
    artifact = artifacts[0]
    if not isinstance(artifact, dict):
        _fail()
    if artifact.get("artifactId") != expected_ref["artifactId"]:
        _fail()
    if artifact.get("sourceRequestId") != source_id:
        _fail()
    if artifact.get("routeId") != source_route.get("routeId"):
        _fail()
    if not same_json(artifact.get("scope"), source_scope):
        _fail()
    artifact_envelope = artifact.get("envelope")
    if not isinstance(artifact_envelope, dict):
        _fail()
    if artifact_envelope.get("taskId") != source_task.get("taskId"):
        _fail()
    if not _is_int(artifact_envelope.get("artifactVersion")):
        _fail()
    if artifact_envelope["artifactVersion"] != expected_ref["artifactVersion"]:
        _fail()
    envelope = task.get("envelope")
    source_envelope = source_task.get("envelope")
    _check_child_envelope(
        envelope, source_envelope, session_id, source_id, task_id,
        _expected_event_seq(history, session_id, problem_hash, _ordinal(source_id)),
    )
    return {
        "sourceRequestId": source_id,
        "sourceArtifactRef": {
            "artifactId": ref["artifactId"],
            "artifactVersion": ref["artifactVersion"],
        },
        "obligationId": obligation_id,
        "routeSignature": route_signature,
    }
