"""Whitelisted AST evaluation and rational polynomial arithmetic, no eval/sympify."""

from __future__ import annotations

import ast
import itertools
import math
import re
from fractions import Fraction as F

from .common import bound, require


def tree(text):
    require(type(text) is str, "expression must be a string")
    bound(len(text) <= 500, "checker expression length bound")
    try:
        node = ast.parse(text.replace("^", "**"), mode="eval").body
    except (SyntaxError, ValueError) as exc:
        require(False, f"invalid expression syntax: {type(exc).__name__}")
    bound(len(list(ast.walk(node))) <= 128, "checker expression node bound")
    return node


def evaluate(text, values=None):
    values = values or {}
    constants = {
        "pi": math.pi,
        "E": math.e,
        "e": math.e,
        "EulerGamma": 0.5772156649015329,
    }
    funcs = {
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "exp": math.exp,
        "log": math.log,
        "sqrt": math.sqrt,
        "Abs": abs,
        "floor": math.floor,
        "ceiling": math.ceil,
    }

    def visit(n):
        if isinstance(n, ast.Constant):
            require(
                type(n.value) in {int, float} and abs(n.value) <= 10**12,
                "bounded numeric literal required",
            )
            return n.value
        if isinstance(n, ast.Name):
            require(n.id in values or n.id in constants, "unbound numeric identifier")
            return values[n.id] if n.id in values else constants[n.id]
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            v = visit(n.operand)
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.BinOp):
            a, b = visit(n.left), visit(n.right)
            if isinstance(n.op, ast.Add):
                v = a + b
            elif isinstance(n.op, ast.Sub):
                v = a - b
            elif isinstance(n.op, ast.Mult):
                v = a * b
            elif isinstance(n.op, ast.Div):
                require(b != 0, "undefined division in original AST")
                v = a / b
            elif isinstance(n.op, ast.Pow):
                bound(abs(b) <= 16, "numeric exponent bound")
                require(not (a == 0 and b <= 0), "undefined zero power")
                v = a**b
            else:
                require(False, "unsupported numeric operator")
        elif (
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and not n.keywords
        ):
            args = [visit(x) for x in n.args]
            if n.func.id in funcs and len(args) == 1:
                if n.func.id == "exp":
                    bound(abs(args[0]) <= 100, "exponential evaluation bound")
                v = funcs[n.func.id](*args)
            elif n.func.id == "Rational" and len(args) == 2:
                require(
                    all(type(x) is int for x in args) and args[1] != 0,
                    "rational literal domain",
                )
                v = args[0] / args[1]
            elif n.func.id == "Integer" and len(args) == 1 and type(args[0]) is int:
                v = args[0]
            else:
                require(False, "unregistered numeric function")
        else:
            require(False, "unregistered numeric syntax")
        require(
            type(v) in {int, float} and math.isfinite(v),
            "nonfinite/complex numeric evaluation",
        )
        bound(abs(v) <= 10**15, "numeric intermediate magnitude bound")
        return v

    return visit(tree(text))


def polynomial(text, variables):
    zero = (0,) * len(variables)
    source = text.replace("^", "**")

    def visit(n):
        if isinstance(n, ast.Constant) and type(n.value) in {int, float}:
            bound(abs(n.value) <= 10**6, "polynomial literal bound")
            if type(n.value) is int:
                value = F(n.value)
            else:
                literal = ast.get_source_segment(source, n).replace("_", "")
                match = re.fullmatch(
                    r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?", literal
                )
                bound(
                    match is not None and len(literal) <= 64,
                    "bounded decimal literal syntax",
                )
                exponent = match.group(1) or "0"
                bound(
                    len(exponent) <= 3 and abs(int(exponent)) <= 12,
                    "decimal exponent bound; no float underflow simplification",
                )
                value = F(literal)
            return {zero: value} if value else {}
        if isinstance(n, ast.Name) and n.id in variables:
            return {
                tuple(
                    int(i == variables.index(n.id)) for i in range(len(variables))
                ): F(1)
            }
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            return {
                k: (-v if isinstance(n.op, ast.USub) else v)
                for k, v in visit(n.operand).items()
            }
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Name)
            and not n.keywords
            and n.func.id in {"Rational", "Integer"}
        ):
            require(
                all(
                    isinstance(x, ast.Constant) and type(x.value) is int for x in n.args
                ),
                "integer literal constructor only",
            )
            args = [x.value for x in n.args]
            bound(
                all(abs(x) <= 10**6 for x in args),
                "rational constructor magnitude bound",
            )
            require(
                (n.func.id == "Integer" and len(args) == 1)
                or (n.func.id == "Rational" and len(args) == 2 and args[1] != 0),
                "constant constructor domain",
            )
            return {zero: F(*args)}
        if isinstance(n, ast.BinOp):
            a, b = visit(n.left), visit(n.right)
            if isinstance(n.op, ast.Add):
                return add(a, b)
            if isinstance(n.op, ast.Sub):
                return add(a, {k: -v for k, v in b.items()})
            if isinstance(n.op, ast.Mult):
                return multiply(a, b)
            if isinstance(n.op, ast.Div):
                bound(
                    set(b) <= {zero},
                    "variable denominators outside exact polynomial scope; no cancellation",
                )
                require(b.get(zero, 0) != 0, "undefined constant division")
                return {k: _coefficient(v / b[zero]) for k, v in a.items()}
            if isinstance(n.op, ast.Pow):
                exponent = b.get(zero, F(0))
                bound(
                    set(b) <= {zero}
                    and exponent.denominator == 1
                    and 0 <= exponent <= 8,
                    "nonnegative integer polynomial powers <=8 only",
                )
                require(bool(a) or exponent != 0, "undefined 0**0")
                out = {zero: F(1)}
                for _ in range(int(exponent)):
                    out = multiply(out, a)
                return out
        bound(False, "outside rational polynomial grammar")

    return visit(tree(text))


def _coefficient(value):
    bound(
        value.numerator.bit_length() <= 1024 and value.denominator.bit_length() <= 1024,
        "rational intermediate bit-size bound",
    )
    return value


def add(a, b):
    result = dict(a)
    for k, v in b.items():
        result[k] = _coefficient(result.get(k, F(0)) + v)
    return {k: v for k, v in result.items() if v}


def multiply(a, b):
    bound(len(a) * len(b) <= 4096, "polynomial product work bound")
    result = {}
    for ka, va in a.items():
        for kb, vb in b.items():
            k = tuple(x + y for x, y in zip(ka, kb))
            bound(sum(k) <= 12, "polynomial total degree bound")
            result[k] = _coefficient(result.get(k, F(0)) + va * vb)
    return {k: v for k, v in result.items() if v}


def poly_value(p, point):
    return sum(v * math.prod(x**k for x, k in zip(point, key)) for key, v in p.items())


def coefficients(p):
    degree = max((k[0] for k in p), default=0)
    return [p.get((k,), F(0)) for k in range(degree + 1)]


def trim(p):
    p = list(p)
    while len(p) > 1 and p[-1] == 0:
        p.pop()
    return p


def remainder(a, b):
    a, b = trim(a), trim(b)
    while any(a) and len(a) >= len(b):
        factor, shift = a[-1] / b[-1], len(a) - len(b)
        for i, v in enumerate(b):
            a[i + shift] -= factor * v
        a = trim(a)
    return a


def root_count(p):
    """Rational Euclidean sign sequence; distinct finite real roots."""
    p = trim(p)
    bound(any(p), "zero polynomial has no finite isolated-root count")
    if len(p) == 1:
        return 0
    seq = [p, [i * v for i, v in enumerate(p)][1:]]
    while any(seq[-1]):
        r = [-v for v in remainder(seq[-2], seq[-1])]
        if not any(r):
            break
        seq.append(r)

    def variations(side):
        signs = [int(v[-1] > 0) * 2 - 1 for v in seq]
        if side < 0:
            signs = [s * (-1) ** (len(v) - 1) for s, v in zip(signs, seq)]
        return sum(a != b for a, b in itertools.pairwise(signs))

    return variations(-1) - variations(1)
