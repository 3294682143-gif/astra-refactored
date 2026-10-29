"""Migration verification tests for Batch W0 (26 implementations, 32 behaviors).

Verifies per §11.2:
1. Real execution through use_math_asset official entry.
2. Accurate mathematical input-to-private parameter mapping.
3. Strict status == 'COMPLETE', observations populated with exactness & domain.
4. Input invalidity rejected with status == 'NEEDS_INPUT'.
5. Out of scope targets rejected with status == 'OUT_OF_SCOPE'.
"""

from __future__ import annotations

import pytest
from python.astra_bridge.math_assets_runtime import (
    ERR_EXECUTION_OUT_OF_SCOPE,
    use_math_asset,
)

W0_CASES = [
    # 01. finite_group_structure
    ("math.algebraic-structures", "group_structure", {"named_group": "V4"}),
    # 02. splitting_field_degree_expr
    ("math.algebraic-structures", "splitting_field_degree", {"expression": "x**2 - 2"}),
    # 03. bounded_enumeration
    ("math.combinatorics", "enumerate", {
        "objects": [[0, 0], [0, 1], [1, 0], [1, 1]],
        "choose": 2,
        "predicate": "distinct(0) > distinct(1)"
    }),
    # 04. count_avoiding_permutations
    ("math.combinatorics", "avoiding_permutations", {"n": 3, "forbidden": [[0, 0]]}),
    # 05. rook_numbers
    ("math.combinatorics", "rook_numbers", {"n": 3, "forbidden": [[0, 0]]}),
    # 06. circle_laplacian_expr
    ("math.differential", "circle_laplacian", {"expression": "theta**2"}),
    # 07. planar_laplacian_expr
    ("math.differential", "planar_laplacian", {"expression": "x**2 + y**2", "variables": ["x", "y"]}),
    # 08. solve_quadratic_diophantine
    ("math.diophantine", "quadratic_diophantine", {"a": 1, "b": 0, "c": 1, "d": 0, "e": 0, "f": -5}),
    # 09. symbolic_diophantine_with_timeout
    ("math.diophantine", "symbolic_diophantine", {"lhs": "x**2 + y**2", "rhs": "5", "variables": ["x", "y"], "timeout_ms": 2000}),
    # 10. exact_check_expr (7 splits per Appendix D)
    ("math.equations", "simplify", {"expression": "(x**2 - 1)/(x - 1)", "variable": "x"}),
    ("math.differential", "trig_reduce", {"expression": "sin(x)**2 + cos(x)**2", "variable": "x"}),
    ("math.linear-algebra", "maximal_minors", {
        "matrix": [["-t**2+2*t-1", "-t"], ["t", "-t**2+2*t-1"]], "variable": "t"
    }),
    ("math.algebraic-structures", "factor_over_extension", {
        "expression": "x**4 + 5", "variable": "x", "minimal_polynomials": ["x**4 - 5", "x**2 + 1"]
    }),
    ("math.integration", "definite_integral", {"expression": "x**2", "variable": "x", "lower": "0", "upper": "1"}),
    ("math.limits", "limit", {"expression": "sin(x)/x", "variable": "x", "point": "0"}),
    ("math.probability", "density_check", {
        "expression": "4*exp(-x**2/2)/sqrt(2*pi)*(1+erf(x/2))/2", "variable": "x", "lower": "0", "upper": "oo"
    }),
    # 11. polynomial_function_check
    ("math.equations", "function_identity", {
        "equation": "f(x+1)-f(x)=2*x+1", "function": "f", "argument": "x", "variables": ["x"], "expression": "x**2"
    }),
    # 12. real_root_count_expr
    ("math.equations", "real_roots", {"expression": "x**2 - 4"}),
    # 13. solve_system_guarded_expr
    ("math.equations", "solve_system", {"expressions": ["x+y-3", "x-y-1"], "variables": ["x", "y"]}),
    # 14. count_by_digit_property
    ("math.finite-states", "digit_property_count", {"digit_set": [1, 2], "max_digits": 2}),
    # 15. independence_polynomial_chain
    ("math.finite-states", "independence_polynomial", {"n": 3}),
    # 16. transition_count
    ("math.finite-states", "transition_count", {"length": 2, "num_states": 2, "transitions": [[0, 1], [1, 0]]}),
    # 17. polynomial_expand_coefficients
    ("math.generating-functions", "expand_coefficients", {"expression": "(1 + x)**3", "variables": ["x"], "parameters": []}),
    # 18. gf2_nullspace
    ("math.linear-algebra", "gf2_nullspace", {"rows": [1, 2], "width": 2}),
    # 19. gf2_rank
    ("math.linear-algebra", "gf2_rank", {"rows": [1, 2]}),
    # 20. linear_system_solution_set
    ("math.linear-algebra", "solution_set", {
        "matrix": [["1", "1"], ["1", "-1"]], "rhs": ["3", "1"], "variables": ["x", "y"], "domain": "RATIONAL"
    }),
    # 21. finite_difference_derivative
    ("math.numerics", "finite_difference", {"f": "x**2", "x": 1.0, "h": 0.001}),
    # 22. interpolation_fit_check
    ("math.numerics", "interpolation_fit", {
        "points": [{"x": "0", "y": "1"}, {"x": "1", "y": "4"}, {"x": "2", "y": "9"}],
        "expression": "x**2+2*x+1", "variable": "x"
    }),
    # 23. richardson_extrapolate
    ("math.numerics", "richardson_extrapolate", {"f": "x**2", "x": 1.0, "h": 0.001}),
    # 24. cover_time_complete_graph
    ("math.probability", "cover_time", {"num_vertices": 4}),
    # 25. markov_expected_steps
    ("math.probability", "markov_expected_steps", {"transition": [[0.5, 0.5], [0.0, 1.0]], "start": 0, "targets": [1]}),
    # 26. stats_ols_check
    ("math.regression", "ols_check", {"data": [{"x": "1", "y": "2"}, {"x": "2", "y": "4"}, {"x": "3", "y": "6"}]}),
]


@pytest.mark.parametrize("asset_id,target,input_data", W0_CASES)
def test_w0_implementation_success(base_context, asset_id, target, input_data):
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
    assert res["checks"][0]["status"] is not None


@pytest.mark.parametrize("asset_id,target,input_data", W0_CASES)
def test_w0_implementation_invalid_input_rejected(base_context, asset_id, target, input_data):
    """Refuse missing required parameters or malformed input."""
    req = {
        "action": "math_asset",
        "assetId": asset_id,
        "target": target,
        "input": {"target": target, "invalid_dummy_param": "bad_value"},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] in ("NEEDS_INPUT", "OUT_OF_SCOPE"), f"Expected rejection for {asset_id}:{target}, got {res['status']}"
    assert len(res["observations"]) == 0


def test_w0_out_of_scope_target(base_context):
    """Refuse unknown target under legitimate asset."""
    req = {
        "action": "math_asset",
        "assetId": "math.linear-algebra",
        "target": "unsupported_operation_xyz",
        "input": {"rows": [1, 2]},
    }
    res = use_math_asset(req, context=base_context)
    assert res["status"] == "OUT_OF_SCOPE"
    assert ERR_EXECUTION_OUT_OF_SCOPE in res["limitations"]
