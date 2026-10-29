"""Small callable ports for side effects; usable with in-memory test doubles."""

from typing import Protocol

from ..domain import Artifact, CandidateRevision, WorkUnit
from ..runtime.adapter import Generation


class Checkpoint(Protocol):
    def __call__(self) -> object: ...


class WorkUnitCall(Protocol):
    def __call__(
        self,
        unit: WorkUnit,
        *,
        deadline: float,
        once: str | None = None,
        review_input: str = "",
        skill: str = "",
        parent: str | None = None,
        final: bool = False,
    ) -> tuple[Artifact, Generation]: ...


class CandidateRegistrar(Protocol):
    def __call__(
        self, artifact: Artifact, *, parent: str | None = None
    ) -> CandidateRevision | None: ...


class ArtifactProcessor(Protocol):
    def __call__(self, artifact: Artifact, unit: WorkUnit) -> Artifact: ...


class WorkUnitResolver(Protocol):
    def __call__(self, artifact: Artifact, fallback: WorkUnit) -> WorkUnit: ...


class BranchReview(Protocol):
    def __call__(self, unit: WorkUnit) -> WorkUnit: ...
