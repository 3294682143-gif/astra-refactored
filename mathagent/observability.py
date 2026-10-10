"""Observed module activation from committed events, separate from configuration."""

from collections import Counter
from statistics import median


def note_admission_wait(store, generation):
    value = generation.transport.get("admission_wait_seconds")
    if type(value) not in {int, float} or not 0 <= value < 21600:
        return
    with store.lock:
        records = store.control.setdefault("recent_admission_wait_records", [])
        if any(row["request"] == generation.request_id for row in records):
            return
        records.append(
            {
                "request": generation.request_id,
                "seconds": float(value),
                "started": generation.transport.get("request_started_monotonic", 0.0),
            }
        )
        # Independent R0 completions may arrive in either order. Recency follows
        # the original dispatch timestamps, not nondeterministic thread return.
        records.sort(key=lambda row: (row["started"], row["request"]))
        del records[:-16]
        store.control["recent_admission_waits"] = [row["seconds"] for row in records]


def admission_wait_estimate(store):
    samples = store.control.get("recent_admission_waits", [])
    return median(samples) if samples else 0.0


def module_usage(snapshot):
    from .contract_diagnostics import goal_chain_usage, tool_chain_usage

    events = snapshot.get("events", [])
    kinds = Counter(e["kind"] for e in events)
    reviews = Counter(
        e["details"].get("position") for e in events if e["kind"] == "review"
    )
    executions = [e["details"] for e in events if e["kind"] == "tool_executed"]
    skills = [
        e["details"]["family"]
        for e in events
        if e["kind"] == "skill_used" and e["details"].get("confirmed_packet")
    ]
    used_routes = {
        e["details"]["route"]["id"] for e in events if e["kind"] == "route_started"
    }
    units = snapshot.get("control", {}).get("artifact_units", {})
    candidate_artifacts = {c["artifact"] for c in snapshot.get("candidates", [])}
    repaired = [e["details"]["revised"] for e in events if e["kind"] == "r5_gap_repair"]
    waits = snapshot.get("control", {}).get("recent_admission_waits", [])
    return {
        "goal_closure": goal_chain_usage(snapshot),
        "tool_flow": tool_chain_usage(snapshot),
        "observed": {
            "skills": bool(skills),
            "registered_tools": any(
                e.get("tool") != "generated_python" for e in executions
            ),
            "risk_review": bool(reviews["R1"] + reviews["R2"]),
            "alternate_routes": len(used_routes) > 1,
            "dynamic_budget": bool(kinds["budget_tightened"]),
            "persistent_recovery": bool(kinds["task_graph_recovery"]),
            "python": any(e.get("tool") == "generated_python" for e in executions),
            "fallback": any(u.get("kind") == "FALLBACK" for u in units.values()),
        },
        "skill_bodies_in_packets": len(skills),
        "skill_families": dict(Counter(skills)),
        "tool_proposed": kinds["tool_proposed"],
        "tool_preflight": kinds["tool_preflight"],
        "tool_executed": len(executions),
        "tool_successful": sum(
            e.get("status") in {"ok", "partial"} for e in executions
        ),
        "evidence": len(snapshot.get("evidence", [])),
        "verified_artifacts": len(snapshot.get("verified", [])),
        "source_checks_compiled": kinds["source_check_compiled"],
        "source_counterexamples": sum(
            e["kind"] == "source_check_result"
            and e["details"].get("outcome") == "REFUTES"
            for e in events
        ),
        "independently_verified_answer_versions": sum(
            e["kind"] == "source_check_result"
            and e["details"].get("answer_complete") is True
            for e in events
        ),
        "source_check_failures": kinds["source_check_failed"]
        + kinds["source_check_inconclusive"],
        "candidate_revisions": len(candidate_artifacts),
        "r5_repairs": len(repaired),
        "computational_tasks": sum(u.get("kind") == "COMPUTE" for u in units.values()),
        "r5_repairs_registered": sum(a in candidate_artifacts for a in repaired),
        "review_positions": dict(reviews),
        "task_delivery_mismatches": sum(
            v.get("status") == "MISMATCH"
            for v in snapshot.get("control", {})
            .get("delivery_assessments", {})
            .values()
        ),
        "truth_or_accuracy_not_established_by_usage": True,
        "admission_wait_median_seconds": median(waits) if waits else 0.0,
    }


def run_usage(snapshots, requests=(), *, normal_per_problem=2):
    per_item = [module_usage(s) for s in snapshots]
    observed = {
        name: any(row["observed"][name] for row in per_item)
        for name in (per_item[0]["observed"] if per_item else [])
    }
    # An unsettled lease remains occupied. This is a resource observation, not
    # an assertion that the provider is still computing or has been cancelled.
    timeline = []
    for r in requests:
        timeline.append((r["dispatched"], 1, r["item"]))
        if r.get("settled") is not None:
            timeline.append((r["settled"], -1, r["item"]))
    active = Counter()
    borrowed = False
    for _, change, item in sorted(timeline):
        active[item] += change
        borrowed |= active[item] > normal_per_problem
    observed["cross_question_borrowing"] = borrowed
    return {
        "observed": observed,
        "items": per_item,
        "derived_from_committed_events": True,
        "accuracy_not_inferred": True,
    }
