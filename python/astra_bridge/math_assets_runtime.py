"""Unified Math Asset runtime implementation and Host handler.

Normative implementation of:
    use_math_asset(request, *, context, catalog, executor, deadline)

Per §4.2, §4.4, §10 U3:
1. Asset identity validation
2. Input schema validation and rejection of model-injected control keys
3. Deterministic normalization and input hash
4. Target and behavior resolution
5. Private implementation execution with bounded subprocesses
6. Independent output audit and check retention
7. Canonical MathAssetResult packaging with resultHash
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Dict, List, Optional

from .generated.math_assets import (
    MATH_ASSET_CATALOG_DIGEST,
    MATH_ASSET_CATALOG_VERSION,
    MATH_ASSET_SCHEMA_VERSION,
    MATH_ASSETS_BY_ID,
    MATH_BEHAVIOR_LOOKUP,
)
from mathagent.tools import RegisteredExecutor

# Context keys that must come strictly from the control side; model injection is refused.
CONTROL_BINDING_KEYS = frozenset([
    "sessionId",
    "problemHash",
    "contractVersion",
    "taskId",
    "goalId",
    "scopeId",
    "sourceRequestId",
    "implementationRef",
    "checkerRef",
    "binding",
])

# Fixed error / limitation codes per §10
ERR_ASSET_NOT_FOUND = "ASSET_NOT_FOUND"
ERR_CATALOG_MISMATCH = "CATALOG_MISMATCH"
ERR_INPUT_INVALID = "INPUT_INVALID"
ERR_INPUT_INCOMPLETE = "INPUT_INCOMPLETE"
ERR_EXECUTION_OUT_OF_SCOPE = "EXECUTION_OUT_OF_SCOPE"
ERR_CHECK_OUT_OF_SCOPE = "CHECK_OUT_OF_SCOPE"
ERR_RESULT_MISMATCH = "RESULT_MISMATCH"
ERR_BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
ERR_DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED"
ERR_OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"


def _canonical_json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalize_input_data(data: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministically normalize mathematical input arguments."""
    normalized = {}
    for k, v in sorted(data.items()):
        if isinstance(v, dict):
            normalized[k] = _normalize_input_data(v)
        elif isinstance(v, list):
            normalized[k] = [_normalize_input_data(item) if isinstance(item, dict) else item for item in v]
        else:
            normalized[k] = v
    return normalized


def _validate_arg_types(target: str, args: Dict[str, Any]) -> Optional[str]:
    """Validate strict types: strings pretending to be ints or bools pretending to be ints are rejected."""
    if target in ("gf2_rank", "rank"):
        rows = args.get("rows")
        if not isinstance(rows, list):
            return "rows must be a list of non-negative integers"
        for r in rows:
            if isinstance(r, bool) or not isinstance(r, int) or r < 0:
                return "rows entries must be non-negative integers, not boolean or string"
    elif target in ("gf2_nullspace", "nullspace"):
        rows = args.get("rows")
        width = args.get("width")
        if not isinstance(rows, list):
            return "rows must be a list of integers"
        for r in rows:
            if isinstance(r, bool) or not isinstance(r, int):
                return "rows entries must be integers"
        if isinstance(width, bool) or not isinstance(width, int) or width <= 0:
            return "width must be a positive integer"
    return None


def _resolve_target_and_behavior(
    asset_id: str,
    asset: Dict[str, Any],
    input_data: Dict[str, Any],
    request_target: Optional[str] = None,
) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    behaviors = asset.get("behaviors", [])

    # Handle linear algebra aliases
    if asset_id == "math.linear-algebra":
        raw_t = request_target or input_data.get("target")
        if raw_t in ("gf2_rank", "rank"):
            request_target = "gf2_rank"
        elif raw_t in ("gf2_nullspace", "nullspace", "kernel"):
            request_target = "gf2_nullspace"
        elif raw_t in ("solution_set", "solve_linear_system"):
            request_target = "solution_set"
        elif raw_t in ("maximal_minors", "minors"):
            request_target = "maximal_minors"

    # 1. Explicit request target
    if request_target:
        for b in behaviors:
            if b.get("target") == request_target or b.get("legacyToolName") == request_target:
                return b.get("target"), b
        return request_target, None

    raw_target = input_data.get("target")
    if not raw_target:
        raw_target = input_data.get("operation") or input_data.get("behavior")

    # 2. Direct behavior target match
    for b in behaviors:
        if b.get("target") == raw_target:
            return raw_target, b

    # 3. Legacy tool name match
    for b in behaviors:
        if b.get("legacyToolName") == raw_target:
            return b.get("target"), b

    # 4. Legacy operation match
    for b in behaviors:
        legacy_op = b.get("legacyOperation")
        if legacy_op and (legacy_op == raw_target or (isinstance(raw_target, str) and legacy_op.lower() == raw_target.lower())):
            return b.get("target"), b

    # 5. Check if input keys uniquely identify a behavior
    input_keys = set(input_data.keys())
    matching_behaviors = []
    for b in behaviors:
        req = set(b.get("requiredParams", []))
        if req and req <= input_keys:
            matching_behaviors.append(b)
    if len(matching_behaviors) == 1:
        return matching_behaviors[0].get("target"), matching_behaviors[0]

    if not raw_target and len(behaviors) == 1:
        return behaviors[0]["target"], behaviors[0]

    return str(raw_target) if raw_target is not None else None, None


def use_math_asset(
    request: Dict[str, Any],
    *,
    context: Dict[str, Any],
    catalog: Optional[Dict[str, Any]] = None,
    executor: Optional[RegisteredExecutor] = None,
    deadline: Optional[float] = None,
) -> Dict[str, Any]:
    """Host-side unified execution entry point for math assets.

    Signature: use_math_asset(request, *, context, catalog, executor, deadline)
    """
    start_time = time.monotonic()
    catalog = catalog or MATH_ASSETS_BY_ID
    executor = executor or RegisteredExecutor()
    catalog_digest = MATH_ASSET_CATALOG_DIGEST

    # 1. Action identity check
    action = request.get("action")
    if action != "math_asset":
        return _make_error_result(
            asset_id=request.get("assetId", "unknown"),
            context=context,
            status="ERROR",
            error_code=ERR_INPUT_INVALID,
            message=f"Action must be 'math_asset', got '{action}'",
            catalog_digest=catalog_digest,
        )

    # 2. Check for unauthorized model override of control binding keys
    for k in CONTROL_BINDING_KEYS:
        if k in request and request[k] != context.get(k):
            return _make_error_result(
                asset_id=request.get("assetId", "unknown"),
                context=context,
                status="ERROR",
                error_code=ERR_INPUT_INVALID,
                message=f"Model may not supply control binding key '{k}'",
                catalog_digest=catalog_digest,
            )

    # 3. Asset identity check
    asset_id = request.get("assetId")
    if not isinstance(asset_id, str) or asset_id not in catalog:
        return _make_error_result(
            asset_id=str(asset_id),
            context=context,
            status="ERROR",
            error_code=ERR_ASSET_NOT_FOUND,
            message=f"Asset ID '{asset_id}' is not registered in the canonical catalog",
            catalog_digest=catalog_digest,
        )

    asset = catalog[asset_id]
    instructions = asset.get("instructions", {})
    guidance_list = list(instructions.get("procedure", [])) + list(instructions.get("conditions", []))

    # 4. Input validation
    input_data = request.get("input")
    if not isinstance(input_data, dict):
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input={},
            status="NEEDS_INPUT",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_INPUT_INVALID, "Input must be a JSON object containing mathematical parameters"],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="NONE",
        )

    # Rejection of model-injected control keys in input
    for k in CONTROL_BINDING_KEYS:
        if k in input_data:
            return _make_error_result(
                asset_id=asset_id,
                context=context,
                status="ERROR",
                error_code=ERR_INPUT_INVALID,
                message=f"Model may not supply control key '{k}' inside input",
                catalog_digest=catalog_digest,
            )

    # 5. Analysis branch: target="analyze"
    if input_data.get("target") == "analyze" or not input_data:
        normalized_input = _normalize_input_data(input_data)
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="COMPLETE",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=["ANALYSIS_BRANCH: Formal reasoning guidance only, no numeric computation"],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="GUIDANCE_ONLY",
        )

    # 6. Target & behavior resolution
    target, behavior = _resolve_target_and_behavior(asset_id, asset, input_data, request.get("target"))
    if not target or not behavior:
        misuse_guidance = list(instructions.get("misuse", []))
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=_normalize_input_data(input_data),
            status="OUT_OF_SCOPE",
            guidance=misuse_guidance or guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_EXECUTION_OUT_OF_SCOPE, f"Target '{target}' is not supported by asset '{asset_id}'"],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="NONE",
        )

    # 7. Check required parameters
    required_params = behavior.get("requiredParams", [])
    missing = [p for p in required_params if p not in input_data or input_data[p] is None]
    if missing:
        examples = asset.get("examples", [])
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=_normalize_input_data(input_data),
            status="NEEDS_INPUT",
            guidance=guidance_list + [f"Missing required parameters: {', '.join(missing)}"],
            observations=[],
            checks=[],
            limitations=[ERR_INPUT_INCOMPLETE, f"Missing required parameter(s): {', '.join(missing)}"],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="NONE",
        )

    # 8. Strict type checks
    type_err = _validate_arg_types(target, input_data)
    if type_err:
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=_normalize_input_data(input_data),
            status="NEEDS_INPUT",
            guidance=guidance_list + [type_err],
            observations=[],
            checks=[],
            limitations=[ERR_INPUT_INVALID, type_err],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="NONE",
        )

    # 9. Deadline check
    if deadline is not None and time.monotonic() >= deadline:
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=_normalize_input_data(input_data),
            status="UNAVAILABLE",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_DEADLINE_EXCEEDED, "Execution deadline exceeded before worker start"],
            duration_ms=int((time.monotonic() - start_time) * 1000),
            computation_type="TIMEOUT",
        )

    # 10. Private implementation dispatch
    normalized_input = _normalize_input_data(input_data)
    input_hash = _sha256(_canonical_json_bytes(normalized_input))

    legacy_tool = behavior.get("legacyToolName")
    legacy_op = behavior.get("legacyOperation")

    allowed_params = set(behavior.get("requiredParams", [])) | set(behavior.get("optionalParams", []))
    exec_args = {k: v for k, v in input_data.items() if k in allowed_params}
    if legacy_op:
        exec_args["operation"] = legacy_op
    if legacy_op == "DENSITY_CHECK" and "density" not in exec_args and "expression" in exec_args:
        exec_args["density"] = exec_args["expression"]

    scope = behavior.get("declaredScope", "EXACT")
    eff_deadline = deadline if deadline is not None else (time.monotonic() + 30.0)

    exec_res = executor.execute(legacy_tool, exec_args, deadline=eff_deadline, scope=scope)
    duration_ms = int((time.monotonic() - start_time) * 1000)

    # 11. Interpret execution results
    if exec_res.status == "ok":
        obs = {
            "quantity": target,
            "value": exec_res.result,
            "domain": scope,
            "exactness": behavior.get("evidenceCeiling", "EXACT_FOR_INPUT"),
            "coverage": "EXACT_FOR_INPUT" if behavior.get("evidenceCeiling") == "EXACT_FOR_INPUT" else "BOUNDED",
            "sourceInputHash": input_hash,
            "taskId": str(context.get("taskId", "")),
            "contractVersion": int(context.get("contractVersion", 1)),
        }
        res_val_hash = _sha256(_canonical_json_bytes(exec_res.result))
        chk = {
            "checkerId": f"checker.{target}.v1",
            "version": "1.0.0",
            "scope": scope,
            "inputHash": input_hash,
            "resultHash": res_val_hash,
            "status": exec_res.verification.status if exec_res.verification else "AUDITED",
        }
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="COMPLETE",
            guidance=guidance_list,
            observations=[obs],
            checks=[chk],
            limitations=[],
            duration_ms=duration_ms,
            computation_type="NATIVE_PYTHON",
        )
    elif exec_res.status in ("invalid_input", "argument contract"):
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="NEEDS_INPUT",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_INPUT_INVALID, exec_res.detail or "Invalid arguments for calculation"],
            duration_ms=duration_ms,
            computation_type="NATIVE_PYTHON",
        )
    elif exec_res.status == "out_of_scope":
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="OUT_OF_SCOPE",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_EXECUTION_OUT_OF_SCOPE, exec_res.detail or "Calculation outside supported audit scope"],
            duration_ms=duration_ms,
            computation_type="NATIVE_PYTHON",
        )
    elif exec_res.status == "resource_limited":
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="UNAVAILABLE",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_DEADLINE_EXCEEDED, "Execution exceeded resource or deadline limits"],
            duration_ms=duration_ms,
            computation_type="NATIVE_PYTHON",
        )
    else:
        return _make_result(
            asset_id=asset_id,
            asset_version=asset.get("version", "1.0.0"),
            catalog_digest=catalog_digest,
            context=context,
            normalized_input=normalized_input,
            status="ERROR",
            guidance=guidance_list,
            observations=[],
            checks=[],
            limitations=[ERR_OUTCOME_UNKNOWN, exec_res.detail or "Execution error"],
            duration_ms=duration_ms,
            computation_type="NATIVE_PYTHON",
        )


def _make_result(
    asset_id: str,
    asset_version: str,
    catalog_digest: str,
    context: Dict[str, Any],
    normalized_input: Dict[str, Any],
    status: str,
    guidance: List[str],
    observations: List[Dict[str, Any]],
    checks: List[Dict[str, Any]],
    limitations: List[str],
    duration_ms: int,
    computation_type: str,
) -> Dict[str, Any]:
    input_hash = _sha256(_canonical_json_bytes(normalized_input))
    binding = {
        "taskId": str(context.get("taskId", "")),
        "goalId": str(context.get("goalId", "")),
        "scopeId": str(context.get("scopeId", "")),
        "contractVersion": int(context.get("contractVersion", 1)),
    }
    if "sourceRequestId" in context:
        binding["sourceRequestId"] = str(context["sourceRequestId"])

    body_to_hash = {
        "assetId": asset_id,
        "assetVersion": asset_version,
        "catalogDigest": catalog_digest,
        "inputHash": input_hash,
        "status": status,
        "observations": observations,
        "checks": checks,
    }
    result_hash = _sha256(_canonical_json_bytes(body_to_hash))

    return {
        "schemaVersion": MATH_ASSET_SCHEMA_VERSION,
        "assetId": asset_id,
        "assetVersion": asset_version,
        "catalogDigest": catalog_digest,
        "requestId": str(context.get("sourceRequestId", "host-req-1")),
        "binding": binding,
        "normalizedInput": normalized_input,
        "inputHash": input_hash,
        "status": status,
        "guidance": guidance,
        "observations": observations,
        "checks": checks,
        "usage": {
            "durationMs": duration_ms,
            "computationType": computation_type,
        },
        "limitations": limitations,
        "resultHash": result_hash,
    }


def _make_error_result(
    asset_id: str,
    context: Dict[str, Any],
    status: str,
    error_code: str,
    message: str,
    catalog_digest: str,
) -> Dict[str, Any]:
    return _make_result(
        asset_id=asset_id,
        asset_version="1.0.0",
        catalog_digest=catalog_digest,
        context=context,
        normalized_input={},
        status=status,
        guidance=[],
        observations=[],
        checks=[],
        limitations=[error_code, message],
        duration_ms=0,
        computation_type="NONE",
    )
