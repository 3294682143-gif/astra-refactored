"""probabilistic_model family.

Structural criterion: probability approximations and expectation formulas —
normal approximation of binomial overflow events, cover times of random
walks via coupon-collector decomposition, and expected hitting times in
finite Markov chains.

Tools:
- normal_overflow_seats: smallest per-group capacity that keeps an overflow
  event under a probability bound, via normal approximation of the
  Binomial(total, 1/groups) group sizes; optional continuity correction.
- cover_time_complete_graph: closed-form expected cover time
  (N-1)*H_{N-1} of the simple random walk on the complete graph K_N.
- markov_expected_steps: expected hitting time of a target set in a finite
  Markov chain, solved as a linear system over the transient states.

Convention note for cover_time_complete_graph: the cover time counts the
starting vertex as visited at t = 0 (equivalently, hitting times are taken
over t >= 0). Requiring a *return* visit to the start (hitting times over
t >= 1) adds exactly one step; see the module tests for both conventions.

All tools refuse work they cannot check: oversized linear systems return
an infeasible Evidence instead of hanging.
"""
from __future__ import annotations

import math
import random
from fractions import Fraction

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible, require_within_budget

#: Exact Fraction harmonic sums are affordable up to this many vertices.
_EXACT_HARMONIC_LIMIT = 2_000
#: Direct float harmonic sums up to this limit; asymptotic expansion beyond.
_FLOAT_HARMONIC_LIMIT = 5_000_000
#: Exact binomial tail cross-check inside normal_overflow_seats (two groups).
_EXACT_BINOMIAL_CHECK_LIMIT = 20_000
#: Full (position, visited-mask) chain solve inside cover_time self-check.
_BITMASK_SELF_CHECK_LIMIT = 5
#: Seeded simulation self-check up to this many vertices.
_SIMULATION_SELF_CHECK_LIMIT = 300

_EULER_MASCHERONI = 0.5772156649015329
_SQRT2 = math.sqrt(2.0)


def _phi(z: float) -> float:
    """Standard normal CDF via math.erf."""
    return 0.5 * (1.0 + math.erf(z / _SQRT2))


class _SingularMatrix(Exception):
    pass


def _solve_dense(matrix: list[list[float]], rhs: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting; returns the solution.

    Raises _SingularMatrix when a pivot vanishes. Caller re-checks the
    residual; this routine is the only linear solver in the module.
    """
    n = len(matrix)
    aug = [row[:] + [rhs[i]] for i, row in enumerate(matrix)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if abs(aug[piv][col]) < 1e-13:
            raise _SingularMatrix(f"pivot {col} vanishes")
        aug[col], aug[piv] = aug[piv], aug[col]
        inv = 1.0 / aug[col][col]
        row_c = aug[col]
        for r in range(col + 1, n):
            f = aug[r][col] * inv
            if f:
                row_r = aug[r]
                for k in range(col, n + 1):
                    row_r[k] -= f * row_c[k]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = aug[i][n]
        row = aug[i]
        for k in range(i + 1, n):
            s -= row[k] * x[k]
        x[i] = s / row[i]
    return x


def _max_residual(matrix: list[list[float]], rhs: list[float], x: list[float]) -> float:
    worst = 0.0
    for row, b in zip(matrix, rhs):
        got = sum(a * v for a, v in zip(row, x))
        worst = max(worst, abs(got - b))
    return worst


# --------------------------------------------------------------------- #
# 1. Normal approximation for binomial overflow capacity
# --------------------------------------------------------------------- #
def normal_overflow_seats(
    total: int,
    groups: int,
    overflow_bound: float,
    continuity_correction: bool = False,
) -> Evidence:
    """Smallest integer capacity x per group such that the probability of
    some group receiving more than x of ``total`` independent uniform
    assignments stays at most ``overflow_bound``.

    Each group size is Binomial(total, 1/groups), approximated by a normal
    N(mu, sigma^2) with mu = total/groups, sigma^2 = total*(1/g)*(1-1/g).
    The overflow probability is approximated by the union over groups,
    groups*(1 - Phi((x + c - mu)/sigma)) with c = 0.5 when
    ``continuity_correction`` holds, else 0; for two groups the two tail
    events are disjoint as soon as 2x >= total - 1, so the union is exact
    there. Certificate: the z-score and both sides of the minimality
    bracket; self-check re-verifies the bracket and, for two groups with
    total <= 20000, recomputes the exact binomial overflow probability.
    """
    if not isinstance(total, int) or isinstance(total, bool) or total < 1:
        raise ValueError("total must be a positive integer")
    if not isinstance(groups, int) or isinstance(groups, bool) or groups < 2:
        raise ValueError("groups must be an integer >= 2")
    if not 0.0 < overflow_bound < 1.0:
        raise ValueError("overflow_bound must lie in (0, 1)")

    p = 1.0 / groups
    mu = total * p
    sigma = math.sqrt(total * p * (1.0 - p))
    shift = 0.5 if continuity_correction else 0.0

    def approx_prob(x: int) -> float:
        return groups * (1.0 - _phi((x + shift - mu) / sigma))

    if approx_prob(total) > overflow_bound:
        return Evidence(
            value=None,
            certificate="",
            self_check="no capacity in [0, total] meets the bound",
            feasibility=infeasible(
                f"bound {overflow_bound} unattainable even at x={total}",
                "probability too small for the normal regime",
            ),
            complexity_bound="O(log total) bisection",
        )

    lo, hi = 0, total  # approx_prob decreasing in x
    while lo < hi:
        mid = (lo + hi) // 2
        if approx_prob(mid) <= overflow_bound:
            hi = mid
        else:
            lo = mid + 1
    x = lo

    z = (x + shift - mu) / sigma
    prob = approx_prob(x)
    prev = approx_prob(x - 1) if x > 0 else float("inf")
    bracket_ok = prob <= overflow_bound and prev > overflow_bound

    check_lines = [
        f"bracket g(x)={prob:.6g} <= {overflow_bound} < g(x-1)={prev:.6g}: "
        f"{'ok' if bracket_ok else 'MISMATCH'}"
    ]
    if groups == 2 and total <= _EXACT_BINOMIAL_CHECK_LIMIT and 2 * x >= total - 1:
        exact = _exact_two_group_overflow(total, x)
        exact_prev = _exact_two_group_overflow(total, x - 1) if 2 * (x - 1) >= total - 1 else float("nan")
        check_lines.append(
            f"exact_binomial P(x)={exact:.6g} (bound {overflow_bound}), "
            f"P(x-1)={exact_prev:.6g}"
        )
    else:
        check_lines.append("normal-approximation regime; bracket re-verified only")

    return Evidence(
        value=x,
        certificate=(
            f"Binomial({total}, 1/{groups}) ~ N({mu:.4f}, {sigma:.4f}^2); "
            f"z=(x+{shift}-{mu:.4f})/{sigma:.4f}={z:.4f}; "
            f"{groups}*(1-Phi(z))={prob:.6g} <= {overflow_bound}; "
            f"union over {groups} groups (disjoint for two groups once 2x>=n-1)"
        ),
        self_check="; ".join(check_lines),
        feasibility="ok" if bracket_ok else "ok (bracket MISMATCH, value untrusted)",
        complexity_bound=f"O(log total) bisection = O({total.bit_length()}) Phi evals",
    )


def _exact_two_group_overflow(n: int, x: int) -> float:
    """Exact P(Bin(n, 1/2) > x or n - Bin > x) = 2*P(Bin > x); the two
    events are disjoint when 2x >= n - 1. Log-gamma per term keeps n up to
    a few tens of thousands cheap and overflow-free."""
    lgn = math.lgamma(n + 1)
    ln_term = n * math.log(2.0)
    tail = 0.0
    for k in range(x + 1, n + 1):
        tail += math.exp(lgn - math.lgamma(k + 1) - math.lgamma(n - k + 1) - ln_term)
    return 2.0 * tail


# --------------------------------------------------------------------- #
# 2. Cover time of the simple random walk on the complete graph
# --------------------------------------------------------------------- #
def cover_time_complete_graph(num_vertices: int) -> Evidence:
    """Expected cover time of the simple random walk on K_N: the start
    vertex counts as visited at t = 0, and E[T] = (N-1) * H_{N-1}.

    Certificate: coupon-collector decomposition — with k distinct vertices
    visited, the waiting time for a new vertex is geometric with mean
    (N-1)/(N-k); summing k = 1..N-1 gives the closed form. Value is an
    exact Fraction for N <= 2000, a direct float sum up to 5e6, and the
    asymptotic expansion H_n = ln n + gamma + 1/(2n) beyond that.
    Self-check: exact (position, visited-mask) chain solve for N <= 5,
    seeded simulation for N <= 300, harmonic identity re-accumulation for
    larger N.
    """
    if not isinstance(num_vertices, int) or isinstance(num_vertices, bool) or num_vertices < 2:
        raise ValueError("num_vertices must be an integer >= 2")
    n = num_vertices

    if n <= _EXACT_HARMONIC_LIMIT:
        harmonic: Fraction | float = sum(
            (Fraction(1, j) for j in range(1, n)), Fraction(0)
        )
        value: Fraction | float = (n - 1) * harmonic
        mode = "exact fraction"
    elif n <= _FLOAT_HARMONIC_LIMIT:
        harmonic = math.fsum(1.0 / j for j in range(1, n))
        value = (n - 1) * harmonic
        mode = "float sum"
    else:
        m = n - 1.0
        harmonic = math.log(m) + _EULER_MASCHERONI + 0.5 / m
        value = m * harmonic
        mode = "asymptotic expansion (error < 1/(12(N-1)^2) in H)"

    if n <= 10:
        phases = [f"(N-1)/(N-{k})={Fraction(n - 1, n - k)}" for k in range(1, n)]
        phase_text = "; ".join(phases)
    else:
        phase_text = (
            f"k=1: {n - 1}/{n - 1}=1 ... k=N-1: (N-1)/1={n - 1} "
            f"(geometric means, {n - 1} phases)"
        )
    certificate = (
        f"coupon decomposition: E[T]=sum_{{k=1}}^{{N-1}} (N-1)/(N-k) "
        f"= (N-1)*H_{{N-1}} [{phase_text}]; value mode: {mode}"
    )

    if n <= _BITMASK_SELF_CHECK_LIMIT:
        chain_value = _cover_time_bitmask_float(n)
        rel = abs(chain_value - float(value)) / float(value)
        self_check = (
            f"full (pos, visited-mask) chain solve = {chain_value:.12g} vs "
            f"closed form {float(value):.12g}, rel err {rel:.2e}: "
            f"{'ok' if rel < 1e-9 else 'MISMATCH'}"
        )
    elif n <= _SIMULATION_SELF_CHECK_LIMIT:
        sim_mean, trials = _simulate_cover_time(n)
        rel = abs(sim_mean - float(value)) / float(value)
        self_check = (
            f"seeded simulation {trials} trials: mean {sim_mean:.6g} vs "
            f"{float(value):.6g}, rel err {rel:.2%}: "
            f"{'ok' if rel < 0.05 else 'MISMATCH'}"
        )
    elif n <= _FLOAT_HARMONIC_LIMIT:
        resum = math.fsum((n - 1) / (n - k) for k in range(1, n))
        rel = abs(resum - float(value)) / float(value)
        self_check = (
            f"harmonic identity re-accumulated: sum of phase means vs "
            f"(N-1)*H_{{N-1}}, rel err {rel:.2e}: "
            f"{'ok' if rel < 1e-12 else 'MISMATCH'}"
        )
    else:
        gap = (n - 1) * (0.5 / (n - 1.0))  # size of the first dropped correction
        self_check = (
            f"asymptotic tier: truncation scale {gap:.3e} is negligible vs "
            f"value; error bound 1/(12(N-1)^2) in H: ok"
        )

    return Evidence(
        value=value,
        certificate=certificate,
        self_check=self_check,
        feasibility="ok",
        complexity_bound=(
            f"O(N) harmonic accumulation ({mode}); O(N*2^(N-1)) self-check chain"
            if n <= _BITMASK_SELF_CHECK_LIMIT
            else f"O(N) harmonic accumulation ({mode})"
        ),
    )


def _cover_time_bitmask_float(n: int) -> float:
    """Exact expected cover time via the full (position, visited-mask)
    chain, solved dense. Independent of the coupon decomposition: no
    symmetry aggregation is assumed."""
    index: dict[tuple[int, int], int] = {}
    for mask in range(1, 1 << n):
        for pos in range(n):
            if mask >> pos & 1:
                index[(pos, mask)] = len(index)
    m = len(index)
    full = (1 << n) - 1
    matrix = [[0.0] * m for _ in range(m)]
    rhs = [0.0] * m
    share = 1.0 / (n - 1)
    for (pos, mask), i in index.items():
        matrix[i][i] = 1.0
        if mask == full:
            rhs[i] = 0.0
            continue
        rhs[i] = 1.0
        for nxt in range(n):
            if nxt == pos:
                continue
            matrix[i][index[(nxt, mask | (1 << nxt))]] -= share
    sol = _solve_dense(matrix, rhs)
    return sol[index[(0, 1)]]


def _simulate_cover_time(n: int) -> tuple[float, int]:
    """Seeded Monte Carlo mean cover time (start counts visited at t=0).

    Trial count adapts to keep the total step budget near 2.5e6."""
    est_steps = max(1.0, n * (math.log(n) + 1.0))
    trials = max(400, min(5000, int(2_500_000 / est_steps)))
    rng = random.Random(0x5EED + n)
    total_steps = 0
    for _ in range(trials):
        visited = bytearray(n)
        visited[0] = 1
        count = 1
        pos = 0
        while count < n:
            nxt = rng.randrange(n - 1)
            if nxt >= pos:
                nxt += 1
            pos = nxt
            if not visited[pos]:
                visited[pos] = 1
                count += 1
            total_steps += 1
    return total_steps / trials, trials


# --------------------------------------------------------------------- #
# 3. Expected hitting time in a finite Markov chain
# --------------------------------------------------------------------- #
def markov_expected_steps(
    transition: list[list[float]],
    start: int,
    targets: set[int],
) -> Evidence:
    """Expected number of steps to hit ``targets`` from ``start`` in the
    Markov chain with row-stochastic matrix ``transition``.

    Only states reachable from ``start`` enter the linear system; among
    them, every transient state must be able to reach the targets,
    otherwise the expectation diverges and the tool reports infeasible.
    The transient block solves (I - P_TT) t = 1 by Gaussian elimination;
    the certificate carries the residual so the solution is re-checkable.
    """
    n = len(transition)
    if n == 0 or any(len(row) != n for row in transition):
        raise ValueError("transition must be a non-empty square matrix")
    for row in transition:
        if any(v < 0.0 for v in row) or abs(sum(row) - 1.0) > 1e-6:
            raise ValueError("rows must be non-negative and sum to 1")
    if not 0 <= start < n:
        raise ValueError("start out of range")
    if not targets or not all(0 <= t < n for t in targets):
        raise ValueError("targets must be a non-empty set of valid states")
    if start in targets:
        return Evidence(
            value=0.0,
            certificate="start lies in the target set",
            self_check="trivial zero: ok",
            feasibility="ok",
            complexity_bound="O(1)",
        )

    # This is a FIRST hitting time. Outgoing target transitions must not make
    # a post-hit trap look like pre-hit divergence.
    hitting_transition = [
        [float(i == j) for j in range(n)] if i in targets else row
        for i, row in enumerate(transition)
    ]
    reachable = _forward_reachable(hitting_transition, start)
    if not reachable & targets:
        return Evidence(
            value=None,
            certificate="",
            self_check="reachability scan: no target reachable from start",
            feasibility=infeasible(
                "target set unreachable from start", "O(n^2) reachability scan"
            ),
            complexity_bound="O(n^2)",
        )
    can_hit = _backward_reachable(hitting_transition, targets, reachable)
    transient = sorted(reachable - set(targets))
    blocked = [s for s in transient if s not in can_hit]
    if blocked:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"states {blocked[:5]} never reach the targets",
            feasibility=infeasible(
                f"{len(blocked)} reachable transient states cannot hit targets "
                "(expectation diverges)",
                "O(n^2) reachability scan",
            ),
            complexity_bound="O(n^2)",
        )

    m = len(transient)
    guard = require_within_budget(3.0 * math.log10(max(m, 1)))
    if guard is not None:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"transient states={m}",
            feasibility=guard,
            complexity_bound="O(transient^3)",
        )

    pos = {s: i for i, s in enumerate(transient)}
    matrix = [[0.0] * m for _ in range(m)]
    rhs = [1.0] * m
    for s, i in pos.items():
        matrix[i][i] = 1.0
        for t, p in enumerate(transition[s]):
            if p and t in pos:
                matrix[i][pos[t]] -= p
    try:
        sol = _solve_dense(matrix, rhs)
    except _SingularMatrix as exc:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"linear system singular: {exc}",
            feasibility=infeasible("singular transient block", "O(transient^3)"),
            complexity_bound="O(transient^3)",
        )

    residual = _max_residual(matrix, rhs, sol)
    value = sol[pos[start]]
    return Evidence(
        value=value,
        certificate=(
            f"states={n}, reachable={len(reachable)}, transient={m}; "
            f"(I-P_TT) t = 1 solved; t_start={value:.12g}; "
            f"max residual {residual:.3e}"
        ),
        self_check=(
            f"residual |(I-P_TT)t - 1|_inf = {residual:.3e}: "
            f"{'ok' if residual < 1e-6 else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(transient^3) = O({m}^3)",
    )


def _forward_reachable(transition: list[list[float]], start: int) -> set[int]:
    seen = {start}
    stack = [start]
    while stack:
        s = stack.pop()
        for t, p in enumerate(transition[s]):
            if p and t not in seen:
                seen.add(t)
                stack.append(t)
    return seen


def _backward_reachable(
    transition: list[list[float]], targets: set[int], within: set[int]
) -> set[int]:
    """States in ``within`` that can reach ``targets`` along positive-prob
    edges (reverse BFS restricted to ``within``)."""
    rev: dict[int, list[int]] = {s: [] for s in within}
    for s in within:
        for t, p in enumerate(transition[s]):
            if p and t in within:
                rev[t].append(s)
    seen = {t for t in targets if t in within}
    stack = list(seen)
    while stack:
        s = stack.pop()
        for r in rev[s]:
            if r not in seen:
                seen.add(r)
                stack.append(r)
    return seen
