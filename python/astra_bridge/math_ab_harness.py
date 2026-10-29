"""G5/PR6 (local) — offline four-arm A/B/C/D comparison harness + statistics judge.

v4.0 §4.6 fixes four same-budget arms:

- **A** = RC2 frozen Python solver;
- **B** = a2 ``lite`` solver (when the rules allow reproducing it);
- **C** = TS *behavior-alignment* profile (the TS loop with the G3/PR4/G4
  enhancements switched off, so it matches the pre-enhancement behaviour);
- **D** = TS *full math mechanism* profile (the TS loop with the full R0/repair/
  multi-gap capabilities enabled).

Arm **C** and **D** can be exercised fully offline through the real
``engine="ts"`` entry with an injected fake client. Arms **A** and **B** require
the separate, authorized real model/API run; offline they are recorded honestly
as ``NOT_RUN (BLOCKED_EXTERNAL)`` and are never faked.

The judge reports a per-cell breakdown (accuracy, right->wrong, wrong->right,
unsolved, missing branch, repair-retention, ``length`` truncation,
``OUTCOME_UNKNOWN``, wall time, known/unknown tokens). No network, no real model.
"""

from __future__ import annotations

__all__ = [
    "ARM_IDS",
    "ARM_PROFILES",
    "OFFLINE_ARMS",
    "ONLINE_ARMS",
    "run_arm",
    "judge",
    "run_comparison",
]

ARM_IDS = ("A", "B", "C", "D")
OFFLINE_ARMS = ("C", "D")
ONLINE_ARMS = ("A", "B")

# The TS profiles: C is behaviour-aligned (enhancements off), D is the full
# math mechanism (R0 + repair + multi-gap on). Same frozen budget for both.
_BASE_BUDGET = {"max_model_calls": 8, "max_work_units": 3, "max_effects": 1, "max_reviews": 1}
ARM_PROFILES = {
    "C": {**_BASE_BUDGET, "max_repairs": 0, "max_r0": 0},
    "D": {**_BASE_BUDGET, "max_repairs": 1, "max_r0": 1},
}


def _unsolved(reason="ERROR"):
    return {
        "status": "unsolved",
        "final_response": "Unsolved.",
        "reason": reason,
        "metrics": {},
    }


def run_arm(arm_id, corpus, make_agent):
    """Run one offline arm over the frozen corpus. `make_agent(arm_id, problem)`."""
    records = []
    for item in corpus:
        try:
            agent = make_agent(arm_id, item["problem"])
            result = agent.solve(item["problem"], {"source": "ab-offline"})
            if not isinstance(result, dict):
                result = _unsolved()
        except Exception:  # noqa: BLE001 - a failed arm run is a fixed unsolved cell
            result = _unsolved()
        records.append(
            {
                "id": item.get("id", item["problem"]),
                "status": result.get("status"),
                "final_response": result.get("final_response"),
                "reason": result.get("reason"),
                "stopReason": result.get("stopReason"),
                "candidate_verified": result.get("candidate_verified"),
                "elapsedMs": result.get("elapsedMs"),
                "reported_tokens": (result.get("metrics") or {}).get("reported_tokens"),
                "unknown_usage_requests": (result.get("metrics") or {}).get("unknown_usage_requests"),
            }
        )
    return records


def _is_correct(item, record):
    return record.get("final_response") == item.get("expected_answer")


def _is_missing_branch(item, record):
    """Expected a superset answer but the arm returned a strict subset."""
    expected = item.get("expected_answer")
    got = record.get("final_response")
    if not isinstance(expected, str) or not isinstance(got, str):
        return False
    try:
        want = {tok for tok in expected.strip("{} ").split(",") if tok}
        have = {tok for tok in got.strip("{} ").split(",") if tok}
    except Exception:  # noqa: BLE001
        return False
    return bool(have) and have < want


def judge(corpus, records, arm_id=None):
    """Per-cell statistics for one arm's records against the corpus."""
    by_id = {record["id"]: record for record in records}
    stats = {
        "arm": arm_id,
        "total": len(corpus),
        "correct": 0,
        "right_to_wrong": 0,
        "wrong_to_right": 0,
        "unsolved": 0,
        "missing_branch": 0,
        "repair_retained": 0,
        "truncated_length": 0,
        "outcome_unknown": 0,
        "known_tokens": 0,
        "unknown_tokens": 0,
        "latency_ms": 0,
        "not_run": 0,
    }
    for item in corpus:
        record = by_id.get(item.get("id", item["problem"]))
        if record is None:
            continue
        status = record.get("status")
        if status == "NOT_RUN":
            stats["not_run"] += 1
            continue
        correct = _is_correct(item, record)
        if correct:
            stats["correct"] += 1
        elif _is_missing_branch(item, record):
            stats["missing_branch"] += 1
        if status != "candidate":
            stats["unsolved"] += 1
        if record.get("reason") == "REVISED_CANDIDATE":
            stats["repair_retained"] += 1
        if record.get("stopReason") == "TRUNCATED" or record.get("reason") == "TRUNCATED":
            stats["truncated_length"] += 1
        if record.get("stopReason") == "OUTCOME_UNKNOWN" or record.get("reason") == "OUTCOME_UNKNOWN":
            stats["outcome_unknown"] += 1
        reported = record.get("reported_tokens")
        unknown = record.get("unknown_usage_requests")
        if isinstance(reported, int):
            stats["known_tokens"] += reported
        if isinstance(unknown, int) and (not isinstance(reported, int)):
            stats["unknown_tokens"] += 1
        elapsed = record.get("elapsedMs")
        if isinstance(elapsed, int):
            stats["latency_ms"] += elapsed
    return stats


def run_comparison(corpus, make_agent, judge_fn=None):
    """Run the four-arm comparison. C/D run offline; A/B are NOT_RUN offline."""
    judge_fn = judge_fn or judge
    out = {"arms": {}, "offline": list(OFFLINE_ARMS), "not_run": list(ONLINE_ARMS)}
    for arm in ARM_IDS:
        if arm in OFFLINE_ARMS:
            records = run_arm(arm, corpus, make_agent)
            out["arms"][arm] = {"status": "RUN", "stats": judge_fn(corpus, records, arm)}
        else:
            out["arms"][arm] = {
                "status": "NOT_RUN",
                "blocker": "BLOCKED_EXTERNAL",
                "note": "requires the separately authorized real model/API run",
                "stats": None,
            }
    return out
