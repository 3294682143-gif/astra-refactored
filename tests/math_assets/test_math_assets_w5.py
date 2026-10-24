"""Migration verification tests for Batch W5 (7 implementations).

Verifies per §11.1 & §11.2:
- Optimization, numerical conjecture, probability approximations, no evidence upgrading.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

CERT = "method=central;x=1.0;h=0.001;order=2;samples=[0.998001, 0.9990002500000001, 0.9995000625, 1.0005000625000002, 1.00100025, 1.0020009999999997];D_h=1.9999999999998352;D_h2=1.9999999999997797;D_h4=2.000000000000446"

W5_CASES = [
    # 70. closed_form_conjecture
    ("math.numerics", "closed_form_conjecture", {"value": 1.41421356237}),
    # 71. identify_constant
    ("math.numerics", "identify_constant", {"value": 1.414213562373}),
    # 72. verify_fd_certificate
    ("math.numerics", "verify_fd_certificate", {"f": "x**2", "x": 1.0, "h": 0.001, "method": "central", "certificate": CERT}),
    # 73. certificate_check_expr
    ("math.optimization", "certificate_check", {"expression": "x**2 + y**2", "variables": ["x", "y"], "bounds": [[-1, 1], [-1, 1]]}),
    # 74. numeric_extremum_search_expr
    ("math.optimization", "numeric_extremum_search", {"expression": "x**2 + y**2", "variables": ["x", "y"], "bounds": [[-1, 1], [-1, 1]]}),
    # 75. subset_gap_worst_case
    ("math.optimization", "subset_gap_worst_case", {"bound": 5, "target": 10, "n_terms": 3}),
    # 76. normal_overflow_seats
    ("math.probability", "normal_overflow_seats", {"total": 100, "groups": 10, "overflow_bound": 0.05}),
]


@pytest.mark.parametrize("asset_id,target,input_data", W5_CASES)
def test_w5_implementation_success(base_context, asset_id, target, input_data):
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


@pytest.mark.parametrize("asset_id,target,input_data", W5_CASES)
def test_w5_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": {"target": target, "malformed_key": True},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE")
    assert len(res["observations"]) == 0


def test_w5_out_of_scope_target(base_context):
    req = {
        "action": "math_asset",
        "assetId": "math.optimization",
        "target": "unsupported_optimization_method",
        "input": {"expression": "x"},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
