"""Exact, bounded data-fit checks shared by the registered tool executor.

Both tools keep every numeric intermediate as ``fractions.Fraction``.  They
consume only explicit JSON data and a claimed expression/coefficient pair; the
result is a data-relative observation, never a claim about the intent of the
original problem.

The public ``interpolation_fit_check`` and ``stats_ols_check`` functions return
the repository's ``math_families.core.evidence.Evidence`` contract.  The small
``normalize_*``/``*_payload`` helpers are also used by the independent output
audit in ``tool_contracts`` so producer and checker share syntax, not trust.
"""

from __future__ import annotations

import ast
import json
import re
from fractions import Fraction

from math_families.core.evidence import Evidence

from .output_checks.algebraic import poly as exact_polynomial
from .output_checks.common import bound, require
from .output_checks.expressions import tree
from .finite_group_tools import finite_group_structure

INTERPOLATION_SCHEMA = "interpolation-fit-check-v1"
OLS_SCHEMA = "stats-ols-check-v1"
INTERPOLATION_OPERATION = "INTERPOLATION_FIT"
OLS_OPERATION = "OLS_CHECK"

MIN_INTERPOLATION_POINTS = 2
MAX_INTERPOLATION_POINTS = 8
MIN_OLS_PAIRS = 3
MAX_OLS_PAIRS = 12
MAX_RATIONAL_TEXT = 160
MAX_RATIONAL_MAGNITUDE = 10**6
MAX_EXPRESSION_TEXT = 500
_MAX_EXPRESSION_NODES = 128
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,15}")
_RATIONAL_TEXT = re.compile(r"-?(?:0|[1-9][0-9]*)(?:/[1-9][0-9]*)?")

TOOL_SIGNATURES = {
    "interpolation_fit_check": ("points", "expression", "variable"),
    "stats_ols_check": ("data", "claimed"),
}


def _exact_rational(value, label):
    require(
        type(value) is str and 1 <= len(value) <= MAX_RATIONAL_TEXT,
        f"{label}: exact rational string required; no implicit numeric coercion",
    )
    require(
        _RATIONAL_TEXT.fullmatch(value) is not None,
        f"{label}: canonical exact rational string required (integer or a/b)",
    )
    try:
        result = Fraction(value)
    except (ValueError, ZeroDivisionError):
        require(False, f"{label}: invalid exact rational")
    bound(
        abs(result.numerator) <= MAX_RATIONAL_MAGNITUDE
        and result.denominator <= MAX_RATIONAL_MAGNITUDE,
        f"{label}: rational magnitude bound |numerator|,denominator <= 10^6",
    )
    return result


def _exact_text(value):
    return str(value)


def _point(value, label):
    require(type(value) is dict, f"{label}: object with exact x and y strings required")
    require(set(value) == {"x", "y"}, f"{label}: exactly x and y fields required")
    return (
        _exact_rational(value["x"], f"{label}.x"),
        _exact_rational(value["y"], f"{label}.y"),
    )


def _exact_points(value, *, minimum, maximum, label, distinct_x=True):
    require(type(value) is list, f"{label}: JSON array required")
    require(len(value) >= minimum, f"{label}: at least {minimum} points required")
    bound(len(value) <= maximum, f"{label}: at most {maximum} points")
    points = [_point(item, f"{label}[{index}]") for index, item in enumerate(value)]
    if distinct_x:
        require(
            len({x for x, _ in points}) == len(points),
            f"{label}: distinct x values required for interpolation",
        )
    return points


def _expression_data(text, variable):
    require(
        type(text) is str and 1 <= len(text) <= MAX_EXPRESSION_TEXT,
        "expression: bounded expression string required",
    )
    require(
        type(variable) is str and _IDENTIFIER.fullmatch(variable) is not None,
        "variable: one bounded identifier required",
    )
    source = text.replace("^", "**")
    node = tree(source)
    bound(
        len(list(ast.walk(node))) <= _MAX_EXPRESSION_NODES,
        "expression AST node bound",
    )
    call_names = set()
    for item in ast.walk(node):
        if isinstance(item, ast.Call):
            require(
                isinstance(item.func, ast.Name)
                and item.func.id in {"Rational", "Integer"}
                and not item.keywords,
                "expression: only exact Rational/Integer constructors are supported",
            )
            call_names.add(id(item.func))
        if isinstance(item, ast.Constant):
            require(
                type(item.value) is int,
                "expression: integer literals or explicit rational fractions only",
            )
    for item in ast.walk(node):
        if isinstance(item, ast.Name) and id(item) not in call_names:
            require(
                item.id == variable,
                "expression: exactly one declared variable is allowed",
            )
    expression = exact_polynomial(source, [variable])
    coefficients = [
        expression.get((power,), Fraction(0))
        for power in range(max((key[0] for key in expression), default=0) + 1)
    ]
    while len(coefficients) > 1 and coefficients[-1] == 0:
        coefficients.pop()
    return coefficients


def _poly_value(coefficients, value):
    result = Fraction(0)
    for coefficient in reversed(coefficients):
        result = result * value + coefficient
    return result


def _format_polynomial(coefficients, variable):
    coefficients = list(coefficients)
    while len(coefficients) > 1 and coefficients[-1] == 0:
        coefficients.pop()
    terms = []
    for power in range(len(coefficients) - 1, -1, -1):
        coefficient = coefficients[power]
        if not coefficient:
            continue
        sign = "-" if coefficient < 0 else "+"
        magnitude = abs(coefficient)
        if power == 0:
            body = str(magnitude)
        else:
            coefficient_text = "" if magnitude == 1 else f"{magnitude}*"
            power_text = variable if power == 1 else f"{variable}**{power}"
            body = coefficient_text + power_text
        terms.append((sign, body))
    if not terms:
        return "0"
    first_sign, first_body = terms[0]
    rendered = ("-" if first_sign == "-" else "") + first_body
    for sign, body in terms[1:]:
        rendered += f" {sign} {body}"
    return rendered


def _interpolating_coefficients(xs, ys):
    # Newton divided differences, evaluated in exact rational arithmetic.
    divided = list(ys)
    for order in range(1, len(xs)):
        for index in range(len(xs) - 1, order - 1, -1):
            divided[index] = (divided[index] - divided[index - 1]) / (
                xs[index] - xs[index - order]
            )
    # Horner form of c0 + c1(x-x0) + ...; multiply by (x - x_k).
    result = [divided[-1]]
    for index in range(len(xs) - 2, -1, -1):
        multiplied = [Fraction(0)] * (len(result) + 1)
        for power, coefficient in enumerate(result):
            multiplied[power] -= coefficient * xs[index]
            multiplied[power + 1] += coefficient
        multiplied[0] += divided[index]
        result = multiplied
    while len(result) > 1 and result[-1] == 0:
        result.pop()
    return result


def normalize_interpolation(args):
    require(type(args) is dict, "interpolation arguments must be an object")
    require(
        set(args) == {"points", "expression", "variable"},
        "interpolation arguments must be exactly points, expression and variable",
    )
    points = _exact_points(
        args["points"],
        minimum=MIN_INTERPOLATION_POINTS,
        maximum=MAX_INTERPOLATION_POINTS,
        label="points",
    )
    coefficients = _expression_data(args["expression"], args["variable"])
    degree = len(coefficients) - 1
    bound(
        degree <= len(points) - 1,
        "expression: degree exceeds the n-1 interpolation bound",
    )
    return {
        "points": [[_exact_text(x), _exact_text(y)] for x, y in points],
        "expression": args["expression"].replace("^", "**"),
        "variable": args["variable"],
        "degree": degree,
    }


def interpolation_payload(normalized):
    points = [
        (Fraction(x), Fraction(y)) for x, y in normalized["points"]
    ]
    variable = normalized["variable"]
    coefficients = _expression_data(normalized["expression"], variable)
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    residuals = [_poly_value(coefficients, x) - y for x, y in points]
    interpolating = _interpolating_coefficients(xs, ys)
    return {
        "schema": INTERPOLATION_SCHEMA,
        "operation": INTERPOLATION_OPERATION,
        "variable": variable,
        "point_count": len(points),
        "residuals": [_exact_text(value) for value in residuals],
        "all_zero": all(value == 0 for value in residuals),
        "degree": len(coefficients) - 1,
        "interpolating_polynomial": _format_polynomial(interpolating, variable),
    }


def interpolation_fit_check(points, expression, variable):
    normalized = normalize_interpolation(
        {"points": points, "expression": expression, "variable": variable}
    )
    payload = interpolation_payload(normalized)
    return Evidence(
        value=payload,
        certificate=json.dumps(
            {
                "residuals": payload["residuals"],
                "interpolating_polynomial": payload["interpolating_polynomial"],
                "method": "exact Fraction evaluation with Newton divided differences",
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        self_check=(
            "self_check: fractions.Fraction residual evaluation and exact "
            "Newton/Lagrange interpolation; all-zero residual list and the "
            "interpolating polynomial are reported without float conversion"
        ),
        feasibility="ok",
        complexity_bound="O(n^2) exact Fraction operations for 2 <= n <= 8",
    )


def normalize_ols(args):
    require(type(args) is dict, "OLS arguments must be an object")
    require("data" in args, "OLS data array required")
    require(
        set(args) <= {"data", "claimed"},
        "OLS arguments may contain only data and optional claimed",
    )
    pairs = _exact_points(
        args["data"],
        minimum=MIN_OLS_PAIRS,
        maximum=MAX_OLS_PAIRS,
        label="data",
        distinct_x=False,
    )
    xs = [x for x, _ in pairs]
    require(
        any(x != xs[0] for x in xs),
        "degenerate OLS: all x values equal; no finite slope",
    )
    claimed = args.get("claimed")
    if claimed is not None:
        require(type(claimed) is dict, "claimed: object required")
        require(
            set(claimed) == {"slope", "intercept"},
            "claimed: exactly slope and intercept fields required",
        )
        claimed = {
            "slope": _exact_text(
                _exact_rational(claimed["slope"], "claimed.slope")
            ),
            "intercept": _exact_text(
                _exact_rational(claimed["intercept"], "claimed.intercept")
            ),
        }
    return {
        "data": [[_exact_text(x), _exact_text(y)] for x, y in pairs],
        "claimed": claimed,
    }


def ols_payload(normalized):
    pairs = [(Fraction(x), Fraction(y)) for x, y in normalized["data"]]
    xs = [x for x, _ in pairs]
    ys = [y for _, y in pairs]
    n = len(pairs)
    mean_x = sum(xs, Fraction(0)) / n
    mean_y = sum(ys, Fraction(0)) / n
    sxx = sum(((x - mean_x) ** 2 for x in xs), Fraction(0))
    sxy = sum(
        ((x - mean_x) * (y - mean_y) for x, y in pairs), Fraction(0)
    )
    require(sxx != 0, "degenerate OLS: no variation in x")
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    residuals = [y - (slope * x + intercept) for x, y in pairs]
    sse = sum((value**2 for value in residuals), Fraction(0))
    sst = sum(((y - mean_y) ** 2 for y in ys), Fraction(0))
    r_squared = Fraction(1) if sst == 0 else Fraction(1) - sse / sst
    claimed = normalized.get("claimed")
    if claimed is None:
        claim_matches = None
    else:
        claim_matches = (
            slope == Fraction(claimed["slope"])
            and intercept == Fraction(claimed["intercept"])
        )
    return {
        "schema": OLS_SCHEMA,
        "operation": OLS_OPERATION,
        "n": n,
        "slope": _exact_text(slope),
        "intercept": _exact_text(intercept),
        "sse": _exact_text(sse),
        "sst": _exact_text(sst),
        "r_squared": _exact_text(r_squared),
        "claim_matches": claim_matches,
        "residuals": [_exact_text(value) for value in residuals],
    }


def stats_ols_check(data, claimed=None):
    normalized = normalize_ols({"data": data, "claimed": claimed})
    payload = ols_payload(normalized)
    return Evidence(
        value=payload,
        certificate=json.dumps(
            {
                "residuals": payload["residuals"],
                "sse": payload["sse"],
                "sst": payload["sst"],
                "method": "exact Fraction closed-form OLS",
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        self_check=(
            "self_check: fractions.Fraction closed-form ordinary least squares "
            "(slope=Sxy/Sxx, intercept=ybar-slope*xbar); residuals, SSE, SST "
            "and R^2 are exact rationals with no float conversion"
        ),
        feasibility="ok",
        complexity_bound="O(n) exact Fraction operations for 3 <= n <= 12",
    )


TOOL_FUNCTIONS = {
    "interpolation_fit_check": interpolation_fit_check,
    "stats_ols_check": stats_ols_check,
    "finite_group_structure": finite_group_structure,
}


def call_tool(name, args):
    """Execute one new exact tool and return the bridge's ToolEvidence shape."""
    from math_families.bridge.evidence_bridge import to_tool_evidence_dict

    evidence = TOOL_FUNCTIONS[name](**args)
    return to_tool_evidence_dict(evidence, method=name)
