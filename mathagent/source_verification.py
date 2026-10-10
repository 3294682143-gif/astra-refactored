"""Source-compiled, version-bound checks through the real registered executor.

These checks consume no model calls. They do not accept model-supplied mappings
or use gold answers, and do not give arbitrary tool proposals a way around R3.
"""

from __future__ import annotations

import json
import math
import threading
from dataclasses import asdict

from .domain import Evidence, Scope
from .math_source import VERSION, compile_candidate
from .runtime.config import fingerprint
from .tool_contracts import audit_output


def check_candidate_locked(store, artifact, answer, **options):
    """Serialize one source check without holding the global math lock during tools."""
    with store.lock:
        locks = getattr(store, "_source_check_locks", None)
        if locks is None:
            locks = store._source_check_locks = {}
        key = fingerprint((artifact.digest, answer))
        lock = locks.setdefault(key, threading.Lock())
    if not lock.acquire(blocking=False):
        return None
    try:
        return check_candidate(store, artifact, answer, **options)
    finally:
        lock.release()


def receipt_key(artifact, plan, checker_version):
    return fingerprint((artifact.digest, plan.digest, checker_version, VERSION))


def _checked_values(plan, receipt):
    if type(receipt) is not dict:
        return None
    if receipt.get("state") != "FINISHED" or fingerprint(
        receipt.get("plan")
    ) != fingerprint(asdict(plan)):
        return None
    timing = [receipt.get(k) for k in ("started_at", "completed_at", "deadline")]
    if (
        any(type(v) not in {int, float} or not math.isfinite(v) for v in timing)
        or not timing[0] <= timing[1] < timing[2]
    ):
        return None
    results = receipt.get("results", [])
    if type(results) is not list or len(results) != len(plan.checks):
        return None
    values = []
    for check, result in zip(plan.checks, results):
        if type(result) is not dict:
            return None
        if (
            result.get("tool") != check.tool
            or result.get("status") != "ok"
            or result.get("input_hash") != fingerprint((check.tool, check.arguments))
            or result.get("evidence_kind") != "EXACT_FOR_INPUT"
        ):
            return None
        audit = audit_output(
            check.tool,
            check.arguments,
            result.get("result"),
            execution_status=result["status"],
            certificate=result.get("certificate"),
        )
        if audit.status != "VERIFIED_FOR_INPUT" or result.get("verification") != asdict(
            audit
        ):
            return None
        values.append(result["result"])
    return values


def _outcome(plan, values):
    if plan.property == "source_function_satisfaction":
        return all(v["identity_holds"] for v in values)
    if plan.property == "source_invariant_generators":
        return all(all(v["invariant"]) for v in values)
    if plan.property == "source_algebraic_minimum":
        return all(v["is_minimal"] for v in values)
    raise ValueError("unsupported compiled source property")


def _statement(plan, values, supports):
    if plan.property == "source_function_satisfaction":
        details = [v["witness"] for v in values if v["witness"]]
        return (
            "Each submitted polynomial satisfies the declared universal equality; this does NOT classify all functions."
            if supports
            else "A submitted function violates the declared source equality at exact rational points: "
            + json.dumps(details, ensure_ascii=False)
        )
    if plan.property == "source_invariant_generators":
        return (
            "Each proposed generator is invariant under the source maps; full invariant-ring completeness is NOT proved."
            if supports
            else "A proposed arbitrary-family generator is not invariant; exact residual coefficients: "
            + json.dumps([v["residual_terms"] for v in values], ensure_ascii=False)
        )
    return (
        "Exact rational quotient reduction and coefficient ranks establish the submitted polynomial as the unique lowest-degree answer for this source relation. The surrounding derivation/ancestors are not certified."
        if supports
        else "The submitted polynomial fails the exact source relation or the minimum-degree requirement: "
        + json.dumps(values, ensure_ascii=False)
    )


def check_candidate(
    store, artifact, answer, *, executor, deadline, clock, persist, checker_version
):
    from .goal_contracts import current

    contract = current(store)
    revision = contract["id"] if contract else None
    if store.control.get("goal_closure_closed"):
        return None
    if not artifact.closed or artifact.problem != store.problem.digest:
        return None
    plan = compile_candidate(store.problem.raw, answer)
    if plan is None:
        return None
    key = receipt_key(artifact, plan, checker_version)
    receipts = store.control.setdefault("source_check_receipts", {})
    if type(receipts) is not dict or (
        key in receipts and type(receipts[key]) is not dict
    ):
        store.event(
            "source_check_not_replayed", artifact=artifact.id, state="INVALID_RECEIPT"
        )
        return None
    receipt = receipts.get(key)
    if receipt is None:
        if clock() >= deadline():
            store.event(
                "source_check_not_started",
                artifact=artifact.id,
                reason="original_deadline",
            )
            return None
        receipt = {
            "state": "STARTED",
            "plan": asdict(plan),
            "artifact_hash": artifact.digest,
            "checker_version": checker_version,
            "results": [],
            "started_at": clock(),
            "deadline": deadline(),
        }
        receipts[key] = receipt
        store.event(
            "source_check_compiled",
            artifact=artifact.id,
            property=plan.property,
            plan_hash=plan.digest,
            source_hash=plan.source_hash,
            answer_hash=plan.answer_hash,
            full_goal=plan.full_goal,
            model_mapping_not_used=True,
        )
        persist()
        try:
            for operation in plan.checks:
                operation_deadline = min(receipt["deadline"], deadline())
                if clock() >= operation_deadline:
                    receipt["state"] = "DEADLINE"
                    persist()
                    return None
                store.event(
                    "tool_preflight",
                    target=artifact.id,
                    tool=operation.tool,
                    status="SOURCE_BOUND_INPUT_CONTRACT_ACCEPTED",
                )
                options = {
                    "deadline": operation_deadline,
                    "scope": f"{plan.property}; compiler={VERSION}; mapping bound to source {plan.source_hash}",
                }
                # Use the same process-limited executor/diagnostic recording seam
                # as model proposals, with a distinct exact source-binding record.
                if callable(getattr(executor, "execute_bound", None)):
                    result = executor.execute_bound(
                        operation.tool,
                        operation.arguments,
                        **options,
                        binding={
                            "source_plan": asdict(plan),
                            "source_plan_hash": plan.digest,
                            "artifact_digest": artifact.digest,
                            "mode": "source_compiled_check",
                        },
                    )
                else:
                    result = executor.execute(
                        operation.tool, operation.arguments, **options
                    )
                receipt["results"].append(asdict(result))
                store.event(
                    "tool_executed",
                    target=artifact.id,
                    tool=operation.tool,
                    status=result.status,
                    trigger="source_compiled_check",
                )
                if clock() >= min(operation_deadline, deadline()):
                    receipt["state"] = "LATE"
                    store.event(
                        "source_check_inconclusive",
                        artifact=artifact.id,
                        reason="late_local_observation_not_adopted",
                    )
                    persist()
                    return None
            receipt["completed_at"] = clock()
            receipt["state"] = "FINISHED"
            persist()
        except Exception as exc:  # noqa: BLE001 - failed local observation supplies no mathematical authority
            receipt["state"] = "FAILED"
            receipt["error_type"] = type(exc).__name__
            store.event(
                "source_check_failed",
                artifact=artifact.id,
                error_type=type(exc).__name__,
            )
            persist()
            return None
    if receipt.get("state") != "FINISHED":
        store.event(
            "source_check_not_replayed",
            artifact=artifact.id,
            state=receipt.get("state"),
        )
        return None
    values = _checked_values(plan, receipt)
    if values is None:
        store.event(
            "source_check_inconclusive",
            artifact=artifact.id,
            reason="independent_output_check_missing_or_mismatch",
        )
        return None
    supports = _outcome(plan, values)
    outcome = "SUPPORTS" if supports else "REFUTES"
    evidence = Evidence(
        fingerprint((key, outcome)),
        artifact.id,
        artifact.digest,
        plan.property,
        "registered_exact_checker",
        checker_version,
        plan.digest,
        Scope(domain=plan.domain),
        outcome,
        "EXACT_CHECK" if supports else "EXACT_COUNTEREXAMPLE",
        ("original_goal_coverage",)
        if supports and plan.full_goal
        else ("candidate_satisfies",)
        if supports
        else (),
        _statement(plan, values, supports),
    )
    with store.lock:
        live = current(store)
        if store.control.get("goal_closure_closed") or (
            revision and (not live or live["id"] != revision)
        ):
            store.event("source_check_stale", artifact=artifact.id, adopted=False)
            return None
        return _adopt_source_evidence(
            store, artifact, evidence, plan, supports, receipt, clock, deadline, persist
        )


def _adopt_source_evidence(
    store, artifact, evidence, plan, supports, receipt, clock, deadline, persist
):
    if evidence.id not in store.evidence:
        if clock() >= min(receipt["deadline"], deadline()):
            store.event(
                "source_check_inconclusive",
                artifact=artifact.id,
                reason="deadline_before_evidence_adoption",
            )
            return None
        store.evidence[evidence.id] = evidence
        store.event("evidence", evidence=asdict(evidence))
        store.event(
            "source_check_result",
            artifact=artifact.id,
            property=plan.property,
            outcome=evidence.outcome,
            answer_complete=supports and plan.full_goal,
            derivation_and_ancestors_verified=False,
        )
        if not supports:
            store.refute(artifact.id, evidence)
        # This is answer/property evidence, NOT verification of a natural-language
        # derivation or its provisional ancestors. Never modify store.verified.
        persist()
    return evidence


def goal_coverage(store, candidate, checker_version):
    artifact = store.artifacts.get(candidate.artifact)
    if (
        artifact is None
        or not artifact.closed
        or artifact.problem != store.problem.digest
        or artifact.id in store.refuted
    ):
        return ()
    plan = compile_candidate(store.problem.raw, candidate.answer)
    if plan is None or not plan.full_goal:
        return ()
    receipts = store.control.get("source_check_receipts", {})
    if type(receipts) is not dict:
        return ()
    receipt = receipts.get(receipt_key(artifact, plan, checker_version), {})
    values = _checked_values(plan, receipt)
    if values is None or not _outcome(plan, values):
        return ()
    obligations = set(candidate.obligations) | {"original_goal_coverage"}
    return tuple(
        e
        for e in store.evidence.values()
        if e.artifact_id == artifact.id
        and e.artifact_hash == artifact.digest
        and e.property == plan.property
        and e.input_hash == plan.digest
        and e.checker == "registered_exact_checker"
        and e.checker_version == checker_version
        and e.kind == "EXACT_CHECK"
        and e.outcome == "SUPPORTS"
        and e.scope == Scope(domain=plan.domain)
        and obligations <= set(e.obligations)
        and e.verified_statement == _statement(plan, values, True)
    )
