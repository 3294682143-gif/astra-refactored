"""Independent score/run/output binding, never imported by the math Controller."""

import copy
import hashlib
import json
import math

from .run_contract import compare_conditions, digest, from_manifest, nonempty
from .runtime.config import Limits, fingerprint

REPORT_SCHEMA = "bound-score-report-v2"
MANIFEST_SCHEMA = "public-sdk-evaluation-v3"
JUDGE_SCHEMA = "independent-judge-contract-v2"


def item_ids(values, *, name):
    if (
        not isinstance(values, list)
        or not values
        or any(type(v) not in {int, str} or not str(v).strip() for v in values)
    ):
        raise ValueError("complete item identities required: " + name)
    ids = [str(v) for v in values]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate item identity: " + name)
    return ids


def validate_manifest(manifest):
    c = from_manifest(manifest)
    expected_schema = (
        "local-stream-evaluation-v1"
        if c["schema"] == "mathagent-run-contract-v2-local-stream"
        else MANIFEST_SCHEMA
    )
    if manifest.get("schema") != expected_schema:
        raise ValueError(
            "legacy run manifest is historical only; explicit migration required"
        )
    nonempty(manifest.get("run_id"), "run_id")
    digest(manifest.get("input_hash"), "input_hash")
    ids = item_ids(manifest.get("item_ids"), name="manifest.item_ids")
    if type(manifest.get("total")) is not int or manifest["total"] != len(ids):
        raise ValueError("manifest total does not match all expected IDs")
    if manifest.get("mode") not in {
        "REAL_CLIENT",
        "OFFLINE_SIMULATION",
    } or manifest.get("run_purpose") not in {"diagnostic", "full_suite"}:
        raise ValueError("run evidence scope missing")
    if (
        manifest["run_purpose"] == "full_suite"
        and c["dependencies"]["mode"] != "locked"
    ):
        raise ValueError("full suite dependency lock identity missing")
    if not isinstance(manifest.get("limits"), dict):
        raise TypeError("actual execution limits missing")
    Limits(**manifest["limits"])
    if not isinstance(manifest.get("evaluation_policy"), dict):
        raise TypeError("suite continuation policy missing")
    from .evaluation_policy import EvaluationPolicy

    EvaluationPolicy(**manifest["evaluation_policy"])
    judge = manifest.get("judge_contract")
    if (
        not isinstance(judge, dict)
        or judge.get("schema") != JUDGE_SCHEMA
        or judge.get("references_complete") is not True
    ):
        raise ValueError("complete frozen independent Judge contract required")
    for name in ("input_hash", "gold_hash", "judge_sha256"):
        digest(judge.get(name), "judge_contract." + name)
    if (
        judge["input_hash"] != manifest["input_hash"]
        or type(judge.get("total")) is not int
        or judge.get("total") != len(ids)
        or item_ids(judge.get("item_ids"), name="judge.item_ids") != ids
        or not judge.get("policy")
        or judge["policy"] != manifest.get("judging_policy")
    ):
        raise ValueError("Judge contract differs from current inputs/policy")
    return c


def validate_counts(report, expected_ids=None):
    if (
        not isinstance(report, dict)
        or not isinstance(report.get("items"), list)
        or not report["items"]
    ):
        raise ValueError("complete score rows required")
    ids = item_ids([r.get("idx") for r in report["items"]], name="report.items")
    if expected_ids is not None and set(ids) != set(expected_ids):
        raise ValueError("score denominator/IDs differ from run")
    if any(type(r.get("correct")) is not bool for r in report["items"]):
        raise ValueError("score correctness must be explicit booleans")
    count = sum(r["correct"] for r in report["items"])
    if (
        type(report.get("correct")) is not int
        or report["correct"] != count
        or type(report.get("total")) is not int
        or report["total"] != len(ids)
    ):
        raise ValueError("score counts do not agree with individual rows")
    accuracy = report.get("accuracy")
    if (
        type(accuracy) not in {int, float}
        or not math.isfinite(accuracy)
        or not math.isclose(accuracy, count / len(ids), rel_tol=0, abs_tol=1e-12)
    ):
        raise ValueError("score accuracy does not match complete denominator")
    if report.get("missing_gold"):
        raise ValueError("missing references cannot form a bound score report")
    return ids


def read_outputs(payload, expected):
    if not isinstance(payload, bytes):
        raise TypeError("exact output file bytes required")
    rows = [
        json.loads(line)
        for line in payload.decode("utf-8").splitlines()
        if line.strip()
    ]
    if not rows:
        return {}
    ids = item_ids([r.get("idx") for r in rows], name="output file")
    if not set(ids) <= set(expected):
        raise ValueError("output contains foreign question identities")
    return dict(zip(ids, rows))


def bind_report(report, manifest, outputs):
    validate_manifest(manifest)
    ids = item_ids(manifest["item_ids"], name="manifest.item_ids")
    validate_counts(report, ids)
    judge = manifest["judge_contract"]
    for key, expected in (
        ("input_hash", manifest["input_hash"]),
        ("gold_hash", judge["gold_hash"]),
        ("judge_sha256", judge["judge_sha256"]),
        ("policy", judge["policy"]),
    ):
        if key not in report or report[key] != expected:
            raise ValueError("score does not belong to manifest: " + key)
    actual = read_outputs(outputs, ids)
    for output in actual.values():
        if output.get("run_id") != manifest["run_id"] or output.get(
            "manifest_fingerprint"
        ) != fingerprint(manifest):
            raise ValueError(
                "output file belongs to a different/unbound run or manifest"
            )
    for row in report["items"]:
        output = actual.get(str(row["idx"]))
        if type(row.get("processed")) is not bool or row["processed"] != (
            output is not None
        ):
            raise ValueError("score processed flags differ from bound output file")
        if row["correct"] and (
            output is None
            or not isinstance(output.get("final_response"), str)
            or not output["final_response"].strip()
            or output.get("status")
            in {"error", "unsolved", "blocked_external", "not_attempted"}
        ):
            raise ValueError("unprocessed/failed output cannot be correct")
    result = copy.deepcopy(report)
    result["schema"] = REPORT_SCHEMA
    result["binding"] = {
        "run_id": manifest["run_id"],
        "manifest_fingerprint": fingerprint(manifest),
        "outputs_sha256": hashlib.sha256(outputs).hexdigest(),
        "input_hash": report["input_hash"],
        "gold_hash": report["gold_hash"],
        "judge_sha256": report["judge_sha256"],
        "expected_ids": ids,
    }
    return result


def verify_report(report, manifest, outputs):
    if report.get("schema") != REPORT_SCHEMA or "binding" not in report:
        raise ValueError("legacy/unbound score report is historical only")
    expected = bind_report(report, manifest, outputs)["binding"]
    if report["binding"] != expected:
        fields = sorted(set(expected) | set(report["binding"]))
        differences = [k for k in fields if report["binding"].get(k) != expected.get(k)]
        raise ValueError("score/run/output binding mismatch: " + ",".join(differences))


def compare_runs(
    baseline_manifest,
    current_manifest,
    baseline_report,
    current_report,
    baseline_outputs,
    current_outputs,
    *,
    mode,
):
    a, b = validate_manifest(baseline_manifest), validate_manifest(current_manifest)
    if baseline_manifest.get("provider_rate_policy") != current_manifest.get(
        "provider_rate_policy"
    ):
        raise ValueError("comparison provider rate policy differs")
    verify_report(baseline_report, baseline_manifest, baseline_outputs)
    verify_report(current_report, current_manifest, current_outputs)
    for key in (
        "input_hash",
        "item_ids",
        "total",
        "judge_contract",
        "judging_policy",
        "mode",
        "run_purpose",
        "limits",
        "evaluation_policy",
    ):
        if baseline_manifest[key] != current_manifest[key]:
            raise ValueError("comparison condition differs: " + key)
    conditions = compare_conditions(a, b, mode=mode)
    from .evaluation import _compare_scored_rows

    differences = _compare_scored_rows(baseline_report, current_report)
    return {
        **conditions,
        **differences,
        "reports_bound": True,
        "comparable_conditions": True,
        "baseline_correct": baseline_report["correct"],
        "current_correct": current_report["correct"],
        "total": current_report["total"],
        "model_accuracy_established": False,
        "evidence_scope": "content-bound independent scores; configuration and hashes do not certify actual provider execution or official acceptance",
    }
