"""G5/PR6 (local) — conservative OfficialClient request policy.

The official contest client is injected by the platform and reached only through
its public signature. This module fixes the *policy* the Python Host applies to
that public surface, mirroring the RC2 request/config intent:

- the output ceiling is a conservative ``max_tokens <= 8192`` bound (a request
  never widens it and never assumes the model's true maximum);
- ``thinking`` / ``usage`` / ``finish_reason`` are normalized from *public*
  fields only — never via reflection, private attributes or environment
  secrets / API keys;
- a missing usage/token field is ``UNKNOWN`` (``None``), never ``0``.

No network, no provider import, no I/O.
"""

from __future__ import annotations

__all__ = [
    "MAX_TOKENS",
    "USAGE_FIELDS",
    "clamp_max_tokens",
    "normalize_usage",
    "normalize_finish_reason",
    "reasoning_used",
    "PUBLIC_FINISH_REASONS",
]

MAX_TOKENS = 8192
USAGE_FIELDS = ("prompt_tokens", "completion_tokens", "total_tokens")
PUBLIC_FINISH_REASONS = ("stop", "end_turn", "tool_calls", "length", "content_filter", "other")


def clamp_max_tokens(requested, ceiling=MAX_TOKENS):
    """Return the effective output ceiling: a bounded int in ``[1, ceiling]``.

    A rejected/absent request falls back to the conservative ceiling itself; it
    is never widened above it.
    """
    if isinstance(requested, bool) or not isinstance(requested, int):
        return ceiling
    if requested < 1:
        return 1
    return min(requested, ceiling)


def _is_safe_uint(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9007199254740991
    )


def normalize_usage(raw):
    """Public usage dict of safe non-negative ints, or ``None`` (UNKNOWN).

    A missing or malformed usage block is ``UNKNOWN`` — never a zero count.
    Only public fields are read.
    """
    if not isinstance(raw, dict):
        return None
    usage = {}
    for key in USAGE_FIELDS:
        value = raw.get(key)
        if _is_safe_uint(value):
            usage[key] = value
    return usage or None


def normalize_finish_reason(choice):
    """Map one public ``finish_reason`` to a fixed token, or ``None`` (UNKNOWN)."""
    if not isinstance(choice, dict):
        return None
    reason = choice.get("finish_reason")
    if reason in (None, ""):
        return None
    if not isinstance(reason, str):
        return None
    return reason if reason in PUBLIC_FINISH_REASONS else "other"


def reasoning_used(response):
    """``True`` iff the public response explicitly declares non-empty reasoning.

    Only public, documented fields are read (``reasoning_content`` /
    ``reasoning``); an absent field is ``False`` — the policy never infers
    thinking from private attributes or reflection.
    """
    if not isinstance(response, dict):
        return False
    for key in ("reasoning_content", "reasoning"):
        value = response.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False
