"""Separate entry, target admission, final lifecycle and mathematical evidence.

Records are supplied by the trusted acceptance workflow, not model output. A
boolean alone, old code identity or an unbound path cannot satisfy a gate.
"""

import json
from dataclasses import asdict
from pathlib import Path

from .entrypoint import code_version
from .platform_resources import platform_python
from .run_contract import (
    compare_conditions,
    environment_fingerprint,
    from_manifest,
    validate,
)
from .runtime.config import Limits, fingerprint
from .runtime.wasi_acceptance import sha

FUNCTIONAL_GATES = ("A01", "A04", "A05", "A07", "A08", "A09", "A10")
TARGET_GATES = ("A02", "A03", "A06", "A11")


def check_full_release(profile, evidence=None, *, manifest=None):
    if profile not in {"admit", "full"}:
        raise ValueError("stage must be admit or full")
    blocked = []
    version = code_version()
    data, base = {}, Path.cwd()
    if evidence is not None:
        path = Path(evidence).resolve(strict=True)
        base, data = path.parent, json.loads(path.read_text(encoding="utf-8"))
    if (
        data.get("schema") != "architecture-acceptance-v2"
        or data.get("source_version") != version
    ):
        blocked.append("missing_or_mismatched_current_acceptance_record")
    accepted_contract = expected_contract = None
    environment_reusable = inherited_ablation = False
    try:
        expected_contract = from_manifest(manifest or {})
        accepted_contract = validate(data.get("run_contract"))
        if data.get("run_contract_fingerprint") != fingerprint(accepted_contract):
            raise ValueError("acceptance contract fingerprint mismatch")
        if (
            accepted_contract["runtime_code_version"] != version
            or expected_contract["runtime_code_version"] != version
        ):
            raise ValueError("acceptance contract source_version mismatch")
        environment_reusable = environment_fingerprint(
            accepted_contract
        ) == environment_fingerprint(expected_contract)
        if not environment_reusable:
            raise ValueError(
                "target environment/SDK/runner/dependencies/resources contract differs"
            )
        if data.get("environment_contract_fingerprint") != environment_fingerprint(
            accepted_contract
        ):
            raise ValueError("environment evidence binding missing")
        if data.get("gates", {}).get("A12", {}).get(
            "run_contract_fingerprint"
        ) != fingerprint(accepted_contract):
            raise ValueError("A12 model/request diagnostic binding missing")
        if accepted_contract != expected_contract:
            if accepted_contract["ablation"] == expected_contract["ablation"]:
                differences = [
                    k
                    for k in sorted(accepted_contract)
                    if accepted_contract[k] != expected_contract[k]
                ]
                raise ValueError(
                    "A12 current model/request contract differs: "
                    + ",".join(differences)
                )
            compare_conditions(accepted_contract, expected_contract, mode="ablation")
            approval = next(
                (
                    row
                    for row in data.get("allowed_ablations", [])
                    if row.get("from_fingerprint") == fingerprint(accepted_contract)
                    and row.get("to_fingerprint") == fingerprint(expected_contract)
                    and row.get("mechanism") == expected_contract["ablation"]
                ),
                None,
            )
            if not approval or not approval.get("evidence"):
                raise ValueError(
                    "A12 contract differs; explicit controlled ablation inheritance missing"
                )
            for row in approval["evidence"]:
                if sha((base / row["path"]).resolve(strict=True)) != row["sha256"]:
                    raise ValueError("controlled ablation evidence changed")
            inherited_ablation = True
    except (OSError, ValueError, TypeError, KeyError, StopIteration) as exc:
        blocked.append("run_contract_rejected: " + str(exc))
    if data.get("limits") != asdict(Limits()):
        blocked.append("formal_configuration_not_3_8_10000_1200_21600_10")
    try:
        sandbox = platform_python()
        physical_identity = (
            accepted_contract["resources"]["python_asset_identity"]
            if accepted_contract
            else None
        )
        if (
            sandbox is None
            or sandbox.identity != physical_identity
            or sandbox.identity != data.get("python_sandbox_identity")
        ):
            blocked.append("required_current_default_python_assets_missing_or_unbound")
    except (OSError, ValueError):
        blocked.append("required_default_python_profile_invalid")
    if data.get("coordination_backend") not in {
        "trusted_public_service",
        "same_host_sqlite_public_transport",
    }:
        blocked.append("complete_coordination_contract_missing")
    configuration_ok = not blocked

    def gate(name, states):
        record = data.get("gates", {}).get(name, {})
        if (
            record.get("status") not in states
            or record.get("source_version") != version
            or not record.get("evidence")
        ):
            blocked.append(name + "_missing_current_scoped_evidence")
            return False
        if name in TARGET_GATES and (
            not accepted_contract
            or record.get("environment_contract_fingerprint")
            != environment_fingerprint(accepted_contract)
        ):
            blocked.append(name + "_environment_binding_missing")
            return False
        try:
            for entry in record["evidence"]:
                path = (base / entry["path"]).resolve(strict=True)
                if sha(path) != entry["sha256"]:
                    raise ValueError("evidence mismatch")
        except (OSError, ValueError, TypeError, KeyError):
            blocked.append(name + "_evidence_content_mismatch")
            return False
        return True

    functional_checks = [
        gate(name, {"PASS_OFFLINE", "PASS_TARGET", "PASS_REAL"})
        for name in FUNCTIONAL_GATES
    ]
    target_checks = [gate(name, {"PASS_TARGET"}) for name in TARGET_GATES]
    functional, target = all(functional_checks), all(target_checks)
    real_math = gate("A12", {"PASS_REAL"})
    admitted = functional and target and real_math and not blocked
    real_suite = accepted = replacement = False
    if profile == "full":
        real_suite = gate("A13", {"PASS_REAL"})
        lifecycle = gate("WP5-B", {"PASS_TARGET"})
        accepted = admitted and lifecycle and real_suite
        gate("A14", {"PASS_TARGET"})
        if not data.get("real_run_id") or data.get("real_run_id") != data.get(
            "target_confirmed_run_id"
        ):
            blocked.append("suite_and_lifecycle_are_not_the_same_run")
            accepted = False
        # Adoption has its own comparison/repetition evidence. It is not needed
        # for availability and cannot be inferred from engineering completion.
        comparison = data.get("baseline_comparison", {})
        if accepted and comparison.get("path") and comparison.get("sha256"):
            try:
                path = (base / comparison["path"]).resolve(strict=True)
                if sha(path) != comparison["sha256"]:
                    raise ValueError("comparison content mismatch")
                decision = json.loads(path.read_text(encoding="utf-8"))
                replacement = bool(
                    decision.get("source_version") == version
                    and decision.get("current_run_id") == data.get("real_run_id")
                    and decision.get("same_conditions") is True
                    and isinstance(decision.get("new_correct"), list)
                    and isinstance(decision.get("new_wrong"), list)
                    and len(decision["new_correct"]) > len(decision["new_wrong"])
                    and decision.get("review_or_confirmation") == "supported"
                    and decision.get("frozen_comparison_evidence")
                )
            except (OSError, ValueError, TypeError, KeyError):
                replacement = False
    return {
        "profile": profile,
        "source_version": version,
        "environment_evidence_reusable": environment_reusable,
        "controlled_ablation_inherited": inherited_ablation,
        "blockers": blocked,
        "functional_complete": configuration_ok and functional and target,
        "target_runtime_admitted": admitted,
        "target_runtime_accepted": accepted,
        "real_suite_evaluated": real_suite,
        "baseline_replacement_supported": replacement,
        "passed": not blocked and (admitted if profile == "admit" else accepted),
    }
