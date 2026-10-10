"""Validate public choice identity before extracting content or trusting an end.

The declared request has one choice (index zero). Missing index is the supported
single-choice response form; explicit indexes must be integer zero, not bool or
float. A transport bridge must apply this to raw chunks, not to a lossy rewrite.
"""

TERMINAL_REASONS = frozenset({"stop", "end_turn", "length", "content_filter"})


def public_choice(chunk):
    if not isinstance(chunk, dict):
        raise TypeError("public stream chunk must be a dictionary")
    if chunk.get("error"):
        raise RuntimeError("provider_stream_error_unconfirmed")
    choices = chunk.get("choices", [])
    if choices is None:  # Metadata-only response, never an end-of-generation proof.
        return None
    if not isinstance(choices, list) or len(choices) > 1:
        raise ValueError("one public response choice required")
    if not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, dict):
        raise TypeError("unexpected public response choice")
    index = choice.get("index", 0)
    if type(index) is not int or index != 0:
        raise ValueError("unexpected public response choice index")
    return choice


def terminal_reason(choice):
    reason = choice.get("finish_reason")
    if reason in (None, ""):
        return None
    if not isinstance(reason, str) or reason not in TERMINAL_REASONS:
        raise ValueError("unrecognized terminal reason")
    return reason


class TerminalDeliveryError(Exception):
    """Validated natural end survived a local delivery failure; no usable answer.

    Only the response validator/transport bridge may construct this receipt after
    checking original choice identity. It carries no provider exception text.
    """

    def __init__(self, reason, transport=None):
        self.reason = terminal_reason({"finish_reason": reason})
        if self.reason is None:
            raise ValueError("a trusted terminal reason is required")
        super().__init__("terminal_delivery_invalid")
        self.transport = transport or {}
