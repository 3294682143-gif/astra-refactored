"""Migration verification tests for Batch W1 (11 implementations).

Verifies per §11.1 & §11.2:
- Encoding, canonical sequences, graph inputs, certificates, and witnesses.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

W1_CASES = [
    # 27. format_phrases
    ("math.encoding", "format_phrases", {"phrases": [[0, "A"], [1, "B"]]}),
    # 28. lz78_bit_string
    ("math.encoding", "lz78_bit_string", {"phrases": [[0, "A"], [1, "B"]], "symbol_code": {"A": "0", "B": "1"}, "index_bits": 2}),
    # 29. lz78_decode
    ("math.encoding", "lz78_decode", {"phrases": [[0, "A"], [1, "B"]]}),
    # 30. lz78_encode
    ("math.encoding", "lz78_encode", {"message": "ABA"}),
    # 31. verify_phrases
    ("math.encoding", "verify_phrases", {"phrases": [[0, "A"], [1, "B"]], "message": "AB"}),
    # 32. constraint_propagation_2coloring
    ("math.graphs", "constraint_propagation_2coloring", {"points": [0, 1, 2], "edges": [[0, 1], [1, 2]], "fixed": {}}),
    # 33. count_complete_bipartite_subgraphs
    ("math.graphs", "count_complete_bipartite_subgraphs", {"n": 4, "s": 1, "t": 1, "edges": [[0, 1], [1, 2], [2, 3]]}),
    # 34. has_perfect_matching
    ("math.graphs", "has_perfect_matching", {"n": 4, "edges": [[0, 1], [2, 3]]}),
    # 35. triangle_free_check
    ("math.graphs", "triangle_free_check", {"n": 3, "edges": [[0, 1], [1, 2]]}),
    # 36. tutte_violation
    ("math.graphs", "tutte_violation", {"n": 4, "edges": [[0, 1], [2, 3]]}),
    # 37. verify_perfect_matching
    ("math.graphs", "verify_perfect_matching", {"n": 4, "edges": [[0, 1], [2, 3]], "matching": [[0, 1], [2, 3]]}),
]


@pytest.mark.parametrize("asset_id,target,input_data", W1_CASES)
def test_w1_implementation_success(base_context, asset_id, target, input_data):
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
    assert "value" in obs
    if target != "tutte_violation":
        assert obs["value"] is not None
    assert len(res["checks"]) >= 1


@pytest.mark.parametrize("asset_id,target,input_data", W1_CASES)
def test_w1_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": {"target": target, "malformed_key": True},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE")
    assert len(res["observations"]) == 0


def test_w1_out_of_scope_target(base_context):
    req = {
        "action": "math_asset",
        "assetId": "math.graphs",
        "target": "unsupported_graph_property",
        "input": {"n": 3, "edges": []},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
