"""Evidence contract for every math_families tool.

Tools never return answers. A tool returns Evidence: a computed value plus
the means to independently re-check it (certificate), a quick invariant
self-check, and an explicit feasibility marker. Responsibility for the final
answer always stays with the caller.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Evidence:
    value: Any              # computed result; None when infeasible
    certificate: str        # witness allowing independent re-verification
    self_check: str         # quick invariant check description + outcome
    feasibility: str        # "ok" or "infeasible: <reason>; bound <estimate>"
    complexity_bound: str   # scale bound, e.g. "O(n * states)"

    @property
    def feasible(self) -> bool:
        return self.feasibility == "ok"


#: Keys a tool result must never carry. Tools produce evidence, not answers.
FORBIDDEN_RESULT_KEYS = frozenset({"final_answer", "candidate", "solved"})


def assert_evidence_contract(result: Any) -> Evidence:
    """Validate a tool return value against the evidence contract."""
    if not isinstance(result, Evidence):
        raise TypeError(f"tool must return Evidence, got {type(result).__name__}")
    for key in FORBIDDEN_RESULT_KEYS:
        if hasattr(result, key):
            raise ValueError(f"Evidence must not carry {key!r}")
    return result
