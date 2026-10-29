"""Purpose-specific review identities, not a source of mathematical authority."""

from dataclasses import asdict, dataclass

from .runtime.config import fingerprint

PURPOSES = {
    "MEMBERSHIP": "For each specified member or parameterized family, inspect source satisfaction and parameter domain; give exact gaps or executable checks. Finite samples do not prove a universal family.",
    "EXHAUSTIVENESS": "Inspect the necessity argument starting from an arbitrary source solution and covering it by the claimed branches. List any unexcluded cases. Substitution only establishes membership, not exhaustiveness.",
    "EXCEPTIONS": "Inspect divisions, degenerate parameters, endpoints, and quantifier changes. Identify the exact missing case, if any. Do not manufacture extra solutions.",
    "REVISION": "Inspect the changed interpretation or derivation against the original source and specific earlier doubt. An author assertion that it is fixed is not evidence.",
    "FINAL_COVERAGE": "Inspect all target obligations, branch domains and output items of the exact candidate. State remaining coverage gaps. Do not create a new answer while formatting.",
}


@dataclass(frozen=True)
class ReviewTask:
    problem: str
    contract: str | None
    target: str
    artifact_hash: str
    role: str
    position: str
    purpose: str | None
    context_identity: str
    evidence: tuple[str, ...] = ()

    @property
    def id(self):
        return fingerprint(asdict(self))
