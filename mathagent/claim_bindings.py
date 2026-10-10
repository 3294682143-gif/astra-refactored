"""Exact scoped proposition identities and checked outside-set counterexamples."""

from dataclasses import asdict, dataclass

from .domain import Challenge, Scope
from .goal_contracts import current
from .runtime.config import fingerprint


@dataclass(frozen=True)
class ClaimBinding:
    problem: str
    contract: str
    artifact: str
    artifact_hash: str
    proposition: str
    variables: tuple[str, ...]
    scope: Scope
    property: str

    @property
    def identity(self):
        # Case, variable order, quantifier order and scope are mathematical data.
        return fingerprint(
            (
                self.problem,
                self.contract,
                self.proposition,
                self.variables,
                asdict(self.scope),
                self.property,
            )
        )


def same_claim(left, right):
    return left.identity == right.identity


def register_claim(store, binding):
    with store.lock:
        contract = current(store)
        artifact = store.artifacts.get(binding.artifact)
        if (
            not contract
            or binding.problem != store.problem.digest
            or binding.contract != contract["id"]
            or (not artifact or binding.artifact_hash != artifact.digest)
        ):
            raise ValueError("unbound mathematical claim")
        key = fingerprint(asdict(binding))
        store.control["goal_closure"]["claims"].setdefault(key, asdict(binding))
        return key


def check_outside_claim(store, candidate, branch):
    """Only the accepted original rational-root grammar licenses this comparison."""
    from .solution_branches import checked_branch, rational_root_check
    from .verification import candidates, root_equation

    evidence = checked_branch(store, branch)
    if (
        not evidence
        or evidence.outcome != "SUPPORTS"
        or not root_equation(store.problem.raw)
    ):
        return None
    result = rational_root_check(store.problem.raw, branch["object"])
    if not result:
        return None
    try:
        values = candidates(candidate.answer)
        outside = candidates(result["value"])[0] not in values
    except (ValueError, TypeError, SyntaxError):
        return None
    if not outside:
        return None
    contract = current(store)
    artifact = store.artifacts[candidate.artifact]
    claim = ClaimBinding(
        store.problem.digest,
        contract["id"],
        artifact.id,
        artifact.digest,
        "all real roots are in " + candidate.answer,
        ("x",),
        Scope(domain="real"),
        "exhaustiveness",
    )
    key = register_claim(store, claim)
    challenge = Challenge(
        "outside-" + fingerprint((key, evidence.id)),
        artifact.id,
        "A source-checked root is outside the claimed complete set.",
        evidence.verified_statement,
        "Restore the omitted root and establish exhaustive coverage from the original equation.",
    )
    store.challenge(challenge)
    store.control["goal_closure"].setdefault("claim_counterexamples", {})[key] = {
        "branch": branch["id"],
        "evidence": evidence.id,
        "denied_property": "exhaustiveness",
        "members_denied": False,
    }
    store.event(
        "outside_counterexample",
        claim=key,
        candidate=candidate.id,
        branch=branch["id"],
        members_denied=False,
    )
    return challenge
