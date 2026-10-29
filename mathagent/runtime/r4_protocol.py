"""R4 delivery diagnostics. Semantic ACTION parsing stays in frozen R4 code."""

from .protocol import ParsedResponse


def parse_r4_delivery(
    raw,
    *,
    finish_reason,
    prefill=False,
    transport_complete=True,
    complete_public_return=False,
):
    delivered = transport_complete and (
        finish_reason in {"stop", "end_turn"}
        or (finish_reason is None and complete_public_return)
    )
    # R4 legitimately accepts labeled candidates/boxed answers without ACTION.
    # Do not apply L3, nor invent a partial duplicate of its semantic parser.
    valid = isinstance(raw, str) and bool(raw.strip()) and delivered
    return ParsedResponse(
        raw,
        "COMPLETED" if valid else "INCOMPLETE",
        raw,
        "NONE" if valid else "delivery",
        valid,
        delivered,
        () if valid else ("incomplete_r4_delivery",),
    )
