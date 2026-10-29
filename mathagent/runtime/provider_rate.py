"""Shared provider-window policy, separate from the competition's hard limits."""

DEFAULT_RATE_POLICY = {
    "requests_per_minute": 30,
    "tokens_per_minute": 150000,
    "min_interval_seconds": 2.1,
}


def validate_policy(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_RATE_POLICY):
        raise ValueError("explicit provider RPM/TPM policy required")
    for key, maximum in (("requests_per_minute", 30), ("tokens_per_minute", 150000)):
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise ValueError("provider policy exceeds documented ordinary limits")
    if (
        type(value["min_interval_seconds"]) not in {int, float}
        or not 0 <= value["min_interval_seconds"] <= 60
    ):
        raise ValueError("invalid provider dispatch interval")
    return dict(value)


def token_reservation(messages, max_tokens):
    # Conservative UTF-8 bytes + framing + full output allowance; not fabricated
    # provider usage. Keep reservations for 60 seconds even when usage is absent.
    return (
        sum(len(row["content"].encode("utf-8")) + 64 for row in messages)
        + 64
        + max_tokens
    )
