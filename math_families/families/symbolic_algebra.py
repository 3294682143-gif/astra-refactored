"""symbolic_algebra family.

Structural criterion: exact symbolic computation on polynomials, field
extensions, and equation systems (roots, factorization, minimal/splitting
fields, invariants, polynomial systems).

Hang-prone backends are wrapped in forked subprocesses with hard timeouts;
timeouts come back as infeasible Evidence, never as silent hangs.

Tools:
- real_root_count: exact count over the reals via Sturm sequences.
- wronskian_root_identity: certificate check for the classical identity
  (g')^2 - g g'' = g^2 * sum 1/(z - root)^2, the mechanism behind
  "gg'' = (g')^2 has no real roots when g has distinct real roots".
- splitting_field_degree: [E:Q] for the splitting field of a univariate
  rational polynomial, by iterative adjunction with primitive elements.
- solve_system_guarded: polynomial system solving with a hard timeout and
  a clearly labeled numerical multistart fallback.
- substitution_invariant_check: verify that claimed invariants of a
  substitution identity are invariant, plus a truncated-degree completeness
  check by exact linear algebra.
"""
from __future__ import annotations

from typing import Any

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible
from math_families.core.guard import run_with_timeout

_DEFAULT_TIMEOUT_MS = 10_000


def _sympy():
    import sympy  # noqa: F401
    return sympy


# --------------------------------------------------------------------- #
# 1. Exact real root counting via Sturm sequences
# --------------------------------------------------------------------- #
def real_root_count(poly: Any, var: Any, timeout_ms: int = _DEFAULT_TIMEOUT_MS) -> Evidence:
    """Exact number of distinct real roots of a univariate polynomial.

    Certificate: the Sturm sequence. Exact (no numerics involved).
    """
    def _work():
        import sympy
        pr = sympy.Poly(poly, var)
        seq = sympy.sturm(pr)
        n = sympy.polys.polytools.count_roots(pr, -sympy.oo, sympy.oo)
        return n, [sympy.srepr(s) for s in seq]

    status, payload = run_with_timeout(_work, timeout_ms)
    if status != "ok":
        return Evidence(
            None, "", "not attempted" if status == "timeout" else f"backend error: {payload}",
            infeasible(status, "Sturm sequence computation"),
            "O(deg^2) Sturm",
        )
    n, seq_repr = payload
    return Evidence(
        value=int(n),
        certificate=f"sturm_sequence={seq_repr}",
        self_check="count_roots over (-inf, inf) via Sturm sign variations (exact)",
        feasibility="ok",
        complexity_bound="O(deg^2) exact arithmetic",
    )


# --------------------------------------------------------------------- #
# 2. Wronskian-type identity certificate
# --------------------------------------------------------------------- #
def wronskian_root_identity(g: Any, var: Any, roots: list[Any]) -> Evidence:
    """Verify (g')^2 - g*g'' == g^2 * sum_i 1/(var - root_i)^2 as a rational
    identity, given g's roots. When all roots are real and distinct the RHS
    is strictly positive on the reals (off the roots), so g*g'' == (g')^2
    has no real solution — this tool certifies the premise.
    """
    sympy = _sympy()
    z = var
    dg = sympy.diff(g, z)
    ddg = sympy.diff(g, z, 2)
    lhs = sympy.expand(dg**2 - g * ddg)
    rhs = sympy.expand(
        g**2 * sum(1 / (z - sympy.nsimplify(r)) ** 2 for r in roots)
    )
    # Verify the polynomial identity g^2 * sum(...) * prod-term matches lhs:
    # compare lhs and rhs after clearing denominators.
    prod = sympy.prod((z - sympy.nsimplify(r)) ** 2 for r in roots)
    lhs2 = sympy.expand(lhs * prod)
    rhs2 = sympy.expand(rhs * prod)
    identical = sympy.simplify(lhs2 - rhs2) == 0
    # Distinctness check via discriminant
    disc = sympy.discriminant(g, z)
    distinct = sympy.simplify(disc) != 0
    return Evidence(
        value={"identity_holds": bool(identical), "roots_distinct": bool(distinct)},
        certificate=f"discriminant={disc}",
        self_check=(
            "identity verified after clearing denominators: "
            f"{'ok' if identical else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(deg^2) symbolic",
    )


# --------------------------------------------------------------------- #
# 3. Splitting field degree via iterative adjunction
# --------------------------------------------------------------------- #
def splitting_field_degree(
    poly: Any, var: Any, timeout_ms: int = 30_000
) -> Evidence:
    """[E:Q] for the splitting field E of a univariate rational polynomial.

    Adjoins roots one at a time, tracking the primitive element's minimal
    polynomial; the final degree is the answer. Certificate: the final
    minimal polynomial.
    """
    def _work():
        import sympy
        from sympy.polys.numberfields import primitive_element
        from sympy.polys.rootoftools import RootOf

        pr = sympy.Poly(poly, var)
        if not pr.is_univariate:
            raise ValueError("univariate only")
        roots = []
        for fac, mult in sympy.factor_list(poly, var)[1]:
            for i in range(sympy.Poly(fac, var).degree()):
                roots.append(RootOf(fac, i))
        current: list = []
        degree = 1
        final_minpoly = None
        newvar = sympy.Dummy("t")
        for r in roots:
            current.append(r)
            pe = primitive_element(current, newvar)
            minpoly = sympy.Poly(pe[0], newvar)
            degree = minpoly.degree()
            final_minpoly = str(pe[0])
        return degree, len(roots), final_minpoly

    status, payload = run_with_timeout(_work, timeout_ms)
    if status != "ok":
        return Evidence(
            None, "", "not attempted" if status == "timeout" else f"backend error: {payload}",
            infeasible(status, "iterated primitive-element adjunction"),
            "iterated minpoly; exponential worst case",
        )
    degree, nroots, minpoly_str = payload
    return Evidence(
        value=degree,
        certificate=f"primitive_element_minpoly={minpoly_str}, roots_adjoined={nroots}",
        self_check="degree from minimal polynomial of primitive element of all roots",
        feasibility="ok",
        complexity_bound="iterated minpoly computation",
    )


# --------------------------------------------------------------------- #
# 4. Guarded polynomial system solving
# --------------------------------------------------------------------- #
def solve_system_guarded(
    equations: list[Any],
    variables: list[Any],
    timeout_ms: int = _DEFAULT_TIMEOUT_MS,
    numeric_fallback: bool = True,
    n_starts: int = 40,
    seed: int = 0,
) -> Evidence:
    """Count real solutions of a polynomial system.

    Tries exact symbolic solving under a hard timeout. Empty or parametric
    symbolic output is treated as *inconclusive* (never as "zero solutions")
    and escalates to the numerical fallback: multistart least-squares on the
    squared residuals with per-root residual certificates — clearly labeled
    numerical evidence, never masquerading as exact.
    """
    import sympy

    def _symbolic():
        sols = sympy.solve(equations, variables, dict=True, check=False)
        return [tuple(str(s[v]) for v in variables) for s in sols]

    symbolic_outcome = "timeout"
    if len(equations) == len(variables):
        status, payload = run_with_timeout(_symbolic, timeout_ms)
        if status == "ok" and payload:
            real_sols = []
            for point in payload:
                vals = [sympy.sympify(c) for c in point]
                if all(v.is_real for v in vals):
                    real_sols.append(point)
            if real_sols:
                return Evidence(
                    value=len(real_sols),
                    certificate=f"real_solutions={real_sols}",
                    self_check="symbolic solve; residuals zero by construction",
                    feasibility="ok",
                    complexity_bound="symbolic solve under timeout",
                )
            symbolic_outcome = "inconclusive (no isolated real solutions found)"
        elif status == "ok":
            symbolic_outcome = "inconclusive (solver returned empty)"
    else:
        symbolic_outcome = "underdetermined for isolated-point counting"

    if not numeric_fallback:
        return Evidence(
            None, "", symbolic_outcome,
            infeasible("symbolic inconclusive", "symbolic solve"),
            "symbolic solve under timeout",
        )

    def _numeric():
        import random

        import numpy as np
        from scipy.optimize import least_squares

        rng = random.Random(seed)
        f = sympy.lambdify(variables, equations, "numpy")

        def residual(vec):
            return np.array([float(fi(*vec)) for fi in f])

        found: dict[tuple, Any] = {}
        for _ in range(n_starts):
            guess = np.array([rng.uniform(-2.2, 2.2) for _ in variables])
            try:
                res = least_squares(residual, guess, method="lm", max_nfev=2000)
            except Exception:
                continue
            if float(np.sum(res.fun**2)) < 1e-12:
                key = tuple(round(float(v), 8) for v in res.x)
                found[key] = res.x
        return sorted(found)

    status2, points = run_with_timeout(_numeric, timeout_ms * max(1, n_starts // 4))
    if status2 != "ok":
        return Evidence(
            None, "", f"symbolic {symbolic_outcome}; numeric {status2}",
            infeasible(status2, "multistart numerical solve"),
            "multistart least-squares",
        )
    return Evidence(
        value=len(points),
        certificate=f"numeric_roots={points}",
        self_check=(
            "NUMERICAL EVIDENCE ONLY: multistart least-squares on squared "
            "residuals, sum(residuals^2) < 1e-12, dedup 1e-8"
        ),
        feasibility="ok",
        complexity_bound=f"multistart n={n_starts}",
    )


# --------------------------------------------------------------------- #
# 5. Substitution invariants
# --------------------------------------------------------------------- #
def substitution_invariant_check(
    forward_map: dict[Any, Any],
    target_map: dict[Any, Any],
    invariants: list[Any],
    variables: list[Any],
    max_degree: int = 6,
) -> Evidence:
    """Check claimed invariants of an identity f(forward) == f(target).

    ``forward_map``/``target_map`` map the base variables to expressions in
    ``variables``; e.g. for f(a^2, b^2) == f(((a-b)^2)/2, ((a+b)^2)/2) the
    forward map is {x: a^2, y: b^2} and the target map is
    {x: (a-b)^2/2, y: (a+b)^2/2}.

    Two parts: (i) each claimed invariant is symbolically unchanged by the
    substitution; (ii) truncated completeness — all polynomials up to
    ``max_degree`` satisfying the identity are linear combinations of
    polynomials in the invariants (exact linear algebra evidence, stated per
    degree, not a proof of the full ring).
    """
    sympy = _sympy()

    # (i) invariance
    invariance = {}
    for inv in invariants:
        lhs = inv.subs(forward_map, simultaneous=True)
        rhs = inv.subs(target_map, simultaneous=True)
        invariance[str(inv)] = sympy.simplify(sympy.expand(lhs - rhs)) == 0

    # (ii) truncated completeness at max_degree: general polynomial in the
    # base variables, impose the identity as a polynomial identity in
    # `variables`, solve the linear system, compare dimension with the span
    # of invariant-generated polynomials.
    base_vars = list(forward_map.keys())
    d = max_degree
    monoms = []
    total = d + 1
    for i in range(total + 1):
        for j in range(total + 1 - i):
            if 1 <= i + j <= d:
                monoms.append((i, j))
    coeffs = sympy.symbols(f"c0:{len(monoms)}")
    poly = sum((c * base_vars[0] ** i * base_vars[1] ** j
                for c, (i, j) in zip(coeffs, monoms)), sympy.Integer(0))
    lhs = poly.subs(forward_map, simultaneous=True)
    rhs = poly.subs(target_map, simultaneous=True)
    diff = sympy.Poly(sympy.expand(lhs - rhs), *variables)
    system = list(diff.coeffs())
    A, b = sympy.linear_eq_to_matrix(system, coeffs)
    null = A.nullspace()
    sol_dim = len(null)

    # dimension spanned by polynomials in the invariants
    gen_polys = []
    for i in range(d + 1):
        for j in range(d + 1):
            cand = invariants[0] ** i * invariants[1] ** j if len(invariants) >= 2 else invariants[0] ** i
            cand = sympy.expand(cand)
            if sympy.Poly(cand, *base_vars).total_degree() <= d:
                gen_polys.append(cand)
    M = []
    for gp in gen_polys:
        row = [sympy.expand(gp).coeff(base_vars[0], i).coeff(base_vars[1], j)
               if (i + j) > 0 else sympy.expand(gp).as_coeff_exponent(base_vars[0])[0]
               for (i, j) in monoms]
        M.append(row)
    gen_dim = sympy.Matrix(M).rank() if M else 0

    return Evidence(
        value={
            "invariance": invariance,
            "solution_space_dim": sol_dim,
            "invariant_generated_dim": gen_dim,
            "degree_cutoff": d,
        },
        certificate=f"nullspace dim {sol_dim} vs invariant span rank {gen_dim} at degree<={d}",
        self_check=(
            "invariance: "
            + ", ".join(f"{k}={v}" for k, v in invariance.items())
            + f"; truncated completeness {'ok' if sol_dim == gen_dim else 'INCOMPLETE'}"
        ),
        feasibility="ok",
        complexity_bound=f"linear algebra on {len(monoms)} coefficients",
    )


def algebraic_polynomial_relation(modulus, generator, argument, target, expression, variable):
    """Exact relation and minimal degree in a bounded rational number field.

    This computes for the supplied field/pair only. Original-problem translation
    and the meaning of a user-supplied root are never certified by this producer.
    """
    import sympy as sp

    m = sp.Poly(modulus, generator, domain=sp.QQ)
    degree = m.degree()
    if not 2 <= degree <= 6 or not m.is_irreducible:
        raise ValueError("irreducible rational modulus of degree 2..6 required")

    def reduce(e):
        return sp.Poly(sp.rem(e, m.as_expr(), generator), generator, domain=sp.QQ)

    residual = reduce(expression.subs(variable, argument) - target)
    columns, minimum = [], None
    target_vector = sp.Matrix([reduce(target).nth(i) for i in range(degree)])
    power = sp.Integer(1)
    for d in range(degree):
        p = reduce(power)
        columns.append(sp.Matrix([p.nth(i) for i in range(degree)]))
        matrix = sp.Matrix.hstack(*columns)
        if matrix.rank() == matrix.row_join(target_vector).rank():
            minimum = d
            break
        power = reduce(power * argument).as_expr()
    expression_degree = max(0, int(sp.Poly(expression, variable, domain=sp.QQ).degree())) if expression != 0 else 0
    value = {
        "residual_coefficients": [str(residual.nth(i)) for i in range(degree)],
        "satisfies": bool(residual.is_zero),
        "minimum_degree": minimum,
        "expression_degree": expression_degree,
        "is_minimal": bool(residual.is_zero and minimum is not None and expression_degree == minimum),
    }
    return Evidence(value, str(m.as_expr()), "exact rational quotient-ring arithmetic and finite coefficient ranks", "ok", "field degree<=6")
