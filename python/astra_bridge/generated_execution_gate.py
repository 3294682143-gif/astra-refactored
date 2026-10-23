"""G7/PR7 (Slice 7c) — controlled generative-execution gate (fail-closed).

Model-generated Python / WASI execution is *disabled by default*. There is no
approved WASI profile in this environment, so every generative-execution request
is refused (``REFUSED_NO_PROFILE``) — the Host never runs model-generated code on
the bare host. An execution is admitted only when an explicitly approved,
bounded profile is present AND the request's digest matches the approved one; the
gate itself never executes anything (execution stays with the isolated sandbox
provider in ``mathagent.tools.PythonSandbox``).

``execute_with_gate`` is the only function here that may reach an executor, and
only after an ``"ADMITTED"`` decision and only through an already-accepted
sandbox that advertises ``available``. Every successful outcome is a
``BOUNDED_OBSERVATION`` that is explicitly *not* a proof; every other outcome is
a fixed refusal. There is no host-Python fallback and no fabricated output.

Pure module: no I/O, no subprocess, no network.
"""

from __future__ import annotations

import json
import math

__all__ = [
    "GATE_REASONS",
    "EXECUTION_REFUSALS",
    "DEFAULT_SCOPE",
    "BOUNDED_OBSERVATION_NOTE",
    "ExecutionRequest",
    "GenerativeExecutionGate",
    "execute_with_gate",
]

GATE_REASONS = (
    "ADMITTED",
    "REFUSED_NO_PROFILE",
    "REFUSED_PROFILE_MISMATCH",
    "REFUSED_UNBOUNDED",
    "REFUSED_SHA_MISMATCH",
)

# Post-admission refusals. Even an ADMITTED request can end without an
# observation: no usable sandbox, a raising or timed-out sandbox, a sandbox
# status that is not ``ok``, or an unbounded observation payload. Those outcomes
# carry one of these fixed codes — never a traceback, never fabricated output.
# The gate's own ``decision`` never returns them.
EXECUTION_REFUSALS = (
    "REFUSED_NO_PROFILE",
    "REFUSED_UNBOUNDED",
    "REFUSED_EXECUTION_FAILED",
)

DEFAULT_SCOPE = "bounded generated exploration"

# The exact tag every admitted execution carries: a sandbox observation is a
# bounded, unverified observation and never a proof of the original problem.
BOUNDED_OBSERVATION_NOTE = "BOUNDED_OBSERVATION_NOT_PROOF"

_MAX_OBSERVATION_BYTES = 65536


class ExecutionRequest:
    """One bounded generative-execution request (declaration only)."""

    def __init__(self, profile_id, code_sha256, max_seconds, max_bytes):
        self.profile_id = profile_id
        self.code_sha256 = code_sha256
        self.max_seconds = max_seconds
        self.max_bytes = max_bytes


def _is_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


class GenerativeExecutionGate:
    """Fail-closed gate. The default carries no approved profile."""

    def __init__(self, approved=None):
        # `approved` is a dict {profile_id, code_sha256, max_seconds, max_bytes}
        # or None. There is no ambient profile.
        self.approved = approved if isinstance(approved, dict) else None

    def decision(self, request):
        """Return one fixed reason; never executes and never raises on refusal."""
        if self.approved is None:
            return "REFUSED_NO_PROFILE"
        if not isinstance(request, ExecutionRequest):
            return "REFUSED_UNBOUNDED"
        if request.profile_id != self.approved.get("profile_id"):
            return "REFUSED_PROFILE_MISMATCH"
        if not _is_hash(self.approved.get("code_sha256")):
            return "REFUSED_SHA_MISMATCH"
        if not _is_hash(request.code_sha256) or request.code_sha256 != self.approved["code_sha256"]:
            return "REFUSED_SHA_MISMATCH"
        # Bounds must be present and within the approved envelope.
        for field, cap in (
            ("max_seconds", self.approved.get("max_seconds")),
            ("max_bytes", self.approved.get("max_bytes")),
        ):
            value = getattr(request, field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                return "REFUSED_UNBOUNDED"
            if not isinstance(cap, int) or value > cap:
                return "REFUSED_UNBOUNDED"
        return "ADMITTED"

    def may_execute(self, request):
        return self.decision(request) == "ADMITTED"


def _refused(reason):
    """One fixed refusal; the vocabulary is closed and never echoes input."""
    if reason not in EXECUTION_REFUSALS and reason not in GATE_REASONS:
        reason = "REFUSED_UNBOUNDED"
    return {"admitted": False, "reason": reason, "result": None}


def _decision(gate, request):
    """``gate.decision`` protected: a broken gate can only refuse."""
    try:
        decide = getattr(gate, "decision", None)
        if not callable(decide):
            return "REFUSED_NO_PROFILE"
        decision = decide(request)
    except Exception:  # noqa: BLE001 - an unusable gate is a refusal, not a crash
        return "REFUSED_NO_PROFILE"
    if not isinstance(decision, str) or decision not in GATE_REASONS:
        # An unrecognised decision is never admitted and never echoed back.
        return "REFUSED_UNBOUNDED"
    return decision


def _bounded(payload):
    """Keep the observation JSON-serializable and inside a fixed byte cap."""
    try:
        text = json.dumps(
            payload, allow_nan=False, ensure_ascii=False, separators=(",", ":"),
            default=str,
        )
    except (ValueError, TypeError, RecursionError, OverflowError):
        return None
    if len(text.encode("utf-8", "replace")) > _MAX_OBSERVATION_BYTES:
        return None
    return payload


def _bounded_observation(result, problem_id, scope):
    """One typed, explicitly unverified observation of the sandbox outcome."""
    payload = {
        "kind": "BOUNDED_OBSERVATION",
        "interpretation": BOUNDED_OBSERVATION_NOTE,
        "tool": "generated_python",
        "status": getattr(result, "status", None),
        "problemId": problem_id,
        "scope": scope,
        "evidenceKind": getattr(result, "evidence_kind", "NONE"),
        "output": getattr(result, "result", None),
        "detail": getattr(result, "detail", ""),
    }
    return _bounded(payload)


def execute_with_gate(
    gate, sandbox, request, code, *, deadline, problem_id, scope=DEFAULT_SCOPE
):
    """Decide first, execute at most once, and never fabricate an outcome.

    The decision is taken before any execution: anything other than
    ``"ADMITTED"`` returns ``{"admitted": False, "reason": <decision>,
    "result": None}`` and no code is run. An admitted request still needs a
    sandbox that advertises ``available``; without one the call fails closed
    with a fixed reason. A raising, timing-out or non-``ok`` sandbox yields a
    fixed refusal, never a traceback and never invented output.
    """
    try:
        decision = _decision(gate, request)
        if decision != "ADMITTED":
            return _refused(decision)
        if sandbox is None or not getattr(sandbox, "available", False):
            return _refused("REFUSED_NO_PROFILE")
        if isinstance(deadline, bool) or not isinstance(deadline, (int, float)):
            return _refused("REFUSED_UNBOUNDED")
        if not math.isfinite(deadline):
            return _refused("REFUSED_UNBOUNDED")
        if not isinstance(problem_id, str) or not problem_id.strip():
            return _refused("REFUSED_UNBOUNDED")
        if not isinstance(scope, str) or not scope.strip():
            return _refused("REFUSED_UNBOUNDED")
        result = sandbox.execute(
            code, deadline=deadline, problem_id=problem_id, scope=scope
        )
    except Exception:  # noqa: BLE001 - a broken provider is a fixed refusal
        return _refused("REFUSED_EXECUTION_FAILED")
    try:
        status = getattr(result, "status", None)
        payload = (
            None
            if status != "ok"
            else _bounded_observation(result, problem_id, scope)
        )
    except Exception:  # noqa: BLE001 - an unreadable provider result is a refusal
        return _refused("REFUSED_EXECUTION_FAILED")
    if status != "ok":
        if status == "resource_limited":
            return _refused("REFUSED_UNBOUNDED")
        if status == "backend_unavailable":
            return _refused("REFUSED_NO_PROFILE")
        return _refused("REFUSED_EXECUTION_FAILED")
    if payload is None:
        return _refused("REFUSED_UNBOUNDED")
    return {"admitted": True, "reason": "ADMITTED", "result": payload}
