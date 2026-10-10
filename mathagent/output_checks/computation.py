"""Independent sparse rational polynomial arithmetic and certificate elimination.

No SymPy or family/bridge producer imports. The limits apply to intermediates,
not only the final polynomial after cancellation.
"""

import ast
import copy
import re
from fractions import Fraction as F

from .common import bound, require

CONTRACTS = {
    "polynomial_expand_coefficients": (
        "complete ordered rational/parameter coefficient table",
        "<=6 symbols, 1..3 main variables, degree<=8, <=256 AST nodes, <=2000 characters, <=512 terms, <=256-bit rationals",
    ),
    "linear_system_solution_set": (
        "exact unique/affine solution set or independently checked inconsistency",
        "1..6 variables, 1..12 rational equations, numerator/denominator<=10^6, RATIONAL or REAL, <=256-bit intermediates",
    ),
}
FIELDS = {
    "polynomial_expand_coefficients": {"expression", "variables", "parameters"},
    "linear_system_solution_set": {"matrix", "rhs", "variables", "domain"},
}


def rational(value, *, input_bound=False):
    require(
        type(value) is int
        or (
            type(value) is str
            and re.fullmatch(r"-?\d+(?:/[1-9]\d*)?", value) is not None
        ),
        "exact integer or rational string required",
    )
    bound(len(str(value)) <= 160, "rational text resource bound")
    result = F(value)
    bounded(result)
    if input_bound:
        bound(
            abs(result.numerator) <= 10**6 and result.denominator <= 10**6,
            "rational input magnitude bound",
        )
    return result


def bounded(value):
    bound(
        abs(value.numerator).bit_length() <= 256
        and value.denominator.bit_length() <= 256,
        "256-bit rational resource bound",
    )
    return value


def symbols(names, maximum):
    require(
        type(names) is list and len({str(n) for n in names}) == len(names),
        "distinct ordered symbol list required",
    )
    bound(len(names) <= maximum, "symbol count bound")
    require(
        all(
            type(n) is str and re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,15}", n)
            for n in names
        ),
        "bounded symbol identifiers required",
    )


def sparse(text, names):
    require(type(text) is str and bool(text), "expression text required")
    bound(len(text) <= 2000, "expression character bound")
    try:
        root = ast.parse(text.replace("^", "**"), mode="eval")
    except (SyntaxError, RecursionError) as exc:
        raise ValueError("invalid polynomial syntax") from exc
    bound(len(list(ast.walk(root))) <= 256, "AST node bound")
    zero = (0,) * len(names)

    def checked(poly):
        poly = {p: bounded(c) for p, c in poly.items() if c}
        bound(
            len(poly) <= 512 and all(sum(p) <= 8 for p in poly),
            "degree/expanded monomial bound",
        )
        return poly

    def add(a, b):
        out = dict(a)
        for p, c in b.items():
            out[p] = bounded(out.get(p, F(0)) + c)
        return checked(out)

    def mul(a, b):
        out = {}
        for p, c in a.items():
            for q, d in b.items():
                powers = tuple(x + y for x, y in zip(p, q))
                bound(sum(powers) <= 8, "intermediate degree bound")
                out[powers] = bounded(out.get(powers, F(0)) + bounded(c * d))
                bound(len(out) <= 512, "intermediate monomial bound")
        return checked(out)

    def visit(node):
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and type(node.value) is int:
            return checked({zero: rational(node.value)})
        if isinstance(node, ast.Name) and node.id in names:
            powers = tuple(int(n == node.id) for n in names)
            return {powers: F(1)}
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return {
                p: c * (-1 if isinstance(node.op, ast.USub) else 1)
                for p, c in visit(node.operand).items()
            }
        if isinstance(node, ast.BinOp):
            a = visit(node.left)
            if isinstance(node.op, ast.Pow):
                require(
                    isinstance(node.right, ast.Constant)
                    and type(node.right.value) is int,
                    "literal nonnegative integer power required",
                )
                bound(0 <= node.right.value <= 8, "power bound")
                out = {zero: F(1)}
                for _ in range(node.right.value):
                    out = mul(out, a)
                return out
            b = visit(node.right)
            if isinstance(node.op, ast.Add):
                return add(a, b)
            if isinstance(node.op, ast.Sub):
                return add(a, {p: -c for p, c in b.items()})
            if isinstance(node.op, ast.Mult):
                return mul(a, b)
            if isinstance(node.op, ast.Div):
                require(
                    set(b) == {zero} and b[zero] != 0,
                    "nonzero constant divisor required",
                )
                return checked({p: c / b[zero] for p, c in a.items()})
        raise ValueError("polynomial AST operation outside contract")

    return visit(root)


def normalize(name, args):
    require(
        type(args) is dict and set(args) == FIELDS[name],
        "exact operation fields required",
    )
    symbols(args["variables"], 3 if name == "polynomial_expand_coefficients" else 6)
    require(bool(args["variables"]), "nonempty variable order required")
    if name == "polynomial_expand_coefficients":
        symbols(args["parameters"], 5)
        names = args["variables"] + args["parameters"]
        symbols(names, 6)
        sparse(args["expression"], names)
    else:
        require(
            args["domain"] in {"RATIONAL", "REAL"},
            "explicit rational or real domain required",
        )
        a, b, n = args["matrix"], args["rhs"], len(args["variables"])
        if type(a) is list:
            bound(1 <= len(a) <= 12, "equation count bound")
        require(
            type(a) is list and type(b) is list and len(a) == len(b),
            "one rhs per matrix row required",
        )
        bound(1 <= len(a) <= 12, "equation count bound")
        for row, rhs in zip(a, b):
            require(type(row) is list and len(row) == n, "ordered matrix row dimension")
            for v in [*row, rhs]:
                rational(v, input_bound=True)
        elimination(a, b)
    return copy.deepcopy(args)


def elimination(matrix, rhs):
    m, n = len(matrix), len(matrix[0])
    rows = [
        [rational(x) for x in row] + [rational(b)] + [F(i == j) for j in range(m)]
        for i, (row, b) in enumerate(zip(matrix, rhs))
    ]
    pivots = []
    for column in range(n):
        at = next((i for i in range(len(pivots), m) if rows[i][column]), None)
        if at is None:
            continue
        rank = len(pivots)
        rows[rank], rows[at] = rows[at], rows[rank]
        pivot = rows[rank][column]
        rows[rank] = [bounded(x / pivot) for x in rows[rank]]
        for i in range(m):
            if i != rank:
                factor = rows[i][column]
                rows[i] = [
                    bounded(x - bounded(factor * y))
                    for x, y in zip(rows[i], rows[rank])
                ]
        pivots.append(column)
    return rows, pivots


def coefficient_table(args):
    names = args["variables"] + args["parameters"]
    poly = sparse(args["expression"], names)
    k = len(args["variables"])
    groups = {}
    for powers, value in sorted(poly.items()):
        groups.setdefault(powers[:k], []).append(
            {"powers": list(powers[k:]), "coefficient": str(value)}
        )
    return {
        "schema": "polynomial-coefficients-v1",
        "variables": args["variables"],
        "parameters": args["parameters"],
        "terms": [
            {"powers": list(p), "coefficient": c} for p, c in sorted(groups.items())
        ],
        "complete_for_input": True,
    }


def check(name, args, result):
    if name == "polynomial_expand_coefficients":
        from .common import exact

        return exact(result, coefficient_table(args))
    if not isinstance(result, dict):
        return False
    n = len(args["variables"])
    a = [[rational(x) for x in row] for row in args["matrix"]]
    b = [rational(x) for x in args["rhs"]]
    rows, pivots = elimination(args["matrix"], args["rhs"])
    common = {
        "schema": "linear-solution-set-v1",
        "variables": args["variables"],
        "domain": args["domain"],
        "rank": len(pivots),
    }
    if any(
        result.get(k) != v or type(result.get(k)) is not type(v)
        for k, v in common.items()
    ):
        return False
    incompatible = any(not any(row[:n]) and row[n] for row in rows)
    if incompatible:
        if (
            set(result) != {*common, "kind", "inconsistency"}
            or result["kind"] != "EMPTY"
        ):
            return False
        cert = result["inconsistency"]
        if not isinstance(cert, list) or len(cert) != len(a):
            return False
        y = [rational(x) for x in cert]
        return (
            all(sum(y[i] * a[i][j] for i in range(len(a))) == 0 for j in range(n))
            and sum(x * z for x, z in zip(y, b)) != 0
        )
    if set(result) != {
        *common,
        "kind",
        "particular",
        "basis",
        "free_variables",
        "parameter_domain",
    }:
        return False
    free = [j for j in range(n) if j not in pivots]
    if (
        result["kind"] != ("AFFINE" if free else "UNIQUE")
        or result["parameter_domain"] != args["domain"]
        or result["free_variables"] != [args["variables"][j] for j in free]
    ):
        return False
    if (
        not isinstance(result["particular"], list)
        or len(result["particular"]) != n
        or not isinstance(result["basis"], list)
        or len(result["basis"]) != len(free)
    ):
        return False
    p = [rational(x) for x in result["particular"]]
    if any(sum(x * y for x, y in zip(row, p)) != rhs for row, rhs in zip(a, b)):
        return False
    basis = []
    for vector in result["basis"]:
        if not isinstance(vector, list) or len(vector) != n:
            return False
        v = [rational(x) for x in vector]
        if any(sum(x * y for x, y in zip(row, v)) != 0 for row in a):
            return False
        basis.append(v)
    if basis:
        _, basis_pivots = elimination(
            [[str(x) for x in v] for v in basis], [0] * len(basis)
        )
        if len(basis_pivots) != len(free):
            return False
    return True
