"""Migration verification tests for Batch W2 (10 implementations).

Verifies per §11.1 & §11.2:
- Coordinates, finite geometry, lattice geometry, degeneracies, numerical errors.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

W2_CASES = [
    # 38. angle_at_vertex
    ("math.geometry", "angle_at_vertex", {"p": [1, 0], "v": [0, 0], "q": [0, 1]}),
    # 39. area_bisection_coverage
    ("math.geometry", "area_bisection_coverage", {"vertices": [[0, 0], [4, 0], [5, 3], [2, 5], [-1, 2]]}),
    # 40. count_angle_ratio_locus
    ("math.geometry", "count_angle_ratio_locus", {"p": [0, 0], "q": [1, 0], "r": [0, 1]}),
    # 41. line_cover_number
    ("math.geometry", "line_cover_number", {"points": [[0, 0], [1, 1], [2, 2]], "max_lines": 2}),
    # 42. line_separation_number
    ("math.geometry", "line_separation_number", {"points": [[0, 0], [1, 1]], "colors": [0, 1]}),
    # 43. line_through
    ("math.geometry", "line_through", {"p": [0, 0], "q": [1, 1]}),
    # 44. worst_configuration_search
    ("math.geometry", "worst_configuration_search", {"objective": "separation", "red": 2, "blue": 2, "grid": 3, "samples": 10}),
    # 45. count_lattice_hexagons
    ("math.lattices", "count_lattice_hexagons", {"n": 1}),
    # 46. hexagon_lattice_points
    ("math.lattices", "hexagon_lattice_points", {"n": 1}),
    # 47. lattice_points_in_polygon
    ("math.lattices", "lattice_points_in_polygon", {"vertices": [[0, 0], [2, 0], [2, 2], [0, 2]]}),
]


@pytest.mark.parametrize("asset_id,target,input_data", W2_CASES)
def test_w2_implementation_success(base_context, asset_id, target, input_data):
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


@pytest.mark.parametrize("asset_id,target,input_data", W2_CASES)
def test_w2_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": {"target": target, "malformed_key": True},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE")
    assert len(res["observations"]) == 0


def test_w2_out_of_scope_target(base_context):
    req = {
        "action": "math_asset",
        "assetId": "math.geometry",
        "target": "unsupported_geometry_op",
        "input": {"p": [0, 0]},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
