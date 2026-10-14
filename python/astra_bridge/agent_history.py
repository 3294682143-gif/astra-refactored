"""Pure Host-side artifact ledger projection for the unified AgentLoop.

Re-derives every artifact row, its version, its availability and its exact
raw bytes from the trusted request history only. No I/O, no client call, no
mathematical selection: a row is a projection of real COMPLETE WORK records,
never of a model claim.

The projected row is a flat record whose authoritative version lives in
``row["envelope"]["artifactVersion"]``; there is no separate top-level
``artifactVersion`` field, so no pseudo P2Artifact field is invented. The
``availability`` key is projection metadata only and is stripped before a row
is handed to a caller as a P2Artifact.
"""

from __future__ import annotations

import copy
import hashlib

from .p0_probe import ProbeError
from .p2_host_fixture import _parse_inner
from .p3_host_context import same_json as _same_json
from .agent_workflow import _source_record, checked_packet
from .text_contract import JS_WHITESPACE, js_nonempty, js_trim

__all__ = ["project_artifacts", "artifact_view", "check_revision_context"]

_ORDINALS = tuple(str(n) for n in range(1, 33))
_ENVELOPE_FIELDS = (
    "recordId", "sessionId", "problemHash", "sourceModule", "taskId",
    "contractVersion", "artifactId", "artifactVersion", "scopeId",
    "causeEventId", "eventSeq",
)
_REVISION_FIELDS = (
    "sourceRequestId", "sourceArtifactRef", "targetArtifactRef",
    "targetSourceRequestId", "targetHash",
)
_REF_FIELDS = ("artifactId", "artifactVersion")
_WORK_V4 = "p2a-work-v4"
_WORK_V5 = "p2a-work-v5"
_REPAIR_SCHEMA_VERSION = "p4-repair-context-v1"
_CONTEXT_V6 = "agent-work-context-v6"
_CONTEXT_V7 = "agent-work-context-v7"
_MAX_TEXT = 4096
_MAX_SHORT = 256
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


def _text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail()
    if not allow_empty and not js_nonempty(value):
        _fail()
    if len(value) > max_chars:
        _fail()
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail()
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
    if suffix not in _ORDINALS:
        _fail()
    return int(suffix)


def _is_ws(ch):
    return ch in _WS


def _js_trim(value):
    """ECMAScript ``String.prototype.trim`` over the shared whitespace set."""
    if not isinstance(value, str):
        _fail()
    return js_trim(value)


def _row_version(row):
    """Authoritative version of one projected row: envelope, never a copy."""
    envelope = row.get("envelope")
    if not isinstance(envelope, dict):
        _fail()
    version = envelope.get("artifactVersion")
    if not _is_int(version) or version < 1:
        _fail()
    return version


def _row_ref(row):
    artifact_id = row.get("artifactId")
    if not isinstance(artifact_id, str):
        _fail()
    return {"artifactId": artifact_id, "artifactVersion": _row_version(row)}


def artifact_view(row):
    """One projected row as a P2Artifact: projection metadata is stripped.

    ``availability`` is a ledger-projection field, not part of the artifact
    shape, so it is removed here; every other key, including the exact raw
    receipt bytes and the full packet, is copied unchanged.
    """
    if not isinstance(row, dict):
        _fail()
    view = {}
    for name, value in row.items():
        if name == "availability":
            continue
        view[name] = value
    return copy.deepcopy(view)


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


def _body_of(entry, phases=("WORK",)):
    request = entry.get("request")
    if not isinstance(request, dict) or request.get("phase") not in phases:
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


def _material(packet):
    return [
        packet["claim"],
        packet["derivation"],
        packet["assumptions"],
        packet["dependencies"],
        packet["candidateProposal"],
    ]


def _same_ref(left, right):
    return (
        left["artifactId"] == right["artifactId"]
        and left["artifactVersion"] == right["artifactVersion"]
    )


def _closure(rows, target_ref):
    """Exact invalidation closure: the target plus its transitive successors."""
    stale = [target_ref]
    changed = True
    while changed:
        changed = False
        for row in rows:
            ref = _row_ref(row)
            if any(_same_ref(ref, item) for item in stale):
                continue
            for dep in row["dependencies"]:
                if any(_same_ref(dep, item) for item in stale):
                    stale.append(ref)
                    changed = True
                    break
    return stale


def _find_row(rows, ref):
    """The one projected row of an exact ref, or ``None``."""
    if not isinstance(ref, dict):
        return None
    for row in rows:
        if (
            row.get("artifactId") == ref.get("artifactId")
            and _row_version(row) == ref.get("artifactVersion")
        ):
            return row
    return None


def _latest_row(rows, artifact_id):
    """The highest-version projected row of one artifact id, or ``None``."""
    best = None
    for row in rows:
        if row.get("artifactId") != artifact_id:
            continue
        if best is None or _row_version(row) > _row_version(best):
            best = row
    return best


def project_artifacts(history, session_id, problem_hash):
    """Project the real artifact ledger of one session from its history.

    Returns ``{"rows": [...], "bySourceRef": {...}}``. Every row keeps the
    exact raw receipt bytes of its own real COMPLETE WORK record; a redo row
    reuses the same artifact id with version old+1 and marks the exact
    invalidation closure of its target STALE. Nothing is invented.

    The returned mapping is a deep copy: the caller never receives a live
    reference into the projection's own working rows.
    """
    if not isinstance(history, dict):
        _fail()
    # Imported lazily: ``agent_progress`` imports ``agent_workflow``, so a
    # top-level import here would create a workflow -> history -> progress ->
    # workflow cycle. The helper is pure and reads only this history.
    from .agent_progress import progress_events

    yield_by_request = {}
    for row in progress_events(history):
        yield_by_request[row["sourceRequestId"]] = row
    rows = []
    by_source = {}
    next_seq = 2
    active_task = None
    seen_dynamic = set()
    seen_redo_sources = set()
    finished_redo = False
    for _, request_id in _ordered(history):
        entry = history.get(request_id)
        if not isinstance(entry, dict):
            continue
        body = _body_of(entry, ("WORK", "REPAIR"))
        if body is None:
            continue
        if finished_redo:
            # A committed replacement ends the WORK phase of this profile: no
            # later WORK record may be projected as a new artifact. This is a
            # bounded profile rule, not a general replay algorithm.
            _fail()
        if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
            continue
        task = body.get("task")
        if not isinstance(task, dict):
            continue
        task_id = task.get("taskId")
        if not isinstance(task_id, str):
            continue
        if body.get("schemaVersion") == _REPAIR_SCHEMA_VERSION:
            # G3/PR4: one revised candidate delivered by the single REPAIR call.
            # It is projected as one new ACTIVE artifact (version 1); the parent
            # artifact keeps its own row. Nothing is invented: the row carries the
            # exact repair receipt bytes and the parsed revised packet.
            try:
                packet = checked_packet(entry["receipt"]["text"])
            except ProbeError:
                continue
            if not isinstance(packet, dict) or packet.get("deliveryStatus") != "COMPLETE":
                continue
            refs = task.get("inputArtifactRefs")
            if not isinstance(refs, list):
                _fail()
            dependencies = []
            for ref in refs:
                _exact_keys(ref, _REF_FIELDS)
                dependencies.append({
                    "artifactId": _text(ref["artifactId"], _MAX_SHORT),
                    "artifactVersion": ref["artifactVersion"],
                })
            raw = entry["receipt"]["text"]
            if not isinstance(raw, str):
                _fail()
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
            artifact_id = "repair-" + str(len(rows) + 1)
            row = {
                "envelope": {
                    "recordId": session_id + ":m3:artifact:" + str(next_seq),
                    "sessionId": session_id,
                    "problemHash": problem_hash,
                    "sourceModule": "M3",
                    "taskId": task_id,
                    "contractVersion": 1,
                    "artifactId": artifact_id,
                    "artifactVersion": 1,
                    "scopeId": task.get("scopeId"),
                    "causeEventId": session_id + ":event:" + str(next_seq),
                    "eventSeq": next_seq,
                },
                "artifactId": artifact_id,
                "routeId": body.get("route", {}).get("routeId"),
                "scope": None,
                "dependencies": dependencies,
                "sourceRequestId": request_id,
                "rawResponseHash": digest,
                "rawResponseRef": session_id + ":raw:" + request_id,
                "rawResponseText": raw,
                "packet": packet,
                "transportStatus": "COMPLETE",
                "deliveryStatus": "COMPLETE",
                "level": "PROVISIONAL",
                "checkResult": "UNKNOWN",
                "provisionalDependency": bool(refs),
                "availability": "ACTIVE",
            }
            rows.append(row)
            by_source[request_id] = row
            next_seq += 1
            continue
        envelope = task.get("envelope")
        if not isinstance(envelope, dict):
            continue
        provenance = body.get("routeProvenance")
        if provenance is None:
            provenance = body.get("dependencyProvenance")
        if provenance is not None and task_id not in seen_dynamic:
            if envelope.get("eventSeq") != next_seq:
                _fail()
            seen_dynamic.add(task_id)
            next_seq += 1
        revision = body.get("revisionProvenance")
        if isinstance(revision, dict):
            source_id = revision.get("sourceRequestId")
            if isinstance(source_id, str) and source_id not in seen_redo_sources:
                seen_redo_sources.add(source_id)
                next_seq += 1
        if active_task != task_id:
            next_seq += 1
            active_task = task_id
        # A real task-level yield of this request advances the control sequence
        # by one step and clears the active task, before any packet handling:
        # an unsolved or repeated-cache WORK has no delivery artifact. A PARTIAL
        # yield is not skipped here: its real partial packet is still projected
        # below as one accepted artifact and then advances the sequence again.
        yield_row = yield_by_request.get(request_id)
        if yield_row is not None and yield_row["reason"] != "PARTIAL":
            next_seq += 1
            active_task = None
            continue
        try:
            _, packet = _source_record(
                history, request_id, session_id, problem_hash, require_complete=False,
            )
        except ProbeError:
            continue
        if not js_nonempty(packet["claim"]) or not js_nonempty(packet["derivation"]):
            continue
        raw = entry["receipt"]["text"]
        if not isinstance(raw, str):
            _fail()
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        stale_refs = None
        if isinstance(revision, dict):
            target_ref = revision.get("targetArtifactRef")
            if not isinstance(target_ref, dict):
                _fail()
            old = _find_row(rows, target_ref)
            if old is None or old["availability"] != "ACTIVE":
                _fail()
            if old["rawResponseHash"] != revision.get("targetHash"):
                _fail()
            if old["sourceRequestId"] != revision.get("targetSourceRequestId"):
                _fail()
            if old["routeId"] != body.get("route", {}).get("routeId"):
                _fail()
            if old["envelope"]["taskId"] != task_id:
                _fail()
            if old["packet"] is None:
                _fail()
            if packet["deliveryStatus"] != "COMPLETE":
                # A redo whose replacement packet is not COMPLETE never
                # produces a new version and never invalidates the target: the
                # projection-only partial relaxation must not leak into redo.
                continue
            if _material(old["packet"]) == _material(packet):
                continue
            # The closure is computed over the rows that already exist, before
            # the new version is appended, so the new row is never its own
            # successor.
            stale_refs = _closure(rows, _row_ref(old))
            for row in rows:
                ref = _row_ref(row)
                if any(_same_ref(ref, item) for item in stale_refs):
                    row["availability"] = "STALE"
            artifact_id = old["artifactId"]
            version = _row_version(old) + 1
        else:
            artifact_id = "artifact-" + str(len(rows) + 1)
            version = 1
        refs = task.get("inputArtifactRefs")
        if not isinstance(refs, list):
            _fail()
        dependencies = []
        for ref in refs:
            _exact_keys(ref, _REF_FIELDS)
            artifact_ref = _text(ref["artifactId"], _MAX_SHORT)
            if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
                _fail()
            dependencies.append({
                "artifactId": artifact_ref,
                "artifactVersion": ref["artifactVersion"],
            })
        row = {
            "envelope": {
                "recordId": session_id + ":m3:artifact:" + str(next_seq),
                "sessionId": session_id,
                "problemHash": problem_hash,
                "sourceModule": "M3",
                "taskId": task_id,
                "contractVersion": 1,
                "artifactId": artifact_id,
                "artifactVersion": version,
                "scopeId": task.get("scopeId"),
                "causeEventId": session_id + ":event:" + str(envelope.get("eventSeq")),
                "eventSeq": next_seq,
            },
            "artifactId": artifact_id,
            "routeId": body.get("route", {}).get("routeId"),
            "scope": body.get("scope"),
            "dependencies": dependencies,
            "sourceRequestId": request_id,
            "rawResponseHash": digest,
            "rawResponseRef": session_id + ":raw:" + request_id,
            "rawResponseText": raw,
            "packet": packet,
            "transportStatus": "COMPLETE",
            "deliveryStatus": packet["deliveryStatus"],
            "level": "PROVISIONAL",
            "checkResult": "UNKNOWN",
            "provisionalDependency": bool(task.get("inputArtifactRefs")),
            "availability": "ACTIVE",
        }
        rows.append(row)
        by_source[request_id] = row
        if packet["deliveryStatus"] != "COMPLETE":
            # A real partial delivery keeps its exact raw bytes, hash, packet
            # and actual delivery status; it counts as one accepted artifact
            # and then yields its task, so the sequence advances twice.
            next_seq += 1
            if yield_row is not None:
                next_seq += 1
            active_task = None
            continue
        if stale_refs is None:
            next_seq += 1
        else:
            # A real replacement advances the control sequence by the new
            # artifact only. The exact stale closure and the affected tasks are
            # reported by the caller's own projection; no post-redo M1 sequence
            # is fabricated here.
            next_seq += 1
            finished_redo = True
        active_task = None
    return copy.deepcopy({
        "rows": rows,
        "bySourceRef": by_source,
        "nextEventSeq": next_seq,
    })


def check_revision_context(body, history, session_id, problem_hash,
                           source_schema=_CONTEXT_V6):
    """Re-derive the control provenance of one redo WORK context body.

    Returns the validated five-field provenance dict for a real redo request,
    or ``None`` for a legal body that is not one. Every illegal shape is a
    fixed rejection. The source is a real COMPLETE v4 WorkPacket whose own v6
    context already passed the earlier guards; the target, the redo task
    definition and the current inputs are all re-derived from that source
    history, never from the model's own claims.
    """
    if not isinstance(body, dict):
        _fail()
    if source_schema not in (_CONTEXT_V6, _CONTEXT_V7):
        _fail()
    if body.get("schemaVersion") != source_schema:
        _fail()
    if body.get("sessionId") != session_id or body.get("problemHash") != problem_hash:
        _fail()
    if not _is_int(body.get("contractVersion")) or body["contractVersion"] != 1:
        _fail()
    request_id = body.get("sourceRequestId")
    _ordinal(request_id)
    provenance = body.get("revisionProvenance")
    if provenance is None:
        if body.get("revisionTarget") is not None:
            _fail()
        return None
    _exact_keys(provenance, _REVISION_FIELDS)
    source_id = provenance["sourceRequestId"]
    _ordinal(source_id)
    if _ordinal(source_id) >= _ordinal(request_id):
        _fail()
    target_source_id = provenance["targetSourceRequestId"]
    _ordinal(target_source_id)
    if _ordinal(target_source_id) > _ordinal(source_id):
        _fail()
    target_ref = provenance["targetArtifactRef"]
    _exact_keys(target_ref, _REF_FIELDS)
    _text(target_ref["artifactId"], _MAX_SHORT)
    if not _is_int(target_ref["artifactVersion"]) or target_ref["artifactVersion"] < 1:
        _fail()
    _hash64(provenance["targetHash"])
    prior = {}
    for ordinal, other_id in _ordered(history):
        if ordinal < _ordinal(request_id):
            prior[other_id] = history[other_id]
    projection = project_artifacts(prior, session_id, problem_hash)
    rows = projection["rows"]
    by_source = projection["bySourceRef"]
    source_row = by_source.get(source_id)
    target_row = by_source.get(target_source_id)
    if not isinstance(source_row, dict) or not isinstance(target_row, dict):
        _fail()
    if source_row["availability"] != "ACTIVE" or target_row["availability"] != "ACTIVE":
        _fail()
    if not _same_ref(_row_ref(target_row), target_ref):
        _fail()
    if _latest_row(rows, target_ref["artifactId"]) is not target_row:
        _fail()
    if target_row["rawResponseHash"] != provenance["targetHash"]:
        _fail()
    source_entry = history.get(source_id)
    if not isinstance(source_entry, dict):
        _fail()
    source_body = _body_of(source_entry)
    if source_body is None:
        _fail()
    if source_body.get("allowArtifactRedo") is not True:
        _fail()
    source_packet = source_row["packet"]
    if source_packet.get("schemaVersion") not in (_WORK_V4, _WORK_V5):
        _fail()
    proposal = source_packet["workflowProposal"]
    if not isinstance(proposal, dict) or proposal.get("kind") != "REDO_ARTIFACT":
        _fail()
    if not _js_trim(proposal["rationale"]):
        _fail()
    declared = proposal["targetArtifactRef"]
    if declared is None:
        if not _same_ref(_row_ref(source_row), target_ref):
            _fail()
    else:
        _exact_keys(declared, _REF_FIELDS)
        if not any(_same_ref(declared, dep) for dep in source_row["dependencies"]):
            _fail()
        if not _same_ref(declared, target_ref):
            _fail()
    target_body = _body_of(history.get(target_source_id))
    if target_body is None:
        _fail()
    target_task = target_body.get("task")
    source_task = source_body.get("task")
    current_task = body.get("task")
    if not isinstance(target_task, dict) or not isinstance(source_task, dict):
        _fail()
    if not isinstance(current_task, dict):
        _fail()
    obligation_id = target_task.get("obligationId")
    _text(obligation_id, _MAX_SHORT)
    if obligation_id not in source_packet["pendingObligations"]:
        _fail()
    obligations = target_body.get("obligations")
    if not isinstance(obligations, list):
        _fail()
    found = False
    for row in obligations:
        if not isinstance(row, dict):
            _fail()
        if row.get("obligationId") != obligation_id:
            continue
        if row.get("status") in ("SATISFIED", "BLOCKED"):
            _fail()
        found = True
    if not found:
        _fail()
    if not _same_json(source_body.get("scope"), body.get("scope")):
        _fail()
    if not _same_json(target_body.get("scope"), body.get("scope")):
        _fail()
    if not _same_json(source_body.get("route"), body.get("route")):
        _fail()
    if not _same_json(target_body.get("route"), body.get("route")):
        _fail()
    if source_body.get("contractVersion") != body.get("contractVersion"):
        _fail()
    if target_body.get("contractVersion") != body.get("contractVersion"):
        _fail()
    for name in (
        "envelope", "goalId", "obligationId", "scopeId", "inputArtifactRefs",
        "dependencyTaskIds", "expectedResult", "acceptanceCriteria",
    ):
        if not _same_json(current_task.get(name), target_task.get(name)):
            _fail()
    if current_task.get("taskId") != target_task.get("taskId"):
        _fail()
    if current_task.get("delivery") != "RUNNING":
        _fail()
    if not _same_json(artifact_view(target_row), body.get("revisionTarget")):
        _fail()
    stale = _closure(rows, _row_ref(target_row))
    refs = current_task.get("inputArtifactRefs")
    if not isinstance(refs, list):
        _fail()
    for ref in refs:
        _exact_keys(ref, _REF_FIELDS)
        _text(ref["artifactId"], _MAX_SHORT)
        if not _is_int(ref["artifactVersion"]) or ref["artifactVersion"] < 1:
            _fail()
        if any(_same_ref(ref, item) for item in stale):
            _fail()
        row = _latest_row(rows, ref["artifactId"])
        if row is None or row["availability"] != "ACTIVE":
            _fail()
        if not _same_ref(_row_ref(row), ref):
            _fail()
        if row["routeId"] != body.get("route", {}).get("routeId"):
            _fail()
        if not _same_json(row["scope"], body.get("scope")):
            _fail()
    expected = {
        "sourceRequestId": source_id,
        "sourceArtifactRef": {
            "artifactId": source_row["artifactId"],
            "artifactVersion": _row_version(source_row),
        },
        "targetArtifactRef": {
            "artifactId": target_ref["artifactId"],
            "artifactVersion": target_ref["artifactVersion"],
        },
        "targetSourceRequestId": target_source_id,
        "targetHash": provenance["targetHash"],
    }
    _exact_keys(expected["sourceArtifactRef"], _REF_FIELDS)
    if not _is_int(expected["sourceArtifactRef"]["artifactVersion"]):
        _fail()
    provided_source_ref = provenance["sourceArtifactRef"]
    _exact_keys(provided_source_ref, _REF_FIELDS)
    _text(provided_source_ref["artifactId"], _MAX_SHORT)
    if not _is_int(provided_source_ref["artifactVersion"]) or provided_source_ref["artifactVersion"] < 1:
        _fail()
    if not _same_ref(expected["sourceArtifactRef"], provided_source_ref):
        _fail()
    if not _same_json(expected, provenance):
        _fail()
    return copy.deepcopy(expected)
