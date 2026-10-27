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
from .p0_protocol import ProtocolError
from .answer_semantics import canonical_answer_key, component_agreement_scores
from .p2_host_fixture import _parse_inner
from .p3_host_context import parse_action, same_json as _same_json
from .agent_workflow import _source_record, checked_packet, trusted_packet_binding
from .text_contract import JS_WHITESPACE, js_nonempty, js_trim

__all__ = [
    "project_artifacts",
    "artifact_view",
    "ballot_choice",
    "check_revision_context",
]

_ORDINALS = tuple(str(n) for n in range(1, 257))
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


def _is_certified_packet(packet):
    """Mirror the Node CERT1|FINAL selection rule (data only, not a proof)."""
    if not isinstance(packet, dict):
        return False
    checks = packet.get("suggestedChecks")
    if not isinstance(checks, list):
        return False
    final = any(
        isinstance(row, str) and row.startswith("CERT1|FINAL|") for row in checks
    )
    checks_rows = any(
        isinstance(row, str)
        and row.startswith("CERT1|CHECK|")
        and "=>" in row
        for row in checks
    )
    return final and checks_rows


def ballot_choice(candidate_ids):
    """The Node majority vote over ``(candidate_id, candidate)`` pairs.

    The count is over CANONICAL answer keys, so ``1/2`` and ``\\frac12`` are one
    vote instead of two minorities. The winner is the LAST candidate whose key
    carries the top count (the Node loop scans its attempts backwards), which is
    also the latest tie-break. The returned id is the raw packet the Node
    delivers; the key never replaces the delivered candidate.
    """
    keys = {
        candidate_id: canonical_answer_key(candidate)
        for candidate_id, candidate in candidate_ids
    }
    counts = {}
    for _candidate_id, _candidate in candidate_ids:
        key = keys[_candidate_id]
        counts[key] = counts.get(key, 0) + 1
    best = max(counts.values())
    if best < 2:
        # No whole-answer majority at all: every ballot is a distinct answer, so
        # the whole-answer vote would just take the last reply. On a multi-part
        # question the ballots usually still agree component by component, so the
        # ballot matching the most component majorities is the strongest real
        # packet; the Node loop applies exactly the same tie-break.
        scores = component_agreement_scores(
            [candidate for _candidate_id, candidate in candidate_ids]
        )
        top = max(scores)
        for index in range(len(candidate_ids) - 1, -1, -1):
            if scores[index] == top:
                return candidate_ids[index][0]
        return candidate_ids[-1][0]
    return next(
        candidate_id
        for candidate_id, _candidate in reversed(candidate_ids)
        if counts[keys[candidate_id]] == best
    )


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

    # Consensus/schema-repair turns may issue several WORK/CONSENSUS packets for
    # the same still-undelivered task. Only the last valid packet in that run is
    # the artifact the Node delivers. Collapse each such run to the last packet
    # with a candidate when one exists; otherwise to the last valid packet. This
    # keeps the Host projection's artifact ordinals and event sequence identical
    # to the delivered WORKUNIT, while every discarded model call remains in the
    # authenticated history.
    ordered = _ordered(history)
    superseded_normal_ids = set()
    normal_packets = {}
    run_ids = []
    run_task = None

    def flush_normal_run():
        nonlocal run_ids, run_task
        if not run_ids:
            run_task = None
            return
        candidate_ids = []
        for candidate_id in run_ids:
            packet = normal_packets.get(candidate_id)
            if isinstance(packet, dict):
                candidate = packet.get("candidateProposal")
                # Node keeps only non-empty candidates in consensusAttempts
                # (``candidate.length > 0`` on artifacts that already passed
                # ``candidateProposal.trim().length > 0``). Mirror that with the
                # shared JavaScript whitespace set; an empty candidate packet is
                # a draft, never a ballot or a tie-break winner.
                # Node's `evaluateConsensus` drops any packet whose
                # deliveryStatus is not COMPLETE before it can become a ballot,
                # so the Host must drop it too: a non-COMPLETE packet that still
                # carries a candidate would otherwise vote here, the two sides
                # would pick different winners, and the Node-selected source
                # would have no ACTIVE row in the projection (the FIELD_VALUE
                # class of failure).
                if (
                    isinstance(candidate, str)
                    and js_nonempty(candidate)
                    and packet.get("deliveryStatus") == "COMPLETE"
                ):
                    candidate_ids.append((candidate_id, candidate))
        # Match Node. A packet carrying a machine-readable CERT1|FINAL row is
        # the final independent certificate and wins over correlated audit
        # repeats. Without one, keep the exact-support majority with the latest
        # tie-break. When no packet of the run carries a candidate at all, Node
        # delivers ``consensusAttempts[0]`` -- the FIRST attempt of the run, not
        # the last one (see the `?? consensusAttempts[0]` fallback in
        # agent-loop.ts), so the Host must project the same first packet.
        chosen = run_ids[0]
        certified_ids = [
            candidate_id
            for candidate_id, _candidate in candidate_ids
            if _is_certified_packet(normal_packets.get(candidate_id))
        ]
        if certified_ids:
            chosen = certified_ids[-1]
        elif candidate_ids:
            chosen = ballot_choice(candidate_ids)
        for candidate_id in run_ids:
            if candidate_id != chosen:
                superseded_normal_ids.add(candidate_id)
        run_ids = []
        run_task = None

    for _, request_id in ordered:
        entry = history.get(request_id)
        body = _body_of(entry, ("WORK", "CONSENSUS")) if isinstance(entry, dict) else None
        if body is None:
            flush_normal_run()
            continue
        if body.get("revisionProvenance") is not None:
            flush_normal_run()
            continue
        task = body.get("task")
        task_id = task.get("taskId") if isinstance(task, dict) else None
        if not isinstance(task_id, str):
            flush_normal_run()
            continue
        try:
            _, packet = _source_record(
                history, request_id, session_id, problem_hash,
                require_complete=False, phases=("WORK", "CONSENSUS"),
            )
        except ProbeError:
            request = entry.get("request") if isinstance(entry, dict) else None
            phase = request.get("phase") if isinstance(request, dict) else None
            # An unusable CONSENSUS attempt is not a projected artifact. Mark it
            # superseded so the projection loop cannot advance the control
            # sequence for a packet that will never be delivered.
            if phase == "CONSENSUS":
                # An unusable consensus attempt is not an artifact. It also
                # does not end the same-task run: the remaining valid attempts
                # still collapse to one delivered artifact, exactly as the
                # Node loop keeps its earlier candidates after a malformed
                # audit.
                superseded_normal_ids.add(request_id)
                continue
            # A WORK tool/method action ends the current draft run: any packet
            # before it was a pre-observation draft and is superseded. A merely
            # malformed WorkPacket (e.g. one failed schema repair) is only
            # superseded; it must not split the same-task run, because the Node
            # loop retains its earlier candidates and a later correction.
            if phase == "WORK" and run_task == task_id:
                action = None
                if isinstance(entry, dict):
                    body_for_action = _body_of(entry, ("WORK",))
                    task_for_action = (
                        body_for_action.get("task")
                        if isinstance(body_for_action, dict)
                        else None
                    )
                    scope_for_action = (
                        body_for_action.get("scope")
                        if isinstance(body_for_action, dict)
                        else None
                    )
                    receipt = entry.get("receipt")
                    if (
                        isinstance(task_for_action, dict)
                        and isinstance(scope_for_action, dict)
                        and isinstance(receipt, dict)
                        and isinstance(receipt.get("text"), str)
                    ):
                        try:
                            action = parse_action(
                                receipt["text"],
                                {
                                    "sessionId": body_for_action.get("sessionId"),
                                    "problemHash": body_for_action.get("problemHash"),
                                    "contractVersion": body_for_action.get("contractVersion"),
                                    "taskId": task_for_action.get("taskId"),
                                    "scopeId": scope_for_action.get("scopeId"),
                                    "sourceRequestId": request_id,
                                },
                            )
                        except (ProbeError, ProtocolError):
                            action = None
                if isinstance(action, dict) and action.get("action") in ("tool", "method", "math_asset"):
                    for draft_id in run_ids:
                        superseded_normal_ids.add(draft_id)
                    run_ids = []
                    continue
                superseded_normal_ids.add(request_id)
                continue
            flush_normal_run()
            continue
        if run_task is not None and run_task != task_id:
            flush_normal_run()
        run_task = task_id
        run_ids.append(request_id)
        normal_packets[request_id] = packet
    flush_normal_run()

    rows = []
    by_source = {}
    next_seq = 2
    active_task = None
    seen_dynamic = set()
    seen_redo_sources = set()
    finished_redo = False
    for _, request_id in ordered:
        entry = history.get(request_id)
        if not isinstance(entry, dict):
            continue
        body = _body_of(entry, ("WORK", "REPAIR", "CONSENSUS"))
        if body is None:
            continue
        if request_id in superseded_normal_ids:
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
                binding = trusted_packet_binding(body, request_id)
                if binding is None:
                    continue
                packet = checked_packet(entry["receipt"]["text"], binding)
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
                history, request_id, session_id, problem_hash,
                require_complete=False, phases=("WORK", "CONSENSUS"),
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
    if not _is_int(body.get("contractVersion")) or body["contractVersion"] not in (1, 2):
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
