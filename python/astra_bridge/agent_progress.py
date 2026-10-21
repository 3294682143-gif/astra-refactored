"""Pure Host-side progress projection for the unified AgentLoop.

Re-derives, from the trusted request history only, which task-level yields a
real run must have recorded: a task-local ``unsolved`` action, a legal partial
WorkPacket delivery, or a second consecutive cached repeat of one task-local
effect key. No I/O, no client call, no budget change and no mathematical
selection: this helper only reports facts that already exist in the history.

The real M1 ``TASK_YIELDED`` event is appended by the composition root; this
module never mutates the history, the effects or any file.
"""

from __future__ import annotations

import copy

from .p0_probe import ProbeError
from .p0_protocol import ProtocolError
from .p2_host_fixture import _parse_inner
from .p3_host_context import effect_key, parse_action, same_json
from .agent_workflow import _trim, checked_packet, trusted_packet_binding

__all__ = [
    "PROGRESS_POLICY",
    "PROGRESS_EVENT_SCHEMA_VERSION",
    "progress_events",
    "yielded_task_ids",
    "yield_event_count_upto",
]

PROGRESS_EVENT_SCHEMA_VERSION = "agent-progress-event-v1"
PROGRESS_POLICY = {
    "schemaVersion": "agent-progress-policy-v1",
    "cachedRepeatLimit": 2,
    "taskLocalUnsolved": True,
    "partialYield": True,
}
_POLICY_FIELDS = (
    "schemaVersion", "cachedRepeatLimit", "taskLocalUnsolved", "partialYield",
)
_CONTEXT_V7 = "agent-work-context-v7"
_ORDINALS = tuple(str(n) for n in range(1, 257))
_REASONS = ("UNSOLVED", "PARTIAL", "REPEATED_EFFECT")
_PARTIAL_DELIVERY = ("INCOMPLETE", "TRUNCATED", "ERROR")
_MAX_TEXT = 4096


def _fail():
    raise ProbeError("FIELD_VALUE")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _ordinal(request_id):
    if not isinstance(request_id, str) or not request_id.startswith("model-"):
        _fail()
    suffix = request_id[len("model-"):]
    if suffix not in _ORDINALS:
        _fail()
    return int(suffix)


def _ordered(history):
    rows = []
    for request_id in history:
        if not isinstance(request_id, str) or not request_id.startswith("model-"):
            continue
        suffix = request_id[len("model-"):]
        if suffix not in _ORDINALS:
            continue
        rows.append((int(suffix), request_id))
    rows.sort()
    return rows


def _policy_ok(value):
    """Exact identity of the fixed policy; a mismatch is a rejection.

    ``same_json`` is byte-exact, so a JSON ``true`` never collapses into ``1``
    and a missing or extra field is never accepted. A v7 body that carries a
    different policy is a fixed rejection, never a silent skip.
    """
    if not isinstance(value, dict):
        _fail()
    if set(value.keys()) != set(_POLICY_FIELDS) or len(value) != len(_POLICY_FIELDS):
        _fail()
    if not same_json(value, PROGRESS_POLICY):
        _fail()
    return True


def _body_of(entry):
    request = entry.get("request")
    if not isinstance(request, dict) or request.get("phase") != "WORK":
        return None
    messages = request.get("messages")
    if not isinstance(messages, list) or len(messages) != 2:
        return None
    try:
        body = _parse_inner(messages[1]["content"])
    except ProbeError:
        return None
    if not isinstance(body, dict):
        return None
    return body


def _binding_of(request_id, request, body):
    task = body.get("task")
    scope = body.get("scope")
    if not isinstance(task, dict) or not isinstance(scope, dict):
        _fail()
    return {
        "sessionId": request["sessionId"],
        "problemHash": request["problemHash"],
        "contractVersion": 1,
        "taskId": task.get("taskId"),
        "scopeId": scope.get("scopeId"),
        "sourceRequestId": request_id,
    }


def _earlier_effect(history, effects, task_id, current_ordinal, key):
    """True when one real earlier effect of this task has the same key."""
    if effects is not None:
        for entry in effects:
            if not isinstance(entry, dict):
                continue
            request = entry.get("request")
            receipt = entry.get("receipt")
            if not isinstance(request, dict) or not isinstance(receipt, dict):
                continue
            binding = request.get("binding")
            if not isinstance(binding, dict):
                continue
            if binding.get("taskId") != task_id:
                continue
            source_id = binding.get("sourceRequestId")
            if not isinstance(source_id, str):
                continue
            try:
                if _ordinal(source_id) >= current_ordinal:
                    continue
            except (ProbeError, ProtocolError):
                continue
            if receipt.get("status") not in ("COMPLETE", "ERROR"):
                continue
            action = request.get("action")
            if not isinstance(action, dict):
                continue
            try:
                if effect_key(action) == key:
                    return True
            except (ProbeError, ProtocolError):
                continue
        return False
    return False


def _observations_cached(history, body, task_id, current_ordinal, key):
    """Fallback: re-derive an earlier real effect from verified observations."""
    observations = body.get("toolObservations")
    if not isinstance(observations, list):
        return False
    for receipt in observations:
        if not isinstance(receipt, dict):
            continue
        binding = receipt.get("binding")
        if not isinstance(binding, dict):
            continue
        if binding.get("taskId") != task_id:
            continue
        source_id = binding.get("sourceRequestId")
        if not isinstance(source_id, str):
            continue
        try:
            if _ordinal(source_id) >= current_ordinal:
                continue
        except (ProbeError, ProtocolError):
            continue
        if receipt.get("status") not in ("COMPLETE", "ERROR"):
            continue
        entry = history.get(source_id)
        if not isinstance(entry, dict):
            continue
        record = entry.get("receipt")
        if not isinstance(record, dict) or record.get("transportStatus") != "COMPLETE":
            continue
        text = record.get("text")
        if not isinstance(text, str):
            continue
        source_request = entry.get("request")
        if not isinstance(source_request, dict):
            continue
        source_body = _body_of(entry)
        if source_body is None:
            continue
        try:
            binding_row = _binding_of(source_id, source_request, source_body)
            action = parse_action(text, binding_row)
        except (ProbeError, ProtocolError):
            continue
        if action.get("action") not in ("tool", "method"):
            continue
        try:
            if effect_key(action) == key:
                return True
        except (ProbeError, ProtocolError):
            continue
    return False


def _partial_packet(history, request_id, body, session_id, problem_hash):
    """True when this record is a legal partial WorkPacket delivery."""
    entry = history.get(request_id)
    if not isinstance(entry, dict):
        return False
    receipt = entry.get("receipt")
    if not isinstance(receipt, dict) or receipt.get("transportStatus") != "COMPLETE":
        return False
    text = receipt.get("text")
    if not isinstance(text, str):
        return False
    try:
        binding = trusted_packet_binding(body, request_id)
        if binding is None:
            return False
        packet = checked_packet(text, binding)
    except ProbeError:
        return False
    if packet["deliveryStatus"] not in _PARTIAL_DELIVERY:
        return False
    if not _is_int(packet["contractVersion"]) or packet["contractVersion"] not in (1, 2):
        return False
    if not _is_int(body.get("contractVersion")) or body["contractVersion"] not in (1, 2):
        return False
    task = body.get("task")
    scope = body.get("scope")
    route = body.get("route")
    if not isinstance(task, dict) or not isinstance(scope, dict) or not isinstance(route, dict):
        return False
    if packet["sessionId"] != session_id or packet["problemHash"] != problem_hash:
        return False
    if packet["sourceRequestId"] != request_id:
        return False
    if packet["taskId"] != task.get("taskId") or packet["goalId"] != task.get("goalId"):
        return False
    if packet["scopeId"] != scope.get("scopeId") or packet["routeId"] != route.get("routeId"):
        return False
    allowed = scope.get("localAssumptions")
    if not isinstance(allowed, list):
        return False
    for assumption in packet["assumptions"]:
        if assumption not in allowed:
            return False
    refs = task.get("inputArtifactRefs")
    if not isinstance(refs, list):
        return False
    declared = []
    for ref in refs:
        if not isinstance(ref, dict):
            return False
        if set(ref.keys()) != {"artifactId", "artifactVersion"} or len(ref) != 2:
            return False
        artifact_id = ref["artifactId"]
        if not isinstance(artifact_id, str) or not artifact_id:
            return False
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
            return False
        pair = (artifact_id, ref["artifactVersion"])
        if pair in declared:
            return False
        declared.append(pair)
    seen = []
    for ref in packet["dependencies"]:
        if not isinstance(ref, dict):
            return False
        pair = (ref.get("artifactId"), ref.get("artifactVersion"))
        if pair in seen or pair not in declared:
            return False
        seen.append(pair)
    if not isinstance(packet["claim"], str) or not _trim(packet["claim"]):
        return False
    if not isinstance(packet["derivation"], str) or not _trim(packet["derivation"]):
        return False
    return True


def progress_events(history, effects=None):
    """Project the real task-level yield events of one session history.

    Returns a list of ``{"schemaVersion", "taskId", "sourceRequestId",
    "reason"}`` rows in root model-ordinal order. Only an active v7 WORK body
    whose fixed ``progressPolicy`` matches exactly, that is not a redo body and
    whose receipt is COMPLETE is considered. A task that already yielded and
    then issued a later WORK request is a fixed rejection. Nothing is mutated.
    """
    if not isinstance(history, dict):
        _fail()
    events = []
    yielded = set()
    counters = {}
    for ordinal, request_id in _ordered(history):
        entry = history.get(request_id)
        if not isinstance(entry, dict):
            continue
        body = _body_of(entry)
        if body is None:
            continue
        if body.get("schemaVersion") != _CONTEXT_V7:
            continue
        _policy_ok(body.get("progressPolicy"))
        task = body.get("task")
        if not isinstance(task, dict):
            continue
        task_id = task.get("taskId")
        if not isinstance(task_id, str):
            continue
        # A task that already yielded must never be scheduled again, even when
        # this later receipt is not COMPLETE: the check precedes the transport
        # filter so an UNKNOWN/TRUNCATED re-dispatch is still a rejection.
        if task_id in yielded:
            _fail()
        # A real redo body does not participate in progress projection. The
        # yielded-task check above runs first, so a forged redo that re-dispatches
        # an already yielded task is still a fixed rejection.
        if body.get("revisionProvenance") is not None:
            continue
        receipt = entry.get("receipt")
        if not isinstance(receipt, dict) or receipt.get("transportStatus") != "COMPLETE":
            continue
        text = receipt.get("text")
        if not isinstance(text, str):
            continue
        session_id = body.get("sessionId")
        problem_hash = body.get("problemHash")
        if not isinstance(session_id, str) or not isinstance(problem_hash, str):
            continue
        try:
            binding = _binding_of(request_id, entry["request"], body)
            action = parse_action(text, binding)
        except (ProbeError, ProtocolError):
            action = None
        # An action that the current context did not advertise is the original
        # Loop's CONTROL_REJECTED raw action, not a Host violation: it produces
        # no yield and no cache count, and the projection simply continues. Only
        # a forged context policy or a re-dispatch of an already yielded task is
        # a fixed rejection.
        if isinstance(action, dict) and action.get("action") in ("tool", "method"):
            flag = "allowMethods" if action.get("action") == "method" else "allowTools"
            if body.get(flag) is not True:
                continue
        reason = None
        if isinstance(action, dict) and action.get("action") == "unsolved":
            reason = "UNSOLVED"
        elif _partial_packet(history, request_id, body, session_id, problem_hash):
            reason = "PARTIAL"
        elif isinstance(action, dict) and action.get("action") in ("tool", "method"):
            try:
                key = effect_key(action)
            except (ProbeError, ProtocolError):
                key = None
            if key is not None:
                cached = _earlier_effect(history, effects, task_id, ordinal, key)
                if not cached and effects is None:
                    cached = _observations_cached(
                        history, body, task_id, ordinal, key,
                    )
                previous = counters.get(task_id)
                if not cached:
                    counters[task_id] = {"key": key, "hits": 0}
                elif previous is None or previous["key"] != key:
                    counters[task_id] = {"key": key, "hits": 1}
                else:
                    hits = previous["hits"] + 1
                    counters[task_id] = {"key": key, "hits": hits}
                    if hits >= PROGRESS_POLICY["cachedRepeatLimit"]:
                        reason = "REPEATED_EFFECT"
        if reason is None:
            continue
        if reason not in _REASONS:
            _fail()
        yielded.add(task_id)
        events.append({
            "schemaVersion": PROGRESS_EVENT_SCHEMA_VERSION,
            "taskId": task_id,
            "sourceRequestId": request_id,
            "reason": reason,
        })
    return copy.deepcopy(events)


def yielded_task_ids(history, effects=None):
    """Task ids that already yielded, in first-yield order."""
    return [row["taskId"] for row in progress_events(history, effects)]


def yield_event_count_upto(history, upto_ordinal, effects=None):
    """Number of real yield events at or before one root model ordinal."""
    if not _is_int(upto_ordinal) or upto_ordinal < 1:
        _fail()
    count = 0
    for row in progress_events(history, effects):
        if _ordinal(row["sourceRequestId"]) <= upto_ordinal:
            count += 1
    return count
