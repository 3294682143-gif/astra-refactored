"""Single-mechanism experiment switches; no switch can disable verification or limits."""

from dataclasses import dataclass
from typing import ClassVar


@dataclass(frozen=True)
class ExperimentConfig:
    ablation: str = "none"
    CHOICES: ClassVar = frozenset(
        {
            "none",
            "risk_review",
            "skills",
            "alternate_routes",
            "dynamic_budget",
            "fallback",
            "python",
        }
    )

    def __post_init__(self):
        if type(self.ablation) is not str or self.ablation not in self.CHOICES:
            raise ValueError(
                "one supported mechanism ablation required; hard gates are not ablatable"
            )

    def enabled(self, mechanism):
        return self.ablation != mechanism
