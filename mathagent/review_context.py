"""Explicit mathematical review input with a separate version-bound cache key."""

from dataclasses import asdict, dataclass

from .runtime.config import fingerprint


@dataclass(frozen=True)
class ReviewContext:
    task: str
    issue: str = ""
    basis: str = ""
    old_derivation: str = ""
    contract: str = ""
    mapping: str = ""
    conditions: str = ""
    bindings: tuple[str, ...] = ()

    @property
    def digest(self):
        return fingerprint(asdict(self))

    def render(self, new_derivation):
        sections = [
            ("Original task", self.task),
            ("Specific doubt", self.issue),
            ("Mathematical basis", self.basis),
            ("Necessary old derivation", self.old_derivation),
            ("Registered mathematical tool contract", self.contract),
            ("Proposed variable/parameter mapping (not verified)", self.mapping),
            ("Conditions and premise status", self.conditions),
            ("Current complete derivation", new_derivation),
        ]
        return "\n\n".join(f"{label}:\n{value}" for label, value in sections if value)
