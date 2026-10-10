"""Redacted explicit error envelopes; arbitrary/mid-output errors stay unknown."""

import re


def describe_error(value, secret=""):
    data = value if isinstance(value, dict) else {"message": value}

    def clean(value):
        text = str(value)
        if secret:
            text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"sk-[A-Za-z0-9_-]+|(?i:Bearer)\s+\S+", "[REDACTED]", text)
        return text[:1500]

    return {
        "provider_error_" + key: clean(data[key])
        for key in ("code", "type", "message", "status")
        if key in data and type(data[key]) in {str, int}
    }


def rejection_kind(error, *, content_seen):
    if content_seen:
        return None
    code = str(
        error.get("provider_error_code", error.get("provider_error_status", ""))
    ).lower()
    kind = str(error.get("provider_error_type", "")).lower()
    message = str(error.get("provider_error_message", "")).lower()
    if (
        code in {"429", "rate_limit_exceeded", "too_many_requests", "throttling"}
        or kind
        in {
            "rate_limit_exceeded",
            "rate_limit_error",
            "too_many_requests",
            "throttling",
        }
        or re.search(
            r"(?:request|token)s? rate limit (?:exceeded|reached)|请求(?:过于|太)频繁|超出.*(?:rpm|tpm)",
            message,
        )
    ):
        return "rate_limit"
    if code in {
        "400",
        "401",
        "403",
        "404",
        "422",
        "invalid_api_key",
        "model_not_found",
        "context_length_exceeded",
    }:
        return "invalid_request"
    return None
