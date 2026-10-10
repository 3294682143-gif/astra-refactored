"""Independent registered-output evidence. Never certifies original mapping."""

from dataclasses import asdict

from .domain import Evidence
from .runtime.config import fingerprint
from .tool_contracts import audit_output


def record_input_evidence(store, observation, proposal, result):
    if result.verification is None or result.evidence_kind != "EXACT_FOR_INPUT":
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
    from .verification import VerificationEngine

    evidence = Evidence(
        fingerprint((observation.digest, asdict(audited))),
        observation.id,
        observation.digest,
        "registered_output:" + proposal.name,
        "registered_exact_checker",
        VerificationEngine.version,
        audited.input_hash,
        observation.scope,
        "SUPPORTS",
        "EXACT_CHECK",
        ("registered_tool_output",),
        f"For the supplied finite tool inputs only: {audited.property}; scope: {audited.scope}. Original-problem mapping remains UNVERIFIED.",
    )
    store.evidence[evidence.id] = evidence
    store.event("evidence", evidence=asdict(evidence))
    # Keep dependencies/Verified unchanged. In particular, checked computation
    # cannot validate the model's translation of a natural-language problem.
    return evidence
