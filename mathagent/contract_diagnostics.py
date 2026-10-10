"""Observed goal-chain admission, separate from transport and tool availability."""

from collections import Counter


def goal_chain_usage(snapshot):
    control = snapshot.get("control", {})
    state = control.get("goal_closure", {})
    contract = state.get("contracts", {}).get(state.get("current_contract"), {})
    revision = contract.get("id")
    artifacts = {row["id"]: row for row in snapshot.get("artifacts", [])}
    jobs = [
        row
        for row in state.get("scheduler", {}).get("jobs", {}).values()
        if row.get("contract") == revision
        and row.get("state") == "DELIVERED"
        and artifacts.get(row.get("artifact"), {}).get("closed")
        and not artifacts.get(row.get("artifact"), {})
        .get("text", "")
        .startswith(("TOOL:", "COMPUTATION_NEEDED:"))
    ]
    deliveries = {row["task"]: row for row in jobs}
    branches = [
        row
        for row in state.get("branches", {}).values()
        if row.get("contract") == revision
    ]
    evidence_ids = {row["id"] for row in snapshot.get("evidence", [])}
    checked = [
        row
        for row in branches
        if row.get("membership") == "VERIFIED_FOR_SCOPE"
        and row.get("evidence")
        and set(row["evidence"]) <= evidence_ids
    ]
    # Bound-variable renaming or repeated receipts cannot satisfy two-member gates.
    from .runtime.config import fingerprint

    identities = {
        row["id"]: row.get("canonical_object")
        or row.get("object_identity")
        or fingerprint((row.get("object"), row.get("domain"), row.get("parameters")))
        for row in checked
    }
    checked = list({identities[row["id"]]: row for row in checked}.values())
    candidate_ids = {row["id"] for row in snapshot.get("candidates", [])}
    merges = [
        row
        for row in state.get("merges", {}).values()
        if row.get("contract") == revision
        and row.get("candidate") in candidate_ids
        and set(row.get("branches", [])) <= set(identities)
        and len({identities[bid] for bid in row.get("branches", [])}) >= 2
    ]
    handoffs = sum(
        bool(artifacts[row["artifact"]].get("dependencies"))
        or (row.get("purpose") == "MERGE" and bool(merges))
        for row in jobs
    )
    purposes = Counter(
        event["details"].get("purpose")
        for event in snapshot.get("events", [])
        if event["kind"] == "review"
        and event["details"].get("contract_revision") == revision
        and event["details"].get("complete")
        and event["details"].get("interpretation") not in {"UNKNOWN", "PARTIAL_REVIEW"}
    )
    return {
        "contract_ready": bool(
            revision
            and contract.get("usable")
            and not contract.get("field_gaps")
            and contract.get("source_binding", {}).get("source_hash")
            == snapshot.get("problem_hash")
        ),
        "kind": contract.get("kind", "UNKNOWN"),
        "field_gaps": contract.get("field_gaps", {}),
        "goal_tasks_delivered": len(deliveries),
        "goal_dependency_handoffs": handoffs,
        "branches_registered": len(branches),
        "source_checked_members": len(checked),
        "merge_candidates": len(merges),
        "outside_search_delivered": sum(
            row.get("purpose") == "OUTSIDE_SEARCH" for row in jobs
        ),
        "review_purposes": dict(purposes),
        "mathematical_accuracy_established": False,
    }


def tool_chain_usage(snapshot):
    """Reconstruct adoption from bound control/artifact/dependency records, not prose."""
    from .domain import Artifact, Scope
    from .runtime.config import fingerprint

    control = snapshot.get("control", {})
    artifacts = {a["id"]: a for a in snapshot.get("artifacts", ())}
    jobs = control.get("tool_jobs", {})
    r3_requests = {
        e["details"].get("request"): e["details"].get("target")
        for e in snapshot.get("events", ())
        if e["kind"] == "review"
        and e["details"].get("role") == "task_tool"
        and e["details"].get("position") == "R3"
        and e["details"].get("complete")
        and e["details"].get("interpretation") == "NO_SPECIFIC_ISSUE"
    }
    delivered_requests = {
        e["details"].get("request")
        for e in snapshot.get("events", ())
        if e["kind"] == "delivery"
        and not e["details"].get("late")
        and not e["details"].get("error")
    }
    states = Counter(j.get("state") for j in jobs.values())
    adopted, executed, dynamic = [], [], set()

    def digest(row):
        data = dict(row)
        data["scope"] = Scope(**data["scope"])
        return Artifact(**data).digest

    for key, row in jobs.items():
        proposal = artifacts.get(row.get("proposal_artifact_id"), {})
        observation = artifacts.get(row.get("observation_id"), {})
        result = control.get("computation_results", {}).get(observation.get("id"), {})
        if not (
            row.get("schema") == "tool-job-v1"
            and row.get("state") in {"OBSERVED", "ADOPTED"}
            and proposal.get("closed")
            and proposal.get("text", "").startswith("TOOL:")
            and proposal.get("request") in delivered_requests
            and control.get("delivery_assessments", {})
            .get(proposal.get("id"), {})
            .get("type")
            == "TOOL_PROPOSAL"
            and row.get("review_receipt_id")
            and row.get("review_request_id") in r3_requests
            and r3_requests[row["review_request_id"]] == proposal.get("id")
            and row.get("execution_receipt_id")
            and observation
            and result.get("artifact_hash") == digest(observation)
            and result.get("execution_receipt_id") == row["execution_receipt_id"]
            and row.get("source_hash") == snapshot.get("problem_hash")
            and row.get("runtime_hash")
            == result.get("runtime_hash")
            == control.get("tool_flow_runtime_hash")
        ):
            continue
        executed.append(row)
        consumer = artifacts.get(row.get("adoption_artifact_id"), {})
        if (
            row["state"] == "ADOPTED"
            and consumer.get("closed")
            and consumer.get("work_unit") == row.get("consumer_task_id")
            and observation["id"] in consumer.get("dependencies", ())
            and not consumer.get("text", "").startswith(
                ("TOOL:", "COMPUTATION_NEEDED:")
            )
        ):
            adopted.append(row)
        for branch in control.get("goal_closure", {}).get("branches", {}).values():
            if (
                branch.get("artifact") == observation["id"]
                and branch.get("membership") == "VERIFIED_FOR_SCOPE"
            ):
                valid = [
                    e
                    for e in snapshot.get("evidence", ())
                    if e["id"] in branch.get("evidence", ())
                    and e.get("outcome") == "SUPPORTS"
                    and e.get("checker") == "registered_exact_checker"
                ]
                if valid:
                    dynamic.add(
                        branch.get("canonical_object")
                        or fingerprint(branch.get("object"))
                    )
    counters = control.get("math_delivery_counters", {}).get("facts", {})
    grouped = {}
    for fact, rows in counters.items():
        for details in rows.values():
            key = str((details.get("role", "UNKNOWN"), details.get("purpose")))
            grouped.setdefault(key, Counter())[fact] += 1
    return {
        "schema": "tool-chain-usage-v1",
        "job_states": dict(states),
        "executed": len(executed),
        "adopted": len(adopted),
        "python_executed": sum(j["backend"] == "WASI" for j in executed),
        "python_adopted": sum(j["backend"] == "WASI" for j in adopted),
        "dynamic_members_independently_checked": len(dynamic),
        "counts": {k: len(v) for k, v in counters.items()},
        "by_role_purpose": {k: dict(v) for k, v in grouped.items()},
        "model_adherence_established": False,
    }


def tool_diagnostic_gate(usages, *, require_python=True):
    rows = [u.get("tool_flow", {}) for u in usages]
    missing = []
    for name in ("executed", "adopted", "dynamic_members_independently_checked"):
        if not any(r.get(name, 0) > 0 for r in rows):
            missing.append(name)
    python_used = any(r.get("python_adopted", 0) > 0 for r in rows)
    if require_python and not python_used:
        missing.append("PYTHON_NOT_EXERCISED")
    return {
        "passed": not missing,
        "reason": "diagnostic_tool_adoption_not_integrated" if missing else None,
        "missing": missing,
        "python_status": "EXECUTED_AND_HANDED_OFF"
        if python_used
        else "PYTHON_NOT_EXERCISED",
        "scope": "bound execution/adoption; real-model origin also requires the sender/stream gate",
    }


def goal_diagnostic_gate(usages):
    """Require one actual ALL_SOLUTIONS chain; a successful scalar tool is insufficient."""
    rows = [usage.get("goal_closure", {}) for usage in usages]
    required = {
        "goal_tasks_delivered": 1,
        "goal_dependency_handoffs": 1,
        "source_checked_members": 2,
        "merge_candidates": 1,
        "outside_search_delivered": 1,
    }
    observations = []
    for row in rows:
        missing = []
        if not row.get("contract_ready"):
            missing.append("usable_first_read_contract")
        if row.get("kind") != "ALL_SOLUTIONS":
            missing.append("all_solutions_diagnostic_scope")
        missing += [
            key for key, minimum in required.items() if row.get(key, 0) < minimum
        ]
        missing += [
            purpose
            for purpose in ("MEMBERSHIP", "EXHAUSTIVENESS", "EXCEPTIONS")
            if row.get("review_purposes", {}).get(purpose, 0) < 1
        ]
        observations.append({"kind": row.get("kind", "UNKNOWN"), "missing": missing})
    passed = bool(observations) and any(not row["missing"] for row in observations)
    return {
        "passed": passed,
        "reason": None if passed else "diagnostic_goal_chain_not_integrated",
        "observations": observations,
        "scope": "observed contract/branch/review/search/merge handoff, not proof of accuracy or generalization",
    }
