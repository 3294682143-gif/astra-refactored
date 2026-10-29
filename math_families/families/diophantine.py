"""diophantine family.

Structural criterion: low-degree Diophantine equations in two variables that
yield to substitution, factorization into linear factors, or quadratic-form
(discriminant-square) parametrization — solving and counting both included.

Tools:
- solve_quadratic_diophantine: integer solutions of the general bivariate
  quadratic a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0. Complete when the
  y-discriminant confines y to a provably tight interval (negative form
  discriminant), when the equation is linear in x and reduces to a constant
  divisibility (divisor enumeration / substitution factorization), or when
  the equation is linear outright (parametrized lattice line). Pell-type,
  parabolic, and degenerate infinite cases need an explicit y_bound and then
  honestly report a bounded horizon instead of claiming completeness.
- solve_quadratic_discriminant_family: equations c2*y^2 + c1(x)*y + c0(x) = 0
  with integer-polynomial coefficients in x; the discriminant is a
  polynomial in x tested for squareness over an exhaustive x-range. Covers
  quadratic-form = polynomial shapes after clearing powers (e.g. cubing
  both sides of a cube-root equation).
- bounded_diophantine_count: exact count of f(x, y) = 0 over an explicit
  box, budget-guarded, with a solution certificate.
- symbolic_diophantine_with_timeout: SymPy's diophantine inside a forked
  subprocess under a hard wall-clock timeout, so symbolic hangs or missing
  solvers come back as infeasible Evidence instead of stalling the caller.

Every returned solution set can be re-checked independently with
verify_quadratic_solutions / verify_discriminant_solutions.
"""
from __future__ import annotations

import math
import multiprocessing
import time
from typing import Callable, Sequence

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible, require_within_budget


# --------------------------------------------------------------------- #
# Small exact-integer helpers
# --------------------------------------------------------------------- #
def _ceil_div(p: int, q: int) -> int:
    return -((-p) // q)


def _divisors(n: int) -> list[int]:
    """All nonzero divisors of a nonzero integer, positive and negative."""
    if n == 0:
        raise ValueError("0 has infinitely many divisors")
    out = []
    for t in range(1, math.isqrt(abs(n)) + 1):
        if n % t == 0:
            out.extend((t, -t))
            if t * t != abs(n):
                out.extend((abs(n) // t, -(abs(n) // t)))
    return out


def _poly_eval(coeffs: Sequence[int], x: int) -> int:
    v = 0
    for c in reversed(coeffs):
        v = v * x + c
    return v


def _poly_mul(p: Sequence[int], q: Sequence[int]) -> list[int]:
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        for j, b in enumerate(q):
            r[i + j] += a * b
    return r


def _poly_scale(p: Sequence[int], k: int) -> list[int]:
    return [k * c for c in p]


def _poly_sub(p: Sequence[int], q: Sequence[int]) -> list[int]:
    n = max(len(p), len(q))
    r = [(p[i] if i < len(p) else 0) - (q[i] if i < len(q) else 0) for i in range(n)]
    while len(r) > 1 and r[-1] == 0:
        r.pop()
    return r


def _poly_str(coeffs: Sequence[int]) -> str:
    terms = []
    for i, c in enumerate(coeffs):
        if c == 0:
            continue
        mono = "1" if i == 0 else ("x" if i == 1 else f"x^{i}")
        if abs(c) != 1 or i == 0:
            terms.append(f"{c}*{mono}")
        else:
            terms.append(mono if c == 1 else f"-{mono}")
    return " + ".join(terms) if terms else "0"


def _fmt_points(points: list[tuple[int, int]], cap: int = 12) -> str:
    if len(points) <= cap:
        return str(points)
    return f"{points[:cap]}... ({len(points)} total)"


# --------------------------------------------------------------------- #
# Independent certificate checkers
# --------------------------------------------------------------------- #
def verify_quadratic_solutions(
    a: int, b: int, c: int, d: int, e: int, f: int,
    points: Sequence[tuple[int, int]],
) -> bool:
    """Re-substitute each pair into a*x^2+b*x*y+c*y^2+d*x+e*y+f."""
    return all(
        a * x * x + b * x * y + c * y * y + d * x + e * y + f == 0
        for x, y in points
    )


def verify_discriminant_solutions(
    c2: int, c1: Sequence[int], c0: Sequence[int],
    points: Sequence[tuple[int, int]],
) -> bool:
    """Re-substitute each pair into c2*y^2 + c1(x)*y + c0(x)."""
    return all(
        c2 * y * y + _poly_eval(c1, x) * y + _poly_eval(c0, x) == 0
        for x, y in points
    )


def verify_quadratic_solutions_evidence(
    a: int, b: int, c: int, d: int, e: int, f: int,
    points: Sequence[tuple[int, int]],
) -> Evidence:
    """Independent back-substitution check, as Evidence.

    Thin Evidence packaging over :func:`verify_quadratic_solutions`: every
    pair is re-substituted into a*x^2+b*x*y+c*y^2+d*x+e*y+f; the wrapper
    adds only the deterministic-checker self-check note. The verdict is the
    value (True only when every listed pair satisfies the equation).
    """
    ok = verify_quadratic_solutions(a, b, c, d, e, f, points)
    return Evidence(
        value=ok,
        certificate=(
            f"re-substituted {len(points)} pairs into "
            f"a*x^2+b*x*y+c*y^2+d*x+e*y+f: accepted={ok}"
        ),
        self_check="independent certificate re-derivation executed deterministically",
        feasibility="ok",
        complexity_bound=f"O(points) = O({len(points)})",
    )


# --------------------------------------------------------------------- #
# 1. General bivariate quadratic
# --------------------------------------------------------------------- #
def _roots_x_at_y(a: int, b: int, c: int, d: int, e: int, f: int, y: int) -> list[int]:
    """Integer x solving a*x^2 + (b*y+d)*x + (c*y^2+e*y+f) = 0; a != 0."""
    disc = (b * y + d) ** 2 - 4 * a * (c * y * y + e * y + f)
    if disc < 0:
        return []
    k = math.isqrt(disc)
    if k * k != disc:
        return []
    out = []
    for s in ((1,) if k == 0 else (1, -1)):  # k == 0: double root, count once
        num = -(b * y + d) + s * k
        if num % (2 * a) == 0:
            out.append(num // (2 * a))
    return out


def _bounded_scan(a: int, b: int, c: int, d: int, e: int, f: int, y_bound: int) -> list[tuple[int, int]]:
    sols = []
    for y in range(-y_bound, y_bound + 1):
        for x in _roots_x_at_y(a, b, c, d, e, f, y):
            sols.append((x, y))
    return sorted(set(sols))


def _solve_linear(d: int, e: int, f: int) -> Evidence:
    """d*x + e*y + f = 0: obstruction, empty, or a parametrized lattice line."""
    if d == 0 and e == 0:
        if f == 0:
            raise ValueError("0 = 0 is satisfied by every pair; not an equation")
        return Evidence(
            value=[],
            certificate=f"constant equation {f} = 0",
            self_check="a nonzero constant has no root: ok",
            feasibility="ok",
            complexity_bound="O(1)",
        )
    g = math.gcd(abs(d), abs(e))
    if f % g != 0:
        return Evidence(
            value=[],
            certificate=f"gcd(d,e)={g} does not divide {-f}",
            self_check=f"{-f} % {g} = {-f % g} != 0, divisibility obstruction: ok",
            feasibility="ok",
            complexity_bound="O(log|coeffs|) extended gcd",
        )
    g0, u, v = _egcd(abs(d), abs(e))
    sd = 1 if d >= 0 else -1
    se = 1 if e >= 0 else -1
    scale = -f // g0
    xp, yp = u * sd * scale, v * se * scale
    dir_x, dir_y = e // g0, -d // g0
    ok = d * xp + e * yp + f == 0 and d * dir_x + e * dir_y == 0
    return Evidence(
        value={"particular": (xp, yp), "direction": (dir_x, dir_y)},
        certificate=(
            f"solutions = ({xp},{yp}) + t*({dir_x},{dir_y}), t in Z; gcd={g0}"
        ),
        self_check=(
            f"d*particular+e*particular+f=0 and d*dir+e*dir=0: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(log|coeffs|) extended gcd",
    )


def _egcd(a: int, b: int) -> tuple[int, int, int]:
    """g, u, v with a*u + b*v = g = gcd(a, b); a, b >= 0."""
    old_r, r = a, b
    old_s, s = 1, 0
    old_t, t = 0, 1
    while r:
        q = old_r // r
        old_r, r = r, old_r - q * r
        old_s, s = s, old_s - q * s
        old_t, t = t, old_t - q * t
    return old_r, old_s, old_t


def _solve_y_quadratic_plus_linear_x(
    c: int, d: int, e: int, f: int, y_bound: int | None
) -> Evidence:
    """c*y^2 + e*y + f + d*x = 0 with c != 0 (quadratic in y, linear in x)."""
    if d == 0:
        disc = e * e - 4 * c * f
        roots: list[int] = []
        if disc >= 0:
            k = math.isqrt(disc)
            if k * k == disc:
                for s in ((1,) if k == 0 else (1, -1)):
                    num = -e + s * k
                    if num % (2 * c) == 0:
                        roots.append(num // (2 * c))
        if roots:
            return Evidence(
                value=None,
                certificate=f"y in {sorted(set(roots))} makes the equation identically 0 in x",
                self_check="each listed y re-roots the y-quadratic: ok",
                feasibility=infeasible(
                    "solution set contains entire vertical line(s); cannot list",
                    "O(1) discriminant",
                ),
                complexity_bound="O(1)",
            )
        return Evidence(
            value=[],
            certificate=f"y-discriminant {disc} gives no integer root",
            self_check="no y can satisfy the equation: ok",
            feasibility="ok",
            complexity_bound="O(1)",
        )
    if y_bound is None:
        m = abs(d)
        guard = require_within_budget(math.log10(m))
        if guard:
            return Evidence(None, "", "not attempted", guard, "O(|d|) residue scan")
        residues = [r for r in range(m) if (c * r * r + e * r + f) % m == 0]
        if not residues:
            return Evidence(
                value=[],
                certificate=f"c*y^2+e*y+f mod {m} is never 0 (full period scanned)",
                self_check=f"exhaustive scan of {m} residues: ok",
                feasibility="ok",
                complexity_bound=f"O(|d|) = O({m})",
            )
        return Evidence(
            value=None,
            certificate=f"working residues y mod {m}: {residues[:12]}{'...' if len(residues) > 12 else ''}",
            self_check="each residue re-satisfies the congruence: ok",
            feasibility=infeasible(
                f"infinite union of {len(residues)} arithmetic-progression families; "
                "supply y_bound to enumerate a window",
                f"O(|d|) = O({m}) residue scan",
            ),
            complexity_bound=f"O(|d|) = O({m})",
        )
    sols = []
    for y in range(-y_bound, y_bound + 1):
        s_val = c * y * y + e * y + f
        if s_val % d == 0:
            sols.append((-s_val // d, y))
    sols = sorted(set(sols))
    ok = verify_quadratic_solutions(0, 0, c, d, e, f, sols)
    return Evidence(
        value=sols,
        certificate=f"bounded horizon |y| <= {y_bound} (completeness only within it)",
        self_check=f"back-substitution of {len(sols)} pairs: {'ok' if ok else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound=f"O(y_bound) = O({y_bound})",
    )


def _solve_linear_in_x(
    b: int, c: int, d: int, e: int, f: int, y_bound: int | None
) -> Evidence:
    """(b*y + d)*x = -(c*y^2 + e*y + f) with b != 0."""
    # t = b*y + d divides S(y) = c*y^2+e*y+f  =>  t divides b^2*S(y),
    # and b^2*S(y) = t*Q(t) + R with constant remainder R = c*d^2 - e*b*d + f*b^2.
    R = c * d * d - e * b * d + f * b * b
    if R != 0:
        guard = require_within_budget(math.log10(math.isqrt(abs(R)) + 1))
        if guard:
            return Evidence(None, "", "not attempted", guard, "O(sqrt|R|) divisor scan")
        sols = []
        divs = _divisors(R)
        for t in divs:
            if (t - d) % b != 0:
                continue
            y = (t - d) // b
            s_val = c * y * y + e * y + f
            if s_val % t == 0:  # direct check; t | b^2*S need not imply t | S
                sols.append((-s_val // t, y))
        sols = sorted(set(sols))
        ok = verify_quadratic_solutions(0, b, c, d, e, f, sols)
        return Evidence(
            value=sols,
            certificate=(
                f"t=(b*y+d) must divide R={R} (b^2*S(y)=t*Q(t)+R); "
                f"{len(divs)} divisors tested; solutions={_fmt_points(sols)}"
            ),
            self_check=(
                f"back-substitution of {len(sols)} pairs: "
                f"{'ok' if ok else 'MISMATCH'}; complete by divisor exhaustion"
            ),
            feasibility="ok",
            complexity_bound=f"O(tau(R)) with |R|={abs(R)}",
        )
    # R == 0: divisibility may hold on unbounded sets; bounded scan only.
    if y_bound is None:
        return Evidence(
            value=None,
            certificate=f"remainder R = c*d^2-e*b*d+f*b^2 = 0; divisor method inconclusive",
            self_check="not attempted",
            feasibility=infeasible(
                "degenerate factorization (remainder 0): possibly unbounded; supply y_bound",
                "O(1) remainder test",
            ),
            complexity_bound="O(1)",
        )
    sols = []
    for y in range(-y_bound, y_bound + 1):
        t = b * y + d
        s_val = c * y * y + e * y + f
        if t == 0:
            if s_val == 0:
                return Evidence(
                    value=None,
                    certificate=f"y={y} zeroes both sides: entire vertical line of solutions",
                    self_check="0*x = 0 at this y: ok",
                    feasibility=infeasible(
                        "solution set contains a vertical line; cannot list",
                        "O(y_bound) scan",
                    ),
                    complexity_bound=f"O(y_bound) = O({y_bound})",
                )
            continue
        if s_val % t == 0:
            sols.append((-s_val // t, y))
    sols = sorted(set(sols))
    ok = verify_quadratic_solutions(0, b, c, d, e, f, sols)
    return Evidence(
        value=sols,
        certificate=f"bounded horizon |y| <= {y_bound} (completeness only within it)",
        self_check=f"back-substitution of {len(sols)} pairs: {'ok' if ok else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound=f"O(y_bound) = O({y_bound})",
    )


def solve_quadratic_diophantine(
    a: int, b: int, c: int, d: int, e: int, f: int, y_bound: int | None = None
) -> Evidence:
    """Integer solutions of a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0.

    value is a sorted list of (x, y) pairs, or a parametrization dict for a
    linear equation with infinitely many solutions. Completeness:
    - form discriminant A = b^2-4ac < 0: exact y-interval, fully complete;
    - linear-in-x with nonzero remainder R: complete by divisor exhaustion;
    - otherwise an explicit y_bound is required and the horizon is stated.
    Certificate: interval/divisor derivation plus the solution list;
    self-check: back-substitution of every returned pair.
    """
    if y_bound is not None and y_bound < 0:
        raise ValueError("y_bound must be non-negative")
    if a == 0 and b == 0 and c == 0:
        return _solve_linear(d, e, f)
    if a == 0 and b == 0:
        return _solve_y_quadratic_plus_linear_x(c, d, e, f, y_bound)
    if a == 0:
        return _solve_linear_in_x(b, c, d, e, f, y_bound)

    A = b * b - 4 * a * c
    B = 2 * b * d - 4 * a * e
    C = d * d - 4 * a * f

    if A < 0:
        # D(y) = A*y^2+B*y+C >= 0 confines y to a tight interval.
        delta_y = B * B - 4 * A * C
        if delta_y < 0:
            return Evidence(
                value=[],
                certificate="D(y) = A*y^2+B*y+C has A<0 and no real root: D(y) < 0 everywhere",
                self_check="no y admits a real x: ok",
                feasibility="ok",
                complexity_bound="O(1) discriminant test",
            )
        s = math.isqrt(delta_y)
        # D(y) >= 0  <=>  (2A*y+B)^2 <= delta_y  <=>  |2A*y+B| <= s (exact, integer).
        y_lo = _ceil_div(s - B, 2 * A)
        y_hi = (-s - B) // (2 * A)
        n = y_hi - y_lo + 1
        if n > 0:
            guard = require_within_budget(math.log10(n))
            if guard:
                return Evidence(None, "", "not attempted", guard, f"O(interval) = O({n})")
        sols = []
        for y in range(y_lo, y_hi + 1):
            for x in _roots_x_at_y(a, b, c, d, e, f, y):
                sols.append((x, y))
        sols = sorted(set(sols))
        tight = (
            A * (y_lo - 1) ** 2 + B * (y_lo - 1) + C < 0
            and A * (y_hi + 1) ** 2 + B * (y_hi + 1) + C < 0
        ) if n > 0 else True
        ok = verify_quadratic_solutions(a, b, c, d, e, f, sols)
        return Evidence(
            value=sols,
            certificate=(
                f"D(y)={A}*y^2+{B}*y+{C}, |2A*y+B|<=isqrt({delta_y})={s} gives "
                f"y in [{y_lo},{y_hi}] (tight={tight}); solutions={_fmt_points(sols)}"
            ),
            self_check=(
                f"back-substitution of {len(sols)} pairs: {'ok' if ok else 'MISMATCH'}; "
                f"interval exhaustive: {'ok' if tight else 'MISMATCH'}"
            ),
            feasibility="ok",
            complexity_bound=f"O(interval) = O({max(n, 0)})",
        )

    # A >= 0: Pell-type / parabolic / degenerate — possibly infinite.
    if A == 0 and B == 0:
        if C < 0 or math.isqrt(C) ** 2 != C:
            return Evidence(
                value=[],
                certificate=f"D(y) is the constant {C}, never a non-negative square",
                self_check="no y admits a real x: ok",
                feasibility="ok",
                complexity_bound="O(1)",
            )
        reason = f"D(y) is the constant square {C}: solutions form unbounded families"
    elif A == 0:
        reason = f"form discriminant A=0, D(y)={B}*y+{C} linear: half-line of candidates"
    else:
        reason = f"positive form discriminant A={A}: Pell-type, solution set may be infinite"
    if y_bound is None:
        return Evidence(
            value=None,
            certificate=reason,
            self_check="not attempted",
            feasibility=infeasible(f"{reason}; supply y_bound", "O(1) discriminant test"),
            complexity_bound="O(1)",
        )
    guard = require_within_budget(math.log10(2 * y_bound + 1))
    if guard:
        return Evidence(None, "", "not attempted", guard, f"O(y_bound) = O({y_bound})")
    sols = _bounded_scan(a, b, c, d, e, f, y_bound)
    ok = verify_quadratic_solutions(a, b, c, d, e, f, sols)
    return Evidence(
        value=sols,
        certificate=(
            f"{reason}; bounded horizon |y| <= {y_bound} "
            f"(completeness only within it); solutions={_fmt_points(sols)}"
        ),
        self_check=f"back-substitution of {len(sols)} pairs: {'ok' if ok else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound=f"O(y_bound) = O({y_bound})",
    )


# --------------------------------------------------------------------- #
# 2. Quadratic in y with polynomial coefficients in x
# --------------------------------------------------------------------- #
def solve_quadratic_discriminant_family(
    c2: int,
    c1: Sequence[int],
    c0: Sequence[int],
    x_lo: int,
    x_hi: int,
) -> Evidence:
    """Integer solutions of c2*y^2 + c1(x)*y + c0(x) = 0 with x in [x_lo, x_hi].

    c1, c0 are integer polynomials in x given as ascending coefficient
    tuples. The discriminant D(x) = c1(x)^2 - 4*c2*c0(x) is a polynomial;
    each x in range is tested for D(x) being a perfect square and for the
    divisibility 2*c2 | -c1(x) +/- sqrt(D(x)). The x-range is exhaustive,
    so completeness holds exactly on the stated horizon.
    """
    if c2 == 0:
        raise ValueError("c2 must be nonzero (equation must be quadratic in y)")
    if not c1 or not c0:
        raise ValueError("c1 and c0 must be non-empty coefficient sequences")
    if x_lo > x_hi:
        raise ValueError("empty x-range")
    n = x_hi - x_lo + 1
    deg = max(len(c1), len(c0))
    guard = require_within_budget(math.log10(n) + math.log10(deg + 1))
    if guard:
        return Evidence(None, "", "not attempted", guard, f"O(range*deg) = O({n}*{deg})")

    dpoly = _poly_sub(_poly_mul(c1, c1), _poly_scale(c0, 4 * c2))
    sols: list[tuple[int, int]] = []
    for x in range(x_lo, x_hi + 1):
        disc = _poly_eval(dpoly, x)
        if disc < 0:
            continue
        k = math.isqrt(disc)
        if k * k != disc:
            continue
        v1 = _poly_eval(c1, x)
        for s in ((1,) if k == 0 else (1, -1)):
            num = -v1 + s * k
            if num % (2 * c2) == 0:
                sols.append((x, num // (2 * c2)))
    sols = sorted(set(sols))
    ok = verify_discriminant_solutions(c2, c1, c0, sols)
    return Evidence(
        value=sols,
        certificate=(
            f"D(x)={_poly_str(dpoly)}; every x in [{x_lo},{x_hi}] tested for "
            f"square discriminant; solutions={_fmt_points(sols)}"
        ),
        self_check=(
            f"back-substitution of {len(sols)} pairs: {'ok' if ok else 'MISMATCH'}; "
            f"x-range exhaustive on [{x_lo},{x_hi}]"
        ),
        feasibility="ok",
        complexity_bound=f"O(range*deg) = O({n}*{deg})",
    )


# --------------------------------------------------------------------- #
# 3. Exact box counting
# --------------------------------------------------------------------- #
def bounded_diophantine_count(
    f: Callable[[int, int], int],
    x_lo: int,
    x_hi: int,
    y_lo: int,
    y_hi: int,
    certificate_cap: int = 32,
) -> Evidence:
    """Exact number of (x, y) in the box with f(x, y) == 0.

    value is the count; the certificate lists the solutions (up to
    certificate_cap) so each can be re-evaluated independently.
    """
    if x_lo > x_hi or y_lo > y_hi:
        raise ValueError("empty box")
    ops = (x_hi - x_lo + 1) * (y_hi - y_lo + 1)
    guard = require_within_budget(math.log10(ops))
    if guard:
        return Evidence(None, "", "not attempted", guard, f"O(box) = O({ops})")
    sols = [
        (x, y)
        for x in range(x_lo, x_hi + 1)
        for y in range(y_lo, y_hi + 1)
        if f(x, y) == 0
    ]
    listed = sols[:certificate_cap]
    ok = all(f(x, y) == 0 for x, y in listed)
    truncated = len(sols) > certificate_cap
    return Evidence(
        value=len(sols),
        certificate=(
            f"solutions={listed}{'... truncated' if truncated else ''}; "
            f"box [{x_lo},{x_hi}]x[{y_lo},{y_hi}] exhaustive"
        ),
        self_check=(
            f"re-evaluation of {len(listed)} listed solutions: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(box) = O({ops})",
    )


# --------------------------------------------------------------------- #
# 4. Symbolic solver under a hard subprocess timeout
# --------------------------------------------------------------------- #
def _isolated_worker(queue, fn, args):
    try:
        queue.put(("ok", fn(*args)))
    except Exception as exc:  # noqa: BLE001 - ferry any failure to the parent
        queue.put(("error", repr(exc)))


def _run_isolated(fn, timeout_ms: int, *args):
    """Run fn(*args) in a forked subprocess with a hard wall-clock timeout.

    Returns (payload, timed_out, error_repr). A C-level hang (e.g. a
    symbolic solver that never returns) is killed rather than blocking the
    caller; the orphan is reaped.
    """
    ctx = multiprocessing.get_context("fork")
    queue = ctx.Queue()
    proc = ctx.Process(target=_isolated_worker, args=(queue, fn, args))
    proc.start()
    try:
        tag, payload = queue.get(timeout=timeout_ms / 1000.0)
        proc.join(timeout=2)
        if proc.is_alive():
            proc.kill()
            proc.join(timeout=2)
        if tag == "ok":
            return payload, False, None
        return None, False, payload
    except Exception:  # queue.Empty: deadline exceeded
        proc.kill()
        proc.join(timeout=2)
        return None, True, None


def _sympy_diophantine_worker(lhs: str, rhs: str, variables: tuple[str, ...]):
    import sympy as sp

    syms = sp.symbols(variables)
    eq = sp.Eq(sp.sympify(lhs), sp.sympify(rhs))
    result = sp.diophantine(eq, syms)
    return sorted({tuple(str(entry) for entry in tup) for tup in result})


def symbolic_diophantine_with_timeout(
    lhs: str,
    rhs: str = "0",
    variables: Sequence[str] = ("x", "y"),
    timeout_ms: int = 20_000,
) -> Evidence:
    """SymPy diophantine on Eq(lhs, rhs), guarded by a subprocess timeout.

    value is the sorted list of solution tuples (entries as strings, possibly
    parametric). A hang, crash, or missing solver yields an infeasible
    Evidence — never a stuck caller. Self-check: integer solutions are
    re-substituted into lhs - rhs (first 40 tuples).
    """
    if timeout_ms <= 0:
        raise ValueError("timeout_ms must be positive")
    started = time.monotonic()
    payload, timed_out, error = _run_isolated(
        _sympy_diophantine_worker, timeout_ms, lhs, rhs, tuple(variables)
    )
    elapsed_ms = (time.monotonic() - started) * 1000
    if timed_out:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"subprocess killed at {timeout_ms} ms deadline",
            feasibility=infeasible(
                f"symbolic solver exceeded {timeout_ms} ms wall-clock; subprocess killed",
                "unguarded symbolic search (hang risk)",
            ),
            complexity_bound="unbounded (symbolic); caller-side guard O(1)",
        )
    if error is not None:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"solver raised in subprocess: {error}",
            feasibility=infeasible(
                f"symbolic solver failed: {error}", "symbolic capability boundary"
            ),
            complexity_bound="unbounded (symbolic)",
        )
    checked = skipped = 0
    check_ok = True
    try:
        import sympy as sp

        syms = sp.symbols(tuple(variables))
        residual = sp.sympify(f"({lhs}) - ({rhs})")
        for tup in payload[:40]:
            try:
                nums = [int(entry) for entry in tup]
            except ValueError:
                skipped += 1  # parametric entry: cannot re-substitute directly
                continue
            if residual.subs(dict(zip(syms, nums))) != 0:
                check_ok = False
            checked += 1
    except ImportError:
        skipped = len(payload)
    return Evidence(
        value=payload,
        certificate=(
            f"sympy diophantine({lhs} = {rhs}) over {tuple(variables)} -> "
            f"{len(payload)} tuples in {elapsed_ms:.0f} ms"
        ),
        self_check=(
            f"re-substituted {checked} integer tuples ({skipped} parametric skipped): "
            f"{'ok' if check_ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="unbounded (symbolic); wall-clock guarded",
    )
