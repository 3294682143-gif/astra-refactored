from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass


def fingerprint(value) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


@dataclass(frozen=True)
class Limits:
    max_tokens: int = 8192
    problems: int = 3
    in_flight: int = 8
    normal_per_problem: int = 2
    logical_requests: int = 10000
    problem_seconds: float = 1200
    run_seconds: float = 21600
    termination_grace: float = 10
    planning_fraction: float = 0.25
    final_fraction: float = 0.10

    def __post_init__(self):
        for field, ceiling in (
            ("max_tokens", 8192),
            ("problems", 3),
            ("in_flight", 8),
            ("normal_per_problem", 2),
            ("logical_requests", 10000),
        ):
            value = getattr(self, field)
            if type(value) is not int or not 1 <= value <= ceiling:
                raise ValueError(f"invalid hard limit: {field}")
        for field, ceiling in (
            ("problem_seconds", 1200),
            ("run_seconds", 21600),
            ("termination_grace", 10),
        ):
            value = getattr(self, field)
            if (
                isinstance(value, bool)
                or not math.isfinite(value)
                or not 0 < value <= ceiling
            ):
                raise ValueError(f"invalid hard limit: {field}")
        if self.planning_fraction != 0.25 or self.final_fraction != 0.10:
            raise ValueError("stage fractions are fixed by the target specification")

    @property
    def digest(self):
        return fingerprint(asdict(self))


@dataclass(frozen=True)
class ClientCapabilities:
    """Explicit integration evidence, never inferred from **kwargs or private fields.

    offline_simulation permits controlled fake clients only. Real integration must
    identify the public request/response contract and at least one end-of-generation
    path. A terminal-response contract does not assert cancellation support:
    ambiguous requests remain charged and in flight, including after local exit.
    No API key, endpoint or provider fallback belongs in this object.
    """

    evidence: str
    offline_simulation: bool = False
    confirmed: bool = False
    thinking_parameter: str = "thinking_mode"
    timeout_parameter: str = "timeout"
    cancellation_parameter: str = "cancellation"
    stream: bool = True
    prefill: bool = True
    cancellation_confirms_end: bool = False
    max_input_chars: int = 64000
    terminal_response_confirms_end: bool = False

    def validate(self, *, diagnostic=False):
        if not isinstance(self.evidence, str) or not self.evidence.strip():
            raise ValueError("public client capability evidence missing")
        for field in (
            "offline_simulation",
            "confirmed",
            "stream",
            "prefill",
            "cancellation_confirms_end",
            "terminal_response_confirms_end",
        ):
            if type(getattr(self, field)) is not bool:
                raise ValueError("client capability flags must be JSON booleans")
        if not (self.confirmed or self.offline_simulation):
            raise ValueError("public client capability evidence missing")
        if not (
            self.stream
            and self.prefill
            and (
                self.cancellation_confirms_end
                or self.terminal_response_confirms_end
                or diagnostic
            )
        ):
            raise ValueError(
                "stream/prefill and terminal-response or cancellation contract not integrated"
            )
        fields = (
            self.thinking_parameter,
            self.timeout_parameter,
            self.cancellation_parameter,
        )
        if (
            any(
                not isinstance(x, str) or not x.isidentifier() or x.startswith("_")
                for x in fields
            )
            or len(set(fields)) != 3
        ):
            raise ValueError("invalid public client parameter mapping")
        if set(fields) & {"messages", "temperature", "max_tokens", "stream"}:
            raise ValueError("client parameter mapping collides with common fields")
        if type(self.max_input_chars) is not int or self.max_input_chars < 1000:
            raise ValueError(
                "input character bound must be explicit; it is not a token window"
            )
