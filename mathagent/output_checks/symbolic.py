"""Exact rational coefficient checks, without the producer symbolic backend."""

from __future__ import annotations

import ast
import math
from fractions import Fraction as F

from .common import bound, exact, require
from .expressions import add, coefficients, polynomial, root_count, tree, trim

CONTRACTS = {
    "real_root_count_expr": (
        "distinct real roots of the original bounded rational polynomial",
        "degree<=6,coefficient numerator/denominator<=128; variable denominators refused before cancellation",
    ),
    "splitting_field_degree_expr": (
        "splitting field degree over Q of a bounded polynomial",
        "degree<=3,rational coefficients; rational-root test and discriminant square classes, not primitive-element solver",
    ),
    "solve_system_guarded_expr": (
        "complete isolated real-solution count for bounded linear or separated polynomial systems",
        "<=3 variables; full-rank affine or one univariate equation per variable,degree<=6; other coupled/parametric systems out of scope",
    ),
    "planar_laplacian_expr": (
        "polynomial Laplacian by rational coefficient differentiation",
        "<=3 variables,total degree<=8; rational polynomial AST, no variable denominator cancellation",
    ),
    "circle_laplacian_expr": (
        "second derivative in the unit-circle angle coordinate",
        "polynomials degree<=8 and rational linear combinations of sin/cos of affine arguments with coefficients<=8; no numeric identity testing",
    ),
}


def _poly(text, variables, degree=6):
    p = polynomial(text, variables)
    bound(
        all(
            sum(k) <= degree and abs(v.numerator) <= 128 and v.denominator <= 128
            for k, v in p.items()
        ),
        "rational coefficient/degree audit bound",
    )
    return p


def normalize(name, p):
    p = dict(p)
    if name in {"real_root_count_expr", "splitting_field_degree_expr"}:
        p.setdefault("variable", "x")
        poly = _poly(
            p["expression"],
            [p["variable"]],
            3 if name == "splitting_field_degree_expr" else 6,
        )
        require(bool(poly), "zero polynomial has no finite root/field-degree contract")
    elif name == "solve_system_guarded_expr":
        bound(
            len(p["variables"]) <= 3 and len(p["expressions"]) <= 6,
            "system audit size bound",
        )
        _system_count(p)
    elif name == "planar_laplacian_expr":
        bound(len(p["variables"]) <= 3, "Laplacian dimension bound")
        _poly(p["expression"], p["variables"], 8)
    elif name == "circle_laplacian_expr":
        _circle(p["expression"])
    return p


def _rref_count(polys, variables):
    n = len(variables)
    zero = (0,) * n
    matrix = [
        [p.get(tuple(int(i == j) for i in range(n)), F(0)) for j in range(n)]
        + [-p.get(zero, F(0))]
        for p in polys
    ]
    rank = 0
    for column in range(n):
        pivot = next((i for i in range(rank, len(matrix)) if matrix[i][column]), None)
        if pivot is None:
            continue
        matrix[rank], matrix[pivot] = matrix[pivot], matrix[rank]
        factor = matrix[rank][column]
        matrix[rank] = [v / factor for v in matrix[rank]]
        for i in range(len(matrix)):
            if i != rank:
                factor = matrix[i][column]
                matrix[i] = [a - factor * b for a, b in zip(matrix[i], matrix[rank])]
        rank += 1
    if any(not any(row[:-1]) and row[-1] for row in matrix):
        return 0
    bound(rank == n, "parametric linear system outside isolated-solution scope")
    return 1


def _system_count(p):
    variables = p["variables"]
    polys = [_poly(e, variables) for e in p["expressions"]]
    if all(all(sum(k) <= 1 for k in poly) for poly in polys):
        return _rref_count(polys, variables)
    bound(
        len(polys) == len(variables),
        "separated system requires one equation per variable",
    )
    occupied = set()
    total = 1
    for poly in polys:
        used = {i for k in poly for i, v in enumerate(k) if v}
        bound(
            len(used) == 1 and not occupied & used,
            "coupled or repeated variable in separated system",
        )
        i = next(iter(used))
        occupied.add(i)
        total *= root_count(coefficients({(k[i],): v for k, v in poly.items()}))
    return total


def _square(q):
    return (
        q >= 0
        and math.isqrt(q.numerator) ** 2 == q.numerator
        and math.isqrt(q.denominator) ** 2 == q.denominator
    )


def _field_degree(p):
    p = trim(p)
    if len(p) <= 2:
        return 1
    if len(p) == 3:
        c, b, a = p
        return 1 if _square(b * b - 4 * a * c) else 2
    scale = math.lcm(*(v.denominator for v in p))
    ints = [int(v * scale) for v in p]
    g = math.gcd(*ints)
    ints = [v // g for v in ints]
    bound(max(map(abs, ints)) <= 100000, "rational-root divisor enumeration bound")

    def divisors(n):
        return {
            d
            for k in range(1, math.isqrt(abs(n)) + 1)
            if n % k == 0
            for d in (k, abs(n) // k)
        }

    roots = (
        {F(0)}
        if ints[0] == 0
        else {
            F(sign * a, b)
            for a in divisors(ints[0])
            for b in divisors(ints[-1])
            for sign in (-1, 1)
        }
    )
    for r in roots:
        if sum(v * r**i for i, v in enumerate(p)) == 0:
            quotient = [p[-1]]
            for v in p[-2:0:-1]:
                quotient.append(v + r * quotient[-1])
            return _field_degree(list(reversed(quotient)))
    d, c, b, a = p
    disc = (
        b * b * c * c
        - 4 * a * c**3
        - 4 * b**3 * d
        - 27 * a * a * d * d
        + 18 * a * b * c * d
    )
    return 3 if _square(disc) else 6


def _circle(text):
    """Canonical polynomial/Fourier atoms; arithmetic only, no CAS diff."""

    def scalar(p):
        return p.get(("p", 0), F(0)) if p.keys() <= {("p", 0)} else None

    def scaled(p, s):
        return {k: v * s for k, v in p.items() if v * s}

    def visit(n):
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Add, ast.Sub)):
            a, b = visit(n.left), visit(n.right)
            return add(a, scaled(b, -1 if isinstance(n.op, ast.Sub) else 1))
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            return scaled(visit(n.operand), -1 if isinstance(n.op, ast.USub) else 1)
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id in {"sin", "cos"}
            and len(n.args) == 1
            and not n.keywords
        ):
            p = _poly(ast.unparse(n.args[0]), ["theta"], 1)
            slope, shift = p.get((1,), F(0)), p.get((0,), F(0))
            bound(
                abs(slope) <= 8 and abs(shift) <= 8, "Fourier affine coefficient bound"
            )
            sign = 1
            if slope < 0 or slope == 0 and shift < 0:
                slope, shift = -slope, -shift
                if n.func.id == "sin":
                    sign = -1
            return {(n.func.id, slope, shift): F(sign)}
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Mult, ast.Div)):
            a, b = visit(n.left), visit(n.right)
            if isinstance(n.op, ast.Div):
                s = scalar(b)
                bound(s is not None, "nonconstant divisor outside circle scope")
                require(s != 0, "undefined division")
                return scaled(a, 1 / s)
            if scalar(a) is not None:
                return scaled(b, scalar(a))
            if scalar(b) is not None:
                return scaled(a, scalar(b))
        p = _poly(ast.unparse(n), ["theta"], 8)
        return {("p", k[0]): v for k, v in p.items()}

    return visit(tree(text))


def check(name, p, result):
    if name == "real_root_count_expr":
        return exact(
            result, root_count(coefficients(_poly(p["expression"], [p["variable"]])))
        )
    if name == "splitting_field_degree_expr":
        return exact(
            result,
            _field_degree(coefficients(_poly(p["expression"], [p["variable"]], 3))),
        )
    if name == "solve_system_guarded_expr":
        return exact(result, _system_count(p))
    if type(result) is not str:
        return False
    if name == "planar_laplacian_expr":
        expected = {}
        for key, v in _poly(p["expression"], p["variables"], 8).items():
            for i, power in enumerate(key):
                if power >= 2:
                    k = tuple(x - 2 if j == i else x for j, x in enumerate(key))
                    expected[k] = expected.get(k, F(0)) + v * power * (power - 1)
        return polynomial(result, p["variables"]) == {
            k: v for k, v in expected.items() if v
        }
    if name == "circle_laplacian_expr":
        expected = {}
        for key, v in _circle(p["expression"]).items():
            if key[0] == "p":
                if key[1] >= 2:
                    expected[("p", key[1] - 2)] = v * key[1] * (key[1] - 1)
            elif key[1]:
                expected[key] = -v * key[1] ** 2
        return _circle(result) == expected
    raise ValueError("unknown symbolic checker")
