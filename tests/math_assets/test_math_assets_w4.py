"""Migration verification tests for Batch W4 (8 implementations).

Verifies per §11.1 & §11.2:
- Integer structure, diophantine families, invariants, algebraic relations.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

W4_CASES = [
    # 62. algebraic_polynomial_check
    ("math.algebraic-structures", "algebraic_polynomial_check", {
        "minimal_polynomial": "t**2 - 2", "generator": "t", "argument": "t",
        "target": "t", "expression": "x", "variable": "x"
    }),
    # 63. wronskian_root_identity_expr
    ("math.algebraic-structures", "wronskian_root_identity", {
        "expression": "(z - 1)*(z - 2)", "variable": "z", "roots": ["1", "2"]
    }),
    # 64. solve_quadratic_discriminant_family
    ("math.diophantine", "quadratic_discriminant_family", {
        "c2": 1, "c1": [0, 1], "c0": [-1, 0], "x_lo": 0, "x_hi": 5
    }),
    # 65. frobenius_semigroup
    ("math.integer-structure", "frobenius_semigroup", {"generators": [3, 5], "limit": 20}),
    # 66. odd_part
    ("math.integer-structure", "odd_part", {"n": 24}),
    # 67. odd_part_table
    ("math.integer-structure", "odd_part_table", {"limit": 10, "modulus": 4}),
    # 68. double_counting_bound
    ("math.invariants", "double_counting", {"count_a": 10, "count_b": 10}),
    # 69. polynomial_invariant_check
    ("math.invariants", "polynomial_invariant", {
        "base_variables": ["x", "y"], "variables": ["x", "y"],
        "forward": ["x + 1", "y + 1"], "target": ["x", "y"], "invariants": ["x - y"]
    }),
]


@pytest.mark.parametrize("asset_id,target,input_data", W4_CASES)
def test_w4_implementation_success(base_context, asset_id, target, input_data):
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": input_data,
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "COMPLETE", f"Failed for {asset_id}:{target}: {res.get('limitations')}"
    assert len(res["observations"]) == 1
    obs = res["observations"][0]
    assert obs["quantity"] == target
    assert obs["domain"] is not None
    assert obs["taskId"] == base_context["taskId"]
    assert obs["contractVersion"] == base_context["contractVersion"]
    assert obs["value"] is not None
    assert len(res["checks"]) >= 1


@pytest.mark.parametrize("asset_id,target,input_data", W4_CASES)
def test_w4_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": {"target": target, "malformed_key": True},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE")
    assert len(res["observations"]) == 0


def test_w4_out_of_scope_target(base_context):
    req = {
        "action": "math_asset",
        "assetId": "math.integer-structure",
        "target": "unsupported_integer_function",
        "input": {"n": 5},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
