"""Independent rational-coefficient and finite-constraint output checks.

No imports of family producers/bridge functions. The symbolic producer is
checked here by sparse Fraction arithmetic, quotient reduction, and graph
constraint elimination. Shared syntax is data, not proof or execution code.
"""

from __future__ import annotations

import ast
import copy
import re
from fractions import Fraction as F

from .common import bound, exact, require
from .expressions import (
    add,
    coefficients,
    multiply,
    poly_value,
    polynomial,
    remainder,
    tree,
    trim,
)

CONTRACTS = {
    "polynomial_function_check": (
        "a submitted polynomial's universal functional equality",
        "rational polynomials; <=3 variables, degree<=12; no completeness of all functions",
    ),
    "polynomial_invariant_check": (
        "individual polynomial invariance under simultaneous substitutions",
        "2 base variables, <=3 input variables, <=4 generators; not full invariant-ring completeness",
    ),
    "algebraic_polynomial_check": (
        "a rational polynomial's value and lowest degree for an explicit field relation",
        "irreducible rational modulus degree 2..6; quotient arithmetic, no unverified source mapping",
    ),
    "wronskian_root_identity_expr": (
        "Wronskian identity with an explicit rational root list and squarefreeness",
        "degree 1..6; one rational root per degree; supplied polynomial only",
    ),
    "constraint_propagation_2coloring": (
        "pinned components' coloring/conflicts and unreachable vertices",
        "<=64 explicit integer vertices, <=256 edges; no global satisfiability claim about unpinned components",
    ),
}

FIELDS = {
    "polynomial_function_check": {
        "equation",
        "function",
        "argument",
        "variables",
        "expression",
    },
    "polynomial_invariant_check": {
        "base_variables",
        "variables",
        "forward",
        "target",
        "invariants",
    },
    "algebraic_polynomial_check": {
        "minimal_polynomial",
        "generator",
        "argument",
        "target",
        "expression",
        "variable",
    },
    "wronskian_root_identity_expr": {"expression", "variable", "roots"},
    "constraint_propagation_2coloring": {"points", "edges", "fixed"},
}


def symbol(name):
    require(
        type(name) is str
        and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9]{0,15}", name) is not None,
        "bounded declared identifier required",
    )
    return name


def names(value, maximum=3):
    if type(value) is list:
        bound(len(value) <= maximum, "declared symbol count bound")
    require(
        type(value) is list and 1 <= len(value) <= maximum,
        "declared symbol array required",
    )
    for name in value:
        symbol(name)
    require(len(set(value)) == len(value), "duplicate declared symbols")
    return value


def poly(text, variables):
    """Keep original domain obligations, even if later simplification is zero."""
    node = tree(text)
    require(
        not any(
            isinstance(n, ast.Constant) and type(n.value) is not int
            for n in ast.walk(node)
        ),
        "integer literals and explicit rational fractions required",
    )
    bound(
        all(
            not isinstance(n, ast.BinOp)
            or not isinstance(n.op, ast.Pow)
            or (
                isinstance(n.right, ast.Constant)
                and type(n.right.value) is int
                and 1 <= n.right.value <= 8
            )
            for n in ast.walk(node)
        ),
        "positive literal polynomial powers 1..8 required",
    )
    result = polynomial(text, variables)
    bound(
        len(result) <= 512
        and all(
            v.numerator.bit_length() <= 256 and v.denominator.bit_length() <= 256
            for v in result.values()
        ),
        "exact polynomial coefficient budget",
    )
    return result


def terms(p):
    return [[list(k), str(v)] for k, v in sorted(p.items()) if v]


def negate(p):
    return {k: -v for k, v in p.items()}


def power(p, n, dimension):
    result = {(0,) * dimension: F(1)}
    for _ in range(n):
        result = multiply(result, p)
    return result


def compose(p, mappings):
    dimension = len(next(iter(mappings[0]), ()))
    # The caller supplies an explicit zero monomial when a mapping is zero.
    result = {}
    for powers, coefficient in p.items():
        value = {(0,) * dimension: coefficient}
        for exponent, mapping in zip(powers, mappings):
            value = multiply(value, power(mapping, exponent, dimension))
        result = add(result, value)
    return result


def mapped(texts, variables):
    return [poly(text, variables) or {(0,) * len(variables): F(0)} for text in texts]


def function_residual(p):
    variables, function, argument = p["variables"], p["function"], p["argument"]
    candidate = tree(p["expression"])
    poly(p["expression"], [argument])

    def expand(node):
        if isinstance(node, ast.Call):
            require(
                isinstance(node.func, ast.Name)
                and node.func.id == function
                and len(node.args) == 1
                and not node.keywords,
                "only the declared function with one argument is supported",
            )
            arg = expand(node.args[0])
            poly(ast.unparse(arg), variables)

            class Substitute(ast.NodeTransformer):
                def visit_Name(self, n):
                    return copy.deepcopy(arg) if n.id == argument else n

            value = Substitute().visit(copy.deepcopy(candidate))
        else:
            value = copy.copy(node)
            for field, child in ast.iter_fields(node):
                if isinstance(child, ast.AST):
                    setattr(value, field, expand(child))
                elif isinstance(child, list):
                    setattr(
                        value,
                        field,
                        [expand(c) if isinstance(c, ast.AST) else c for c in child],
                    )
        bound(len(list(ast.walk(value))) <= 128, "composed function syntax budget")
        return value

    left, right = p["equation"].split("=")
    return add(
        poly(ast.unparse(expand(tree(left))), variables),
        negate(poly(ast.unparse(expand(tree(right))), variables)),
    )


def field_data(p):
    t = p["generator"]
    modulus = coefficients(poly(p["minimal_polynomial"], [t]))
    bound(
        2 <= len(modulus) - 1 <= 6
        and all(abs(v.numerator) <= 128 and v.denominator <= 128 for v in modulus),
        "field modulus degree/coefficient budget",
    )
    # Irreducibility is an input prerequisite, not trust in a producer's flag.
    import sympy as sp

    z = sp.Symbol("z")
    m = sp.Poly(
        sum(
            sp.Rational(v.numerator, v.denominator) * z**i
            for i, v in enumerate(modulus)
        ),
        z,
        domain=sp.QQ,
    )
    require(m.is_irreducible is True, "a genuine minimal polynomial over Q is required")
    return (
        modulus,
        coefficients(poly(p["argument"], [t])),
        coefficients(poly(p["target"], [t])),
        coefficients(poly(p["expression"], [p["variable"]])),
    )


def vector_rank(rows):
    a = [list(row) for row in rows]
    if not a:
        return 0
    rank = 0
    for column in range(len(a[0])):
        pivot = next((i for i in range(rank, len(a)) if a[i][column]), None)
        if pivot is None:
            continue
        a[rank], a[pivot] = a[pivot], a[rank]
        factor = a[rank][column]
        a[rank] = [v / factor for v in a[rank]]
        for i in range(len(a)):
            if i != rank:
                factor = a[i][column]
                a[i] = [x - factor * y for x, y in zip(a[i], a[rank])]
        bound(
            all(
                v.numerator.bit_length() <= 1024 and v.denominator.bit_length() <= 1024
                for row in a
                for v in row
            ),
            "linear algebra coefficient budget",
        )
        rank += 1
    return rank


def algebraic_result(p):
    modulus, argument, target, expression = field_data(p)
    d = len(modulus) - 1

    def padded(values):
        return (remainder(values, modulus) + [F(0)] * d)[:d]

    def mul(a, b):
        result = [F(0)] * (len(a) + len(b) - 1)
        for i, x in enumerate(a):
            for j, y in enumerate(b):
                result[i + j] += x * y
        return padded(result)

    value = [F(0)] * d
    for coefficient in reversed(expression):
        value = mul(value, argument)
        value[0] += coefficient
    target = padded(target)
    residual = [x - y for x, y in zip(value, target)]
    powers = []
    power_value = padded([F(1)])
    minimum = None
    for degree in range(d):
        powers.append(power_value)
        if vector_rank(powers) == vector_rank(powers + [target]):
            minimum = degree
            break
        power_value = mul(power_value, argument)
    actual_degree = len(trim(expression)) - 1
    return {
        "residual_coefficients": [str(v) for v in residual],
        "satisfies": not any(residual),
        "minimum_degree": minimum,
        "expression_degree": actual_degree,
        "is_minimal": not any(residual)
        and minimum is not None
        and minimum == actual_degree,
    }


def normalize(name, args):
    require(
        type(args) is dict and set(args) == FIELDS[name],
        "exact mathematical input fields required",
    )
    p = copy.deepcopy(args)

    def size(value):
        if type(value) is str:
            bound(len(value) <= 500, "mathematical text input bound")
        elif type(value) is list:
            bound(len(value) <= 256, "mathematical array input bound")
            for child in value:
                size(child)
        elif type(value) is dict:
            bound(len(value) <= 64, "mathematical object input bound")
            for key, child in value.items():
                size(key)
                size(child)

    size(p)
    if name == "polynomial_function_check":
        names(p["variables"])
        symbol(p["function"])
        symbol(p["argument"])
        require(
            p["function"] not in p["variables"] and p["function"] != p["argument"],
            "function and variable bindings collide",
        )
        require(
            type(p["equation"]) is str and p["equation"].count("=") == 1,
            "one functional equality required",
        )
        function_residual(p)
    elif name == "polynomial_invariant_check":
        names(p["base_variables"], 2)
        names(p["variables"])
        require(len(p["base_variables"]) == 2, "two base variables required")
        for key in ["forward", "target"]:
            require(
                type(p[key]) is list and len(p[key]) == 2,
                "two simultaneous map expressions required",
            )
            mapped(p[key], p["variables"])
        require(
            type(p["invariants"]) is list and 1 <= len(p["invariants"]) <= 4,
            "one to four invariants required",
        )
        for e in p["invariants"]:
            invariant = poly(e, p["base_variables"])
            compose(invariant, mapped(p["forward"], p["variables"]))
            compose(invariant, mapped(p["target"], p["variables"]))
    elif name == "algebraic_polynomial_check":
        symbol(p["generator"])
        symbol(p["variable"])
        require(
            p["generator"] != p["variable"],
            "field generator must not capture candidate variable",
        )
        field_data(p)
    elif name == "wronskian_root_identity_expr":
        symbol(p["variable"])
        pol = poly(p["expression"], [p["variable"]])
        degree = len(coefficients(pol)) - 1
        bound(1 <= degree <= 6, "Wronskian polynomial degree 1..6")
        require(
            type(p["roots"]) is list and len(p["roots"]) == degree,
            "explicit rational root list must match degree",
        )
        for root in p["roots"]:
            require(
                set(poly(root, [p["variable"]])) <= {(0,)},
                "explicit rational roots required",
            )
    else:
        require(
            type(p["points"]) is list and 1 <= len(p["points"]) <= 64,
            "bounded vertex list required",
        )
        require(
            all(type(v) is int and 0 <= v <= 10**6 for v in p["points"])
            and len(set(p["points"])) == len(p["points"]),
            "distinct strict nonnegative vertex IDs required",
        )
        require(
            type(p["edges"]) is list and len(p["edges"]) <= 256,
            "bounded edge list required",
        )
        for edge in p["edges"]:
            require(
                type(edge) is list
                and len(edge) == 2
                and all(type(v) is int and v in p["points"] for v in edge)
                and edge[0] != edge[1],
                "valid distinct integer endpoints required",
            )
        require(
            type(p["fixed"]) is dict and len(p["fixed"]) <= len(p["points"]),
            "explicit pin table required",
        )
        require(
            all(
                type(k) is str
                and re.fullmatch(r"0|[1-9][0-9]{0,6}", k)
                and int(k) in p["points"]
                and type(v) is int
                and v in {0, 1}
                for k, v in p["fixed"].items()
            ),
            "canonical vertex keys and strict binary colors required",
        )
    return p


def graph_check(p, result):
    require(
        type(result) is dict
        and set(result) == {"assignment", "conflicts", "unconstrained"},
        "exact coloring result fields required",
    )
    assigned = result["assignment"]
    conflicts = result["conflicts"]
    require(
        type(assigned) is dict
        and all(
            type(k) is str
            and k in {str(v) for v in p["points"]}
            and type(v) is int
            and v in {0, 1}
            for k, v in assigned.items()
        ),
        "strict color assignments required",
    )
    reached = set(map(int, p["fixed"]))
    while True:
        more = reached | {
            v for a, b in p["edges"] for v, u in [(a, b), (b, a)] if u in reached
        }
        if more == reached:
            break
        reached = more
    if set(map(int, assigned)) != reached or not all(
        assigned.get(k) == v for k, v in p["fixed"].items()
    ):
        return False
    if not exact(result["unconstrained"], [v for v in p["points"] if v not in reached]):
        return False
    # Independent GF(2) elimination checks whether the pinned components really
    # are contradictory; a merely bad producer coloring cannot invent conflicts.
    ordered = sorted(reached)
    n = len(ordered)
    rows = []
    for a, b in p["edges"]:
        if a in reached:
            rows.append((1 << ordered.index(a)) ^ (1 << ordered.index(b)) ^ (1 << n))
    for k, v in p["fixed"].items():
        rows.append((1 << ordered.index(int(k))) ^ (v << n))
    pivots = {}
    inconsistent = False
    for row in rows:
        while row & ((1 << n) - 1):
            bit = (row & ((1 << n) - 1)).bit_length() - 1
            if bit not in pivots:
                pivots[bit] = row
                break
            row ^= pivots[bit]
        if row == (1 << n):
            inconsistent = True
    actual = sorted(
        {
            tuple(sorted((a, b)))
            for a, b in p["edges"]
            if a in reached and assigned[str(a)] == assigned[str(b)]
        }
    )
    return exact(conflicts, [list(e) for e in actual]) and bool(actual) == inconsistent


def check(name, p, result):
    if name == "polynomial_function_check":
        residual = function_residual(p)
        if type(result) is not dict or set(result) != {
            "identity_holds",
            "residual_terms",
            "witness",
        }:
            return False
        if not exact(result["identity_holds"], not residual) or not exact(
            result["residual_terms"], terms(residual)
        ):
            return False
        if not residual:
            return result["witness"] is None
        witness = result["witness"]
        if type(witness) is not dict or set(witness) != {"point", "residual"}:
            return False
        point = witness["point"]
        if (
            type(point) is not list
            or len(point) != len(p["variables"])
            or not all(type(v) is int and abs(v) <= 12 for v in point)
        ):
            return False
        value = poly_value(residual, point)
        return value != 0 and exact(witness["residual"], str(value))
    if name == "polynomial_invariant_check":
        residuals = [
            add(
                compose(
                    poly(e, p["base_variables"]), mapped(p["forward"], p["variables"])
                ),
                negate(
                    compose(
                        poly(e, p["base_variables"]),
                        mapped(p["target"], p["variables"]),
                    )
                ),
            )
            for e in p["invariants"]
        ]
        return exact(
            result,
            {
                "invariant": [not r for r in residuals],
                "residual_terms": [terms(r) for r in residuals],
            },
        )
    if name == "algebraic_polynomial_check":
        return exact(result, algebraic_result(p))
    if name == "constraint_propagation_2coloring":
        return graph_check(p, result)
    pol = poly(p["expression"], [p["variable"]])
    coefs = coefficients(pol)
    product = {(0,): coefs[-1]}
    for root in p["roots"]:
        value = poly(root, [p["variable"]]).get((0,), F(0))
        product = multiply(product, {(1,): F(1), (0,): -value})
    a = coefs
    b = trim([i * v for i, v in enumerate(coefs)][1:])
    while any(b):
        a, b = b, remainder(a, b)
    return exact(
        result, {"identity_holds": product == pol, "roots_distinct": len(trim(a)) == 1}
    )
