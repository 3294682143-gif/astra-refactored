"""One explicitly bounded original-goal/tool mapping; all other mappings unknown."""

import re

from .domain import Evidence, Scope
from .runtime.config import fingerprint
from .tool_contracts import audit_output


def odd_part_goal(text):
    match = re.fullmatch(
        r"Compute the odd part of ([1-9]\d*)[.]?", text.strip(), re.IGNORECASE
    )
    return int(match[1]) if match and int(match[1]) <= 10**9 else None


def mapped_value(store, unit, proposal, result):
    n = odd_part_goal(store.problem.raw)
    if (
        n is None
        or odd_part_goal(unit.goal) != n
        or proposal.name != "odd_part"
        or proposal.args != {"n": n}
        or type(proposal.args.get("n")) is not int
        or unit.scope.conditions
        or unit.scope.quantifiers
        or unit.scope.domain not in {"unspecified", "positive_integer"}
        or result.status != "ok"
        or result.evidence_kind != "EXACT_FOR_INPUT"
    ):
        return None
    audited = audit_output(
        proposal.name,
        proposal.args,
        result.result,
        execution_status=result.status,
        certificate=result.certificate,
    )
    if (
        audited.status != "VERIFIED_FOR_INPUT"
        or result.verification != audited
        or result.input_hash != audited.input_hash
    ):
        return None
    return n, result.result


def register_mapping(store, observation, source, pair):
    from .verification import VerificationEngine

    n, value = pair
    evidence = Evidence(
        fingerprint((observation.digest, "odd_part_value", n, value)),
        observation.id,
        observation.digest,
        "odd_part_value",
        "registered_exact_checker",
        VerificationEngine.version,
        fingerprint((str(n), str(value))),
        Scope(domain="positive_integer"),
        "SUPPORTS",
        "EXACT_CHECK",
        ("value",),
        f"The odd part of {n} is {value}.",
    )
    with store.lock:
        store.evidence[evidence.id] = evidence
        store.verified.add(observation.id)
        store.control.setdefault("mapped_tool_goals", {})[observation.id] = {
            "problem": store.problem.digest,
            "n": n,
            "value": value,
            "evidence": evidence.id,
            "source_proposal": source.id,
            "source_hash": source.digest,
            "observation_hash": observation.digest,
        }
        store.event(
            "tool_goal_mapping",
            artifact=observation.id,
            evidence=evidence.id,
            property="odd_part_value",
            original_goal="explicit odd-part grammar",
            source_proposal=source.id,
            mapping_status="EXACT_FOR_DECLARED_GOAL",
        )


def has_mapped_ancestor(store, artifact):
    n = odd_part_goal(store.problem.raw)
    pending, seen = list(artifact.dependencies), set()
    while pending:
        aid = pending.pop()
        if aid in seen:
            continue
        seen.add(aid)
        parent = store.artifacts[aid]
        pending.extend(parent.dependencies)
        mapping = store.control.get("mapped_tool_goals", {}).get(aid)
        if (
            mapping
            and mapping["problem"] == store.problem.digest
            and mapping["n"] == n
            and mapping["observation_hash"] == parent.digest
            and mapping["source_hash"]
            == store.artifacts[mapping["source_proposal"]].digest
            and store.applicable_evidence(aid, Scope(domain="positive_integer"))
        ):
            return True
    return False
