"""Six historical consistency families plus bounded arithmetic/solution/vector checks.

No experiment schema, gold label, runner or monkey-patched enumerator is imported.
Only complete, documented WorkUnit goals compile. Unknown syntax abstains.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass

import sympy as sp

from .expressions import safe_expr


@dataclass(frozen=True)
class TemplateTask:
    property: str
    goal: str
    payload: tuple[str, ...]
    domain: str
    obligation: str
    result_kind: str


_PATTERNS = (
    (
        "binomial_value",
        r"Compute binomial: n=(\d+),\s*k=(\d+)",
        "integer",
        "binomial_value",
        "number",
    ),
    (
        "arithmetic_equality",
        r"Check arithmetic equality: (.+?) = (.+)",
        "rational",
        "arithmetic_equality",
        "boolean",
    ),
    (
        "polynomial_solution",
        r"Check polynomial solution: (.+?) at (.+)",
        "real",
        "candidate_satisfies",
        "boolean",
    ),
    (
        "path_independence_coefficients",
        r"Compute path independence coefficients \(low to high\): n=(\d+)",
        "integer_vector",
        "coefficient_vector",
        "integer_vector",
    ),
    (
        "equation_equivalence",
        r"Check equation equivalence: (.+?) <=> (.+?) over real numbers\.?",
        "real",
        "equivalence",
        "boolean",
    ),
    (
        "polynomial_substitution",
        r"Evaluate polynomial: (.+?) at (.+)",
        "real",
        "substituted_value",
        "number",
    ),
    (
        "transformation_invariance",
        r"Check polynomial invariance: (.+?) under (.+)",
        "real",
        "invariance",
        "boolean",
    ),
    (
        "interval_membership",
        r"Check membership: (.+?) in (.+?)\s*(<=|<)\s*x\s*(<=|<)\s*(.+)",
        "rational",
        "domain_membership",
        "boolean",
    ),
    (
        "finite_dedup_count",
        r"Count distinct objects: (.+) using (EXACT|UNORDERED_PAIR)",
        "finite_integer_objects",
        "bounded_count",
        "number",
    ),
    (
        "integer_interval_count",
        r"Count integers: (.+?)\s*(<=|<)\s*n\s*(<=|<)\s*(.+)",
        "integer",
        "bounded_count",
        "number",
    ),
)


def enumerate_templates(goal: str) -> tuple[TemplateTask, ...]:
    if len(goal) > 5000:
        return ()
    tasks = []
    for name, pattern, domain, obligation, result_kind in _PATTERNS:
        match = re.fullmatch(pattern, goal.strip())
        if match:
            tasks.append(
                TemplateTask(
                    name, goal, match.groups(), domain, obligation, result_kind
                )
            )
    return tuple(tasks)


def result_instruction(goal: str) -> str:
    tasks = enumerate_templates(goal)
    if len(tasks) != 1:
        return ""
    kind = (
        "one JSON array of exact integers in increasing power order"
        if tasks[0].result_kind == "integer_vector"
        else "TRUE or FALSE"
        if tasks[0].result_kind == "boolean"
        else "one exact integer or rational value"
    )
    return f" For this bounded check, RESULT must contain only {kind}. This is a claim to be checked, not verification authority."


def rational(text):
    if re.fullmatch(r"[+-]?\d{1,77}", text.strip()):
        value = int(text)
        if value.bit_length() <= 256:
            return sp.Integer(value)
    value = safe_expr(text, constants_only=True)
    if value.is_Rational is not True:
        raise ValueError("explicit exact rational required")
    return value


def polynomial(text, variables=("x", "y")):
    return safe_expr(text, polynomial_only=True, variables=variables)


def _bindings(text, separator, *, affine=False):
    parts = text.split(",")
    if not 1 <= len(parts) <= 2:
        raise ValueError("one or two explicit variable bindings required")
    values = {}
    for part in parts:
        match = re.fullmatch(r"\s*([xy])\s*" + re.escape(separator) + r"\s*(.+)", part)
        if not match or match[1] in values:
            raise ValueError("ambiguous or duplicate variable binding")
        value = polynomial(match[2]) if affine else rational(match[2])
        if (
            affine
            and sp.Poly(
                value, sp.Symbol("x", real=True), sp.Symbol("y", real=True)
            ).total_degree()
            > 1
        ):
            raise ValueError("only total, affine real transformations are supported")
        values[match[1]] = value
    return {sp.Symbol(name, real=True): value for name, value in values.items()}


def _equation(text):
    if text.count("=") != 1:
        raise ValueError("one equality required")
    left, right = text.split("=")
    x = sp.Symbol("x", real=True)
    return sp.Poly(polynomial(left, ("x",)) - polynomial(right, ("x",)), x)


def _equivalent_real_equations(first, second):
    a, b = _equation(first), _equation(second)
    if a.is_zero or b.is_zero:
        return a.is_zero and b.is_zero
    # Compare distinct real zero sets using polynomial GCD and exact root counts,
    # not numerical samples or structural equality of radical representations.
    a, b = a.sqf_part(), b.sqf_part()
    common = sp.gcd(a, b)

    def count(p):
        return int(p.count_roots(-sp.oo, sp.oo)) if p.degree() > 0 else 0

    return count(common) == count(a) == count(b)


def _finite_objects(raw, mode):
    if len(raw) > 4096:
        raise ValueError("finite object input too large")
    values = json.loads(raw)
    if not isinstance(values, list) or len(values) > 64:
        raise ValueError("at most 64 explicit integer objects")
    keys = []
    for value in values:
        if type(value) is int and abs(value) <= 10**6 and mode == "EXACT":
            keys.append(("integer", value))
        elif (
            isinstance(value, list)
            and 1 <= len(value) <= 8
            and all(type(n) is int and abs(n) <= 10**6 for n in value)
        ):
            if mode == "UNORDERED_PAIR" and len(value) != 2:
                raise ValueError("unordered pair requires exactly two coordinates")
            keys.append(
                ("tuple", tuple(sorted(value) if mode == "UNORDERED_PAIR" else value))
            )
        else:
            raise ValueError("unsupported object or implicit equivalence")
    return len(set(keys))


def evaluate_template(task: TemplateTask):
    """Return an exact local value for the entire stated mathematical task."""
    if task not in enumerate_templates(task.goal):
        raise ValueError("task payload/property does not match its controller goal")
    values = task.payload
    if task.property == "binomial_value":
        n, k = map(int, values)
        if not 0 <= k <= n <= 128:
            raise ValueError("binomial exact check supports 0<=k<=n<=128")
        return sp.Integer(math.comb(n, k))
    if task.property == "arithmetic_equality":
        return rational(values[0]) == rational(values[1])
    if task.property == "polynomial_solution":
        if values[0].count("=") != 1:
            raise ValueError("one complete polynomial equation required")
        lhs, rhs = values[0].split("=")
        difference = polynomial(lhs) - polynomial(rhs)
        assignments = _bindings(values[1], "=")
        if set(assignments) != difference.free_symbols:
            raise ValueError("missing or unused solution variable")
        return difference.subs(assignments, simultaneous=True) == 0
    if task.property == "path_independence_coefficients":
        n = int(values[0])
        if not 0 <= n <= 64:
            raise ValueError("path coefficient check supports 0<=n<=64")
        return [math.comb(n - k + 1, k) for k in range((n + 1) // 2 + 1)]
    if task.property == "equation_equivalence":
        return _equivalent_real_equations(*values)
    if task.property == "polynomial_substitution":
        expression = polynomial(values[0])
        assignments = _bindings(values[1], "=")
        if set(assignments) != expression.free_symbols:
            raise ValueError("missing or unused substitution variable")
        result = expression.subs(assignments, simultaneous=True)
        if result.is_Rational is not True:
            raise ValueError("substitution did not produce an exact rational")
        return result
    if task.property == "transformation_invariance":
        expression = polynomial(values[0])
        substitutions = _bindings(values[1], "->", affine=True)
        if set(substitutions) != expression.free_symbols:
            raise ValueError("missing or unused transformation variable")
        difference = expression.subs(substitutions, simultaneous=True) - expression
        return sp.Poly(
            difference, sp.Symbol("x", real=True), sp.Symbol("y", real=True)
        ).is_zero
    if task.property == "interval_membership":
        value, lower, left, right, upper = values
        v, lo, hi = rational(value), rational(lower), rational(upper)
        return bool(
            (lo <= v if left == "<=" else lo < v)
            and (v <= hi if right == "<=" else v < hi)
        )
    if task.property == "finite_dedup_count":
        return sp.Integer(_finite_objects(*values))
    if task.property == "integer_interval_count":
        lower, left, right, upper = values
        lo, hi = rational(lower), rational(upper)
        if not lo.is_Integer or not hi.is_Integer or abs(lo) > 10**9 or abs(hi) > 10**9:
            raise ValueError("bounded integer endpoints required")
        first = lo + int(left == "<")
        last = hi - int(right == "<")
        return sp.Integer(max(0, last - first + 1))
    raise ValueError("unregistered template")


def evaluate_assertion(task: TemplateTask, proposed: str):
    actual = evaluate_template(task)
    if task.result_kind == "boolean":
        if proposed not in {"TRUE", "FALSE"}:
            raise ValueError("only a complete TRUE/FALSE assertion is bindable")
        asserted = proposed == "TRUE"
    elif task.result_kind == "integer_vector":
        if len(proposed) > 4096:
            raise ValueError("coefficient payload too large")
        asserted = json.loads(proposed)
        if (
            not isinstance(asserted, list)
            or len(asserted) > 65
            or any(type(x) is not int or x.bit_length() > 256 for x in asserted)
        ):
            raise ValueError("bounded exact integer coefficient list required")
    else:
        asserted = rational(proposed)
    return bool(asserted == actual), f"{task.goal}; exact local result: {actual}"
