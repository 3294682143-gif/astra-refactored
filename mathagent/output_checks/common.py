"""Small, bounded checker primitives, independent of the producer backend."""

from __future__ import annotations

import ast
import math
from fractions import Fraction


def require(condition, detail):
    from ..tool_contracts import InvalidToolInput

    if not condition:
        raise InvalidToolInput(detail)


def bound(condition, detail):
    from ..tool_contracts import OutsideAuditScope

    if not condition:
        raise OutsideAuditScope(detail)


def exact(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return actual.keys() == expected.keys() and all(
            exact(actual[k], v) for k, v in expected.items()
        )
    if type(expected) is list:
        return len(actual) == len(expected) and all(map(exact, actual, expected))
    return actual == expected


def number(value):
    return type(value) in {int, float} and math.isfinite(value)


def near(actual, expected, *, atol=1e-9, rtol=1e-9):
    return (
        number(actual)
        and math.isfinite(expected)
        and math.isclose(actual, expected, abs_tol=atol, rel_tol=rtol)
    )


def fraction(value):
    return Fraction(str(value))


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(p, a, b):
    return cross(a, b, p) == 0 and all(
        min(a[i], b[i]) <= p[i] <= max(a[i], b[i]) for i in (0, 1)
    )


def simple_polygon(vertices, *, integral=False):
    require(
        3 <= len(vertices) and len(set(map(tuple, vertices))) == len(vertices),
        "polygon needs distinct vertices",
    )
    bound(
        len(vertices) <= 12 and all(abs(v) <= 32 for p in vertices for v in p),
        "polygon checker: <=12 vertices, coordinates in [-32,32]",
    )
    if integral:
        require(
            all(type(v) is int for p in vertices for v in p),
            "lattice coordinates must be integers; no bridge truncation",
        )
    pts = [tuple(map(fraction, p)) for p in vertices]
    edges = list(zip(pts, pts[1:] + pts[:1]))
    require(sum(a[0] * b[1] - a[1] * b[0] for a, b in edges) != 0, "zero polygon area")
    for i, (a, b) in enumerate(edges):
        for j, (c, d) in enumerate(edges):
            if j <= i or (j - i) in {1, len(pts) - 1}:
                continue
            intersects = (
                cross(a, b, c) * cross(a, b, d) < 0
                and cross(c, d, a) * cross(c, d, b) < 0
            )
            intersects |= any(
                (
                    on_segment(c, a, b),
                    on_segment(d, a, b),
                    on_segment(a, c, d),
                    on_segment(b, c, d),
                )
            )
            require(not intersects, "polygon must be simple")
    # Adjacent collinear edges may continue but must not double back.
    for i, p in enumerate(pts):
        a, b = pts[i - 1], pts[(i + 1) % len(pts)]
        require(
            not (cross(a, p, b) == 0 and (on_segment(b, a, p) or on_segment(a, p, b))),
            "overlapping adjacent polygon edges",
        )
    return pts


def point_location(p, vertices):
    """Return boundary=0, inside=1, outside=-1 by rational ray crossings."""
    inside = False
    for a, b in zip(vertices, vertices[1:] + vertices[:1]):
        if on_segment(p, a, b):
            return 0
        if (a[1] > p[1]) != (b[1] > p[1]):
            x = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if x > p[0]:
                inside = not inside
    return 1 if inside else -1


def certificate_data(certificate, prefix, suffix=None):
    """Read only bounded data literals, including source Fraction repr; never eval."""
    require(
        type(certificate) is dict and type(certificate.get("certificate")) is str,
        "missing structured producer witness",
    )
    text = certificate["certificate"]
    bound(len(text) <= 32768, "witness text bound")
    require(text.startswith(prefix), "missing expected witness field")
    text = text[len(prefix) :]
    if suffix:
        require(suffix in text, "missing witness delimiter")
        text = text.split(suffix, 1)[0]
    node = ast.parse(text, mode="eval").body
    bound(len(list(ast.walk(node))) <= 4096, "witness literal node bound")

    def visit(n):
        if isinstance(n, (ast.List, ast.Tuple)):
            return [visit(x) for x in n.elts]
        if isinstance(n, ast.Constant) and type(n.value) in {int, float, str}:
            return n.value
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            value = visit(n.operand)
            require(type(value) in {int, float}, "numeric unary witness only")
            return -value if isinstance(n.op, ast.USub) else value
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and n.func.id == "Fraction"
            and len(n.args) == 2
            and not n.keywords
        ):
            args = [visit(x) for x in n.args]
            require(
                all(type(x) is int and abs(x) <= 10**9 for x in args) and args[1] != 0,
                "bounded rational witness required",
            )
            return Fraction(*args)
        require(False, "unsupported witness literal syntax")

    return visit(node)
