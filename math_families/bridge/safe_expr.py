"""Safe expression parsing for the bridge's expression DSL.

Model-supplied expressions are parsed with a strict whitelist AST walk:
numbers, declared variable names, arithmetic operators, and a fixed set of
math functions. Attribute access, calls outside the whitelist, comprehensions,
and dunder names are rejected before anything is evaluated.
"""
from __future__ import annotations

import ast
import math
from typing import Any

_ALLOWED_FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "exp": math.exp, "log": math.log, "sqrt": math.sqrt,
    "abs": abs, "min": min, "max": max,
    "erf": math.erf, "erfc": math.erfc,
    "Phi": lambda z: (1.0 + math.erf(z / math.sqrt(2.0))) / 2.0,
    "phi": lambda z: math.exp(-z * z / 2.0) / math.sqrt(2.0 * math.pi),
}
_ALLOWED_CONSTS = {"pi": math.pi, "e": math.e}
_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.FloorDiv)

#: Resource caps enforced statically on the AST: numeric literals must be
#: small, exponent literals small, factorial arguments small constants.
_MAX_LITERAL_ABS = 1e9
_MAX_POW_LITERAL = 12
_MAX_FACTORIAL_ARG = 200


def _check_literal(value) -> None:
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or abs(value) > _MAX_LITERAL_ABS:
            raise ValueError(f"numeric literal {value!r} exceeds magnitude cap {_MAX_LITERAL_ABS:g}")


def _static_int(node: ast.AST) -> int | None:
    """Small signed integer constant, or None if not statically one."""
    if isinstance(node, ast.Constant) and isinstance(node.value, int) \
            and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) \
            and isinstance(node.operand, ast.Constant) and isinstance(node.operand.value, int):
        return -node.operand.value
    return None


def _check(node: ast.AST, variables: set[str]) -> None:
    if isinstance(node, ast.Expression):
        _check(node.body, variables)
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)):
            raise ValueError("only numeric constants are allowed")
        _check_literal(node.value)
    elif isinstance(node, ast.Name):
        if node.id not in variables and node.id not in _ALLOWED_CONSTS \
                and node.id not in _ALLOWED_FUNCS:
            raise ValueError(f"name {node.id!r} is not a declared variable or whitelisted")
    elif isinstance(node, ast.BinOp):
        if not isinstance(node.op, _BINOPS):
            raise ValueError(f"operator {type(node.op).__name__} not allowed")
        if isinstance(node.op, (ast.Pow,)):
            exp = _static_int(node.right)
            if exp is None or abs(exp) > _MAX_POW_LITERAL:
                raise ValueError(
                    f"exponent must be an integer literal with |e| <= {_MAX_POW_LITERAL}"
                )
        _check(node.left, variables)
        _check(node.right, variables)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise ValueError("only unary +/- are allowed")
        _check(node.operand, variables)
    elif isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCS:
            raise ValueError("only whitelisted math function calls are allowed")
        if node.keywords:
            raise ValueError("keyword arguments are not allowed")
        for arg in node.args:
            _check(arg, variables)
    else:
        raise ValueError(f"syntax node {type(node).__name__} is not allowed")


def parse_numeric_function(source: str, variables: list[str]):
    """Parse "expr in the declared variables" into a float callable.

    The source is validated by a whitelist AST walk before evaluation;
    anything outside numbers, the declared variables, arithmetic, and the
    whitelisted math functions is rejected.
    """
    if not isinstance(source, str) or not source.strip():
        raise ValueError("expression must be a non-empty string")
    if len(source) > 500:
        raise ValueError("expression too long (500 chars)")
    tree = ast.parse(source, mode="eval")
    _check(tree, set(variables))
    code = compile(tree, "<bridge-expr>", "eval")
    env = {**_ALLOWED_FUNCS, **_ALLOWED_CONSTS, "__builtins__": {}}

    def f(*args):
        if len(args) != len(variables):
            raise TypeError(f"expected {len(variables)} arguments")
        return float(eval(code, env, dict(zip(variables, args))))  # noqa: S307 - whitelisted AST

    return f


def sympy_expr(source: str, variables: list[str]):
    """Parse into a sympy expression under the same whitelist discipline."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("expression must be a non-empty string")
    if len(source) > 2000:
        raise ValueError("expression too long (2000 chars)")
    tree = ast.parse(source, mode="eval")
    extra = {"factorial"}
    _check_ext(tree, set(variables), extra)
    import sympy
    from sympy.parsing.sympy_parser import (
        convert_xor,
        factorial_notation,
        implicit_multiplication_application,
        parse_expr,
        standard_transformations,
    )

    local = {v: sympy.Symbol(v) for v in variables}
    local["pi"] = sympy.pi
    local["e"] = sympy.E
    local.update({"sin": sympy.sin, "cos": sympy.cos, "tan": sympy.tan,
                  "exp": sympy.exp, "log": sympy.log, "sqrt": sympy.sqrt,
                  "Abs": sympy.Abs, "factorial": sympy.factorial,
                  "erf": sympy.erf, "erfc": sympy.erfc,
                  "Phi": lambda z: (1 + sympy.erf(z / sympy.sqrt(2))) / 2,
                  "phi": lambda z: sympy.exp(-z**2 / 2) / sympy.sqrt(2 * sympy.pi)})
    return parse_expr(
        source,
        local_dict=local,
        transformations=standard_transformations
        + (convert_xor, factorial_notation, implicit_multiplication_application),
        evaluate=True,
    )


def _check_ext(node: ast.AST, variables: set[str], extra_funcs: set[str]) -> None:
    """AST whitelist for the symbolic variant (also allows factorial/Abs)."""
    allowed_names = variables | set(_ALLOWED_CONSTS) | set(_ALLOWED_FUNCS) | {"Abs", "Phi", "phi"} | extra_funcs
    if isinstance(node, ast.Expression):
        _check_ext(node.body, variables, extra_funcs)
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)):
            raise ValueError("only numeric constants are allowed")
        _check_literal(node.value)
    elif isinstance(node, ast.Name):
        if node.id not in allowed_names:
            raise ValueError(f"name {node.id!r} not whitelisted")
    elif isinstance(node, ast.BinOp):
        if not isinstance(node.op, _BINOPS):
            raise ValueError(f"operator {type(node.op).__name__} not allowed")
        if isinstance(node.op, ast.Pow):
            exp = _static_int(node.right)
            if exp is None or abs(exp) > _MAX_POW_LITERAL:
                raise ValueError(
                    f"exponent must be an integer literal with |e| <= {_MAX_POW_LITERAL}"
                )
        _check_ext(node.left, variables, extra_funcs)
        _check_ext(node.right, variables, extra_funcs)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise ValueError("only unary +/- are allowed")
        _check_ext(node.operand, variables, extra_funcs)
    elif isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in allowed_names:
            raise ValueError("only whitelisted function calls are allowed")
        if node.keywords:
            raise ValueError("keyword arguments are not allowed")
        if node.func.id == "factorial":
            arg = _static_int(node.args[0]) if node.args else None
            if arg is None or not 0 <= arg <= _MAX_FACTORIAL_ARG:
                raise ValueError(
                    f"factorial argument must be an integer literal in 0..{_MAX_FACTORIAL_ARG}"
                )
        for arg in node.args:
            _check_ext(arg, variables, extra_funcs)
    else:
        raise ValueError(f"syntax node {type(node).__name__} is not allowed")
