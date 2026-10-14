"""G7/PR7 (Slice 7c) — controlled generative-execution gate (fail-closed).

Model-generated Python / WASI execution is *disabled by default*. There is no
approved WASI profile in this environment, so every generative-execution request
is refused (``REFUSED_NO_PROFILE``) — the Host never runs model-generated code on
the bare host. An execution is admitted only when an explicitly approved,
bounded profile is present AND the request's digest matches the approved one; the
gate itself never executes anything (execution stays with the isolated sandbox
provider, which is out of scope until approved).

Pure module: no I/O, no subprocess, no network.
"""

from __future__ import annotations

__all__ = [
    "GATE_REASONS",
    "ExecutionRequest",
    "GenerativeExecutionGate",
]

GATE_REASONS = (
    "ADMITTED",
    "REFUSED_NO_PROFILE",
    "REFUSED_PROFILE_MISMATCH",
    "REFUSED_UNBOUNDED",
    "REFUSED_SHA_MISMATCH",
)


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
