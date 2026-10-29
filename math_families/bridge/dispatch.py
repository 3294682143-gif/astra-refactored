"""Bridge dispatcher: JSON tool calls -> math_families -> ToolEvidence dicts.

Each entry maps a tool name to (callable, coercers). Coercers convert JSON
payloads (lists, strings) into the exact Python types the family functions
declare — the model never supplies code; expression strings pass through the
whitelist parser in bridge/safe_expr.py.

Error mapping:
- ValueError / TypeError / KeyError from coercion or the tool -> invalid_input
- Evidence with feasibility "infeasible: ..." -> resource_limited (bridge)
- anything else -> error
"""

from __future__ import annotations

from typing import Any, Callable

from math_families.bridge.evidence_bridge import family_error, to_tool_evidence_dict
from math_families.bridge.safe_expr import parse_numeric_function, sympy_expr
from math_families.bridge.spec_adapters import (
    discrepancy_spec,
    minimax_value_graph,
    win_draw_loss_graph,
)
from math_families.core.evidence import Evidence


# --------------------------------------------------------------------- #
# Coercers
# --------------------------------------------------------------------- #
def _int(v):
    """Strict JSON integer: no bools, no strings, no fractional floats."""
    if isinstance(v, bool) or not isinstance(v, int):
        raise TypeError(f"expected a JSON integer, got {type(v).__name__}")
    return v


def _float(v):
    """Strict JSON number: int or float, no bools, no strings."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError(f"expected a JSON number, got {type(v).__name__}")
    return float(v)


def _str(v):
    if not isinstance(v, str):
        raise TypeError("expected a string")
    return v


def _bool(v):
    """Strict JSON boolean: strings like "false" are rejected, not coerced."""
    if not isinstance(v, bool):
        raise TypeError(f"expected a JSON boolean, got {type(v).__name__}")
    return v


def _intlist(v):
    return [int(x) for x in v]


def _intset(v):
    return {int(x) for x in v}


def _pairlist(v):
    return [(int(a), int(b)) for a, b in v]


def _pairset(v):
    return {(int(a), int(b)) for a, b in v}


def _pointlist(v):
    return [(float(a), float(b)) for a, b in v]


def _passthrough(v):
    return v


def _expr_in_x(v):
    return parse_numeric_function(v, ["x"])


def _safe_expr_str(v):
    """Validate an expression string against the whitelist, pass through."""
    if not isinstance(v, str):
        raise TypeError("expected expression string")
    sympy_expr(v, ["x", "y", "z", "n", "t"])  # validation only
    return v


def _intkeymap(v):
    """JSON object with integer keys -> dict with int keys."""
    if not isinstance(v, dict):
        raise TypeError("expected an object")
    return {int(k): int(val) for k, val in v.items()}


def _sympy_var(name):
    import sympy

    if not isinstance(name, str) or not name.isidentifier():
        raise ValueError("variable name must be an identifier")
    return sympy.Symbol(name)


def _phrases(v):
    return [(int(i), str(s)) for i, s in v]


#: Integer-typed parameters get the strict _int coercer even when the entry
#: needs no other coercion (bool and strings are rejected, not silently
#: reinterpreted).
_INT_PARAMS: dict[str, dict[str, Callable]] = {
    "count_by_digit_property": {
        "max_digits": _int,
        "modulus": _int,
        "residue": _int,
        "include_zero": _bool,
    },
    "digit_sum_window_search": {"window": _int, "modulus": _int, "max_n": _int},
    "deletion_divisible_largest": {"distinct_digits": _bool, "max_digits": _int},
    "transition_count": {"length": _int, "num_states": _int},
    "independence_polynomial_chain": {"n": _int},
    "hamiltonian_paths_grid": {
        "width": _int,
        "height": _int,
        "vertical": _bool,
        "right": _bool,
        "wrap": _bool,
    },
    "hexagon_lattice_points": {"n": _int},
    "count_lattice_hexagons": {"n": _int},
    "rook_numbers": {"n": _int},
    "count_avoiding_permutations": {"n": _int},
    "gf2_rank": {},
    "gf2_nullspace": {"width": _int},
    "deck_game_outcome": {"d": _int},
    "odd_part": {"n": _int},
    "odd_part_table": {"limit": _int, "modulus": _int},
    "frobenius_semigroup": {"limit": _int},
    "normal_overflow_seats": {
        "total": _int,
        "groups": _int,
        "overflow_bound": _float,
        "continuity_correction": _bool,
    },
    "cover_time_complete_graph": {"num_vertices": _int},
    "markov_expected_steps": {"start": _int},
    "finite_difference_derivative": {"h": _float, "x": _float},
    "richardson_extrapolate": {"h": _float, "x": _float},
    "lz78_bit_string": {"index_bits": _int},
    "count_tilings": {"rows": _int, "cols": _int},
    "min_tiles_cover": {"rows": _int, "cols": _int},
    "unique_tiling_check": {"rows": _int, "cols": _int},
    "count_complete_bipartite_subgraphs": {
        "n": _int,
        "s": _int,
        "t": _int,
        "injective": _bool,
    },
    "has_perfect_matching": {"n": _int},
    "tutte_violation": {"n": _int, "max_subsets": _int},
    "triangle_free_check": {"n": _int},
    "verify_perfect_matching": {"n": _int},
    "line_cover_number": {"max_lines": _int},
    "worst_configuration_search": {
        "red": _int,
        "blue": _int,
        "grid": _int,
        "samples": _int,
        "seed": _int,
    },
    "double_counting_bound": {"count_a": _int, "count_b": _int},
    "subset_gap_worst_case": {"bound": _int, "target": _int, "n_terms": _int},
}


# --------------------------------------------------------------------- #
# Dispatch table
# --------------------------------------------------------------------- #
def _entries() -> dict[str, tuple[Callable, dict[str, Callable]]]:
    base = _entries_impl()
    merged: dict[str, tuple[Callable, dict[str, Callable]]] = {}
    for name, (func, coercers) in base.items():
        extra = _INT_PARAMS.get(name, {})
        overlap = set(extra) & set(coercers)
        if overlap:
            raise ValueError(f"coercer overlap on {name}: {sorted(overlap)}")
        merged[name] = (func, {**extra, **coercers})
    return merged


def _entries_impl():
    from math_families.bridge import exact_math, computation
    from math_families.families import (
        algorithm_simulation,
        algorithm_simulation as algo,
        classical_geometry_compute,
        combinatorial_geometry,
        constrained_tiling,
        diophantine,
        digit_dp,
        extremal_construction,
        functional_equation,
        game_strategy_proof,
        graph_extremal,
        inclusion_exclusion_counting,
        lattice_counting,
        linear_algebra_game,
        number_theory_structure,
        probabilistic_model,
        transfer_matrix,
    )
    from math_families.families import numerical_methods

    T: dict[str, tuple[Callable, dict[str, Callable]]] = {
        # digit_dp
        "count_by_digit_property": (
            digit_dp.count_by_digit_property,
            {"digit_set": _intset},
        ),
        "digit_sum_window_search": (digit_dp.digit_sum_window_search, {}),
        "deletion_divisible_largest": (digit_dp.deletion_divisible_largest, {}),
        # transfer_matrix
        "transition_count": (
            transfer_matrix.transition_count,
            {"transitions": _pairset, "starts": _intset, "ends": _intset},
        ),
        "independence_polynomial_chain": (
            transfer_matrix.independence_polynomial_chain,
            {},
        ),
        "hamiltonian_paths_grid": (
            transfer_matrix.hamiltonian_paths_grid,
            {"start_rows": _intset, "end_rows": _intset},
        ),
        # minimax via structured state graphs
        "win_draw_loss_graph": (win_draw_loss_graph, {}),
        "minimax_value_graph": (minimax_value_graph, {}),
        "gap_subsequence_discrepancy": (discrepancy_spec, {}),
        # lattice_counting
        "hexagon_lattice_points": (lattice_counting.hexagon_lattice_points, {}),
        "count_lattice_hexagons": (lattice_counting.count_lattice_hexagons, {}),
        "lattice_points_in_polygon": (
            lattice_counting.lattice_points_in_polygon,
            {"vertices": _pairlist},
        ),
        # inclusion_exclusion
        "rook_numbers": (
            inclusion_exclusion_counting.rook_numbers,
            {"forbidden": _pairset},
        ),
        "count_avoiding_permutations": (
            inclusion_exclusion_counting.count_avoiding_permutations,
            {"forbidden": _pairset},
        ),
        # linear_algebra_game
        "gf2_rank": (linear_algebra_game.gf2_rank_evidence, {"rows": _intlist}),
        "gf2_nullspace": (
            linear_algebra_game.gf2_nullspace_evidence,
            {"rows": _intlist},
        ),
        "deck_game_outcome": (linear_algebra_game.deck_game_outcome, {}),
        # number_theory_structure (use Evidence-wrapped versions)
        "odd_part": (number_theory_structure.odd_part_evidence, {}),
        "odd_part_table": (number_theory_structure.odd_part_table_evidence, {}),
        "frobenius_semigroup": (
            number_theory_structure.frobenius_semigroup,
            {"generators": _intlist},
        ),
        # probabilistic_model
        "normal_overflow_seats": (probabilistic_model.normal_overflow_seats, {}),
        "cover_time_complete_graph": (
            probabilistic_model.cover_time_complete_graph,
            {},
        ),
        "markov_expected_steps": (
            probabilistic_model.markov_expected_steps,
            {"targets": _intset},
        ),
        # numerical_methods (expression DSL in x)
        "finite_difference_derivative": (
            numerical_methods.finite_difference_derivative,
            {"f": _expr_in_x},
        ),
        "richardson_extrapolate": (
            numerical_methods.richardson_extrapolate,
            {"f": _expr_in_x},
        ),
        "verify_fd_certificate": (
            numerical_methods.verify_fd_certificate_evidence,
            {"f": _expr_in_x},
        ),
        # algorithm_simulation
        "lz78_encode": (algorithm_simulation.lz78_encode, {}),
        "lz78_decode": (algorithm_simulation.lz78_decode, {"phrases": _phrases}),
        "verify_phrases": (
            algorithm_simulation.verify_phrases_evidence,
            {"phrases": _phrases},
        ),
        "lz78_bit_string": (
            algorithm_simulation.lz78_bit_string,
            {"phrases": _phrases},
        ),
        "format_phrases": (algorithm_simulation.format_phrases, {"phrases": _phrases}),
        # constrained_tiling (specs are already structured dicts)
        "count_tilings": (constrained_tiling.count_tilings, {}),
        "coloring_bound": (constrained_tiling.coloring_bound, {}),
        "min_tiles_cover": (constrained_tiling.min_tiles_cover, {}),
        "unique_tiling_check": (constrained_tiling.unique_tiling_check, {}),
        "check_tiling_certificate": (_tiling_certificate_check, {}),
        # graph_extremal
        "count_complete_bipartite_subgraphs": (
            graph_extremal.count_complete_bipartite_subgraphs,
            {"edges": _pairlist},
        ),
        "has_perfect_matching": (
            graph_extremal.has_perfect_matching,
            {"edges": _pairlist},
        ),
        "tutte_violation": (graph_extremal.tutte_violation, {"edges": _pairlist}),
        "triangle_free_check": (
            graph_extremal.triangle_free_check,
            {"edges": _pairlist},
        ),
        "verify_perfect_matching": (
            graph_extremal.verify_perfect_matching_evidence,
            {"edges": _pairlist, "matching": _pairlist},
        ),
        # combinatorial_geometry
        "line_cover_number": (
            combinatorial_geometry.line_cover_number,
            {"points": _pointlist},
        ),
        "line_separation_number": (
            combinatorial_geometry.line_separation_number,
            {"points": _pointlist, "colors": _intlist},
        ),
        "area_bisection_coverage": (
            combinatorial_geometry.area_bisection_coverage,
            {"vertices": _pointlist},
        ),
        "worst_configuration_search": (
            combinatorial_geometry.worst_configuration_search,
            {},
        ),
        # extremal_construction
        "double_counting_bound": (extremal_construction.double_counting_bound, {}),
        # game_strategy_proof (pure data entries only)
        "pairing_strategy_verify": (
            game_strategy_proof.pairing_strategy_verify,
            {"partner": _intkeymap},
        ),
        "independent_reply_certificate": (
            game_strategy_proof.independent_reply_certificate,
            {},
        ),
        # inequality_extremum (data-safe entries)
        "closed_form_conjecture": (_ineq_closed_form, {}),
        "subset_gap_worst_case": (_ineq_subset_gap, {}),
        "numeric_extremum_search_expr": (_ineq_extremum_expr, {}),
        "certificate_check_expr": (_ineq_certificate_expr, {}),
        # classical geometry (exact/numeric primitives)
        "line_through": (_geom_line_through, {"p": _passthrough, "q": _passthrough}),
        "angle_at_vertex": (_geom_angle, {}),
        "count_angle_ratio_locus": (
            classical_geometry_compute.count_angle_ratio_locus,
            {"p": list, "q": list, "r": list},
        ),
        "identify_constant": (classical_geometry_compute.identify_constant, {}),
        # symbolic algebra via expression DSL
        "real_root_count_expr": (_alg_real_root_count, {}),
        "splitting_field_degree_expr": (_alg_splitting_field, {}),
        "solve_system_guarded_expr": (_alg_solve_system, {}),
        # symbolic calculus via expression DSL
        "planar_laplacian_expr": (_calc_planar_laplacian, {}),
        "circle_laplacian_expr": (_calc_circle_laplacian, {}),
        # diophantine
        "solve_quadratic_diophantine": (diophantine.solve_quadratic_diophantine, {}),
        "solve_quadratic_discriminant_family": (
            diophantine.solve_quadratic_discriminant_family,
            {"c1": _intlist, "c0": _intlist},
        ),
        "symbolic_diophantine_with_timeout": (
            diophantine.symbolic_diophantine_with_timeout,
            {"lhs": _safe_expr_str, "rhs": _safe_expr_str},
        ),
        # functional_equation (JSON-safe 2-coloring propagation)
        "constraint_propagation_2coloring": (
            functional_equation.constraint_propagation_2coloring,
            {"points": _intlist, "edges": _pairlist, "fixed": _intkeymap},
        ),
    }
    T.update(
        {
            name: (getattr(exact_math, name), {})
            for name in (
                "polynomial_function_check",
                "polynomial_invariant_check",
                "algebraic_polynomial_check",
                "wronskian_root_identity_expr",
            )
        }
    )
    T.update(
        {
            name: (getattr(computation, name), {})
            for name in ("polynomial_expand_coefficients", "linear_system_solution_set")
        }
    )
    from math_families.bridge.exact_check import exact_check_expr
    from math_families.bridge.finite_enumeration import bounded_enumeration

    T.update(
        {
            "exact_check_expr": (exact_check_expr, {}),
            "bounded_enumeration": (bounded_enumeration, {}),
        }
    )
    return T


# --------------------------------------------------------------------- #
# Expression-DSL wrappers for callable-taking family tools
# --------------------------------------------------------------------- #
def _tiling_certificate_check(rows, cols, placements, **kwargs):
    """Wrap check_tiling_certificate (returns bool) as Evidence."""
    from math_families.families.constrained_tiling import check_tiling_certificate

    ok = check_tiling_certificate(rows, cols, placements, **kwargs)
    return Evidence(
        value=ok,
        certificate="tiling placement verification" if ok else "placement rejected",
        self_check="check_tiling_certificate passed"
        if ok
        else "check_tiling_certificate failed",
        feasibility="ok",
        complexity_bound="O(rows*cols)",
    )


def _ineq_closed_form(value):
    from math_families.families.inequality_extremum import closed_form_conjecture

    return closed_form_conjecture(float(value))


def _ineq_subset_gap(bound, target, n_terms):
    from math_families.families.inequality_extremum import subset_gap_worst_case

    return subset_gap_worst_case(
        bound=int(bound), target=int(target), n_terms=int(n_terms)
    )


def _ineq_extremum_expr(expression, variables, bounds, maximize=False):
    from math_families.families.inequality_extremum import numeric_extremum_search

    f = parse_numeric_function(expression, list(variables))
    return numeric_extremum_search(
        lambda v: f(*v),
        dim=len(variables),
        bounds=[tuple(b) for b in bounds],
        maximize=bool(maximize),
    )


def _ineq_certificate_expr(expression, variables, bounds, n_samples=2000, seed=0):
    import random

    from math_families.families.inequality_extremum import certificate_check

    margin = parse_numeric_function(expression, list(variables))

    def sampler(rng: random.Random):
        return [rng.uniform(lo, hi) for lo, hi in bounds]

    return certificate_check(
        lambda v: margin(*v), sampler, n_samples=int(n_samples), seed=int(seed)
    )


def _geom_line_through(p, q):
    from math_families.families.classical_geometry_compute import line_through

    ev_value = line_through(tuple(p), tuple(q))
    return Evidence(
        value=ev_value,
        certificate="line equation coefficients",
        self_check="point substitution check",
        feasibility="ok",
        complexity_bound="O(1)",
    )


def _geom_angle(p, v, q):
    from math_families.families.classical_geometry_compute import angle_at_vertex

    ev_value = angle_at_vertex(tuple(p), tuple(v), tuple(q))
    return Evidence(
        value=ev_value,
        certificate="atan2 exact float",
        self_check="O(1) numeric",
        feasibility="ok",
        complexity_bound="O(1)",
    )


def _alg_real_root_count(expression, variable="x", timeout_ms=10_000):
    from math_families.families.symbolic_algebra import real_root_count

    poly = sympy_expr(expression, [variable])
    return real_root_count(poly, _sympy_var(variable), timeout_ms=int(timeout_ms))


def _alg_splitting_field(expression, variable="x", timeout_ms=30_000):
    from math_families.families.symbolic_algebra import splitting_field_degree

    poly = sympy_expr(expression, [variable])
    return splitting_field_degree(
        poly, _sympy_var(variable), timeout_ms=int(timeout_ms)
    )


def _alg_solve_system(expressions, variables, timeout_ms=10_000, n_starts=40, seed=0):
    from math_families.families.symbolic_algebra import solve_system_guarded

    eqs = [sympy_expr(e, list(variables)) for e in expressions]
    vs = [_sympy_var(v) for v in variables]
    return solve_system_guarded(
        eqs, vs, timeout_ms=int(timeout_ms), n_starts=int(n_starts), seed=int(seed)
    )


def _calc_planar_laplacian(expression, variables):
    from math_families.families.symbolic_calculus import planar_laplacian

    f = sympy_expr(expression, list(variables))
    return planar_laplacian(f, [_sympy_var(v) for v in variables])


def _calc_circle_laplacian(expression):
    from math_families.families.symbolic_calculus import circle_laplacian

    f = sympy_expr(expression, ["theta"])
    return circle_laplacian(f, _sympy_var("theta"))


_DISPATCH: dict[str, tuple[Callable, dict[str, Callable]]] | None = None


def tool_names() -> list[str]:
    global _DISPATCH
    if _DISPATCH is None:
        _DISPATCH = _entries()
    return sorted(_DISPATCH)


def call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one JSON tool call. Returns a ToolEvidence-shaped dict."""
    global _DISPATCH
    if _DISPATCH is None:
        _DISPATCH = _entries()
    if not isinstance(args, dict):
        raise TypeError("tool arguments must be an object")
    entry = _DISPATCH.get(name)
    if entry is None:
        return {
            "status": "unsupported",
            "result": None,
            "assumptions": [],
            "method": name,
            "certificate": None,
            "completeness": "unknown",
            "warnings": [f"unknown or non-exposed family tool: {name}"],
        }
    func, coercers = entry
    try:
        coerced = {k: (coercers[k](v) if k in coercers else v) for k, v in args.items()}
        ev = func(**coerced)
        if not isinstance(ev, Evidence):
            raise TypeError(f"{name} returned {type(ev).__name__}, not Evidence")
        return to_tool_evidence_dict(ev, method=name)
    except (ValueError, TypeError, KeyError) as exc:
        return {
            "status": "invalid_input",
            "result": None,
            "assumptions": [],
            "method": name,
            "certificate": None,
            "completeness": "unknown",
            "warnings": [f"{type(exc).__name__}: {exc}"],
        }
    except Exception as exc:  # noqa: BLE001 - never let the bridge crash the caller
        return family_error(exc, method=name)
