"""Local evaluation continuation policy, separate from diagnostic success."""

from dataclasses import dataclass


@dataclass(frozen=True)
class EvaluationPolicy:
    mode: str = "full_suite"
    max_consecutive_delivery_failures: int = 3

    def __post_init__(self):
        if self.mode not in {"full_suite", "strict_diagnostic"}:
            raise ValueError("unknown local evaluation mode")
        if (
            type(self.max_consecutive_delivery_failures) is not int
            or not 1 <= self.max_consecutive_delivery_failures <= 10
        ):
            raise ValueError("delivery-failure threshold must be between 1 and 10")

    def delivery_stop_reason(self, *, category, consecutive):
        if category == "content_filter":
            return "provider_content_filter"
        if category in {"truncated", "protocol_invalid"}:
            if self.mode == "strict_diagnostic":
                return "strict_diagnostic_delivery_failure"
            if consecutive >= self.max_consecutive_delivery_failures:
                return "repeated_delivery_failures"
        return ""
