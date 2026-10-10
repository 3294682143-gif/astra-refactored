"""Three-line wire contract adapted from workunit_v12; no oracle input API."""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..prompts.protocol import messages

__all__ = ["ParsedResponse", "messages", "parse_response"]


@dataclass(frozen=True)
class ParsedResponse:
    raw: str
    status: str
    result: str
    gap: str
    valid: bool
    delivered: bool
    violations: tuple[str, ...]
    normalizations: tuple[str, ...] = ()

    @property
    def closed(self):
        return (
            self.valid
            and self.delivered
            and self.status == "COMPLETED"
            and self.gap == "NONE"
        )


def parse_response(
    raw: str,
    *,
    finish_reason: str | None,
    prefill=True,
    transport_complete=True,
    complete_public_return=False,
) -> ParsedResponse:
    text = raw.strip()
    normalized = []
    if prefill and re.match(r"^(COMPLETED|INCOMPLETE|BLOCKED)\s*\n", text):
        text = "STATUS: " + text
        normalized.append("prefill_restored")
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    fields = {}
    errors = []
    if len(lines) != 3:
        errors.append("three_nonempty_lines_required")
    for index, line in enumerate(lines):
        match = re.fullmatch(r"(STATUS|RESULT|GAP):\s*(.+)", line)
        if not match:
            errors.append("malformed_line")
            continue
        key, value = match.groups()
        if key in fields:
            errors.append("duplicate_" + key)
        if index >= 3 or key != ("STATUS", "RESULT", "GAP")[index]:
            errors.append("field_order")
        fields.setdefault(key, value)
    for key in ("STATUS", "RESULT", "GAP"):
        if key not in fields:
            errors.append("missing_" + key)
    status, result, gap = (fields.get(k, "") for k in ("STATUS", "RESULT", "GAP"))
    if status not in {"COMPLETED", "INCOMPLETE", "BLOCKED"}:
        errors.append("invalid_status")
    if status == "COMPLETED" and result in {"", "NONE"}:
        errors.append("completed_without_result")
    if status != "COMPLETED" and gap in {"", "NONE"}:
        errors.append("unfinished_without_gap")
    # The official non-streaming baseline returns text and omits finish metadata.
    # This establishes a public-method delivery boundary, NOT a fabricated stop,
    # remote-cancellation receipt or assurance that the SDK exposed truncation.
    # Explicit truncation/unknown reasons cannot be overridden by this contract.
    delivered = transport_complete and (
        finish_reason in {"stop", "end_turn"}
        or (complete_public_return and finish_reason is None)
    )
    if not delivered:
        errors.append("incomplete_transport_or_truncation")
    return ParsedResponse(
        raw,
        status,
        result,
        gap,
        not errors,
        delivered,
        tuple(sorted(set(errors))),
        tuple(normalized),
    )
