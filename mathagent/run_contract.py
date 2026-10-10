"""Answer/credential-free condition identities shared by admission and comparison.

Versioned records are strict. Missing fields never become equal by both being
None. Run IDs, datasets and reduced diagnostic budgets are deliberately separate
from reusable environment/model-diagnostic conditions.
"""

import copy
import hashlib
import math
import re
from dataclasses import asdict
from importlib.resources import files

from .experiments import ExperimentConfig
from .policy import WORKFLOW_DEFAULTS
from .runtime.config import Limits, fingerprint

SCHEMA = "mathagent-run-contract-v1"
STREAM_SCHEMA = "mathagent-run-contract-v2-local-stream"
MECHANISMS = tuple(sorted(ExperimentConfig.CHOICES - {"none"}))
FIELDS = frozenset(
    {
        "schema",
        "runtime_code_version",
        "model_id",
        "sdk_sha256",
        "runner_hash",
        "request_contract",
        "transport_contract",
        "coordination_backend",
        "target_environment",
        "dependencies",
        "resources",
        "features",
        "ablation",
        "solver",
        "solver_identity",
        "protocol",
        "formal_limits",
        "mathematical_policy",
    }
)
ENVIRONMENT_FIELDS = (
    "runtime_code_version",
    "sdk_sha256",
    "runner_hash",
    "transport_contract",
    "coordination_backend",
    "target_environment",
    "dependencies",
    "resources",
    "formal_limits",
)
REQUEST_FIELDS = {
    "thinking_mode",
    "thinking_contract",
    "model_stream",
    "assistant_prefill",
    "max_tokens",
    "temperature",
    "sdk_attempts_per_call",
    "connect_timeout_seconds",
    "read_timeout_seconds",
}


def digest(value, name):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("missing or invalid digest: " + name)
    return value


def nonempty(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing condition: " + name)
    return value


def resource_identities(python_identity=None):
    root = files("mathagent").joinpath("resources")
    names = ["skill-mapping-manifest.json", "tool-registry.json"]
    names += [
        "skills/" + p.name
        for p in root.joinpath("skills").iterdir()
        if p.name.endswith(".md")
    ]
    return {
        "skills_and_registry_sha256": fingerprint(
            {
                name: hashlib.sha256(root.joinpath(name).read_bytes()).hexdigest()
                for name in sorted(names)
            }
        ),
        "python_asset_identity": python_identity or "not_provisioned",
    }


def validate(contract):
    if (
        not isinstance(contract, dict)
        or set(contract) != FIELDS
        or contract.get("schema") not in {SCHEMA, STREAM_SCHEMA}
    ):
        raise ValueError("run contract missing/version migration required")
    c = copy.deepcopy(contract)
    streaming = c["schema"] == STREAM_SCHEMA
    for name in ("runtime_code_version", "sdk_sha256", "runner_hash"):
        digest(c[name], name)
    for name in ("model_id", "coordination_backend", "solver_identity", "protocol"):
        nonempty(c[name], name)
    if c["solver"] not in {"mathagent", "r4"}:
        raise ValueError("unsupported solver contract")
    ExperimentConfig(c["ablation"])
    if c["solver"] == "r4" and c["ablation"] != "none":
        raise ValueError("new-core ablations do not describe R4")
    if (
        not isinstance(c["features"], dict)
        or set(c["features"]) != set(MECHANISMS)
        or any(type(v) is not bool for v in c["features"].values())
    ):
        raise ValueError("actual boolean mechanism configuration required")
    if c["ablation"] != "none" and c["features"][c["ablation"]]:
        raise ValueError("ablation differs from active mechanism")
    r = c["request_contract"]
    if not isinstance(r, dict) or set(r) not in (
        REQUEST_FIELDS,
        REQUEST_FIELDS | {"request_profile"},
    ):
        raise ValueError("public request contract fields missing")
    if r.get("request_profile", "fixed_8192") not in {
        "fixed_8192",
        "scoped_caps_v1",
        "scoped_caps_v2",
    }:
        raise ValueError("unsupported request profile")
    if not streaming and r.get("request_profile", "fixed_8192") != "fixed_8192":
        raise ValueError("scoped output policy is only integrated in local stream mode")
    for name in ("thinking_mode", "model_stream", "assistant_prefill"):
        if type(r[name]) is not bool:
            raise ValueError("explicit request boolean required: " + name)
    nonempty(r["thinking_contract"], "thinking_contract")
    if c["coordination_backend"] != (
        "same_host_sqlite_local_stream"
        if streaming
        else "same_host_sqlite_public_transport"
    ):
        raise ValueError(
            "this contract version only covers the implemented shared public runner"
        )
    if (
        r["model_stream"] is not streaming
        or r["assistant_prefill"] is not streaming
        or r["thinking_mode"]
        or r["thinking_contract"] != "named_public_parameter"
    ):
        raise ValueError("unsupported public nonstream/non-thinking request contract")
    if type(r["max_tokens"]) is not int or not 1 <= r["max_tokens"] <= 8192:
        raise ValueError("invalid max_tokens")
    if type(r["sdk_attempts_per_call"]) is not int or r["sdk_attempts_per_call"] != 1:
        raise ValueError("explicit SDK attempt responsibility required")
    for name, maximum in (
        ("temperature", 2),
        ("connect_timeout_seconds", 1200),
        ("read_timeout_seconds", 1200),
    ):
        value = r[name]
        if (
            type(value) not in {int, float}
            or not math.isfinite(value)
            or not 0 <= value <= maximum
        ):
            raise ValueError("invalid request parameter: " + name)
        if name != "temperature" and value == 0:
            raise ValueError("request timeout must be positive")
    t = c["transport_contract"]
    if not isinstance(t, dict) or set(t) != {
        "mode",
        "terminal_authority",
        "logical_request_authority",
        "unknown_policy",
        "cancellation",
    }:
        raise ValueError("transport/termination responsibility missing")
    for name, value in t.items():
        nonempty(value, "transport_contract." + name)
    if t != {
        "mode": "local_stream_prefill" if streaming else "public_nonstream",
        "terminal_authority": "observed_http_terminal",
        "logical_request_authority": "one_shared_lease_per_stream_invocation"
        if streaming
        else "one_shared_lease_per_public_invocation",
        "unknown_policy": "retain_until_trusted_terminal",
        "cancellation": "not_assumed",
    }:
        raise ValueError("unimplemented transport/terminal responsibility contract")
    if streaming and (
        c["solver"] != "mathagent" or c["protocol"] != "l3-stream-prefill-v1"
    ):
        raise ValueError(
            "local stream contract requires the new core and explicit protocol"
        )
    env = c["target_environment"]
    if (
        not isinstance(env, dict)
        or not {
            "system",
            "machine",
            "host_python",
            "executable_sha256",
            "cpu_features_sha256",
            "kernel_release",
        }
        <= env.keys()
    ):
        raise ValueError("target environment identity incomplete")
    for name, value in env.items():
        nonempty(value, "target_environment." + name)
    dep = c["dependencies"]
    if (
        not isinstance(dep, dict)
        or set(dep) != {"mode", "identity", "versions"}
        or dep["mode"] not in {"locked", "versions_only"}
        or not dep["versions"]
    ):
        raise ValueError("dependency identity incomplete")
    digest(dep["identity"], "dependencies.identity")
    for name, value in dep["versions"].items():
        nonempty(value, "dependency version " + name)
    resources = c["resources"]
    if not isinstance(resources, dict) or set(resources) != {
        "skills_and_registry_sha256",
        "python_asset_identity",
    }:
        raise ValueError("stable physical resource identities required")
    digest(resources["skills_and_registry_sha256"], "skills_and_registry_sha256")
    if resources["python_asset_identity"] != "not_provisioned":
        digest(resources["python_asset_identity"], "python_asset_identity")
    elif c["features"]["python"]:
        raise ValueError("Python execution declared without assets")
    if not isinstance(c["formal_limits"], dict) or c["formal_limits"] != asdict(
        Limits()
    ):
        raise ValueError("formal resource contract differs from required limits")
    if not isinstance(c["mathematical_policy"], dict) or not c["mathematical_policy"]:
        raise ValueError("mathematical strategy identity missing")
    fingerprint(c)  # Also rejects non-finite or non-JSON values.
    return c


def from_manifest(manifest):
    c = validate(manifest.get("run_contract"))
    if manifest.get("run_contract_fingerprint") != fingerprint(c):
        raise ValueError("run contract fingerprint mismatch")
    aliases = {
        "code_version": "runtime_code_version",
        "model_id": "model_id",
        "sdk_sha256": "sdk_sha256",
        "runner_hash": "runner_hash",
        "request_contract": "request_contract",
        "coordination_backend": "coordination_backend",
        "target_environment": "target_environment",
        "ablation": "ablation",
        "solver": "solver",
    }
    for outer, inner in aliases.items():
        if outer not in manifest or manifest[outer] != c[inner]:
            raise ValueError("manifest differs from run contract: " + outer)
    active_python = (
        c["resources"]["python_asset_identity"] if c["features"]["python"] else None
    )
    if (
        "python_sandbox_identity" not in manifest
        or manifest["python_sandbox_identity"] != active_python
    ):
        raise ValueError(
            "manifest Python execution identity differs from active configuration"
        )
    if manifest.get("resource_identity") != fingerprint(c["resources"]):
        raise ValueError("manifest resource_identity mismatch")
    if manifest.get("dependency_hash") != c["dependencies"]["identity"]:
        raise ValueError("manifest dependency_hash mismatch")
    if manifest.get("dependency_versions") != c["dependencies"]["versions"]:
        raise ValueError("manifest dependency_versions mismatch")
    if c["solver"] == "r4":
        if (
            not isinstance(manifest.get("solver_variant"), dict)
            or not manifest["solver_variant"]
        ):
            raise ValueError("frozen R4 solver identity missing")
        digest(
            manifest.get("r4_evaluation_support_identity"),
            "r4_evaluation_support_identity",
        )
        expected_solver = fingerprint(
            (manifest["solver_variant"], manifest["r4_evaluation_support_identity"])
        )
    else:
        expected_solver = manifest["code_version"]
    if c["solver_identity"] != expected_solver:
        raise ValueError("manifest solver identity differs from run contract")
    if manifest.get("experiment") != {"ablation": c["ablation"]}:
        raise ValueError("manifest experiment mismatch")
    return c


def build(manifest, *, provisioned_python=None):
    ablation, solver = manifest["ablation"], manifest["solver"]
    streaming = manifest["coordination_backend"] == "same_host_sqlite_local_stream"
    experiment = ExperimentConfig(ablation)
    resources = resource_identities(provisioned_python)
    features = {
        name: solver == "mathagent" and experiment.enabled(name) for name in MECHANISMS
    }
    features["python"] = features["python"] and provisioned_python is not None
    features["dynamic_budget"] = features["dynamic_budget"] and manifest[
        "coordination_backend"
    ] in {"same_host_sqlite_public_transport", "same_host_sqlite_local_stream"}
    dependencies = manifest["dependency_versions"]
    c = {
        "schema": STREAM_SCHEMA if streaming else SCHEMA,
        "runtime_code_version": manifest["code_version"],
        "model_id": manifest["model_id"],
        "sdk_sha256": manifest["sdk_sha256"],
        "runner_hash": manifest["runner_hash"],
        "request_contract": manifest["request_contract"],
        "transport_contract": {
            "mode": "local_stream_prefill" if streaming else "public_nonstream",
            "terminal_authority": "observed_http_terminal",
            "logical_request_authority": "one_shared_lease_per_stream_invocation"
            if streaming
            else "one_shared_lease_per_public_invocation",
            "unknown_policy": "retain_until_trusted_terminal",
            "cancellation": "not_assumed",
        },
        "coordination_backend": manifest["coordination_backend"],
        "target_environment": manifest["target_environment"],
        "dependencies": {
            "mode": "locked" if manifest["dependency_hash"] else "versions_only",
            "identity": manifest["dependency_hash"] or fingerprint(dependencies),
            "versions": dependencies,
        },
        "resources": resources,
        "features": features,
        "ablation": ablation,
        "solver": solver,
        "solver_identity": fingerprint(
            (
                manifest.get("solver_variant"),
                manifest.get("r4_evaluation_support_identity"),
            )
        )
        if solver == "r4"
        else manifest["code_version"],
        "protocol": "l3-stream-prefill-v1"
        if streaming
        else "r4-action-original"
        if solver == "r4"
        else "l3-public-v1",
        "formal_limits": asdict(Limits()),
        "mathematical_policy": json_policy()
        if solver == "mathagent"
        else {"policy": "original_r4"},
    }
    if solver == "mathagent" and manifest.get("goal_closure_policy"):
        from .goal_policy import GoalClosurePolicy

        c["mathematical_policy"]["goal_closure"] = asdict(
            GoalClosurePolicy(**manifest["goal_closure_policy"])
        )
    return validate(c)


def json_policy():
    import json

    from .goal_policy import DEFAULT

    return json.loads(
        json.dumps(asdict(WORKFLOW_DEFAULTS) | {"goal_closure": asdict(DEFAULT)})
    )


def environment_fingerprint(contract):
    c = validate(contract)
    return fingerprint({k: c[k] for k in ENVIRONMENT_FIELDS})


def compare_conditions(baseline, current, *, mode):
    a, b = validate(baseline), validate(current)
    baseline_identity, current_identity = fingerprint(a), fingerprint(b)
    if mode not in {"repeat", "ablation", "r4", "version"}:
        raise ValueError("explicit comparison mode required")
    allowed = set()
    if mode == "version":
        if (
            a["solver"] != "mathagent"
            or b["solver"] != "mathagent"
            or a["ablation"] != b["ablation"]
        ):
            raise ValueError("version comparison requires the same solver and ablation")
        allowed = {
            "runtime_code_version",
            "solver_identity",
            "runner_hash",
            "mathematical_policy",
        }
        for c in (a, b):
            c["request_contract"].setdefault("request_profile", "fixed_8192")
    if mode == "ablation":
        mechanism = b["ablation"]
        if (
            a["solver"] != "mathagent"
            or b["solver"] != "mathagent"
            or a["ablation"] != "none"
            or mechanism == "none"
        ):
            raise ValueError("single ablation requires a complete new-core control")
        changed = [k for k in MECHANISMS if a["features"][k] != b["features"][k]]
        if (
            changed != [mechanism]
            or not a["features"][mechanism]
            or b["features"][mechanism]
        ):
            raise ValueError(
                "declared ablation must disable exactly one active mechanism"
            )
        allowed = {"ablation", "features"}
    elif mode == "r4":
        if (
            a["solver"] != "r4"
            or b["solver"] != "mathagent"
            or a["ablation"] != "none"
            or b["ablation"] != "none"
        ):
            raise ValueError(
                "R4 comparison requires original R4 versus the complete new core"
            )
        allowed = {
            "solver",
            "solver_identity",
            "protocol",
            "features",
            "mathematical_policy",
        }
    for name in sorted(FIELDS - allowed):
        if a[name] != b[name]:
            raise ValueError("run condition differs: " + name)
    return {
        "comparison_mode": mode,
        "declared_change": b["ablation"] if mode == "ablation" else mode,
        "baseline_contract": baseline_identity,
        "current_contract": current_identity,
        **(
            {
                "declared_differences": sorted(k for k in allowed if a[k] != b[k]),
                "attribution": "whole version; not a single-mechanism ablation",
            }
            if mode == "version"
            else {}
        ),
    }
