"""Versioned mathematical objects; model delivery never assigns truth."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .runtime.config import fingerprint


@dataclass(frozen=True)
class Scope:
    conditions: tuple[str, ...] = ()
    domain: str = "unspecified"
    quantifiers: tuple[str, ...] = ()

    def covers(self, requested: Scope) -> bool:
        # Conservative exact domain/quantifier match, no guessed semantic implication.
        return (
            self.domain == requested.domain
            and self.quantifiers == requested.quantifiers
            and set(self.conditions) <= set(requested.conditions)
        )


@dataclass(frozen=True)
class ProblemContract:
    raw: str
    goals: tuple[str, ...] = ()
    scope: Scope = Scope()
    answer_shape: str = "UNKNOWN"
    uncertainties: tuple[str, ...] = ("problem view not mechanically confirmed",)

    @property
    def digest(self):
        return fingerprint(self.raw)


@dataclass(frozen=True)
class WorkUnit:
    id: str
    route: str
    goal: str
    kind: str = "DERIVE"
    dependencies: tuple[str, ...] = ()
    obligations: tuple[str, ...] = ()
    scope: Scope = Scope()
    bottleneck: str = ""
    priority: int = 10

    @property
    def bottleneck_key(self):
        return fingerprint(
            (self.route, self.bottleneck or self.goal, asdict(self.scope))
        )


@dataclass(frozen=True)
class Route:
    id: str
    method: str
    first_goal: str
    mechanism: str = "UNKNOWN"
    priority: int = 10


@dataclass(frozen=True)
class Artifact:
    id: str
    problem: str
    route: str
    work_unit: str
    text: str
    request: str
    scope: Scope
    dependencies: tuple[str, ...]
    unverified_dependencies: tuple[str, ...]
    closed: bool
    parent_revision: str | None = None

    @property
    def digest(self):
        return fingerprint(asdict(self))


@dataclass(frozen=True)
class Evidence:
    id: str
    artifact_id: str
    artifact_hash: str
    property: str
    checker: str
    checker_version: str
    input_hash: str
    scope: Scope
    outcome: str
    kind: str
    obligations: tuple[str, ...]
    verified_statement: str = ""


@dataclass(frozen=True)
class CandidateRevision:
    id: str
    artifact: str
    answer: str
    route: str
    parent: str | None = None
    obligations: tuple[str, ...] = ("original_goal_coverage",)


@dataclass(frozen=True)
class Challenge:
    id: str
    target: str
    issue: str
    basis: str
    next_check: str
    status: str = "OPEN"
    check_artifact: str | None = None
    evidence_ids: tuple[str, ...] = ()
    replacement: str | None = None
    resolution: str = ""


@dataclass(frozen=True)
class FailureRecord:
    target: str
    reason: str
    affected: tuple[str, ...] = ()
