"""Bounded expression parsing shared by exact verification templates."""

from __future__ import annotations

import ast
import re

import sympy as sp


def _validate_polynomial_tree(
    node: ast.AST, variables=("x",)
) -> tuple[int, int | None]:
    """Check original syntax without SymPy evaluation or algebraic cancellation.

    This narrow checker admits integer constants, x, +, -, *, and constant
    positive integer powers 1..4. Division and nonpositive/symbolic powers
    remain outside its domain, even inside a term that later cancels to zero.
    The returned degree is a conservative syntactic bound; the constant value
    is computed only for x-free integer expressions (including exponents).
    """
    if (
        isinstance(node, ast.Constant)
        and type(node.value) is int
        and abs(node.value) <= 10**9
    ):
        return 0, node.value
    if isinstance(node, ast.Name) and node.id in variables:
        return 1, None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        degree, value = _validate_polynomial_tree(node.operand, variables)
        return degree, -value if value is not None and isinstance(
            node.op, ast.USub
        ) else value
    if not isinstance(node, ast.BinOp) or not isinstance(
        node.op, (ast.Add, ast.Sub, ast.Mult, ast.Pow)
    ):
        raise ValueError("original expression is outside polynomial-only syntax")  # noqa: TRY004 - well-formed AST, unsupported mathematical scope
    left_degree, left = _validate_polynomial_tree(node.left, variables)
    right_degree, right = _validate_polynomial_tree(node.right, variables)
    value = None
    if isinstance(node.op, ast.Pow):
        if right is None or not 1 <= right <= 4:
            raise ValueError(
                "polynomial powers must be constant positive integers 1..4"
            )
        degree = left_degree * right
        if left is not None:
            value = left**right
    elif isinstance(node.op, ast.Mult):
        degree = left_degree + right_degree
        if left is not None and right is not None:
            value = left * right
    else:
        degree = max(left_degree, right_degree)
        if left is not None and right is not None:
            value = left + right if isinstance(node.op, ast.Add) else left - right
    if degree > 4 or (value is not None and value.bit_length() > 256):
        raise ValueError(
            "original polynomial exceeds bounded degree or arithmetic scope"
        )
    return degree, value


def safe_expr(
    text: str, *, polynomial_only=False, constants_only=False, variables=("x",)
):
    if not set(variables) <= {"x", "y"}:
        raise ValueError("only explicitly declared x/y symbols are supported")
    if len(text) > 300:
        raise ValueError("expression too large")
    text = text.strip().replace("^", "**")
    text = re.sub(r"(?<=[0-9xy)])(?=\()|(?<=[0-9)])(?=[xy])", "*", text)
    tree = ast.parse(text, mode="eval")
    if len(list(ast.walk(tree))) > 100:
        raise ValueError("expression too complex")
    if constants_only and any(isinstance(n, ast.Name) for n in ast.walk(tree)):
        raise ValueError(
            "candidate values must be explicit constants before simplification"
        )
    if polynomial_only:
        _validate_polynomial_tree(tree.body, variables)

    def checked(value):
        if value.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
            raise ValueError("undefined intermediate expression")
        if value.is_Rational and (
            int(value.p).bit_length() > 256 or int(value.q).bit_length() > 256
        ):
            raise ValueError("intermediate arithmetic magnitude bound")
        return value

    def visit(n):
        if (
            isinstance(n, ast.Constant)
            and type(n.value) is int
            and abs(n.value) <= 10**9
        ):
            return sp.Integer(n.value)
        if isinstance(n, ast.Name) and n.id in variables:
            return sp.Symbol(n.id, real=True)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
            return visit(n.operand) * (-1 if isinstance(n.op, ast.USub) else 1)
        if isinstance(n, ast.BinOp):
            a, b = visit(n.left), visit(n.right)
            for value in (a, b):
                if value.is_Rational and (
                    int(value.p).bit_length() > 256 or int(value.q).bit_length() > 256
                ):
                    raise ValueError("intermediate arithmetic magnitude bound")
            if isinstance(n.op, ast.Add):
                return checked(a + b)
            if isinstance(n.op, ast.Sub):
                return checked(a - b)
            if isinstance(n.op, ast.Mult):
                return checked(a * b)
            if isinstance(n.op, ast.Div) and b != 0:
                return checked(a / b)
            if isinstance(n.op, ast.Pow) and b.is_Integer and abs(int(b)) <= 4:
                if a == 0 and b <= 0:
                    raise ValueError(
                        "zero base with nonpositive exponent is outside the exact arithmetic domain"
                    )
                return checked(a**b)
        raise ValueError("unsupported safe expression")

    value = visit(tree.body)
    if value.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
        raise ValueError("undefined expression")
    return value
