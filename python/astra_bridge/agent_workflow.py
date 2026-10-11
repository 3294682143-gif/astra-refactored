"""Pure Host-side route-proposal helpers for the unified AgentLoop.

Strictly re-parses one raw WorkPacket (v1/v2) with the shared P0 inner parser
and derives the canonical route identity of one untrusted NEW_ROUTE mechanism.
No I/O, no client call, no budget change, no mathematical selection: a route
signature is an identity of declared data, never a proof of independence.
"""

from __future__ import annotations

import copy
import hashlib
import json

from .p0_probe import ProbeError
from .p2_host_fixture import _parse_inner, _strict_utf8

__all__ = [
    "checked_packet",
    "normalize_route",
    "default_route",
    "check_route_provenance",
]

_WORK_V1 = "p2a-work-v1"
_WORK_V2 = "p2a-work-v2"
_CONTEXT_V4 = "agent-work-context-v4"
_MAX_TEXT = 4096
_MAX_SHORT = 256
_MAX_LEMMAS = 32
_MAX_REF = 256
_REQUEST_IDS = ("model-1", "model-2", "model-3")
_PACKET_FIELDS = (
    "schemaVersion", "sessionId", "problemHash", "contractVersion", "taskId",
    "goalId", "scopeId", "routeId", "sourceRequestId", "claim", "derivation",
    "assumptions", "dependencies", "pendingObligations", "suggestedChecks",
    "deliveryStatus", "candidateProposal",
)
_PROPOSAL_FIELDS = ("kind", "obligationId", "mechanism", "rationale")
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
_WS = ("\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680", "\u2000",
       "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007",
       "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f",
       "\u3000", "\ufeff")


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
    if not allow_empty and not value.strip():
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


def _ordinal(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in ("1", "2", "3", "4"):
        _fail()
    return int(suffix)


def _is_ws(ch):
    return ch in _WS


def _trim(value):
    start = 0
    end = len(value)
    while start < end and _is_ws(value[start]):
        start += 1
    while end > start and _is_ws(value[end - 1]):
        end -= 1
    return value[start:end]


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


def checked_packet(text):
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


def _source_record(history, source_id, session_id, problem_hash):
    """Strict read of one real COMPLETE WORK record; returns (body, packet).

    The request body and the raw receipt packet are cross-checked against each
    other: the packet must be bound to the body's own task/goal/scope/route and
    to this session/problem, its declared dependencies must be a duplicate-free
    subset of the body's own ``inputArtifactRefs``, and every declared
    assumption must already be a declared scope assumption. A record that fails
    any of these is not a source, never a repaired one.
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
    if request.get("phase") != "WORK" or request.get("requestId") != source_id:
        _fail()
    if request.get("sessionId") != session_id or request.get("problemHash") != problem_hash:
        _fail()
    messages = request.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        _fail()
    body = _parse_inner(messages[1]["content"])
    if not isinstance(body, dict):
        _fail()
    packet = checked_packet(receipt["text"])
    if packet["deliveryStatus"] != "COMPLETE":
        _fail()
    if not _is_int(packet["contractVersion"]) or packet["contractVersion"] != 1:
        _fail()
    if not _is_int(body.get("contractVersion")) or body["contractVersion"] != 1:
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


def _source_artifact_ref(history, source_id, session_id, problem_hash):
    """``artifact-N`` where N counts real COMPLETE valid WorkPackets up to source."""
    if not isinstance(history, dict):
        _fail()
    source_ordinal = _ordinal(source_id)
    count = 0
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in ("1", "2", "3", "4"):
            continue
        if int(suffix) > source_ordinal:
            continue
        try:
            _, packet = _source_record(history, request_id, session_id, problem_hash)
        except ProbeError:
            continue
        if packet["deliveryStatus"] != "COMPLETE":
            continue
        count += 1
    if count < 1:
        _fail()
    return {"artifactId": "artifact-" + str(count), "artifactVersion": 1}


def _check_source_body(body, source_id, session_id, problem_hash):
    """Strict shape of the source WORK context body (v4, proposal allowed)."""
    if body.get("schemaVersion") != _CONTEXT_V4:
        _fail()
    if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
        _fail()
    if body.get("sourceRequestId") != source_id:
        _fail()
    if body.get("allowRouteProposal") is not True:
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


def check_route_provenance(body, history):
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
    provenance = body.get("routeProvenance")
    if provenance is None:
        if route != default_route():
            _fail()
        if task_id.startswith("route-task-"):
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
        source_body, source_id, session_id, problem_hash,
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
    count = 0
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in ("1", "2", "3", "4"):
            continue
        if int(suffix) > _ordinal(source_id):
            continue
        try:
            _, packet = _source_record(history, request_id, session_id, problem_hash)
        except ProbeError:
            continue
        if packet["deliveryStatus"] != "COMPLETE":
            continue
        count += 1
    if count < 1:
        _fail()
    if envelope.get("eventSeq") != 2 * count + 2:
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
