"""Read-only logical call accounting and explicitly uncertain capacity models."""

from __future__ import annotations

import math


def counts(db, run_id):
    run = db.execute("SELECT calls FROM runs WHERE id=?", (run_id,)).fetchone()
    if run is None:
        raise ValueError("unknown run")
    requests = [
        dict(r) for r in db.execute("SELECT * FROM requests WHERE run=?", (run_id,))
    ]
    tables = {
        r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    facts = (
        [
            dict(r)
            for r in db.execute(
                "SELECT f.* FROM request_facts f JOIN requests r ON f.request=r.id WHERE r.run=?",
                (run_id,),
            )
        ]
        if "request_facts" in tables
        else []
    )
    ids = lambda fact: {r["request"] for r in facts if r["fact"] == fact}
    sent = ids("dispatch_attempted")
    if len(requests) != run[0]:
        raise ValueError("logical call ledger inconsistent")
    for fact in ("provider_response_observed", "protocol_valid", "task_delivered"):
        if not ids(fact) <= sent:
            raise ValueError("unbound or forged post-dispatch facts")
    transport = [r for r in facts if r["fact"].startswith("transport_attempt:")]
    if any(r["request"] not in sent for r in transport):
        raise ValueError("transport fact without logical dispatch")
    measured = bool(facts) or not requests
    return {
        "logical_admitted": run[0],
        "dispatch_attempted": len(sent) if measured else None,
        "provider_response_observed": len(ids("provider_response_observed"))
        if measured
        else None,
        "terminal_confirmed": sum(
            r["settled"] is not None and r["status"] != "IN_FLIGHT" for r in requests
        ),
        "protocol_valid": len(ids("protocol_valid")) if measured else None,
        "task_delivered": len(ids("task_delivered")) if measured else None,
        "remote_unknown": sum(r["status"] == "IN_FLIGHT" for r in requests),
        "transport_attempts": len(transport) if transport else None,
        "transport_observed_logical_requests": len({r["request"] for r in transport}),
        "counting_scope": "stable logical request IDs; provider receipt/completion are separate",
        "resource_goal": "RESOURCE_GOAL_MET"
        if measured and len(sent) >= 5000 and run[0] <= 10000
        else "COMPLETE_WITH_CALL_TARGET_UNMET",
    }


def duration_statistics(samples):
    groups = {}
    for row in samples:
        if (
            row.get("task_delivered") is not True
            or row.get("error")
            or row.get("late")
            or type(row.get("seconds")) not in {float, int}
            or not math.isfinite(row["seconds"])
            or row["seconds"] < 0
        ):
            continue
        groups.setdefault((row.get("kind", "unknown"), row.get("purpose")), []).append(
            row["seconds"]
        )
    result = []
    for (kind, purpose), values in sorted(groups.items(), key=lambda x: repr(x[0])):
        values.sort()
        result.append(
            {
                "kind": kind,
                "purpose": purpose,
                "n": len(values),
                "mean": sum(values) / len(values),
                "p50": values[math.ceil(len(values) * 0.5) - 1],
                "p90": values[math.ceil(len(values) * 0.9) - 1],
                "uncertainty": "small sample"
                if len(values) < 30
                else "empirical, not a guarantee",
            }
        )
    return result


def capacity_report(
    *,
    messages,
    caps,
    seconds=21600,
    logical_remaining=10000,
    legal_permits=None,
    duration_p90=None,
    productive_tasks=None,
    rpm=30,
    tpm=150000,
    duration_estimate=None,
    request_profile=None,
    global_max_tokens=8192,
    rate_policy_enforced=False,
    dispatched_so_far=0,
):
    from .runtime.provider_rate import token_reservation

    if len(messages) != len(caps) or not messages:
        raise ValueError("complete frozen message/cap samples required")
    if any(type(cap) is not int or not 1 <= cap <= 8192 for cap in caps):
        raise ValueError("invalid request caps")
    for value in (duration_p90, duration_estimate):
        if value is not None and (
            type(value) not in {int, float} or not math.isfinite(value) or value <= 0
        ):
            raise ValueError("positive finite duration estimate required")
    if type(dispatched_so_far) is not int or not 0 <= dispatched_so_far <= 10000:
        raise ValueError("invalid same-run dispatch count")
    if type(rate_policy_enforced) is not bool:
        raise ValueError("rate policy enforcement must be explicit")
    if legal_permits is not None and (
        type(legal_permits) is not int or not 0 <= legal_permits <= 8
    ):
        raise ValueError("invalid legal permit estimate")
    if (
        not 0 <= seconds <= 21600
        or not 0 <= logical_remaining <= 10000
        or not 0 < rpm <= 30
        or not 0 < tpm <= 150000
    ):
        raise ValueError("capacity cannot increase formal/provider limits")
    reservations = [token_reservation(m, c) for m, c in zip(messages, caps)]
    mean = sum(reservations) / len(reservations)
    bounds = {
        "logical": logical_remaining,
        "rpm": seconds / 60 * rpm,
        "tpm_optimistic": seconds / 60 * tpm / mean,
        "latency": seconds * legal_permits / duration_p90
        if legal_permits is not None and duration_p90 and duration_p90 > 0
        else None,
        "productive_task_supply": productive_tasks,
    }
    # Estimates are not physical limits. Slow p90s, current occupied slots and
    # sample message lengths cannot establish impossibility for a future task mix.
    scenario = math.floor(min(v for v in bounds.values() if v is not None))
    physical = {"logical_remaining": logical_remaining}
    if seconds == 0:
        physical["original_deadline"] = 0
    if rate_policy_enforced:
        # An extra window safely overbounds a boundary burst; no guessed refund.
        windows = math.ceil(seconds / 60) + 1 if seconds else 0
        physical["rpm_window_limit"] = windows * rpm
        if request_profile is not None:
            from .request_policy import effective_max_tokens

            minimum = effective_max_tokens(
                request_profile, "single_object_check", global_max_tokens
            )
            physical["tpm_output_floor"] = math.floor(windows * tpm / minimum)
    upper = math.floor(min(physical.values()))
    prediction = None
    if duration_estimate is not None and legal_permits is not None:
        prediction = math.floor(
            min(
                logical_remaining,
                seconds / 60 * rpm,
                seconds / 60 * tpm / mean,
                seconds * legal_permits / duration_estimate,
            )
        )
    impossible = dispatched_so_far + upper < 5000
    missing = [k for k, v in bounds.items() if v is None]
    return {
        "schema": "goal-capacity-v2",
        "target": 5000,
        "working_target": 5500,
        "reservation_units": "UTF-8 input bytes + framing + actual output cap; not true usage",
        "sample_count": len(messages),
        "mean_reservation": mean,
        "bounds": bounds,
        "bounds_scope": "legacy estimates; only certified_upper_bounds may block dispatch",
        "prediction": {
            "calls": prediction,
            "duration_seconds": duration_estimate,
            "basis": "assumed future mix like observed diagnostic mix; not a guarantee",
        },
        "conservative_scenario": {
            "calls": scenario,
            "all_calls_seconds": duration_p90,
            "basis": "all future calls as slow as selected p90, not an upper bound",
        },
        "scenario_capacity": scenario,
        "scenario_assessment": "BELOW_TARGET"
        if scenario + dispatched_so_far < 5000
        else "NOT_BELOW_TARGET",
        "certified_upper_bounds": physical,
        "certified_upper": upper,
        "dispatched_so_far": dispatched_so_far,
        "certified_total_upper": dispatched_so_far + upper,
        "block_basis": "CERTIFIED_LIMIT" if impossible else None,
        "optimistic_upper": upper,
        "optimistic_upper_scope": "loose physical/quota upper bound, not achievable capacity",
        "missing": missing,
        "assessment": "CLEARLY_BELOW_TARGET" if impossible else "UNCERTAIN",
        "admission_authority": False,
        "ready_for_execution": False,
        "caveat": "No refund for short output. Dependency/three-item scheduling, pauses and provider uncertainty reduce capacity.",
    }


def capacity_blocks_dispatch(report):
    """Legacy/scenario-only reports cannot authorize a capacity stop."""
    bounds = report.get("certified_upper_bounds", {})
    if (
        report.get("schema") != "goal-capacity-v2"
        or not bounds
        or set(bounds)
        - {
            "logical_remaining",
            "original_deadline",
            "rpm_window_limit",
            "tpm_output_floor",
        }
        or any(
            type(v) not in {int, float} or not math.isfinite(v) or v < 0
            for v in bounds.values()
        )
    ):
        return False
    upper = math.floor(min(bounds.values()))
    spent = report.get("dispatched_so_far")
    return (
        type(spent) is int
        and 0 <= spent <= 10000
        and upper + spent < 5000
        and report.get("certified_upper") == upper
        and report.get("certified_total_upper") == upper + spent
        and report.get("assessment") == "CLEARLY_BELOW_TARGET"
        and report.get("block_basis") == "CERTIFIED_LIMIT"
    )


def static_preview(items, manifest, legal_permits):
    """Complete cold-start message samples; missing parents/latencies are explicit."""
    from .prompts.planning import PLAN_GOAL
    from .prompts.protocol import messages
    from .prompts.review import review_goal
    from .request_policy import effective_max_tokens
    from .skills import SkillCatalog

    profile = manifest.get("request_contract", {}).get("request_profile", "fixed_8192")
    samples, caps = [], []
    for item in items[:3]:
        for kind, goal, output_class in (
            ("plan", PLAN_GOAL, "contract"),
            (
                "derive",
                "Derive one source-bound intermediate result with its assumptions.",
                "full",
            ),
            (
                "candidate",
                "Form the original-problem candidate and state unresolved obligations.",
                "full",
            ),
            ("review_method", review_goal("method", "EXHAUSTIVENESS"), "full"),
        ):
            samples.append(
                messages(
                    problem=item["problem"],
                    goal=goal,
                    kind=kind,
                    skill=SkillCatalog().metadata() if kind == "plan" else "",
                )
            )
            caps.append(effective_max_tokens(profile, output_class, 8192))
    rates = manifest.get("provider_rate_policy")
    report = capacity_report(
        messages=samples,
        caps=caps,
        legal_permits=legal_permits,
        request_profile=profile,
        rate_policy_enforced=rates is not None,
        rpm=rates["requests_per_minute"] if rates else 30,
        tpm=rates["tokens_per_minute"] if rates else 150000,
    )
    report["sample_scope"] = (
        "equal-weight cold-start task mix on first <=3 frozen public sources; no references"
    )
    report["missing"].extend(["later_complete_parent_contexts", "real_task_mix"])
    report["sample_message_hashes"] = []
    from .runtime.config import fingerprint

    report["sample_message_hashes"] = [fingerprint(packet) for packet in samples]
    report["request_profile"] = profile
    return report


def diagnostic_capacity(output, manifest, coordinator):
    """Re-estimate from visible diagnostic calls; does not change provider limits."""
    import hashlib
    import json
    from pathlib import Path

    from .runtime.config import fingerprint
    from .runtime.protocol import ParsedResponse

    samples, caps, durations, identities = [], [], [], []
    for path in sorted((Path(output) / "diagnostics").glob("diagnostic-*/call-*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        generated = row["generation"]
        samples.append(row["messages"])
        caps.append(row["request_parameters"]["max_tokens"])
        durations.append(
            {
                "kind": row["kind"],
                "seconds": row["returned_monotonic"] - row["started_monotonic"],
                "task_delivered": ParsedResponse(**generated["parsed"]).closed,
                "purpose": row.get("intent", {}).get("task_purpose"),
                "error": row["error"],
                "late": row["late"],
            }
        )
        identities.append(
            {
                "path": str(path.relative_to(output)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    if not samples:
        return {
            "assessment": "UNCERTAIN",
            "reason": "no complete visible diagnostic inventory",
            "ready_for_execution": False,
            "manifest_fingerprint": fingerprint(manifest),
        }
    stats = duration_statistics(durations)
    latency = max((g["p90"] for g in stats if g["p90"] > 0), default=None)
    sample_count = sum(g["n"] for g in stats)
    mixture = (
        sum(g["n"] * g["mean"] for g in stats) / sample_count if sample_count else None
    )
    metrics = coordinator.metrics()
    rates = getattr(coordinator, "provider_rate_policy", None)
    counted = coordinator.call_accounting()["dispatch_attempted"]
    report = capacity_report(
        messages=samples,
        caps=caps,
        seconds=max(0, metrics["deadline"] - coordinator.clock()),
        logical_remaining=max(0, 10000 - metrics["calls"]),
        legal_permits=max(0, coordinator.limits.in_flight - metrics["in_flight"]),
        duration_p90=latency,
        duration_estimate=mixture if mixture and mixture > 0 else None,
        dispatched_so_far=counted if counted is not None else metrics["calls"],
        request_profile=manifest.get("request_contract", {}).get("request_profile"),
        global_max_tokens=coordinator.limits.max_tokens,
        rate_policy_enforced=rates is not None,
        rpm=rates["requests_per_minute"] if rates else 30,
        tpm=rates["tokens_per_minute"] if rates else 150000,
    )
    report.update(
        duration_groups=stats,
        diagnostic_records=identities,
        manifest_fingerprint=fingerprint(manifest),
        counted_before_suite=counted,
        prior_count_basis="observed dispatches"
        if counted is not None
        else "admitted upper bound; dispatch observation missing",
        caveat="diagnostic task mix is a sample, not a promise about future 112-task supply",
    )
    # Target is total dispatches in the SAME run, not 5000 additional calls.
    return report
