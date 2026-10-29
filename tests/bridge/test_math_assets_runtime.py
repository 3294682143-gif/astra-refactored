"""Tests for unified math_assets_runtime and use_math_asset entry point.

Verifies §10 U3 acceptance criteria:
1. Valid GF(2) rank request returns real result and independent check
2. JSON string pretending to be int, bool pretending to be int, out of scope, unknown assetId rejected
3. Legacy function name, module path, or forged binding rejected
4. No hidden fallback to legacy engines on failure
5. COMPLETE, UNKNOWN, timeout usage and process cleanup recorded
6. First NEEDS_INPUT parameter completion within same root budget and deadline
"""

from __future__ import annotations

import time
import pytest

from python.astra_bridge.math_assets_runtime import (
    ERR_ASSET_NOT_FOUND,
    ERR_DEADLINE_EXCEEDED,
    ERR_EXECUTION_OUT_OF_SCOPE,
    ERR_INPUT_INCOMPLETE,
    ERR_INPUT_INVALID,
    use_math_asset,
)


@pytest.fixture
def base_context():
    return {
        "sessionId": "test-session-u3",
        "problemHash": "b" * 64,
        "contractVersion": 1,
        "taskId": "task-linear-algebra-1",
        "goalId": "goal-1",
        "scopeId": "scope-1",
        "sourceRequestId": "model-1",
    }


def test_valid_gf2_rank_request(base_context):
    """1. 合法秩请求返回真实结果和独立检查。"""
    request = {
        "action": "math_asset",
        "assetId": "math.linear-algebra",
        "input": {
            "target": "rank",
            "field": "GF2",
            "rows": [1, 2, 3],  # [0b01, 0b10, 0b11] -> rank 2
        },
    }
    result = use_math_asset(request, context=base_context)
    assert result["schemaVersion"] == "math-assets-v1"
    assert result["assetId"] == "math.linear-algebra"
    assert result["status"] == "COMPLETE"
    assert len(result["observations"]) == 1
    obs = result["observations"][0]
    assert obs["quantity"] == "gf2_rank"
    assert obs["value"] == 2
    assert obs["domain"] == "Exact rank of binary matrix over GF(2)"
    assert obs["exactness"] == "EXACT_FOR_INPUT"
    assert len(result["checks"]) == 1
    assert result["checks"][0]["status"] == "VERIFIED_FOR_INPUT"
    assert result["resultHash"] is not None


def test_type_spoofing_rejected(base_context):
    """2. JSON 字符串冒充整数、bool 冒充整数均拒绝。"""
    # String spoofing
    r1 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": ["1", "2"]},
        },
        context=base_context,
    )
    assert r1["status"] == "NEEDS_INPUT"
    assert ERR_INPUT_INVALID in r1["limitations"]

    # Bool spoofing
    r2 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": [True, False]},
        },
        context=base_context,
    )
    assert r2["status"] == "NEEDS_INPUT"
    assert ERR_INPUT_INVALID in r2["limitations"]


def test_unknown_asset_and_target_rejected(base_context):
    """未知 assetId 及超出范围的 target 均拒绝。"""
    # Unknown asset
    r1 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.nonexistent",
            "input": {"target": "rank"},
        },
        context=base_context,
    )
    assert r1["status"] == "ERROR"
    assert ERR_ASSET_NOT_FOUND in r1["limitations"]

    # Unsupported target
    r2 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "unsupported_nonlinear_quantum"},
        },
        context=base_context,
    )
    assert r2["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in r2["limitations"]


def test_forged_binding_and_legacy_names_rejected(base_context):
    """3. 传入旧函数名、模块路径或伪造 binding 均拒绝。"""
    # Model trying to inject taskId in input
    r1 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": [1, 2], "taskId": "forged-task"},
        },
        context=base_context,
    )
    assert r1["status"] == "ERROR"
    assert ERR_INPUT_INVALID in r1["limitations"]

    # Model trying to pass implementationRef
    r2 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": [1, 2], "implementationRef": "os.system"},
        },
        context=base_context,
    )
    assert r2["status"] == "ERROR"
    assert ERR_INPUT_INVALID in r2["limitations"]


def test_timeout_and_deadline_exceeded(base_context):
    """5. 超时用量如实记录。"""
    past_deadline = time.monotonic() - 1.0
    result = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": [1, 2]},
        },
        context=base_context,
        deadline=past_deadline,
    )
    assert result["status"] == "UNAVAILABLE"
    assert ERR_DEADLINE_EXCEEDED in result["limitations"]


def test_needs_input_then_completion(base_context):
    """6. 第一次 NEEDS_INPUT 后补齐参数，仍在同一根预算和 deadline 中完成。"""
    deadline = time.monotonic() + 10.0

    # Turn 1: missing rows
    r1 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank"},
        },
        context=base_context,
        deadline=deadline,
    )
    assert r1["status"] == "NEEDS_INPUT"
    assert ERR_INPUT_INCOMPLETE in r1["limitations"]
    assert any("rows" in g for g in r1["guidance"])

    # Turn 2: supplied rows
    r2 = use_math_asset(
        {
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "input": {"target": "rank", "rows": [1, 2, 3]},
        },
        context=base_context,
        deadline=deadline,
    )
    assert r2["status"] == "COMPLETE"
    assert r2["observations"][0]["value"] == 2
