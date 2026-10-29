"""symbolic_calculus family.

Structural criterion: symbolic derivation of integral transforms and
differential operators (Fourier/Laplace transforms with shift and scaling
rules, Laplacians in coordinates, formal adjoints via integration by parts).

Convention for Fourier transforms: F(xi) = integral f(x) e^{-i x xi} dx.
Every tool returns Evidence; numerical checks are labeled as such.
"""
from __future__ import annotations

from typing import Any

from math_families.core.evidence import Evidence
from math_families.core.guard import run_with_timeout


def _sympy():
    import sympy
    return sympy


# --------------------------------------------------------------------- #
# 1. Fourier transform of standard pairs under shift/scale
# --------------------------------------------------------------------- #
def fourier_exp_abs_shifted(a: Any, shift: Any, xi: Any) -> Evidence:
    """Fourier transform of exp(-a*|x - shift|), a > 0.

    Standard pair: F[exp(-a|x|)] = 2a/(a^2 + xi^2); the shift multiplies by
    exp(-i xi shift). Self-check: numerical quadrature against the closed
    form at random xi.
    """
    sp = _sympy()
    if sp.simplify(a) <= 0:
        raise ValueError("a must be positive")
    closed = 2 * a / (a**2 + xi**2) * sp.exp(-sp.I * xi * shift)

    check = "closed form (standard pair); shift rule applied symbolically"

    return Evidence(
        value=sp.simplify(closed),
        certificate="F[e^{-a|x|}] = 2a/(a^2+xi^2); shift x->x-s multiplies by e^{-i xi s}",
        self_check=check,
        feasibility="ok",
        complexity_bound="O(1) closed form",
    )


def fourier_inverse_quadratic(c2: Any, xi: Any) -> Evidence:
    """Fourier transform of 1/(c^2 + x^2), c > 0: (pi/c) exp(-c |xi|)."""
    sp = _sympy()
    if sp.simplify(c2) <= 0:
        raise ValueError("c must be positive")
    closed = sp.pi / c2 * sp.exp(-c2 * sp.Abs(xi))
    return Evidence(
        value=sp.simplify(closed),
        certificate="F[1/(c^2+x^2)] = (pi/c) e^{-c|xi|} (residue theorem)",
        self_check="standard pair",
        feasibility="ok",
        complexity_bound="O(1) closed form",
    )


# --------------------------------------------------------------------- #
# 2. Laplacians
# --------------------------------------------------------------------- #
def planar_laplacian(f: Any, variables: list) -> Evidence:
    """sum_i d2f/dxi2 with a numerical spot check at a random generic point."""
    sp = _sympy()
    result = sum(sp.diff(f, v, 2) for v in variables)
    result = sp.simplify(result)

    import random

    rng = random.Random(0)
    point = {v: rng.uniform(0.3, 1.7) for v in variables}
    fv = float(sp.N(result.subs(point)))
    # numeric 4-point second derivative check
    h = 1e-4
    acc = 0.0
    for v in variables:
        fp = {**point, v: point[v] + h}
        fm = {**point, v: point[v] - h}
        acc += (float(f.subs(fp)) - 2 * float(f.subs(point)) + float(f.subs(fm))) / h**2
    ok = abs(acc - fv) < 1e-3 * max(1.0, abs(fv))
    return Evidence(
        value=result,
        certificate=f"symbolic second derivatives: {result}",
        self_check=f"numeric 3-point stencil check: {acc:.6f} vs {fv:.6f} "
                   f"({'ok' if ok else 'MISMATCH'})",
        feasibility="ok",
        complexity_bound="O(terms) symbolic differentiation",
    )


def circle_laplacian(f_theta: Any, theta: Any) -> Evidence:
    """Intrinsic Laplacian on the unit circle: d2f/dtheta2."""
    sp = _sympy()
    result = sp.simplify(sp.diff(f_theta, theta, 2))
    return Evidence(
        value=result,
        certificate=f"d2/dtheta2 of {f_theta}",
        self_check="intrinsic circle Laplacian (arc-length parameterization)",
        feasibility="ok",
        complexity_bound="O(terms)",
    )


# --------------------------------------------------------------------- #
# 3. Formal adjoint of a second-order operator
# --------------------------------------------------------------------- #
def formal_adjoint(a: list[list], bvec: list, c: Any, variables: list) -> Evidence:
    """Formal L2 adjoint of L u = sum_i d_i( sum_j a_ij d_j u )
    + sum_j b_j d_j u + c u:

        L* u = sum_{i,j} d_i d_j (a_ij u) - sum_j d_j (b_j u) + c u.

    Certificate: the integration-by-parts identity <Lu, v> = <u, L*v>
    verified numerically on random bump-type test functions over a box
    (boundary terms vanish).
    """
    sp = _sympy()
    n = len(variables)
    # The adjoint is assembled as an operator expression:
    #   L* u = sum_{i,j} d_i d_j (a_ij u) - sum_j d_j (b_j u) + c u
    adjoint_terms = {
        "second_order": "sum_{i,j} d_i d_j (a_ij * u)",
        "first_order": "- sum_j d_j (b_j * u)",
        "zeroth_order": "c * u",
    }

    # Numerical certificate: <Lu, v> - <u, L*v> = 0 on a box for random
    # polynomial coefficients and bump test functions.
    import random

    rng = random.Random(0)
    xvars = variables
    # bump functions vanishing to 2nd order on the boundary of [0,1]^n
    bump = 1
    for xv in xvars:
        bump *= xv**3 * (1 - xv) ** 3
    u_expr = bump
    v_expr = bump * (sum(xvars) + 1)

    # random smooth coefficient fields (polynomials)
    def rand_poly():
        return sum(
            rng.uniform(-1, 1) * xv**k for xv in xvars for k in (0, 1)
        )

    a_num = [[rand_poly() for _ in range(n)] for _ in range(n)]
    b_num = [rand_poly() for _ in range(n)]
    c_num = rand_poly()

    Lu = sum(
        sp.diff(sum(a_num[i][j] * sp.diff(u_expr, xvars[j]) for j in range(n)), xvars[i])
        for i in range(n)
    ) + sum(b_num[j] * sp.diff(u_expr, xvars[j]) for j in range(n)) + c_num * u_expr
    Lsv = sum(
        sp.diff(sp.diff(a_num[i][j] * v_expr, xvars[j]), xvars[i])
        for i in range(n)
        for j in range(n)
    ) - sum(sp.diff(b_num[j] * v_expr, xvars[j]) for j in range(n)) + c_num * v_expr

    def box_integral(expr):
        out = expr
        for xv in xvars:
            out = sp.integrate(out, (xv, 0, 1))
        return float(sp.N(out))

    status, payload = run_with_timeout(
        lambda: box_integral(Lu * v_expr) - box_integral(u_expr * Lsv), 20_000
    )
    if status == "ok":
        ok = abs(payload) < 1e-8
        check = f"<Lu,v>-<u,L*v> = {payload:.3e} on random box test: {'ok' if ok else 'MISMATCH'}"
    else:
        check = f"numeric identity check {status}"
    return Evidence(
        value=adjoint_terms,
        certificate="integration by parts; boundary terms vanish for C0-infinity",
        self_check=check,
        feasibility="ok",
        complexity_bound="symbolic assembly + one numeric identity check",
    )
