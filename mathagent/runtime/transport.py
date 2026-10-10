"""Request-local, redacted transport diagnostics; never end-of-generation proof."""

import math


def safe_transport(value):
    allowed = {
        "stage",
        "attempts",
        "http_status",
        "transport",
        "done_seen",
        "finish_reason",
        "failure_type",
        "failure_code",
        "cleanup_error_type",
        "post_dispatch_cancellation_confirmed",
        "provider_error_code",
        "provider_error_type",
        "provider_error_message",
        "provider_error_status",
    }
    result = {
        key: item
        for key, item in value.items()
        if key in allowed and type(item) in {str, int, bool}
    }
    for key in (
        "connect_timeout_seconds",
        "read_timeout_seconds",
        "response_headers_seconds",
        "first_body_chunk_seconds",
        "response_bytes",
        "retry_after_seconds",
    ):
        item = value.get(key)
        if type(item) in {int, float} and math.isfinite(item) and item >= 0:
            result[key] = item
    chain = value.get("exception_types")
    if isinstance(chain, list):
        result["exception_types"] = [
            s
            for s in chain[:12]
            if isinstance(s, str) and s.isidentifier() and len(s) <= 64
        ]
    return result


class TransportResponse(dict):
    def __init__(self, value, summary):
        super().__init__(value)
        self.transport = summary


class UnconfirmedTransportFailure(RuntimeError):
    def __init__(self, error_type, summary, code):
        super().__init__(code)
        self.error_type = error_type
        self.transport = summary
