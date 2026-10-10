"""Execution-input contracts for exploratory tools, not mathematical certificates."""

from __future__ import annotations

import ast
import json
import math
import re
from importlib.resources import files

from .tool_contracts import CONTRACTS, InvalidToolInput, OutsideAuditScope

VERSION = "registered-input-v1"
_REGISTRY = json.loads(
    files("mathagent")
    .joinpath("resources/tool-registry.json")
    .read_text(encoding="utf-8")
)["tools"]

# Rules define a documented execution subset. The producer may support more;
# inputs outside this subset are refused without fabricating a mathematical answer.
SCHEMAS = {
    "digit_sum_window_search": {
        "window": "positive",
        "modulus": "positive",
        "max_n": "budget",
    },
    "deletion_divisible_largest": {"distinct_digits": "bool", "max_digits": "digits"},
    "hamiltonian_paths_grid": {
        "width": "dimension",
        "height": "dimension",
        "vertical": "bool",
        "right": "bool",
        "wrap": "bool",
        "start_rows": "ints",
        "end_rows": "ints",
    },
    "win_draw_loss_graph": {"spec": "graph", "state_budget": "budget"},
    "minimax_value_graph": {"spec": "graph", "state_budget": "budget"},
    "gap_subsequence_discrepancy": {"spec": "discrepancy"},
    "hexagon_lattice_points": {"n": "positive"},
    "count_lattice_hexagons": {"n": "positive"},
    "lattice_points_in_polygon": {"vertices": "points"},
    "deck_game_outcome": {"d": "deck_dimension"},
    "frobenius_semigroup": {"generators": "positive_ints", "limit": "budget"},
    "normal_overflow_seats": {
        "total": "positive",
        "groups": "positive",
        "overflow_bound": "probability",
        "continuity_correction": "bool",
    },
    "cover_time_complete_graph": {"num_vertices": "positive"},
    "markov_expected_steps": {
        "transition": "matrix",
        "start": "nonnegative",
        "targets": "ints",
    },
    "finite_difference_derivative": {
        "f": "expr",
        "x": "number",
        "h": "positive_number",
        "method": "method",
    },
    "richardson_extrapolate": {
        "f": "expr",
        "x": "number",
        "h": "positive_number",
        "method": "method",
        "order": "positive",
    },
    "verify_fd_certificate": {
        "f": "expr",
        "x": "number",
        "h": "positive_number",
        "method": "method",
        "certificate": "text",
    },
    "lz78_bit_string": {
        "phrases": "phrases",
        "symbol_code": "symbol_code",
        "index_bits": "positive",
    },
    "format_phrases": {
        "phrases": "phrases",
        "style": "style",
        "sep": "text",
        "latex": "bool",
        "with_words": "bool",
        "pair": "pair_style",
    },
    "count_tilings": {
        "rows": "dimension",
        "cols": "dimension",
        "tile_shape_spec": "tile",
        "constraint_spec": "constraints",
        "tile_area": "positive",
        "max_nodes": "budget",
    },
    "coloring_bound": {
        "board_spec": "board",
        "tile_shape_spec": "tile",
        "coloring_spec": "coloring",
    },
    "min_tiles_cover": {
        "rows": "dimension",
        "cols": "dimension",
        "tile_shape_spec": "tile",
        "target_spec": "target",
    },
    "unique_tiling_check": {
        "rows": "dimension",
        "cols": "dimension",
        "marked_cells": "pairs",
        "tile_shape_spec": "tile",
        "tile_area": "positive",
        "max_nodes": "budget",
    },
    "check_tiling_certificate": {
        "rows": "dimension",
        "cols": "dimension",
        "placements": "placements",
        "tile_shape_spec": "tile",
        "tile_area": "positive",
        "constraint_spec": "constraints",
    },
    "tutte_violation": {"n": "positive", "edges": "pairs", "max_subsets": "budget"},
    "line_cover_number": {"points": "points", "max_lines": "positive"},
    "line_separation_number": {"points": "points", "colors": "ints"},
    "area_bisection_coverage": {"vertices": "points"},
    "worst_configuration_search": {
        "objective": "objective",
        "red": "positive",
        "blue": "positive",
        "line_budget": "positive",
        "grid": "dimension",
        "samples": "samples",
        "seed": "seed",
    },
    "double_counting_bound": {
        "count_a": "nonnegative",
        "count_b": "nonnegative",
        "description": "text",
    },
    "pairing_strategy_verify": {
        "elements": "ints",
        "partner": "partner",
        "threat_sets": "int_lists",
        "max_elements": "budget",
        "max_threats": "budget",
    },
    "independent_reply_certificate": {
        "elements": "ints",
        "conflicts": "pairs",
        "max_elements": "budget",
        "max_conflicts": "budget",
    },
    "closed_form_conjecture": {"value": "number"},
    "subset_gap_worst_case": {
        "bound": "positive",
        "target": "number",
        "n_terms": "dimension",
    },
    "numeric_extremum_search_expr": {
        "expression": "expr",
        "variables": "variables",
        "bounds": "bounds",
        "maximize": "bool",
    },
    "certificate_check_expr": {
        "expression": "expr",
        "variables": "variables",
        "bounds": "bounds",
        "n_samples": "samples",
        "seed": "seed",
    },
    "line_through": {"p": "point", "q": "point"},
    "angle_at_vertex": {"p": "point", "v": "point", "q": "point"},
    "count_angle_ratio_locus": {
        "p": "point",
        "q": "point",
        "r": "point",
        "ratio": "positive_number",
        "n_samples": "samples",
    },
    "identify_constant": {"value": "number", "basis": "expressions"},
    "real_root_count_expr": {
        "expression": "expr",
        "variable": "variable",
        "timeout_ms": "timeout",
    },
    "splitting_field_degree_expr": {
        "expression": "expr",
        "variable": "variable",
        "timeout_ms": "timeout",
    },
    "solve_system_guarded_expr": {
        "expressions": "expressions",
        "variables": "variables",
        "timeout_ms": "timeout",
        "n_starts": "samples",
        "seed": "seed",
    },
    "planar_laplacian_expr": {"expression": "expr", "variables": "variables"},
    "circle_laplacian_expr": {"expression": "expr"},
    "solve_quadratic_diophantine": {
        "a": "integer",
        "b": "integer",
        "c": "integer",
        "d": "integer",
        "e": "integer",
        "f": "integer",
        "y_bound": "nonnegative",
    },
    "solve_quadratic_discriminant_family": {
        "c2": "integer",
        "c1": "signed_ints",
        "c0": "signed_ints",
        "x_lo": "integer",
        "x_hi": "integer",
    },
    "symbolic_diophantine_with_timeout": {
        "lhs": "expr",
        "rhs": "expr",
        "variables": "variables",
        "timeout_ms": "timeout",
    },
}

INTEGER_RULES = {
    "integer": (-(10**6), 10**6),
    "nonnegative": (0, 10**6),
    "positive": (1, 1000),
    "dimension": (1, 6),
    "deck_dimension": (1, 3),
    "digits": (1, 6),
    "budget": (1, 100000),
    "samples": (1, 10000),
    "seed": (0, 2**32 - 1),
    "timeout": (1, 30000),
}
ENUMS = {
    "method": {"forward", "backward", "central"},
    "style": {"plain", "comma", "latex", "subscript", "words"},
    "pair_style": {"paren", "subscript"},
    "objective": {"covering_critical", "separation"},
}


def _array(value, minimum=0, maximum=128):
    if type(value) is not list or len(value) < minimum:
        raise InvalidToolInput("JSON array shape/length violation")
    if len(value) > maximum:
        raise OutsideAuditScope("documented array bound")


def _object(value, rules, required=()):
    if type(value) is not dict or not set(required) <= value.keys():
        raise InvalidToolInput("structured input fields missing")
    if value.keys() - rules.keys():
        raise OutsideAuditScope("undocumented structured input fields")
    for key, item in value.items():
        try:
            _check(rules[key], item)
        except (InvalidToolInput, OutsideAuditScope) as exc:
            raise type(exc)(f"{key}: {exc}") from exc


def _check(rule, value):
    if rule in INTEGER_RULES:
        lo, hi = INTEGER_RULES[rule]
        if rule == "integer" and type(value) is int and abs(value) > 10**6:
            raise OutsideAuditScope("documented signed-integer magnitude")
        if type(value) is not int or value < lo:
            raise InvalidToolInput("strict integer type/domain violation")
        if value > hi:
            raise OutsideAuditScope(f"documented integer bound: {lo} <= {rule} <= {hi}")
    elif rule in {"number", "positive_number", "probability"}:
        if type(value) is int and abs(value) > 10**9:
            raise OutsideAuditScope("documented numeric magnitude")
        if type(value) not in {int, float} or not math.isfinite(value):
            raise InvalidToolInput("finite JSON number required")
        if rule != "number" and value <= 0 or rule == "probability" and value >= 1:
            raise InvalidToolInput("numeric domain violation")
        if abs(value) > 10**9:
            raise OutsideAuditScope("documented numeric magnitude")
    elif rule == "bool":
        if type(value) is not bool:
            raise InvalidToolInput("strict JSON boolean required")
    elif rule in ENUMS:
        if type(value) is not str or value not in ENUMS[rule]:
            raise InvalidToolInput("unsupported explicit enum value")
    elif rule in {"text", "expr", "variable"}:
        if type(value) is not str or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
            raise InvalidToolInput("string required without coercion")
        if len(value) > (500 if rule == "expr" else 2000):
            raise OutsideAuditScope("documented text bound")
        if rule == "variable" and not re.fullmatch(
            r"[A-Za-z][A-Za-z0-9_]{0,15}", value
        ):
            raise InvalidToolInput("explicit identifier required")
        if rule == "expr":
            try:
                nodes = list(ast.walk(ast.parse(value.replace("^", "**"), mode="eval")))
            except (SyntaxError, ValueError) as exc:
                raise InvalidToolInput("expression syntax") from exc
            if len(nodes) > 128:
                raise OutsideAuditScope("expression AST bound")
            allowed = (
                ast.Expression,
                ast.BinOp,
                ast.UnaryOp,
                ast.Add,
                ast.Sub,
                ast.Mult,
                ast.Div,
                ast.Pow,
                ast.UAdd,
                ast.USub,
                ast.Constant,
                ast.Name,
                ast.Load,
                ast.Call,
            )
            functions = {
                "sin",
                "cos",
                "tan",
                "exp",
                "log",
                "sqrt",
                "Abs",
                "Rational",
                "Integer",
                "floor",
                "ceiling",
            }
            if any(not isinstance(n, allowed) for n in nodes):
                raise InvalidToolInput(
                    "only scalar mathematical AST nodes are permitted"
                )
            if any(
                isinstance(n, ast.Constant) and type(n.value) not in {int, float}
                for n in nodes
            ):
                raise InvalidToolInput("mathematical constants must be numbers")
            if any(
                isinstance(n, ast.Call)
                and (not isinstance(n.func, ast.Name) or n.func.id not in functions)
                for n in nodes
            ):
                raise InvalidToolInput("unregistered mathematical function")
            if any(
                isinstance(
                    n,
                    (
                        ast.Attribute,
                        ast.Subscript,
                        ast.Lambda,
                        ast.ListComp,
                        ast.DictComp,
                        ast.GeneratorExp,
                        ast.NamedExpr,
                    ),
                )
                for n in nodes
            ):
                raise InvalidToolInput(
                    "expression is not a pure mathematical expression"
                )
    elif rule in {"point", "pair"}:
        _array(value, 2, 2)
        for v in value:
            _check("number" if rule == "point" else "integer", v)
    elif rule in {
        "points",
        "pairs",
        "ints",
        "positive_ints",
        "signed_ints",
        "variables",
        "expressions",
        "int_lists",
        "placements",
        "matrix",
        "bounds",
    }:
        _array(
            value,
            1
            if rule in {"points", "variables", "matrix", "bounds", "positive_ints"}
            else 0,
            64,
        )
        subtype = {
            "points": "point",
            "pairs": "pair",
            "ints": "nonnegative",
            "positive_ints": "positive",
            "signed_ints": "integer",
            "variables": "variable",
            "expressions": "expr",
            "int_lists": "ints",
            "placements": "pairs",
            "matrix": "numbers",
            "bounds": "point",
        }[rule]
        for v in value:
            _check(subtype, v)
    elif rule == "numbers":
        _array(value, 1, 64)
        for v in value:
            _check("number", v)
    elif rule == "phrases":
        _array(value, 0, 64)
        for pair in value:
            _array(pair, 2, 2)
            _check("nonnegative", pair[0])
            _check("text", pair[1])
            if type(pair[1]) is not str or len(pair[1]) > 1:
                raise InvalidToolInput(
                    "phrase symbol must be empty or one string character"
                )
    elif rule == "symbol_code":
        if type(value) is not dict or not value or len(value) > 64:
            raise InvalidToolInput("explicit symbol dictionary required")
        if any(
            type(k) is not str
            or len(k) != 1
            or type(v) is not str
            or not re.fullmatch(r"[01]{1,16}", v)
            for k, v in value.items()
        ):
            raise InvalidToolInput("binary symbol encoding required")
        if (
            len(set(value.values())) != len(value)
            or len({len(v) for v in value.values()}) != 1
        ):
            raise InvalidToolInput("fixed-width injective symbol code required")
    elif rule == "partner":
        if type(value) is not dict or len(value) > 128:
            raise InvalidToolInput("partner table required")
        for k, v in value.items():
            if not re.fullmatch(r"0|[1-9][0-9]{0,6}", k):
                raise InvalidToolInput("canonical integer table keys required")
            _check("nonnegative", v)
    elif rule == "graph":
        _graph(value)
    elif rule == "discrepancy":
        _object(value, {"length": "positive", "max_gap": "positive"}, ("length",))
        if value["length"] > 32 or value.get("max_gap", 2) > 8:
            raise OutsideAuditScope("discrepancy search bound")
    elif rule == "tile":
        _object(
            value,
            {"cells": "pairs", "allow_rotations": "bool", "allow_reflections": "bool"},
            ("cells",),
        )
        if not value["cells"] or len(value["cells"]) > 16:
            raise OutsideAuditScope("tile area bound")
    elif rule == "board":
        _object(value, {"rows": "dimension", "cols": "dimension"}, ("rows", "cols"))
    elif rule == "constraints":
        _object(
            value,
            {
                "exact_tiles": "nonnegative",
                "exact_tiles_per_type": "ints",
                "min_uncovered_per_2x2": "nonnegative",
                "forbid_full_2x2": "bool",
                "two_uncovered_aligned_per_2x2": "bool",
                "blocked_cells": "pairs",
                "marked_cells": "pairs",
                "forbid_two_marked_per_tile": "bool",
            },
        )
    elif rule in {"coloring", "target"}:
        _object(
            value,
            {
                "kind": "text",
                "target_parity": "nonnegative",
                "parity": "nonnegative",
                "row_mod": "positive",
                "col_mod": "positive",
                "target": "pair",
                "cells": "pairs",
            },
            ("kind",),
        )
        if value["kind"] not in {"checkerboard", "product_mod", "cells"}:
            raise OutsideAuditScope("unsupported coloring/target family")
        if any(value.get(k, 0) not in {0, 1} for k in ("parity", "target_parity")):
            raise InvalidToolInput("checkerboard parity must be 0 or 1")
    else:
        raise InvalidToolInput("no documented field contract")


def _graph(value):
    if type(value) is not dict or not {"states", "edges", "terminal"} <= value.keys():
        raise InvalidToolInput("explicit graph schema required")
    if value.keys() - {"states", "edges", "terminal", "initial", "maximizer_states"}:
        raise OutsideAuditScope("unknown graph fields")
    states = value["states"]
    _array(states, 1, 64)
    for state in states:
        _check("variable", state)
    known = set(states)
    if len(known) != len(states) or value.get("initial", states[0]) not in known:
        raise InvalidToolInput("distinct states and valid initial state required")
    if type(value["edges"]) is not dict or type(value["terminal"]) is not dict:
        raise InvalidToolInput("edge/terminal objects required")
    for state, successors in value["edges"].items():
        _array(successors)
        if state not in known or any(
            type(s) is not str or s not in known for s in successors
        ):
            raise InvalidToolInput("edge endpoint not in explicit state set")
    for state, outcome in value["terminal"].items():
        if state not in known or type(outcome) is not int or outcome not in {-1, 0, 1}:
            raise InvalidToolInput(
                "source bridge supports strict -1/0/1 terminal values"
            )
    maximizers = value.get("maximizer_states", [])
    _array(maximizers)
    if any(type(s) is not str or s not in known for s in maximizers):
        raise InvalidToolInput("maximizer state not in graph")


def validate_inputs(name, args):
    from .output_checks import algebraic, computation

    if name in computation.CONTRACTS:
        computation.normalize(name, args)
        return {
            "version": "computation-input-v1",
            "validation": "bounded_rational_operation",
            "schema": {
                k: "see exact bounded operation contract"
                for k in sorted(computation.FIELDS[name])
            },
            "mathematical_output_verified": False,
        }

    if name in algebraic.CONTRACTS:
        algebraic.normalize(name, args)
        return {
            "version": VERSION,
            "validation": "bounded_structured_mathematical_input",
            "schema": {
                key: "see exact mathematical contract"
                for key in sorted(algebraic.FIELDS[name])
            },
            "mathematical_output_verified": False,
        }
    if name in CONTRACTS and name not in SCHEMAS:
        return {
            "version": VERSION,
            "validation": "delegated_to_independent_contract_preflight",
            "mathematical_output_verified": False,
        }
    if name not in SCHEMAS:
        raise InvalidToolInput("tool has no registered input contract")
    _object(args, SCHEMAS[name], _REGISTRY[name]["required_params"])
    if "bounds" in args and (
        len(args["bounds"]) != len(args["variables"])
        or any(a >= b for a, b in args["bounds"])
    ):
        raise InvalidToolInput("one ordered finite interval per variable")
    if "variables" in args and len(set(args["variables"])) != len(args["variables"]):
        raise InvalidToolInput("duplicate variable binding")
    if (
        "points" in args
        and "colors" in args
        and len(args["points"]) != len(args["colors"])
    ):
        raise InvalidToolInput("one color per point")
    if name == "line_through" and args["p"] == args["q"]:
        raise InvalidToolInput("two distinct line points required")
    if name == "angle_at_vertex" and (args["p"] == args["v"] or args["q"] == args["v"]):
        raise InvalidToolInput("angle arms must be nonzero")
    if "rows" in args and args["rows"] * args["cols"] > 16:
        raise OutsideAuditScope("documented finite board bound")
    if name == "hamiltonian_paths_grid":
        if args["width"] * args["height"] > 12:
            raise OutsideAuditScope(
                f"Hamiltonian grid execution bound is width*height<=12; requested "
                f"{args['width']}*{args['height']}={args['width'] * args['height']}"
            )
        if any(
            v >= args["height"]
            for k in ("start_rows", "end_rows")
            for v in args.get(k, [])
        ):
            raise InvalidToolInput("endpoint row outside grid")
    if name == "subset_gap_worst_case" and args["bound"] > 20:
        raise OutsideAuditScope("subset search bound")
    if name == "markov_expected_steps":
        matrix = args["transition"]
        n = len(matrix)
        if any(
            len(row) != n
            or any(v < 0 or v > 1 for v in row)
            or abs(sum(row) - 1) > 1e-12
            for row in matrix
        ):
            raise InvalidToolInput("finite square stochastic matrix required")
        if args["start"] >= n or any(v >= n for v in args["targets"]):
            raise InvalidToolInput("Markov state outside matrix")
    if name == "tutte_violation" and any(
        a == b or min(a, b) < 0 or max(a, b) >= args["n"] for a, b in args["edges"]
    ):
        raise InvalidToolInput("simple graph edges must fit n")
    if name == "solve_quadratic_discriminant_family" and (
        len(args["c1"]) != 2 or len(args["c0"]) != 2 or args["x_lo"] > args["x_hi"]
    ):
        raise InvalidToolInput(
            "affine coefficients and ordered integer interval required"
        )
    return {
        "version": VERSION,
        "validation": "documented_execution_input_subset",
        "schema": SCHEMAS[name],
        "omitted_arguments": "registered producer defaults, still subject to process resource caps",
        "mathematical_output_verified": False,
    }
