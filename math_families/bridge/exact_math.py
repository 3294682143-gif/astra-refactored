"""Bounded expression interfaces for existing mathematical families.

Only arithmetic ASTs and declared single-argument function applications are
accepted. This module produces observations, never controller truth receipts.
"""

from __future__ import annotations

import ast
import itertools
import re

import sympy as sp

from math_families.core.evidence import Evidence


def _variables(names):
    if (
        type(names) is not list
        or not 1 <= len(names) <= 3
        or len(set(names)) != len(names)
        or any(
            type(n) is not str or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9]{0,15}", n)
            for n in names
        )
    ):
        raise ValueError("one to three distinct declared symbols required")
    return tuple(sp.Symbol(n) for n in names)


def _polynomial(text, names, *, function=None, expression=None, argument="x"):
    variables = _variables(names)
    if type(text) is not str or not 0 < len(text) <= 500:
        raise ValueError("bounded polynomial text required")
    root = ast.parse(text.replace("^", "**"), mode="eval")
    if len(list(ast.walk(root))) > 128:
        raise ValueError("polynomial syntax budget")
    symbols = dict(zip(names, variables))

    def checked(value):
        p = sp.Poly(value, *variables, domain=sp.QQ)
        if (
            p.total_degree() > 12
            or len(p.terms()) > 512
            or any(
                abs(int(c.p)).bit_length() > 256 or int(c.q).bit_length() > 256
                for c in p.coeffs()
            )
        ):
            raise ValueError("polynomial degree/coefficient budget")
        return p.as_expr()

    def visit(node):
        if (
            isinstance(node, ast.Constant)
            and type(node.value) is int
            and abs(node.value) <= 10**6
        ):
            return sp.Integer(node.value)
        if isinstance(node, ast.Name) and node.id in symbols:
            return symbols[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return -value if isinstance(node.op, ast.USub) else value
        if (
            isinstance(node, ast.Call)
            and function
            and isinstance(node.func, ast.Name)
            and node.func.id == function
            and len(node.args) == 1
            and not node.keywords
        ):
            # Evaluate/validate the argument even for a constant candidate; an
            # undefined original expression must not disappear by substitution.
            value = visit(node.args[0])
            return checked(expression.subs(sp.Symbol(argument), value))
        if isinstance(node, ast.BinOp):
            a, b = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add):
                return checked(a + b)
            if isinstance(node.op, ast.Sub):
                return checked(a - b)
            if isinstance(node.op, ast.Mult):
                if (
                    sp.Poly(a, *variables).total_degree()
                    + sp.Poly(b, *variables).total_degree()
                    > 12
                ):
                    raise ValueError("polynomial product degree budget")
                return checked(a * b)
            if isinstance(node.op, ast.Div):
                if b.free_symbols or b == 0:
                    raise ValueError("only nonzero constant denominators allowed")
                return checked(a / b)
            if isinstance(node.op, ast.Pow):
                if not b.is_Integer or not 0 <= b <= 8 or (a == 0 and b == 0):
                    raise ValueError("bounded nonnegative powers required")
                if sp.Poly(a, *variables).total_degree() * int(b) > 12:
                    raise ValueError("polynomial power degree budget")
                return checked(a**b)
        raise ValueError("unsupported polynomial syntax")

    return checked(visit(root.body))


def _terms(expression, names):
    poly = sp.Poly(expression, *_variables(names), domain=sp.QQ)
    return [
        [list(powers), str(coefficient)]
        for powers, coefficient in sorted(poly.terms())
        if coefficient
    ]


def polynomial_function_check(equation, function, argument, variables, expression):
    from math_families.families.functional_equation import substitution_probe

    _variables([function, argument])
    if function in variables or type(equation) is not str or equation.count("=") != 1:
        raise ValueError("one bound functional equality required")
    candidate = _polynomial(expression, [argument])
    left, right = equation.split("=")
    residual = sp.expand(
        _polynomial(
            left, variables, function=function, expression=candidate, argument=argument
        )
        - _polynomial(
            right, variables, function=function, expression=candidate, argument=argument
        )
    )
    poly = sp.Poly(residual, *_variables(variables), domain=sp.QQ)
    witness = None
    if not poly.is_zero:
        degree = int(poly.total_degree())
        for point in itertools.product(range(degree + 1), repeat=len(variables)):
            value = residual.subs(
                dict(zip(_variables(variables), point)), simultaneous=True
            )
            if value:
                witness = {"point": list(point), "residual": str(value)}
                break
        if witness is None:
            raise ValueError("nonidentity without a bounded witness")
    points = [tuple(witness["point"])] if witness else [(0,) * len(variables)]
    probe = substitution_probe(
        lambda f, *point: bool(
            residual.subs(dict(zip(_variables(variables), point)), simultaneous=True)
            == 0
        ),
        points,
        {"polynomial": lambda x: candidate.subs(sp.Symbol(argument), x)},
    )
    return Evidence(
        {
            "identity_holds": bool(poly.is_zero),
            "residual_terms": _terms(residual, variables),
            "witness": witness,
        },
        probe.certificate,
        "symbolic residual plus exact boolean substitution probe; no all-functions classification",
        "ok",
        "bounded degree<=12, at most 3 variables",
    )


def polynomial_invariant_check(base_variables, variables, forward, target, invariants):
    from math_families.families.symbolic_algebra import substitution_invariant_check

    base = _variables(base_variables)
    if (
        len(base) != 2
        or len(forward) != 2
        or len(target) != 2
        or not 1 <= len(invariants) <= 4
    ):
        raise ValueError("two-variable maps and one to four invariants required")
    src = dict(zip(base, (_polynomial(e, variables) for e in forward)))
    dst = dict(zip(base, (_polynomial(e, variables) for e in target)))
    values = [_polynomial(e, base_variables) for e in invariants]
    # Reuse the family identity engine. Degree-zero completeness is deliberately
    # omitted from the public result: no finite cutoff certifies the full ring.
    observed = substitution_invariant_check(
        src, dst, values, list(_variables(variables)), max_degree=0
    )
    residuals = [
        sp.expand(e.subs(src, simultaneous=True) - e.subs(dst, simultaneous=True))
        for e in values
    ]
    return Evidence(
        {
            "invariant": [bool(observed.value["invariance"][str(e)]) for e in values],
            "residual_terms": [_terms(e, variables) for e in residuals],
        },
        observed.certificate,
        "polynomial substitution identities only; full invariant ring remains unproved",
        "ok",
        "bounded polynomial maps",
    )


def algebraic_polynomial_check(
    minimal_polynomial, generator, argument, target, expression, variable
):
    from math_families.families.symbolic_algebra import algebraic_polynomial_relation

    (t,) = _variables([generator])
    (x,) = _variables([variable])
    if t == x:
        raise ValueError("generator and polynomial variable must differ")
    modulus = _polynomial(minimal_polynomial, [generator])
    a, b = (_polynomial(e, [generator]) for e in (argument, target))
    candidate = _polynomial(expression, [variable])
    return algebraic_polynomial_relation(modulus, t, a, b, candidate, x)


def wronskian_root_identity_expr(expression, variable, roots):
    from math_families.families.symbolic_algebra import wronskian_root_identity

    (z,) = _variables([variable])
    poly = _polynomial(expression, [variable])
    if (
        not 1 <= sp.Poly(poly, z).degree() <= 6
        or len(roots) != sp.Poly(poly, z).degree()
    ):
        raise ValueError("one explicit rational root per polynomial degree required")
    values = [_polynomial(root, [variable]) for root in roots]
    if any(value.free_symbols for value in values):
        raise ValueError("roots must be explicit rational constants")
    return wronskian_root_identity(poly, z, values)
