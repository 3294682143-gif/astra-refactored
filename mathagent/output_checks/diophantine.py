"""Direct integer enumeration under proved Cauchy/positive-definite bounds."""

from __future__ import annotations

import math
from fractions import Fraction as F

from .common import bound, exact, require
from .expressions import add, polynomial

CONTRACTS = {
    "solve_quadratic_diophantine": (
        "complete integer solution pairs in the certified global or explicit-y domain",
        "a!=0,coefficients<=32; definite ellipse global box<=128, otherwise |y|<=32 and <=250000 Cauchy-bounded x checks",
    ),
    "solve_quadratic_discriminant_family": (
        "all integer pairs for the explicit x interval",
        "c2!=0,affine coefficients<=32,x interval within[-32,32],<=250000 direct y checks; independent of square-discriminant producer",
    ),
    "symbolic_diophantine_with_timeout": (
        "complete finite integer solution set of the original positive/negative definite quadratic",
        "two variables,integer coefficients<=32,proved global box<=128; parametric/Pell and rational-domain simplification outside scope",
    ),
}


def _coefficients(p):
    variables = p.get("variables", ["x", "y"])
    bound(len(variables) == 2, "two-variable finite Diophantine scope")
    left = polynomial(p["lhs"], variables)
    right = polynomial(p.get("rhs", "0"), variables)
    poly = add(left, {k: -v for k, v in right.items()})
    require(
        all(v.denominator == 1 for v in poly.values()),
        "integer polynomial coefficients required",
    )
    bound(all(sum(k) <= 2 for k in poly), "quadratic Diophantine scope")
    return [
        int(poly.get(k, 0)) for k in ((2, 0), (1, 1), (0, 2), (1, 0), (0, 1), (0, 0))
    ]


def _definite_box(coeffs):
    a, b, c, d, e, f = coeffs
    if a < 0:
        a, b, c, d, e, f = (-x for x in coeffs)
    if not (a > 0 and c > 0 and 4 * a * c - b * b > 0):
        return None
    delta = 4 * a * c - b * b
    x0, y0 = F(b * e - 2 * c * d, delta), F(b * d - 2 * a * e, delta)
    radius2 = -(a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + d * x0 + e * y0 + f)
    if radius2 < 0:
        return -1
    # lambda_min >= determinant/trace for a positive definite 2x2 form.
    distance2 = radius2 * F(4 * (a + c), delta)
    radius = math.isqrt(distance2.numerator // distance2.denominator)
    if radius * radius < distance2:
        radius += 1
    size = math.ceil(max(abs(x0), abs(y0))) + radius
    bound(size <= 128, "proved global integer enumeration box bound")
    return size


def _quadratic_values(coeffs, y_bound=None):
    a, b, c, d, e, f = coeffs
    size = _definite_box(coeffs)
    if size is not None:
        return (
            [
                [x, y]
                for x in range(-size, size + 1)
                for y in range(-size, size + 1)
                if a * x * x + b * x * y + c * y * y + d * x + e * y + f == 0
            ]
            if size >= 0
            else []
        )
    bound(
        y_bound is not None and y_bound <= 32, "nondefinite form needs explicit |y|<=32"
    )
    bounds = [
        (y, 1 + math.ceil(F(max(abs(b * y + d), abs(c * y * y + e * y + f)), abs(a))))
        for y in range(-y_bound, y_bound + 1)
    ]
    bound(
        sum(2 * m + 1 for _, m in bounds) <= 250000,
        "Cauchy root enumeration work bound",
    )
    return sorted(
        [x, y]
        for y, m in bounds
        for x in range(-m, m + 1)
        if a * x * x + b * x * y + c * y * y + d * x + e * y + f == 0
    )


def _family_values(p):
    rows = []
    for x in range(p["x_lo"], p["x_hi"] + 1):
        linear = p["c1"][0] + p["c1"][1] * x
        constant = p["c0"][0] + p["c0"][1] * x
        size = 1 + math.ceil(F(max(abs(linear), abs(constant)), abs(p["c2"])))
        rows.append((x, linear, constant, size))
    bound(
        sum(2 * row[3] + 1 for row in rows) <= 250000, "family enumeration work bound"
    )
    return [
        [x, y]
        for x, b, c, m in rows
        for y in range(-m, m + 1)
        if p["c2"] * y * y + b * y + c == 0
    ]


def normalize(name, p):
    p = dict(p)
    if name == "solve_quadratic_discriminant_family":
        require(p["c2"] != 0, "nonzero quadratic coefficient required")
        bound(
            all(
                abs(v) <= 32
                for v in [p["c2"], *p["c1"], *p["c0"], p["x_lo"], p["x_hi"]]
            ),
            "family coefficient/interval bound",
        )
        _family_values(p)
    else:
        coeffs = (
            _coefficients(p)
            if name == "symbolic_diophantine_with_timeout"
            else [p[k] for k in "abcdef"]
        )
        bound(all(abs(v) <= 32 for v in coeffs), "quadratic coefficient bound")
        bound(coeffs[0] != 0, "a!=0 required for finite enumeration checker")
        if name == "symbolic_diophantine_with_timeout":
            bound(
                _definite_box(coeffs) is not None,
                "symbolic output contract requires a definite finite form",
            )
        _quadratic_values(coeffs, p.get("y_bound"))
    return p


def check(name, p, result):
    if name == "solve_quadratic_discriminant_family":
        return exact(result, _family_values(p))
    coeffs = (
        _coefficients(p)
        if name == "symbolic_diophantine_with_timeout"
        else [p[k] for k in "abcdef"]
    )
    expected = _quadratic_values(coeffs, p.get("y_bound"))
    if name == "symbolic_diophantine_with_timeout":
        expected = sorted([[str(x), str(y)] for x, y in expected])
    return exact(result, expected)
