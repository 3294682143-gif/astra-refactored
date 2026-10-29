"""Offline scoring only; never imported by the online controller or verifier."""

from __future__ import annotations

from .runtime.config import fingerprint


def exact_judge_identity():
    import hashlib
    from pathlib import Path

    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def public_problems(rows):
    """Only the documented problem/idx boundary enters the solve path."""
    problems = []
    ids = set()
    for index, row in enumerate(rows):
        idx = row.get("idx", index)
        if type(idx) not in (int, str) or str(idx) in ids:
            raise ValueError("unique public idx required")
        if not isinstance(row.get("problem"), str) or not row["problem"].strip():
            raise ValueError("nonempty problem required")
        ids.add(str(idx))
        problems.append({"idx": idx, "problem": row["problem"]})
    return problems


def score_all(problems, outputs, gold):
    """Exact-answer policy v1, all items in denominator, missing is wrong.

    No ad-hoc algebraic normalization or LLM self-grading. A richer proof judging
    policy must be provided and frozen before mathematical quality experiments.
    """
    problems = public_problems(problems)
    results = {str(row["idx"]): row for row in outputs}
    expected = {
        str(row.get("idx", index)): str(row["answer"]).strip()
        for index, row in enumerate(gold)
    }
    if len(results) != len(outputs) or len(expected) != len(gold):
        raise ValueError("duplicate result/gold identities cannot be merged silently")
    rows = []
    for item in problems:
        key = str(item["idx"])
        output = results.get(key, {})
        correct = (
            bool(output)
            and isinstance(output.get("final_response"), str)
            and bool(output["final_response"].strip())
            and key in expected
            and output.get("status")
            not in {"error", "unsolved", "blocked_external", "not_attempted"}
            and str(output.get("final_response", "")).strip() == expected[key]
        )
        rows.append(
            {
                "idx": item["idx"],
                "correct": correct,
                "processed": bool(output),
                "status": output.get("status", "unprocessed"),
                "attempted": output.get("execution", {}).get("attempted"),
                "provider_success": output.get("execution", {}).get("provider_success"),
            }
        )
    n = len(rows)
    correct = sum(row["correct"] for row in rows)
    return {
        "policy": "exact-text-v1",
        "schema": "historical-exact-text-unbound-v1",
        "judge_sha256": exact_judge_identity(),
        "input_hash": fingerprint(problems),
        "gold_hash": fingerprint(sorted(expected.items())),
        "correct": correct,
        "total": n,
        "accuracy": correct / n if n else 0,
        "missing_gold": [
            item["idx"] for item in problems if not expected.get(str(item["idx"]))
        ],
        "items": rows,
    }


def compare_reports(
    baseline,
    current,
    *,
    baseline_manifest=None,
    current_manifest=None,
    baseline_outputs=None,
    current_outputs=None,
    mode="repeat",
):
    """Public comparisons require both actual runs/files; old reports are display-only."""
    if (
        baseline_manifest is None
        or current_manifest is None
        or baseline_outputs is None
        or current_outputs is None
    ):
        raise ValueError(
            "report comparison requires corresponding manifests and actual output files; legacy reports are historical only"
        )
    from .scoring_binding import compare_runs

    return compare_runs(
        baseline_manifest,
        current_manifest,
        baseline,
        current,
        baseline_outputs,
        current_outputs,
        mode=mode,
    )


def _compare_scored_rows(baseline, current):
    from .scoring_binding import validate_counts

    validate_counts(baseline)
    validate_counts(current)
    if baseline.get("missing_gold") or current.get("missing_gold"):
        raise ValueError("complete independent reference coverage required")
    if baseline.get("judge_sha256") != current.get("judge_sha256"):
        raise ValueError("comparison requires the unchanged independent judge")
    old = {str(x["idx"]): x["correct"] for x in baseline["items"]}
    new = {str(x["idx"]): x["correct"] for x in current["items"]}
    if old.keys() != new.keys() or baseline["policy"] != current["policy"]:
        raise ValueError("comparison requires the same items and judging policy")
    for field in ("input_hash", "gold_hash"):
        if not baseline.get(field) or baseline[field] != current.get(field):
            raise ValueError(
                "comparison requires identical frozen inputs and judging references"
            )
    return {
        "new_correct": [k for k in sorted(new) if new[k] and not old[k]],
        "new_wrong": [k for k in sorted(new) if old[k] and not new[k]],
    }


def compare_manifests(baseline, current, *, mode="repeat"):
    for key in ("input_hash", "model_id", "limits", "judging_policy", "mode"):
        if key not in baseline or baseline[key] != current.get(key):
            raise ValueError("run comparison differs in frozen condition: " + key)
    if not baseline.get("code_version") or not current.get("code_version"):
        raise ValueError("both source versions must be frozen")
    if baseline.get("request_contract") != current.get("request_contract"):
        raise ValueError("run comparison differs in public request contract")
    if baseline.get("evaluation_policy") != current.get("evaluation_policy"):
        raise ValueError("run comparison differs in evaluation continuation policy")
    if baseline.get("judge_contract") != current.get("judge_contract"):
        raise ValueError("run comparison differs in frozen independent Judge contract")
    for field in (
        "coordination_backend",
        "target_environment",
        "dependency_hash",
        "run_purpose",
        "sdk_sha256",
        "runner_hash",
    ):
        if baseline.get(field) != current.get(field):
            raise ValueError(
                "run comparison differs in frozen runtime condition: " + field
            )
    for manifest in (baseline, current):
        if manifest.get("experiment", {}).get(
            "ablation", manifest.get("ablation", "none")
        ) != manifest.get("ablation", "none"):
            raise ValueError("manifest experiment does not match active ablation")
    if baseline.get("ablation", "none") != "none" and mode == "ablation":
        raise ValueError("single ablations must compare against a complete control run")
    from .run_contract import compare_conditions
    from .scoring_binding import validate_manifest

    compare_conditions(
        validate_manifest(baseline), validate_manifest(current), mode=mode
    )
    return {
        "comparable_conditions": True,
        "mechanism_change": current.get("ablation", "none"),
        # Configuration comparison alone does not establish actual model quality.
        "model_accuracy_established": False,
    }
