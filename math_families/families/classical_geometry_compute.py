"""classical_geometry_compute family.

Structural criterion: classical plane-geometry computation — trigonometric
evaluation, angle loci, radical axes, tangency, pole-polar — by coordinate
methods with exact symbolic arithmetic where feasible and clearly labeled
high-precision numerics otherwise.

Tools are primitives; problem-specific setups live in the caller. Tools
never output a final answer object, only evidence (values + certificates).
"""
from __future__ import annotations

import math

from math_families.core.evidence import Evidence


def _sympy():
    import sympy
    return sympy


# --------------------------------------------------------------------- #
# Exact coordinate primitives (sympy-backed)
# --------------------------------------------------------------------- #
def line_through(p, q):
    """Line through distinct points p, q as (A, B, C) with A*x+B*y+C = 0.
    Exact for rational/symbolic inputs."""
    sp = _sympy()
    (x1, y1), (x2, y2) = p, q
    A = sp.sympify(y2) - sp.sympify(y1)
    B = sp.sympify(x1) - sp.sympify(x2)
    C = -(A * sp.sympify(x1) + B * sp.sympify(y1))
    if all(v.is_rational for v in (A, B, C)):
        g = sp.gcd(sp.gcd(A, B), C)
        A, B, C = A / g, B / g, C / g
    return (sp.simplify(A), sp.simplify(B), sp.simplify(C))


def line_line_intersection(l1, l2):
    """Intersection point of two lines, or None if parallel."""
    sp = _sympy()
    A1, B1, C1 = l1
    A2, B2, C2 = l2
    D = A1 * B2 - A2 * B1
    if sp.simplify(D) == 0:
        return None
    x = (B1 * C2 - B2 * C1) / D
    y = (C1 * A2 - C2 * A1) / D
    return (sp.simplify(x), sp.simplify(y))


def radical_axis(c1, c2):
    """Radical axis of circles c1, c2 given as (h, k, r): the line of equal
    power. Exact."""
    sp = _sympy()
    h1, k1, r1 = (sp.sympify(v) for v in c1)
    h2, k2, r2 = (sp.sympify(v) for v in c2)
    A = 2 * (h2 - h1)
    B = 2 * (k2 - k1)
    C = h1**2 + k1**2 - r1**2 - (h2**2 + k2**2 - r2**2)
    return (sp.simplify(A), sp.simplify(B), sp.simplify(C))


def circle_circle_intersections(c1, c2):
    """Intersection points of two circles (h, k, r): 0, 1 (tangent), or 2.
    Numeric."""
    h1, k1, r1 = (float(v) for v in c1)
    h2, k2, r2 = (float(v) for v in c2)
    d = math.hypot(h2 - h1, k2 - k1)
    if d > r1 + r2 + 1e-12 or d < abs(r1 - r2) - 1e-12 or d == 0:
        return []
    a = (d**2 + r1**2 - r2**2) / (2 * d)
    h = math.sqrt(max(r1**2 - a**2, 0.0))
    xm, ym = h1 + a * (h2 - h1) / d, k1 + a * (k2 - k1) / d
    if h < 1e-12:
        return [(xm, ym)]
    rx, ry = -(k2 - k1) * h / d, (h2 - h1) * h / d
    return [(xm + rx, ym + ry), (xm - rx, ym - ry)]


def polar_line(center, radius, point):
    """Polar of `point` wrt circle (center, radius): exact line."""
    sp = _sympy()
    h, k = sp.sympify(center[0]), sp.sympify(center[1])
    r2 = sp.sympify(radius) ** 2
    x0, y0 = sp.sympify(point[0]), sp.sympify(point[1])
    A = x0 - h
    B = y0 - k
    C = -(A * h + B * k) - r2
    return (sp.simplify(A), sp.simplify(B), sp.simplify(C))


# --------------------------------------------------------------------- #
# Angle computations and locus root counting (numeric, labeled)
# --------------------------------------------------------------------- #
def angle_at_vertex(p, v, q) -> float:
    """Angle PVQ in degrees, in [0, 180]."""
    a1 = math.atan2(p[1] - v[1], p[0] - v[0])
    a2 = math.atan2(q[1] - v[1], q[0] - v[0])
    d = abs(math.degrees(a1 - a2)) % 360.0
    return d if d <= 180.0 else 360.0 - d


def count_angle_ratio_locus(p, q, r, ratio: int = 2, n_samples: int = 4000) -> Evidence:
    """Count points Y on the line through P, Q such that one of the angles
    ∠PYR, ∠QYR equals the other divided by ``ratio``.

    Numerical root count along the line (both ratio orientations), with the
    found roots as certificate. Explicitly numerical evidence.
    """
    if ratio < 2:
        raise ValueError("ratio must be >= 2")
    (x1, y1), (x2, y2), (xr, yr) = p, q, r
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy)
    if L == 0:
        raise ValueError("P and Q must be distinct")
    ux, uy = dx / L, dy / L

    def f(t, swapped):
        # Outside the OPEN segment P--Q the two rays to P and Q coincide,
        # so nonzero angles cannot have ratio >=2. At P/Q an angle arm is
        # undefined; its atan2 jump is not a root and must not be bracketed.
        if not 0 < t < L:
            return None
        y = (x1 + t * ux, y1 + t * uy)
        if math.hypot(y[0] - xr, y[1] - yr) < 1e-10:
            return None
        a1 = angle_at_vertex(p, y, r)
        a2 = angle_at_vertex(q, y, r)
        if min(a1, a2) < 1e-9:
            return None
        return (a1 - ratio * a2) if not swapped else (a2 - ratio * a1)

    roots = set()
    span = 3.0 * L
    for swapped in (False, True):
        prev_t, prev_f = None, None
        for i in range(-n_samples, n_samples + 1):
            t = i * (span / n_samples)
            ft = f(t, swapped)
            if ft is None:
                prev_t, prev_f = None, None
                continue
            if abs(ft) < 1e-10:
                roots.add((round(x1 + t * ux, 9), round(y1 + t * uy, 9)))
                prev_t, prev_f = None, None
                continue
            if prev_f is not None and ft * prev_f < 0:
                lo, hi = prev_t, t
                flo = prev_f
                for _ in range(60):
                    mid = (lo + hi) / 2
                    fm = f(mid, swapped)
                    if fm is None:
                        break
                    if abs(fm) < 1e-12:
                        lo = hi = mid
                        break
                    if fm * flo < 0:
                        hi = mid
                    else:
                        lo, flo = mid, fm
                yroot = (x1 + (lo + hi) / 2 * ux, y1 + (lo + hi) / 2 * uy)
                residual = f((lo + hi) / 2, swapped)
                if residual is not None and abs(residual) < 1e-7:
                    roots.add((round(yroot[0], 9), round(yroot[1], 9)))
            prev_t, prev_f = t, ft
    return Evidence(
        value=len(roots),
        certificate=f"roots_at={sorted(roots)}",
        self_check=(
            "NUMERICAL: sign-change + bisection over sampled line parameter"
        ),
        feasibility="ok",
        complexity_bound=f"O(n_samples) = O({n_samples})",
    )


def identify_constant(value: float, basis: tuple = ()) -> Evidence:
    """High-precision constant identification via sympy.nsimplify
    (conjecture-level: always labeled as such)."""
    sp = _sympy()
    guess = sp.nsimplify(value, list(basis))
    return Evidence(
        value=str(guess),
        certificate=f"nsimplify({value!r}, basis={basis})",
        self_check="CONJECTURE-LEVEL: identification, not a proof",
        feasibility="ok",
        complexity_bound="O(1)",
    )
