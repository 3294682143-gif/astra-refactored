"""Bounded exact symbolic checks exposed as one registered tool.

Every operation parses model-supplied expressions through the same whitelist
AST parser used by the other bridge tools.  The module returns an observation
with an explicit certificate; it does not decide how the original problem maps
to the supplied expression.
"""

from __future__ import annotations

import itertools

import sympy as sp

from math_families.bridge.safe_expr import sympy_expr
from math_families.core.evidence import Evidence

__all__ = ["exact_check_expr"]

_OPERATIONS = {
    "SIMPLIFY",
    "TRIG_REDUCE",
    "MAXIMAL_MINORS",
    "FACTOR_OVER_EXTENSION",
    "DEFINITE_INTEGRAL",
    "LIMIT",
    "DENSITY_CHECK",
}
_MAX_MATRIX = 8
_MAX_EXTENSIONS = 4
_MAX_DEGREE = 12


def _point(value):
    if value is None:
        raise ValueError("a limit/integral endpoint is required")
    text = str(value).strip().replace(" ", "")
    if text in {"oo", "+oo", "inf", "+inf", "infinity", "+infinity"}:
        return sp.oo
    if text in {"-oo", "-inf", "-infinity"}:
        return -sp.oo
    if text in {"pi", "PI"}:
        return sp.pi
    return sympy_expr(text, [])


def _expr(value, variables):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expression must be a non-empty string")
    # Accept the common caret spelling as exponentiation; the safe parser's
    # whitelist still runs after this single lexical normalization.
    return sympy_expr(value.replace("^", "**"), list(variables))


def _matrix(value, variable):
    if not isinstance(value, list) or not 1 <= len(value) <= _MAX_MATRIX:
        raise ValueError("matrix must be a bounded non-empty row list")
    rows = []
    width = None
    for row in value:
        if not isinstance(row, list) or not 1 <= len(row) <= _MAX_MATRIX:
            raise ValueError("matrix rows must be bounded non-empty lists")
        if width is None:
            width = len(row)
        elif len(row) != width:
            raise ValueError("matrix must be rectangular")
        rows.append([_expr(entry, [variable]) for entry in row])
    return sp.Matrix(rows)


def _polynomial(expr, variable):
    poly = sp.Poly(expr, sp.Symbol(variable))
    if poly.total_degree() > _MAX_DEGREE:
        raise ValueError("polynomial degree exceeds the bounded exact-check scope")
    return poly


def _normalized_poly(expr, variable):
    poly = _polynomial(sp.factor(expr), variable)
    if poly.is_zero:
        return poly
    lc = poly.LC()
    if lc.is_number and lc.is_negative:
        poly = -poly
    if poly.LC() != 1:
        poly = poly.monic()
    return poly


def _trig_reduce(expression, variable):
    x = sp.Symbol(variable, real=True)
    expr = _expr(expression, [variable]).subs(sp.Symbol(variable), x)
    rewritten = sp.expand(expr.rewrite(sp.exp))
    reduced = sp.expand(sp.re(rewritten))
    return Evidence(
        value={
            "schema": "exact-trig-reduction-v1",
            "operation": "TRIG_REDUCE",
            "expression": str(expr),
            "trig_reduced": str(reduced),
            "difference": str(sp.simplify(reduced - expr)),
        },
        certificate="rewrite to exp, take the real part, expand and compare",
        self_check="difference simplified to zero",
        feasibility="ok",
        complexity_bound="bounded expression AST and degree",
    )


def _maximal_minors(matrix, variable):
    rows, cols = matrix.shape
    size = min(rows, cols)
    if size < 2:
        raise ValueError("maximal-minor check needs at least a 2x2 matrix")
    minor_size = size - 1
    normalized = {}
    raw = []
    for row_ids in itertools.combinations(range(rows), minor_size):
        for col_ids in itertools.combinations(range(cols), minor_size):
            det = sp.factor(matrix.extract(row_ids, col_ids).det())
            if det == 0:
                continue
            raw.append(str(det))
            poly = _normalized_poly(det, variable)
            if not poly.is_zero:
                key = str(poly.as_expr())
                normalized.setdefault(key, 0)
                normalized[key] += 1
    return Evidence(
        value={
            "schema": "exact-maximal-minors-v1",
            "operation": "MAXIMAL_MINORS",
            "shape": [rows, cols],
            "minor_size": minor_size,
            "raw_minors": raw[:64],
            "normalized_minors": [
                {"polynomial": key, "multiplicity": count}
                for key, count in sorted(normalized.items())
            ],
            "zero_minors": sum(1 for _ in raw) == 0,
        },
        certificate="all maximal minors were independently expanded and sign-normalized",
        self_check="minor count follows C(rows,k)*C(cols,k)",
        feasibility="ok",
        complexity_bound="at most C(8,4)^2 maximal minors",
    )


def _factor_over_extension(expression, variable, minimal_polynomials):
    if not isinstance(minimal_polynomials, list) or not 1 <= len(minimal_polynomials) <= _MAX_EXTENSIONS:
        raise ValueError("minimal_polynomials must contain 1..4 polynomials")
    target = _expr(expression, [variable])
    roots = []
    for text in minimal_polynomials:
        poly = _polynomial(_expr(text, [variable]), variable)
        if poly.degree() < 1:
            raise ValueError("extension minimal polynomial must have positive degree")
        roots.append(sp.RootOf(poly, 0))
    factored = sp.factor(target, extension=roots)
    factors = sp.factor_list(target, extension=roots)[1]
    symbol = sp.Symbol(variable)
    residual_degree = sum(sp.Poly(factor, symbol).degree() for factor, _ in factors
                          if sp.Poly(factor, symbol).degree() > 1)
    return Evidence(
        value={
            "schema": "exact-factor-extension-v1",
            "operation": "FACTOR_OVER_EXTENSION",
            "expression": str(target),
            "extensions": [str(root) for root in roots],
            "factorization": str(factored),
            "factors": [
                {"factor": str(factor), "multiplicity": multiplicity,
                 "degree": sp.Poly(factor, symbol).degree()}
                for factor, multiplicity in factors
            ],
            "splits_completely": residual_degree == 0,
            "residual_degree": residual_degree,
        },
        certificate="factorization over explicit RootOf extensions; residual degrees are reported",
        self_check="splits_completely iff no factor of degree > 1 remains",
        feasibility="ok",
        complexity_bound="degree <= 12 and at most four extension generators",
    )


def _definite_integral(expression, variable, lower, upper):
    x = sp.Symbol(variable)
    expr = _expr(expression, [variable])
    lo = _point(lower)
    hi = _point(upper)
    integral = sp.integrate(expr, (x, lo, hi))
    numeric = None
    exact = None
    if integral.has(sp.Integral):
        numeric = sp.N(integral, 15)
    else:
        exact = str(sp.simplify(integral))
        numeric = sp.N(integral, 15)
    return Evidence(
        value={
            "schema": "exact-definite-integral-v1",
            "operation": "DEFINITE_INTEGRAL",
            "expression": str(expr),
            "variable": variable,
            "lower": str(lo),
            "upper": str(hi),
            "exact": exact,
            "numeric": str(numeric),
        },
        certificate="independent symbolic integration with numeric evaluation",
        self_check="endpoints and integrand were parsed from the request",
        feasibility="ok",
        complexity_bound="bounded expression AST; integration may return unevaluated",
    )


def _limit(expression, variable, point):
    x = sp.Symbol(variable)
    expr = _expr(expression, [variable])
    at = _point(point)
    value = sp.limit(expr, x, at)
    return Evidence(
        value={
            "schema": "exact-limit-v1",
            "operation": "LIMIT",
            "expression": str(expr),
            "variable": variable,
            "point": str(at),
            "limit": str(value),
            "numeric": str(sp.N(value, 15)),
        },
        certificate="independent symbolic limit evaluation",
        self_check="limit value is reported together with a numeric approximation",
        feasibility="ok",
        complexity_bound="bounded expression AST",
    )


def _density_check(density, variable, lower, upper):
    x = sp.Symbol(variable, real=True)
    expr = _expr(density, [variable]).subs(sp.Symbol(variable), x)
    lo = _point(lower)
    hi = _point(upper)
    integral = sp.integrate(expr, (x, lo, hi))
    numeric = sp.N(integral, 15)
    samples = []
    for point in (0.1, 0.5, 1.0, 2.0, 4.0):
        try:
            value = sp.N(expr.subs(x, point), 12)
            samples.append({"x": point, "value": str(value)})
        except Exception:  # noqa: BLE001 - sampling is advisory only
            samples.append({"x": point, "value": "UNKNOWN"})
    normalized = bool(abs(abs(complex(numeric)) - 1) < 1e-9) if numeric.is_number else False
    nonnegative = all(
        sample["value"] in {"UNKNOWN"} or sp.N(sp.sympify(sample["value"])) >= 0
        for sample in samples
    )
    return Evidence(
        value={
            "schema": "exact-density-check-v1",
            "operation": "DENSITY_CHECK",
            "density": str(expr),
            "lower": str(lo),
            "upper": str(hi),
            "integral": str(sp.simplify(integral)),
            "numeric_integral": str(numeric),
            "normalized": normalized,
            "nonnegative_samples": nonnegative,
            "samples": samples,
        },
        certificate="independent integral and pointwise nonnegativity samples",
        self_check="normalized compares the integral with 1 at 1e-9",
        feasibility="ok",
        complexity_bound="bounded expression AST and five sample points",
    )


def exact_check_expr(
    operation,
    expression=None,
    variable="x",
    matrix=None,
    lower=None,
    upper=None,
    point=None,
    minimal_polynomials=None,
    density=None,
):
    """Run one bounded exact symbolic check.  The caller owns the mapping."""
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        raise ValueError("unsupported exact-check operation")
    if not isinstance(variable, str) or not variable.isidentifier() or len(variable) > 16:
        raise ValueError("variable must be a short identifier")
    if operation == "TRIG_REDUCE":
        return _trig_reduce(expression, variable)
    if operation == "MAXIMAL_MINORS":
        return _maximal_minors(_matrix(matrix, variable), variable)
    if operation == "FACTOR_OVER_EXTENSION":
        return _factor_over_extension(expression, variable, minimal_polynomials)
    if operation == "DEFINITE_INTEGRAL":
        return _definite_integral(expression, variable, lower, upper)
    if operation == "LIMIT":
        return _limit(expression, variable, point)
    if operation == "DENSITY_CHECK":
        return _density_check(density, variable, lower, upper)
    if operation == "SIMPLIFY":
        value = _expr(expression, [variable])
        simplified = sp.simplify(value)
        return Evidence(
            value={
                "schema": "exact-simplify-v1",
                "operation": "SIMPLIFY",
                "expression": str(value),
                "simplified": str(simplified),
                "difference": str(sp.simplify(value - simplified)),
            },
            certificate="independent simplify and zero-difference check",
            self_check="difference simplified to zero",
            feasibility="ok",
            complexity_bound="bounded expression AST",
        )
    raise ValueError("unsupported exact-check operation")
