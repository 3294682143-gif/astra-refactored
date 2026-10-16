"""G7/PR7 (Slice 7d) — signed/hashed cross-process checkpoint for resume.

One ``AgentRuntime.solve`` may export a *controlled* checkpoint of the run it
already performed: the spent root budget, the settled request-id ledger and the
authenticated ``SessionLog`` prefix. A later process may resume from it, but
only after the Host re-checks the whole identity:

- the same problem identity (``problem_hash``) and the same contract version;
- the root budget may only *tighten* (never reset, never widen);
- an in-flight ``OUTCOME_UNKNOWN`` request id is recorded and **never
  auto-replayed**: the resume is safely blocked instead of re-dispatching it;
- the checkpoint digest is recomputed from the canonical bytes, so a tampered
  or cross-problem checkpoint is a fixed rejection.

Pure module: no I/O, no network, no clock, no client call. It never executes a
model or a tool and never claims a mathematical result.
"""

from __future__ import annotations

import copy
import hashlib
import json

from . import host_carriers

__all__ = [
    "CHECKPOINT_SCHEMA_VERSION",
    "CheckpointError",
    "export_checkpoint",
    "verify_checkpoint",
    "resume_plan",
]

CHECKPOINT_SCHEMA_VERSION = "agent-checkpoint-v1"

_MAX_EVENTS = 512
_MAX_LEDGER = 64
_MAX_TEXT = 4096
_HEX64 = frozenset("0123456789abcdef")
_SETTLED_STATES = ("REMOTE_TERMINAL_CONFIRMED", "OUTCOME_UNKNOWN")
_UNKNOWN_STATE = "OUTCOME_UNKNOWN"
_PHASES = ("WORK", "R2", "REPAIR", "R0")


class CheckpointError(Exception):
    """Fixed-code checkpoint failure; never carries raw input."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _fail(code):
    raise CheckpointError(code)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_hash64(value):
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(ch in _HEX64 for ch in value)
    )


def _canonical(value):
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        _fail("CHECKPOINT_ENCODING")


def _digest(body):
    return hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()


def _bounded_text(value, max_chars, allow_empty=False):
    if not isinstance(value, str):
        _fail("CHECKPOINT_SHAPE")
    if not allow_empty and not value.strip():
        _fail("CHECKPOINT_SHAPE")
    if len(value) > max_chars:
        _fail("CHECKPOINT_BOUND")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail("CHECKPOINT_SHAPE")
    return value


def _ledger_rows(records):
    """Last settlement of each (sessionId, requestId) pair, in first-seen order."""
    if not isinstance(records, list) or len(records) > _MAX_LEDGER * 8:
        _fail("CHECKPOINT_BOUND")
    settled = {}
    order = []
    for row in records:
        if not isinstance(row, dict):
            _fail("CHECKPOINT_SHAPE")
        request_id = row.get("requestId")
        session_id = row.get("sessionId")
        if not isinstance(request_id, str) or not isinstance(session_id, str):
            continue
        key = (session_id, request_id)
        if key not in settled:
            order.append(key)
        settled[key] = row
    out = []
    for key in order:
        row = settled[key]
        state = row.get("state")
        if state not in _SETTLED_STATES:
            continue
        phase = row.get("phase")
        if phase not in _PHASES:
            _fail("CHECKPOINT_SHAPE")
        usage = row.get("usage")
        total = None
        if isinstance(usage, dict) and _is_int(usage.get("total_tokens")):
            total = usage["total_tokens"]
        out.append({
            "requestId": key[1],
            "sessionId": key[0],
            "phase": phase,
            "state": state,
            "totalTokens": total,
        })
        if len(out) > _MAX_LEDGER:
            _fail("CHECKPOINT_BOUND")
    return out


def _log_events(events):
    """Authenticated SessionLog prefix: fixed kind + bounded data only."""
    if not isinstance(events, list) or len(events) > _MAX_EVENTS:
        _fail("CHECKPOINT_BOUND")
    out = []
    for index, row in enumerate(events):
        if not isinstance(row, dict):
            _fail("CHECKPOINT_SHAPE")
        seq = row.get("seq")
        if not _is_int(seq) or seq != index + 1:
            _fail("CHECKPOINT_SEQ")
        kind = row.get("kind")
        if not isinstance(kind, str) or not kind or len(kind) > 64:
            _fail("CHECKPOINT_SHAPE")
        data = row.get("data")
        if not isinstance(data, dict):
            _fail("CHECKPOINT_SHAPE")
        out.append({"seq": seq, "kind": kind, "data": copy.deepcopy(data)})
    return out


def _history_rows(history):
    if not isinstance(history, (list, tuple)) or len(history) > 256:
        _fail("CHECKPOINT_SHAPE")
    out = []
    for rec in history:
        if not isinstance(rec, dict) or set(rec.keys()) != {"requestId", "request", "receipt"}:
            _fail("CHECKPOINT_SHAPE")
        rid = rec["requestId"]; req = rec["request"]; receipt = rec["receipt"]
        if not isinstance(rid, str) or not isinstance(req, dict) or not isinstance(receipt, dict):
            _fail("CHECKPOINT_SHAPE")
        out.append({"requestId": rid, "request": copy.deepcopy(req), "receipt": copy.deepcopy(receipt)})
    return out


def export_checkpoint(*, carrier, problem_hash, contract_version, spent,
                      ledger, session_log, unknown_request_ids=(), history=()):
    """Export one controlled checkpoint of an already-performed run.

    ``carrier`` is the bound :class:`host_carriers.RunCarrier`; ``spent`` is the
    already-consumed root budget (it may only be <= the carrier budget);
    ``ledger`` is the settled request-id ledger; ``session_log`` is the
    authenticated event prefix. Nothing here re-dispatches anything.
    """
    if not isinstance(carrier, host_carriers.RunCarrier):
        _fail("CHECKPOINT_CARRIER")
    if not _is_hash64(problem_hash) or problem_hash != carrier.problem_hash:
        _fail("CHECKPOINT_PROBLEM")
    if not _is_int(contract_version) or contract_version not in (1, 2):
        _fail("CHECKPOINT_VERSION")
    if not isinstance(spent, dict):
        _fail("CHECKPOINT_SHAPE")
    spent_model = spent.get("modelCalls")
    spent_effects = spent.get("effectCalls")
    if not _is_int(spent_model) or spent_model < 0:
        _fail("CHECKPOINT_BUDGET")
    if not _is_int(spent_effects) or spent_effects < 0:
        _fail("CHECKPOINT_BUDGET")
    if spent_model > carrier.max_model_calls or spent_effects > carrier.max_effects:
        _fail("CHECKPOINT_BUDGET")
    rows = _ledger_rows(ledger)
    events = _log_events(session_log)
    unknown = []
    if unknown_request_ids is None:
        unknown_request_ids = ()
    if not isinstance(unknown_request_ids, (list, tuple)):
        _fail("CHECKPOINT_SHAPE")
    for request_id in unknown_request_ids:
        if not isinstance(request_id, str) or not request_id:
            _fail("CHECKPOINT_SHAPE")
        if request_id not in unknown:
            unknown.append(request_id)
    for row in rows:
        if row["state"] == _UNKNOWN_STATE and row["requestId"] not in unknown:
            unknown.append(row["requestId"])
    body = {
        "schemaVersion": CHECKPOINT_SCHEMA_VERSION,
        "mode": carrier.mode,
        "problemHash": problem_hash,
        "contractVersion": contract_version,
        "profileId": carrier.profile_id,
        "budget": {
            "maxModelCalls": carrier.max_model_calls,
            "maxWorkUnits": carrier.max_work_units,
            "maxEffects": carrier.max_effects,
            "rootDeadlineMs": carrier.root_deadline_ms,
        },
        "spent": {"modelCalls": spent_model, "effectCalls": spent_effects},
        "ledger": rows,
        "sessionLog": events,
        "history": _history_rows(history),
        "unknownRequestIds": unknown,
    }
    body["digest"] = _digest(body)
    return copy.deepcopy(body)


def verify_checkpoint(checkpoint, *, problem_hash, contract_version, mode=None):
    """Re-check one checkpoint against the current problem identity.

    Returns the verified body. A cross-problem checkpoint, a wrong contract
    version, a tampered digest or a malformed shape is a fixed rejection.
    """
    if not isinstance(checkpoint, dict):
        _fail("CHECKPOINT_SHAPE")
    body = copy.deepcopy(checkpoint)
    digest = body.pop("digest", None)
    if not _is_hash64(digest):
        _fail("CHECKPOINT_DIGEST")
    if _digest(body) != digest:
        _fail("CHECKPOINT_DIGEST")
    if body.get("schemaVersion") != CHECKPOINT_SCHEMA_VERSION:
        _fail("CHECKPOINT_VERSION")
    if not _is_hash64(problem_hash) or body.get("problemHash") != problem_hash:
        _fail("CHECKPOINT_PROBLEM")
    if not _is_int(contract_version) or body.get("contractVersion") != contract_version:
        _fail("CHECKPOINT_VERSION")
    if mode is not None and body.get("mode") != mode:
        _fail("CHECKPOINT_MODE")
    if body.get("mode") not in host_carriers.MODES:
        _fail("CHECKPOINT_MODE")
    _bounded_text(body.get("profileId"), 128)
    budget = body.get("budget")
    if not isinstance(budget, dict):
        _fail("CHECKPOINT_SHAPE")
    for field in ("maxModelCalls", "maxWorkUnits", "maxEffects", "rootDeadlineMs"):
        if not _is_int(budget.get(field)) or budget[field] < 0:
            _fail("CHECKPOINT_BUDGET")
    spent = body.get("spent")
    if not isinstance(spent, dict):
        _fail("CHECKPOINT_SHAPE")
    for field in ("modelCalls", "effectCalls"):
        if not _is_int(spent.get(field)) or spent[field] < 0:
            _fail("CHECKPOINT_BUDGET")
    if spent["modelCalls"] > budget["maxModelCalls"]:
        _fail("CHECKPOINT_BUDGET")
    if spent["effectCalls"] > budget["maxEffects"]:
        _fail("CHECKPOINT_BUDGET")
    body["ledger"] = _ledger_rows(body.get("ledger"))
    body["sessionLog"] = _log_events(body.get("sessionLog"))
    unknown = body.get("unknownRequestIds")
    if not isinstance(unknown, list):
        _fail("CHECKPOINT_SHAPE")
    for request_id in unknown:
        if not isinstance(request_id, str) or not request_id:
            _fail("CHECKPOINT_SHAPE")
    body["digest"] = digest
    return body


def resume_plan(checkpoint, *, prior, session_id, max_model_calls=None,
                max_work_units=None, max_effects=None, root_deadline_ms=None):
    """Plan one resume: tighten the carrier, block an unknown in-flight request.

    Returns ``{"carrier", "remaining", "sessionLog", "ledger", "blocked"}``.
    The carrier is recovered through :func:`host_carriers.recover_carrier`, so a
    widened budget is a fixed ``BUDGET_WIDENED`` error. When any in-flight
    ``OUTCOME_UNKNOWN`` request id exists the plan is returned with
    ``blocked=True`` and an empty ``sessionLog``: the caller must refuse the
    resume instead of replaying the unknown request.
    """
    if not isinstance(prior, host_carriers.RunCarrier):
        _fail("CHECKPOINT_CARRIER")
    body = verify_checkpoint(
        checkpoint,
        problem_hash=prior.problem_hash,
        contract_version=body_contract_version(checkpoint),
        mode=prior.mode,
    )
    try:
        carrier = host_carriers.recover_carrier(
            prior,
            session_id=session_id,
            max_model_calls=max_model_calls,
            max_work_units=max_work_units,
            max_effects=max_effects,
            root_deadline_ms=root_deadline_ms,
        )
    except host_carriers.CarrierError as exc:
        _fail(exc.code)
    spent = body["spent"]
    remaining = {
        "maxModelCalls": carrier.max_model_calls - spent["modelCalls"],
        "maxEffects": carrier.max_effects - spent["effectCalls"],
    }
    if remaining["maxModelCalls"] < 0 or remaining["maxEffects"] < 0:
        _fail("CHECKPOINT_BUDGET")
    unknown = tuple(body["unknownRequestIds"])
    blocked = len(unknown) > 0
    return {
        "carrier": carrier,
        "remaining": remaining,
        "sessionLog": [] if blocked else copy.deepcopy(body["sessionLog"]),
        "ledger": copy.deepcopy(body["ledger"]),
        "history": [] if blocked else copy.deepcopy(body.get("history") or []),
        "unknownRequestIds": unknown,
        "blocked": blocked,
    }


def body_contract_version(checkpoint):
    """Read the declared contract version of a raw checkpoint (shape only)."""
    if not isinstance(checkpoint, dict):
        _fail("CHECKPOINT_SHAPE")
    version = checkpoint.get("contractVersion")
    if not _is_int(version) or version not in (1, 2):
        _fail("CHECKPOINT_VERSION")
    return version
