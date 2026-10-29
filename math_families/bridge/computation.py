"""Small general algebra producers, independent of the output checker's arithmetic."""

import ast

import sympy as sp

from math_families.core.evidence import Evidence


def evidence(value):
    return Evidence(
        value,
        "recompute exact input and independently check output",
        "producer result is not proof",
        "ok",
        "bounded rational algebra",
    )


def polynomial_expand_coefficients(expression, variables, parameters):
    names = variables + parameters
    symbols = dict(zip(names, map(sp.Symbol, names)))

    def bounded(value):
        poly = sp.Poly(sp.expand(value), *symbols.values(), domain=sp.QQ)
        if (
            poly.total_degree() > 8
            or len(poly.terms()) > 512
            or any(
                max(abs(int(c.p)).bit_length(), int(c.q).bit_length()) > 256
                for c in poly.coeffs()
            )
        ):
            raise ValueError("bounded polynomial resources")
        return poly.as_expr()

    def visit(node):
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return bounded(sp.Integer(node.value))
        if isinstance(node, ast.Name) and node.id in symbols:
            return symbols[node.id]
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            return bounded(
                visit(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
            )
        if isinstance(node, ast.BinOp):
            a = visit(node.left)
            if isinstance(node.op, ast.Pow):
                if (
                    not isinstance(node.right, ast.Constant)
                    or type(node.right.value) is not int
                    or not 0 <= node.right.value <= 8
                ):
                    raise ValueError("literal bounded exponent required")
                return bounded(a**node.right.value)
            b = visit(node.right)
            if isinstance(node.op, ast.Add):
                return bounded(a + b)
            if isinstance(node.op, ast.Sub):
                return bounded(a - b)
            if isinstance(node.op, ast.Mult):
                return bounded(a * b)
            if isinstance(node.op, ast.Div) and b.is_Rational and b != 0:
                return bounded(a / b)
        raise ValueError("polynomial AST not allowed")

    if (
        len(expression) > 2000
        or not 1 <= len(variables) <= 3
        or len(names) > 6
        or len(set(names)) != len(names)
    ):
        raise ValueError("polynomial input bound")
    tree = ast.parse(expression.replace("^", "**"), mode="eval")
    if len(list(ast.walk(tree))) > 256:
        raise ValueError("AST resource bound")
    polynomial = sp.Poly(visit(tree.body), *symbols.values(), domain=sp.QQ)
    groups = {}
    for powers, c in sorted(polynomial.terms()):
        if c:
            groups.setdefault(powers[: len(variables)], []).append(
                {"powers": list(powers[len(variables) :]), "coefficient": str(c)}
            )
    return evidence(
        {
            "schema": "polynomial-coefficients-v1",
            "variables": variables,
            "parameters": parameters,
            "terms": [
                {"powers": list(p), "coefficient": c} for p, c in sorted(groups.items())
            ],
            "complete_for_input": True,
        }
    )


def linear_system_solution_set(matrix, rhs, variables, domain):
    if (
        domain not in {"RATIONAL", "REAL"}
        or not 1 <= len(variables) <= 6
        or not 1 <= len(matrix) <= 12
        or len(rhs) != len(matrix)
    ):
        raise ValueError("linear system scope")
    a, b = (
        sp.Matrix([[sp.Rational(x) for x in row] for row in matrix]),
        sp.Matrix([sp.Rational(x) for x in rhs]),
    )
    if a.cols != len(variables):
        raise ValueError("variable order mismatch")
    # Track row combinations explicitly, so no-solution is accompanied by a witness.
    joined = a.row_join(b).row_join(sp.eye(a.rows))
    rank, pivots = 0, []
    for column in range(a.cols):
        index = next((i for i in range(rank, a.rows) if joined[i, column]), None)
        if index is None:
            continue
        joined.row_swap(rank, index)
        divisor = joined[rank, column]
        joined.row_op(rank, lambda x, j, divisor=divisor: x / divisor)
        for i in range(a.rows):
            if i != rank:
                factor = joined[i, column]
                joined.row_op(
                    i,
                    lambda x, j, factor=factor, rank=rank: x - factor * joined[rank, j],
                )
        if any(
            max(abs(int(x.p)).bit_length(), int(x.q).bit_length()) > 256 for x in joined
        ):
            raise ValueError("linear intermediate bit bound")
        pivots.append(column)
        rank += 1
    common = {
        "schema": "linear-solution-set-v1",
        "variables": variables,
        "domain": domain,
        "rank": rank,
    }
    for i in range(a.rows):
        if all(joined[i, j] == 0 for j in range(a.cols)) and joined[i, a.cols] != 0:
            return evidence(
                {
                    **common,
                    "kind": "EMPTY",
                    "inconsistency": [
                        str(joined[i, j]) for j in range(a.cols + 1, joined.cols)
                    ],
                }
            )
    free = [j for j in range(a.cols) if j not in pivots]
    particular, basis = ["0"] * a.cols, []
    for i, j in enumerate(pivots):
        particular[j] = str(joined[i, a.cols])
    for f in free:
        vector = ["0"] * a.cols
        vector[f] = "1"
        for i, j in enumerate(pivots):
            vector[j] = str(-joined[i, f])
        basis.append(vector)
    return evidence(
        {
            **common,
            "kind": "AFFINE" if free else "UNIQUE",
            "particular": particular,
            "basis": basis,
            "free_variables": [variables[j] for j in free],
            "parameter_domain": domain,
        }
    )
