"""Strict loader for the supplied full-S2 specification; flags are not evidence."""

import copy
import importlib
import importlib.metadata
import inspect
import json
import re
from dataclasses import asdict
from importlib.resources import files
from pathlib import Path

from .diagnostic_selection import select_diagnostic_items, validate_selection
from .entrypoint import code_version
from .evaluation import public_problems
from .evaluation_policy import EvaluationPolicy
from .run_contract import build, resource_identities
from .runtime.config import ClientCapabilities, Limits, fingerprint
from .runtime.provider_rate import DEFAULT_RATE_POLICY, validate_policy
from .runtime.wasi_acceptance import environment, sha
from .scoring_binding import validate_manifest
from .skills import SkillCatalog
from .tool_inventory import validate_inventory
from .tools import PythonSandbox


def template():
    return json.loads(
        files("mathagent")
        .joinpath("resources/next-run-spec.json")
        .read_text(encoding="utf-8")
    )


def validate_shape(value):
    missing = []
    mutable = {
        "document_kind",
        "ready_for_execution",
        "recovery_policy.historical_unknown_inventory_verified",
    }

    def check(expected, actual, name):
        if expected is None:
            if actual is None:
                missing.append(name)
            return
        if isinstance(expected, dict):
            if not isinstance(actual, dict) or set(actual) != set(expected):
                raise ValueError("missing/unknown configuration fields: " + name)
            for key in expected:
                check(expected[key], actual[key], (name + "." + key).lstrip("."))
        elif name in mutable:
            if type(actual) is not type(expected):
                raise ValueError("invalid configuration type: " + name)
        elif type(actual) is not type(expected) or actual != expected:
            raise ValueError("unsupported policy change: " + name)

    expected = template()
    if "execution_scope" in value:
        if value["execution_scope"] not in {"diagnostic_only", "full_suite"}:
            raise ValueError("explicit supported execution scope required")
        expected["execution_scope"] = value["execution_scope"]
    if "source_snapshot" in value:
        expected["source_snapshot"] = {"path": None, "sha256": None}
        if value.get("actual_fixed_source_commit") is not None:
            raise ValueError(
                "uncommitted snapshot must not claim a committed candidate"
            )
    if "goal_closure_policy" in value:
        from .goal_policy import GoalClosurePolicy

        expected["goal_closure_policy"] = asdict(
            GoalClosurePolicy(**value["goal_closure_policy"])
        )
    if "rate_policy" in value.get("client", {}):
        expected["client"]["rate_policy"] = DEFAULT_RATE_POLICY
    evaluation = value.get("evaluation", {})
    for name in ("diagnostic_require_tool_adoption", "diagnostic_require_python"):
        if name in evaluation:
            if type(evaluation[name]) is not bool:
                raise TypeError(name + " must be a boolean")
            expected["evaluation"][name] = evaluation[name]
    if "diagnostic_item_ids" in evaluation:
        expected["evaluation"]["diagnostic_item_ids"] = validate_selection(
            evaluation["diagnostic_item_ids"]
        )
    if "diagnostic_require_tool_execution" in evaluation:
        if type(evaluation["diagnostic_require_tool_execution"]) is not bool:
            raise TypeError("diagnostic_require_tool_execution must be a boolean")
        expected["evaluation"]["diagnostic_require_tool_execution"] = evaluation[
            "diagnostic_require_tool_execution"
        ]
    check(expected, value, "")
    if "source_snapshot" in value:
        missing = [name for name in missing if name != "actual_fixed_source_commit"]
    return missing


def read_configuration(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    missing = validate_shape(value)
    if missing:
        raise ValueError(
            "unresolved specification (not executable): " + ", ".join(missing)
        )
    return value


def check_external_history(config):
    import sqlite3

    reference = config["features_verified_at_target"]["history_inventory"]
    if sha(reference["path"]) != reference["sha256"]:
        raise ValueError("external history inventory changed")
    report = json.loads(Path(reference["path"]).read_text(encoding="utf-8"))
    external = report.get("emulator_inventory_separate_not_summed")
    if external is not None:
        db = sqlite3.connect(
            Path(external["path"]).resolve(strict=True).as_uri() + "?mode=ro", uri=True
        )
        try:
            actual = dict(
                db.execute("SELECT status,COUNT(*) FROM requests GROUP BY status")
            )
        finally:
            db.close()
        if actual != external["states"]:
            raise ValueError(
                "external emulator history changed; re-audit without rewriting it"
            )
        if actual.get("aborted", 0) or actual.get("error", 0):
            raise ValueError(
                "external emulator requests require service/account and terminal-responsibility evidence"
            )


def inspect_target(config):
    """No generation, no output directory creation, no history mutation."""
    validate_shape(config)
    runtime, client, assets, evaluation = (
        config[k] for k in ("runtime", "client", "assets", "evaluation")
    )
    root = Path(runtime["target_root"]).resolve(strict=True)
    if (
        root != Path(__file__).resolve().parent.parent
        or environment()["system"] != "Linux"
    ):
        raise ValueError("explicit final same-host Linux import root required")
    source_record = None
    if "source_snapshot" in config:
        from .source_snapshot import validate as validate_snapshot

        source_record = validate_snapshot(
            root, config["source_snapshot"], code_version()
        )
    elif not isinstance(config["actual_fixed_source_commit"], str) or not re.fullmatch(
        r"[0-9a-f]{40}", config["actual_fixed_source_commit"]
    ):
        raise ValueError(
            "explicit frozen source commit or uncommitted snapshot required"
        )
    module, symbol = client["factory"].split(":", 1)
    factory = getattr(importlib.import_module(module), symbol)
    if (
        sha(inspect.getsourcefile(factory))
        != client["expected_sdk_or_connector_sha256"]
    ):
        raise ValueError("client implementation changed")
    caps = ClientCapabilities(
        **json.loads(
            Path(client["verified_capabilities_file"]).read_text(encoding="utf-8")
        )
    )
    caps.validate()
    rate_policy = validate_policy(client.get("rate_policy"))
    if (
        caps.cancellation_confirms_end
        != client["terminal_policy"]["actual_cancellation_capability"]
    ):
        raise ValueError("cancellation capability differs from evidence")
    sandbox = PythonSandbox(profile=Path(assets["accepted_wasi_profile"]))
    if (
        not sandbox.available
        or sandbox.identity != assets["verified_python_asset_identity"]
    ):
        raise ValueError("current accepted Python asset identity missing/different")
    resources = resource_identities(sandbox.identity)
    if fingerprint(resources) != assets["verified_resource_identity"]:
        raise ValueError("Skill/tool/Python resource identity changed")
    tool_inventory = validate_inventory()
    if tool_inventory["tools"] != assets["expected_registered_tools"]:
        raise ValueError("frozen registered tool inventory differs")
    catalog = SkillCatalog()
    if len(catalog.families) != 22:
        raise ValueError("expected 22 Skill families")
    facts = config["features_verified_at_target"]
    if not isinstance(facts, dict) or set(facts) != {
        "runtime_code_version",
        "environment",
        "available",
        "enabled",
        "observed",
        "history_inventory",
    }:
        raise ValueError(
            "requested/available/enabled/observed capability evidence required"
        )
    enabled = {k: v for k, v in config["features_requested"].items() if k != "ablation"}
    inventory = facts["history_inventory"]
    if (
        not isinstance(inventory, dict)
        or set(inventory) != {"path", "sha256"}
        or sha(inventory["path"]) != inventory["sha256"]
    ):
        raise ValueError(
            "content-bound current external responsibility inventory required"
        )
    if (
        facts["runtime_code_version"] != code_version()
        or facts["environment"] != environment()
    ):
        raise ValueError("frozen runtime/environment changed")
    if facts["available"] != enabled or facts["enabled"] != enabled:
        raise ValueError("full local capabilities not provisioned/enabled")
    if set(facts["observed"]) != set(enabled) or any(
        type(v) is not bool for v in facts["observed"].values()
    ):
        raise ValueError("observed is a separate explicit evidence inventory")
    payload = Path(evaluation["input_file"]).read_bytes()
    if sha(evaluation["input_file"]) != evaluation["verified_input_identity"]:
        raise ValueError("original input bytes changed")
    raw = [
        json.loads(line)
        for line in payload.decode("utf-8").splitlines()
        if line.strip()
    ]
    items = public_problems(raw)
    if len(items) != evaluation["expected_total"] or len(items) != 112:
        raise ValueError("full 112-item denominator required")
    diagnostic_items = select_diagnostic_items(
        items,
        evaluation.get("diagnostic_item_ids"),
        require_goal_closure=config["goal_closure_policy"].get(
            "diagnostic_require_goal_closure", False
        ),
    )
    judge = json.loads(
        Path(evaluation["frozen_judge_contract"]).read_text(encoding="utf-8")
    )
    import official_judge_emulator.judge as original_judge

    references = {
        str(row.get("idx", index)): row.get("answer") for index, row in enumerate(raw)
    }
    if any(not isinstance(v, str) or not v.strip() for v in references.values()):
        raise ValueError(
            "original complete reference answers required on independent scoring side"
        )
    if judge.get("gold_hash") != fingerprint(sorted(references.items())) or judge.get(
        "judge_sha256"
    ) != sha(original_judge.__file__):
        raise ValueError("frozen original Judge or references changed")
    versions = {
        name: importlib.metadata.version(name)
        for name in ("sympy", "numpy", "scipy", "requests", "mpmath")
    }
    # A lock must describe the packages actually imported, not just be a file hash.
    lock = Path(evaluation["dependency_lock"]).read_text(encoding="utf-8")
    for name, version in versions.items():
        if (
            re.search(
                r"(?im)^" + re.escape(name) + r"==" + re.escape(version) + r"(?:\s|$)",
                lock,
            )
            is None
        ):
            raise ValueError("dependency version differs from supplied lock: " + name)
    state_dir = Path(runtime["shared_state_dir"]).resolve()
    output = state_dir.parent
    if (
        state_dir.name != "state"
        or Path(config["diagnostics"]["directory"]).resolve() != output / "diagnostics"
    ):
        raise ValueError(
            "state and diagnostics must bind the same independent run directory"
        )
    if output == root or output.is_relative_to(root):
        raise ValueError("evaluation outputs must not be inside the submission")
    manifest = {
        "provider_rate_policy": rate_policy,
        "schema": "local-stream-evaluation-v1",
        "evaluation_policy": asdict(EvaluationPolicy()),
        "mode": "OFFLINE_SIMULATION" if caps.offline_simulation else "REAL_CLIENT",
        "coordination_backend": "same_host_sqlite_local_stream",
        "experiment": {"ablation": "none"},
        "ablation": "none",
        "solver": "mathagent",
        "run_purpose": "diagnostic"
        if config.get("execution_scope") == "diagnostic_only"
        else "full_suite",
        "limits": asdict(Limits()),
        "target_environment": environment(),
        "dependency_versions": versions,
        "dependency_hash": sha(evaluation["dependency_lock"]),
        "judging_policy": judge["policy"],
        "judge_contract": judge,
        "code_version": code_version(),
        "source_commit": config["actual_fixed_source_commit"],
        "runner_hash": sha(root / "mathagent/local_runner.py"),
        "input_hash": fingerprint(items),
        "input_sha256": evaluation["verified_input_identity"],
        "total": len(items),
        "item_ids": [str(row["idx"]) for row in items],
        "model_id": client["expected_model_id"],
        "run_id": runtime["run_id"],
        "sdk_sha256": client["expected_sdk_or_connector_sha256"],
        "request_contract": {
            "thinking_mode": False,
            "thinking_contract": "named_public_parameter",
            "model_stream": True,
            "assistant_prefill": True,
            "max_tokens": 8192,
            "temperature": 0.2,
            "sdk_attempts_per_call": 1,
            "connect_timeout_seconds": 10,
            "read_timeout_seconds": 60,
        },
        "python_sandbox_identity": sandbox.identity,
        "official_score": "NOT_RUN",
        "configuration_fingerprint": fingerprint(config),
        "capabilities": asdict(caps),
        "features": copy.deepcopy(facts),
        "generation_margin": 10,
        "goal_closure_policy": copy.deepcopy(config["goal_closure_policy"]),
    }
    manifest["request_contract"]["request_profile"] = config["goal_closure_policy"][
        "request_profile"
    ]
    if "execution_scope" in config:
        manifest["execution_scope"] = config["execution_scope"]
    if (
        "diagnostic_item_ids" in evaluation
        or "diagnostic_require_tool_execution" in evaluation
        or config["goal_closure_policy"].get("diagnostic_require_goal_closure")
    ):
        manifest["diagnostic_policy"] = {
            "item_ids": [
                row["idx"].removeprefix("diagnostic:") for row in diagnostic_items
            ],
            "require_tool_execution": evaluation.get(
                "diagnostic_require_tool_execution", False
            ),
            "max_calls": 30,
            "require_goal_closure": config["goal_closure_policy"].get(
                "diagnostic_require_goal_closure", False
            ),
            "separate_from_all_scored_items": True,
        }
    if source_record is not None:
        manifest.update(
            source_snapshot=copy.deepcopy(config["source_snapshot"]),
            source_state="UNCOMMITTED_SNAPSHOT",
            base_source_commit=source_record["base_commit"],
        )
    contract = build(manifest, provisioned_python=sandbox.identity)
    manifest.update(
        run_contract=contract,
        run_contract_fingerprint=fingerprint(contract),
        resource_identity=fingerprint(contract["resources"]),
    )
    validate_manifest(manifest)
    return items, caps, sandbox, manifest
