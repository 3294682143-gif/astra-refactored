"""inequality_extremum family.

Structural criterion: extrema of symmetric / ordering / convexity
inequalities over continuous boxes or finitely generated integer domains.
The family separates conjecture from verification: a numeric search
proposes an extremum value, a closed-form recognizer proposes a symbolic
candidate, and a certificate checker independently re-verifies a claimed
inequality direction and its tightness on fresh random instances. Search
outcomes are evidence, never final answers.

Tools:
- numeric_extremum_search: multi-start Nelder-Mead over a box with an
  optional penalty constraint; the reported point is the certificate.
- certificate_check: sampled verification of margin(x) >= 0; reports the
  minimum margin, its witness point, and the violation count.
- closed_form_conjecture: decimal -> closed-form candidate (symbolic
  backend in a forked child under a hard timeout; stdlib fallback).
- subset_gap_worst_case: maximin over bounded integer sequences of the
  subset-sum distance to a target; the witness sequence is certified
  exactly by a subset-sum DP.
"""
from __future__ import annotations

import importlib.util
import math
import random
from fractions import Fraction
from typing import Callable, Iterable, Sequence

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible
from math_families.core.guard import run_with_timeout

#: Hard dimension cap for the numeric search (keeps simplexes small).
_MAX_DIM = 256
#: Hard cap on the subset-sum DP bitset length.
_MAX_DP_BITS = 4_000_000


# --------------------------------------------------------------------- #
# Nelder-Mead simplex core (derivative-free, box-clamped)
# --------------------------------------------------------------------- #
def _nelder_mead(
    f: Callable[[list[float]], float],
    x0: Sequence[float],
    bounds: Sequence[tuple[float, float]],
    max_iter: int,
    tol: float,
    evals_left: list[int],
) -> tuple[list[float], float]:
    """Minimize f from x0. Returns (best_point, best_value)."""
    n = len(x0)
    lo = [b[0] for b in bounds]
    hi = [b[1] for b in bounds]

    def clamp(x: Sequence[float]) -> list[float]:
        return [min(max(v, lo[i]), hi[i]) for i, v in enumerate(x)]

    def ev(x: Sequence[float]) -> float:
        evals_left[0] -= 1
        return f(clamp(x))

    simplex = [clamp(x0)]
    for i in range(n):
        x = list(simplex[0])
        step = 0.05 * (hi[i] - lo[i])
        x[i] += step if x[i] + step <= hi[i] else -step
        simplex.append(clamp(x))
    vals = [ev(x) for x in simplex]

    for _ in range(max_iter):
        if evals_left[0] <= 0:
            break
        order = sorted(range(n + 1), key=lambda i: vals[i])
        simplex = [simplex[i] for i in order]
        vals = [vals[i] for i in order]
        fspread = abs(vals[-1] - vals[0])
        xspread = max(
            abs(simplex[j][i] - simplex[0][i])
            for j in range(1, n + 1)
            for i in range(n)
        )
        if fspread < tol and xspread < max(tol, 1e-12) ** 0.5:
            break
        centroid = [sum(simplex[j][i] for j in range(n)) / n for i in range(n)]
        worst = simplex[-1]
        xr = [centroid[i] + (centroid[i] - worst[i]) for i in range(n)]
        fr = ev(xr)
        if fr < vals[0]:  # reflection wins: try expansion
            xe = [centroid[i] + 2.0 * (xr[i] - centroid[i]) for i in range(n)]
            fe = ev(xe)
            simplex[-1], vals[-1] = (clamp(xe), fe) if fe < fr else (clamp(xr), fr)
        elif fr < vals[-2]:
            simplex[-1], vals[-1] = clamp(xr), fr
        else:
            if fr < vals[-1]:  # outside contraction
                xc = [centroid[i] + 0.5 * (xr[i] - centroid[i]) for i in range(n)]
                fc = ev(xc)
                if fc <= fr:
                    simplex[-1], vals[-1] = clamp(xc), fc
                    continue
            else:  # inside contraction
                xc = [centroid[i] - 0.5 * (centroid[i] - worst[i]) for i in range(n)]
                fc = ev(xc)
                if fc < vals[-1]:
                    simplex[-1], vals[-1] = clamp(xc), fc
                    continue
            # shrink toward the best point
            best = simplex[0]
            for j in range(1, n + 1):
                simplex[j] = clamp(
                    [best[i] + 0.5 * (simplex[j][i] - best[i]) for i in range(n)]
                )
                vals[j] = ev(simplex[j])
                if evals_left[0] <= 0:
                    break
    best_idx = min(range(n + 1), key=lambda i: vals[i])
    return simplex[best_idx], vals[best_idx]


# --------------------------------------------------------------------- #
# 1. Multi-start numeric extremum search (conjecture producer)
# --------------------------------------------------------------------- #
def numeric_extremum_search(
    objective: Callable[[list[float]], float],
    dim: int,
    bounds: Sequence[tuple[float, float]] | None = None,
    *,
    maximize: bool = True,
    constraint_violation: Callable[[list[float]], float] | None = None,
    penalty: float = 1e6,
    restarts: int = 24,
    max_iter: int = 400,
    starts: Iterable[Sequence[float]] | None = None,
    seed: int = 0,
    tol: float = 1e-10,
    feas_tol: float = 1e-7,
    eval_budget: int = 2_000_000,
) -> Evidence:
    """Multi-start Nelder-Mead extremum search over a box.

    ``objective`` receives a list of ``dim`` floats. ``bounds`` defaults
    to [-1, 1]^dim. ``constraint_violation(x)`` must return >= 0 with 0 on
    the feasible set; it is enforced by a quadratic-free linear penalty
    ``penalty * violation``. The result is a conjecture: the certificate
    is the reported point itself (anyone may re-evaluate objective and
    violation there); the self-check re-evaluates both and probes random
    small perturbations for improvements.
    """
    if dim < 1:
        raise ValueError("dim must be >= 1")
    if dim > _MAX_DIM:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"dimension {dim} > cap {_MAX_DIM}", "O(restarts*max_iter*dim)"
            ),
            complexity_bound="O(restarts*max_iter*dim)",
        )
    if bounds is None:
        bounds = [(-1.0, 1.0)] * dim
    if len(bounds) != dim:
        raise ValueError("bounds must have one (lo, hi) pair per dimension")
    for lo, hi in bounds:
        if not (math.isfinite(lo) and math.isfinite(hi) and lo < hi):
            raise ValueError("each bound must be finite with lo < hi")
    if restarts < 1 or max_iter < 1 or penalty <= 0:
        raise ValueError("bad restarts/max_iter/penalty")
    start_points = [list(s) for s in (starts or [])]
    for s in start_points:
        if len(s) != dim:
            raise ValueError("each start must have dim coordinates")
    estimated = (restarts + len(start_points)) * max_iter * (dim + 1)
    if estimated > eval_budget:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"estimated {estimated:.3g} evals > budget {eval_budget:.3g}",
                "O(restarts*max_iter*dim)",
            ),
            complexity_bound="O(restarts*max_iter*dim)",
        )

    rng = random.Random(seed)
    sign = -1.0 if maximize else 1.0

    def penalized(x: list[float]) -> float:
        v = float(objective(x))
        if not math.isfinite(v):
            return math.inf
        if constraint_violation is None:
            return sign * v
        vio = float(constraint_violation(x))
        if not math.isfinite(vio):
            return math.inf
        return sign * v + penalty * max(0.0, vio)

    evals_left = [eval_budget]
    restart_rows: list[tuple[float, list[float], float]] = []  # (obj, x, viol)
    initial = start_points + [
        [rng.uniform(lo, hi) for lo, hi in bounds] for _ in range(restarts)
    ]
    for x0 in initial:
        bx, _ = _nelder_mead(penalized, x0, bounds, max_iter, tol, evals_left)
        obj = float(objective(bx))
        vio = (
            float(constraint_violation(bx))
            if constraint_violation is not None
            else 0.0
        )
        restart_rows.append((obj, bx, vio))
        if evals_left[0] <= 0:
            break

    feasible = [r for r in restart_rows if r[2] <= feas_tol]
    if not feasible:
        return Evidence(
            value=None,
            certificate="",
            self_check=(
                f"no point with violation <= {feas_tol} across "
                f"{len(restart_rows)} restarts"
            ),
            feasibility=infeasible(
                "no feasible point located", "penalty method, multi-start"
            ),
            complexity_bound="O(restarts*max_iter*dim)",
        )
    feasible.sort(key=lambda r: r[0], reverse=maximize)
    best_obj, best_x, best_vio = feasible[0]
    top = [r[0] for r in feasible[:5]]
    spread = max(top) - min(top) if len(top) > 1 else 0.0

    # Self-check: re-evaluation plus a local perturbation probe.
    recheck = float(objective(best_x))
    scale = max(1.0, abs(best_obj))
    re_ok = abs(recheck - best_obj) <= 1e-9 * scale
    improving = 0
    probes = 12
    for _ in range(probes):
        px = [
            v + rng.uniform(-1e-5, 1e-5) * (bounds[i][1] - bounds[i][0])
            for i, v in enumerate(best_x)
        ]
        px = [min(max(v, bounds[i][0]), bounds[i][1]) for i, v in enumerate(px)]
        pvio = (
            float(constraint_violation(px)) if constraint_violation is not None else 0.0
        )
        if pvio <= feas_tol:
            pobj = float(objective(px))
            better = pobj > best_obj + 1e-6 * scale if maximize else pobj < best_obj - 1e-6 * scale
            if better:
                improving += 1
    probe_note = (
        f"{improving}/{probes} perturbations improve (boundary/plateau: interpret with care)"
        if improving
        else f"0/{probes} improving perturbations: ok"
    )
    return Evidence(
        value={
            "extremum": best_obj,
            "point": best_x,
            "violation": best_vio,
            "mode": "max" if maximize else "min",
            "restarts": len(restart_rows),
        },
        certificate=(
            f"point={[round(v, 12) for v in best_x]} obj={best_obj:.12g} "
            f"viol={best_vio:.3g} top{len(top)}_spread={spread:.3g}"
        ),
        self_check=(
            f"re-eval {'ok' if re_ok else 'MISMATCH'}; {probe_note}"
        ),
        feasibility="ok",
        complexity_bound=(
            f"O((restarts+starts)*max_iter*(dim+1)); used "
            f"{eval_budget - evals_left[0]} evals"
        ),
    )


# --------------------------------------------------------------------- #
# 2. Sampled certificate check of a claimed inequality direction
# --------------------------------------------------------------------- #
def certificate_check(
    margin: Callable[[object], float],
    sampler: Callable[[random.Random], object],
    *,
    n_samples: int = 2000,
    seed: int = 0,
    tol: float = 1e-9,
    tight_tol: float = 1e-6,
    eval_budget: int = 10_000_000,
) -> Evidence:
    """Verify the claim ``margin(x) >= 0`` on random instances.

    ``sampler(rng)`` draws an instance; ``margin(x)`` is the claimed
    left-minus-right side. The reported value carries the minimum margin
    seen, its witness point, and the violation count; ``tight`` flags
    whether equality is approached (min margin <= tight_tol), which is
    the extremum-point re-check half of the contract. A nonzero
    violation count refutes the claim; zero violations over n_samples is
    supporting evidence, never a proof.
    """
    if n_samples < 1:
        raise ValueError("n_samples must be >= 1")
    if n_samples > eval_budget:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{n_samples} samples > budget {eval_budget}", "O(n_samples)"
            ),
            complexity_bound="O(n_samples)",
        )
    rng = random.Random(seed)
    min_margin = math.inf
    argmin: object = None
    violations = 0
    for _ in range(n_samples):
        x = sampler(rng)
        m = float(margin(x))
        if not math.isfinite(m):
            violations += 1
            continue
        if m < min_margin:
            min_margin = m
            argmin = x
        if m < -tol:
            violations += 1
    recheck = float(margin(argmin)) if argmin is not None else math.inf
    re_ok = abs(recheck - min_margin) <= 1e-9 * max(1.0, abs(min_margin))
    return Evidence(
        value={
            "min_margin": min_margin,
            "argmin": argmin,
            "violations": violations,
            "samples": n_samples,
            "tight": min_margin <= tight_tol,
        },
        certificate=f"argmin={argmin!r} margin={min_margin:.6g}",
        self_check=(
            f"witness re-eval {'ok' if re_ok else 'MISMATCH'}; "
            f"{violations} violations over {n_samples} samples: "
            f"{'ok' if violations == 0 else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(n_samples)",
    )


# --------------------------------------------------------------------- #
# 3. Decimal -> closed-form conjecture (guarded symbolic backend)
# --------------------------------------------------------------------- #
_SYMBOLIC_CONSTANTS = ("pi", "e", "euler", "sqrt2", "ln2", "phi")


def _symbolic_candidate(value_str: str, constant_names: tuple[str, ...], tol: float) -> str:
    import sympy  # noqa: PLC0415 - child-process import by design

    table = {
        "pi": sympy.pi,
        "e": sympy.E,
        "euler": sympy.EulerGamma,
        "sqrt2": sympy.sqrt(2),
        "ln2": sympy.log(2),
        "phi": (1 + sympy.sqrt(5)) / 2,
    }
    consts = [table[n] for n in constant_names]
    v = sympy.Float(value_str, 30)
    expr = sympy.nsimplify(v, constants=consts, tolerance=tol, full=False)
    return str(expr)


def _rational_surd_fallback(
    value: float, max_denominator: int, rel_tol: float
) -> tuple[str, float] | None:
    """Recognize rationals and pure quadratic surds without a backend."""
    scale = max(1.0, abs(value))
    frac = Fraction(value).limit_denominator(max_denominator)
    if abs(float(frac) - value) <= rel_tol * scale:
        return str(frac), abs(float(frac) - value)
    if value != 0.0:
        f2 = Fraction(value * value).limit_denominator(max_denominator)
        root = math.sqrt(float(f2))
        if f2 > 0 and abs(root - abs(value)) <= rel_tol * scale:
            sign = "-" if value < 0 else ""
            num, den = f2.numerator, f2.denominator
            rnum, rden = math.isqrt(num), math.isqrt(den)
            if den == 1:
                if rnum * rnum != num:
                    return f"{sign}sqrt({num})", abs(root - abs(value))
            elif rden * rden == den:
                if rnum * rnum != num:
                    return f"{sign}sqrt({num})/{rden}", abs(root - abs(value))
            else:
                return f"{sign}sqrt({num}/{den})", abs(root - abs(value))
    return None


def closed_form_conjecture(
    value: float,
    *,
    constants: Sequence[str] = (),
    max_denominator: int = 1_000_000,
    rel_tol: float = 1e-9,
    timeout_ms: int = 4000,
) -> Evidence:
    """Propose a closed form for a decimal value.

    Tries the symbolic backend's nsimplify in a forked child under a hard
    timeout (the backend can wedge at C level), then a stdlib
    rational/quadratic-surd fallback. The parent independently
    re-evaluates the candidate and reports the residual as the
    certificate. The result is always a conjecture string, never a proof
    of closed-form correctness.
    """
    if not math.isfinite(value):
        raise ValueError("value must be finite")
    if not 100 <= timeout_ms <= 60_000:
        raise ValueError("timeout_ms must be in [100, 60000]")
    unknown = [c for c in constants if c not in _SYMBOLIC_CONSTANTS]
    if unknown:
        raise ValueError(f"unknown constants: {unknown}; known: {_SYMBOLIC_CONSTANTS}")
    if max_denominator < 1:
        raise ValueError("max_denominator must be >= 1")

    notes: list[str] = []
    candidate: str | None = None
    residual = math.inf
    if importlib.util.find_spec("sympy") is not None:
        status, payload = run_with_timeout(
            _symbolic_candidate, timeout_ms, repr(float(value)), tuple(constants), rel_tol
        )
        if status == "ok":
            import sympy  # noqa: PLC0415 - verification in the parent

            expr = sympy.sympify(payload)
            if expr.is_Float:
                notes.append("symbolic backend returned the raw float (no match)")
            else:
                residual = abs(float(expr) - value)
                if residual <= rel_tol * max(1.0, abs(value)):
                    candidate = payload
                else:
                    notes.append(f"symbolic candidate residual {residual:.3g} too large")
        elif status == "timeout":
            notes.append(f"symbolic backend timeout after {timeout_ms} ms")
        else:
            notes.append(f"symbolic backend error: {payload}")
    else:
        notes.append("symbolic backend unavailable")

    if candidate is None:
        fb = _rational_surd_fallback(value, max_denominator, rel_tol)
        if fb is not None:
            candidate, residual = fb
            notes.append("stdlib rational/surd fallback used")

    scale = max(1.0, abs(value))
    ok = candidate is not None and residual <= rel_tol * scale
    if not ok:
        return Evidence(
            value=None,
            certificate="",
            self_check="; ".join(notes) or "no closed form within tolerance",
            feasibility=infeasible(
                "no closed form matched within tolerance",
                "nsimplify + rational/surd fallback",
            ),
            complexity_bound="O(1) + symbolic backend",
        )
    return Evidence(
        value=candidate,
        certificate=f"|candidate - value| = {residual:.3e}",
        self_check=(
            f"residual {residual:.3e} <= rel_tol*{scale:.3g}: ok"
            + ("; " + "; ".join(notes) if notes else "")
        ),
        feasibility="ok",
        complexity_bound="O(1) + symbolic backend",
    )


# --------------------------------------------------------------------- #
# 4. Worst-case subset-sum gap over bounded integer sequences
# --------------------------------------------------------------------- #
def _subset_dp_bits(seq: Sequence[int]) -> list[int]:
    """Prefix bitsets: bits[k] has bit s set iff a subset of seq[:k] sums to s."""
    bits = [1]
    for v in seq:
        bits.append(bits[-1] | (bits[-1] << v))
    return bits


def _gap_and_nearest(seq: Sequence[int], target: int) -> tuple[int, int, list[int]] | None:
    """Exact min over subsets of |sum - target|; None when total < target."""
    bits = _subset_dp_bits(seq)
    full = bits[-1]
    d = 0
    while True:
        lo = target - d
        if lo >= 0 and (full >> lo) & 1:
            nearest = lo
            break
        hi = target + d
        if (full >> hi) & 1:
            nearest = hi
            break
        d += 1
    # Reconstruct one achieving subset from the prefix bitsets.
    subset: list[int] = []
    s = nearest
    for i in range(len(seq) - 1, -1, -1):
        if s >= seq[i] and (bits[i] >> (s - seq[i])) & 1:
            subset.append(i)
            s -= seq[i]
    return d, nearest, subset


def subset_gap_worst_case(
    bound: int,
    target: int,
    *,
    n_terms: int,
    restarts: int = 60,
    max_passes: int = 100,
    seed: int = 0,
    eval_budget: int = 2_000_000,
) -> Evidence:
    """Maximin over integer sequences of the subset-sum distance to target.

    Considers sequences of ``n_terms`` values in [0, ``bound``] with total
    >= ``target`` and searches (random restarts + local moves) for one
    whose every subset sum stays far from ``target``. The inner distance
    is computed exactly by a bitset DP, so the reported witness's gap is
    certified; the claim that no sequence does worse remains a search
    outcome (conjecture level), which is exactly the intended split.
    """
    if bound < 1 or target < 0 or n_terms < 1:
        raise ValueError("need bound >= 1, target >= 0, n_terms >= 1")
    total_cap = n_terms * bound
    if total_cap < target:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"sum floor {target} unreachable: {n_terms}*{bound} = {total_cap}",
                "O(n_terms*bound) subset DP",
            ),
            complexity_bound="O(n_terms*bound)",
        )
    if total_cap > _MAX_DP_BITS:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"DP bitset length {total_cap} > cap {_MAX_DP_BITS}",
                "O(n_terms*bound/64)",
            ),
            complexity_bound="O(n_terms*bound/64)",
        )
    estimated = restarts * max_passes * (3 * n_terms + 30)
    if estimated > eval_budget:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"estimated {estimated:.3g} gap evals > budget {eval_budget:.3g}",
                "O(restarts*passes*n_terms)",
            ),
            complexity_bound="O(restarts*passes*n_terms*bound/64)",
        )

    rng = random.Random(seed)
    best_gap = -1
    best_seq: list[int] | None = None

    def random_seq() -> list[int]:
        if rng.random() < 0.5:
            # clustered start: values near the constant sequence hitting target
            base = min(bound, max(0, math.ceil(target / n_terms)))
            jitter = max(1, bound // 8)
            seq = [
                min(bound, max(0, base + rng.randint(-jitter, jitter)))
                for _ in range(n_terms)
            ]
        else:
            seq = [rng.randint(0, bound) for _ in range(n_terms)]
        s = sum(seq)
        while s < target:
            i = rng.randrange(n_terms)
            if seq[i] < bound:
                seq[i] += 1
                s += 1
        return seq

    for _ in range(restarts):
        seq = random_seq()
        gap = _gap_and_nearest(seq, target)[0]
        for _ in range(max_passes):
            improved = False
            for i in range(n_terms):
                for delta in (1, -1, 2, -2):
                    v = seq[i] + delta
                    if not 0 <= v <= bound or sum(seq) - seq[i] + v < target:
                        continue
                    old = seq[i]
                    seq[i] = v
                    g2 = _gap_and_nearest(seq, target)[0]
                    if g2 > gap:
                        gap = g2
                        improved = True
                    else:
                        seq[i] = old
            # transfer moves keep the total fixed
            for _ in range(30):
                i, j = rng.randrange(n_terms), rng.randrange(n_terms)
                if i == j or seq[i] >= bound or seq[j] <= 0:
                    continue
                seq[i] += 1
                seq[j] -= 1
                g2 = _gap_and_nearest(seq, target)[0]
                if g2 > gap:
                    gap = g2
                    improved = True
                else:
                    seq[i] -= 1
                    seq[j] += 1
            if not improved:
                break
        if gap > best_gap:
            best_gap = gap
            best_seq = list(seq)

    assert best_seq is not None
    d, nearest, subset = _gap_and_nearest(best_seq, target)
    re_ok = d == best_gap and sum(best_seq[i] for i in subset) == nearest
    return Evidence(
        value={
            "gap": d,
            "sequence": best_seq,
            "nearest_sum": nearest,
            "subset": sorted(subset),
        },
        certificate=(
            f"sequence={best_seq} subset={sorted(subset)} "
            f"sum={nearest} |sum-target|={d}"
        ),
        self_check=(
            f"DP re-eval gap={d}, subset reconstructs sum={nearest}: "
            f"{'ok' if re_ok else 'MISMATCH'}; maximin claim is search-level"
        ),
        feasibility="ok",
        complexity_bound=(
            f"O(restarts*passes*n_terms*{total_cap}/64) bitset DP"
        ),
    )
