"""Migration verification tests for Batch W3 (14 implementations).

Verifies per §11.1 & §11.2:
- Tiling, finite games, remaining finite state counts, node budgets, terminal states.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

W3_CASES = [
    # 48. deletion_divisible_largest
    ("math.finite-states", "deletion_divisible_largest", {"distinct_digits": True, "max_digits": 3}),
    # 49. digit_sum_window_search
    ("math.finite-states", "digit_sum_window", {"window": 2, "modulus": 3}),
    # 50. hamiltonian_paths_grid
    ("math.finite-states", "hamiltonian_paths_grid", {"width": 2, "height": 2}),
    # 51. deck_game_outcome
    ("math.games", "deck_game_outcome", {"d": 2}),
    # 52. gap_subsequence_discrepancy
    ("math.games", "gap_subsequence_discrepancy", {"spec": {"length": 5, "max_gap": 2}}),
    # 53. independent_reply_certificate
    ("math.games", "independent_reply_certificate", {"elements": [1, 2, 3, 4], "conflicts": [[1, 2], [3, 4]]}),
    # 54. minimax_value_graph
    ("math.games", "minimax_value_graph", {
        "spec": {"states": ["A", "B"], "edges": {"A": ["B"]}, "terminal": {"B": 1}, "maximizer_states": ["A"]}
    }),
    # 55. pairing_strategy_verify
    ("math.games", "pairing_strategy_verify", {"elements": [1, 2, 3, 4], "partner": {"1": 2, "2": 1, "3": 4, "4": 3}}),
    # 56. win_draw_loss_graph
    ("math.games", "win_draw_loss_graph", {
        "spec": {"states": ["A", "B"], "edges": {"A": ["B"]}, "terminal": {"B": 1}}
    }),
    # 57. check_tiling_certificate
    ("math.tiling", "check_tiling_certificate", {
        "rows": 2, "cols": 2, "tile_area": 2, "placements": [[[0, 0], [0, 1]], [[1, 0], [1, 1]]]
    }),
    # 58. coloring_bound
    ("math.tiling", "coloring_bound", {
        "board_spec": {"rows": 2, "cols": 2},
        "tile_shape_spec": {"cells": [[0, 0], [0, 1]], "allow_rotations": True},
        "coloring_spec": {"kind": "product_mod", "row_mod": 2, "col_mod": 2, "target": [0, 0]}
    }),
    # 59. count_tilings
    ("math.tiling", "count_tilings", {"rows": 2, "cols": 2, "tile_area": 2}),
    # 60. min_tiles_cover
    ("math.tiling", "min_tiles_cover", {
        "rows": 2, "cols": 2,
        "tile_shape_spec": {"cells": [[0, 0], [0, 1]], "allow_rotations": True},
        "target_spec": {"kind": "cells", "cells": [[0, 0]]}
    }),
    # 61. unique_tiling_check
    ("math.tiling", "unique_tiling_check", {"rows": 2, "cols": 2, "tile_area": 2, "marked_cells": [[0, 0]]}),
]


@pytest.mark.parametrize("asset_id,target,input_data", W3_CASES)
def test_w3_implementation_success(base_context, asset_id, target, input_data):
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


@pytest.mark.parametrize("asset_id,target,input_data", W3_CASES)
def test_w3_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    if target == "deletion_divisible_largest":
        bad_input = {"target": target, "distinct_digits": "not_a_bool", "max_digits": -1}
    else:
        bad_input = {"target": target, "malformed_key": True}
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": bad_input,
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE")
    assert len(res["observations"]) == 0


def test_w3_out_of_scope_target(base_context):
    req = {
        "action": "math_asset",
        "assetId": "math.tiling",
        "target": "unsupported_tiling_search",
        "input": {"rows": 2, "cols": 2},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
