"""inclusion_exclusion_counting family.

Structural criterion: counting permutations that avoid forbidden positions
(rook numbers / inclusion-exclusion), and process-driven permutation
predicates evaluated by exact simulation on small instances.

Tools:
- rook_numbers: number of ways to place k non-attacking rooks on a set of
  forbidden cells (the rook numbers of a board).
- count_avoiding_permutations: permutations with no assignment in a
  forbidden cell set, via inclusion-exclusion over rook numbers.
- count_with_predicate_small: exact count over all permutations of a
  process-driven predicate (feasible only for small n; refuses beyond).
"""
from __future__ import annotations

import itertools
from functools import lru_cache
from typing import Callable, Iterable

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible


def rook_numbers(n: int, forbidden: set[tuple[int, int]]) -> Evidence:
    """Rook numbers r_k of the forbidden board for an n x n permutation
    matrix: r_k = number of ways to place k non-attacking rooks on
    forbidden cells. Certificate: the full rook-number vector; self-check
    against brute force for small boards.
    """
    if n < 1:
        raise ValueError("n must be >= 1")
    rows: list[tuple[int, ...]] = [tuple() for _ in range(n)]
    for i, j in forbidden:
        if not (0 <= i < n and 0 <= j < n):
            raise ValueError("forbidden cell out of range")
        rows[i] = tuple(sorted(set(rows[i]) | {j}))

    @lru_cache(maxsize=None)
    def rec(row: int, used_cols: frozenset) -> tuple[int, ...]:
        # placements using rows[row:]; always returns n+1 entries
        if row == n:
            return (1,) + (0,) * n
        out = list(rec(row + 1, used_cols))
        for c in rows[row]:
            if c not in used_cols:
                sub = rec(row + 1, frozenset(used_cols | {c}))
                for k in range(n):
                    out[k + 1] += sub[k]
        return tuple(out)

    r = rec(0, frozenset())

    check = "skipped (board too large for brute force)"
    if n <= 7 and len(forbidden) <= 20:
        brute = [0] * (n + 1)
        for cells in itertools.chain.from_iterable(
            itertools.combinations(forbidden, k) for k in range(len(forbidden) + 1)
        ):
            rs = [c[0] for c in cells]
            cs = [c[1] for c in cells]
            if len(set(rs)) == len(rs) and len(set(cs)) == len(cs):
                brute[len(cells)] += 1
        check = f"brute={brute} vs dp={list(r)}: {'ok' if tuple(brute) == tuple(r) else 'MISMATCH'}"

    return Evidence(
        value=tuple(r),
        certificate=f"rook_numbers={list(r)}",
        self_check=check,
        feasibility="ok",
        complexity_bound="O(n * 2^n) memoized row DP",
    )


def count_avoiding_permutations(n: int, forbidden: set[tuple[int, int]]) -> Evidence:
    """Number of permutations pi of 0..n-1 with (i, pi(i)) never forbidden.

    Inclusion-exclusion: sum_k (-1)^k r_k (n-k)!.
    """
    import math

    ev = rook_numbers(n, forbidden)
    r = ev.value
    total = sum((-1) ** k * r[k] * math.factorial(n - k) for k in range(n + 1))

    check = "skipped (n too large for brute force)"
    if n <= 8:
        brute = sum(
            1
            for perm in itertools.permutations(range(n))
            if all((i, perm[i]) not in forbidden for i in range(n))
        )
        check = f"brute={brute} vs IE={total}: {'ok' if brute == total else 'MISMATCH'}"

    return Evidence(
        value=total,
        certificate=f"rook_numbers={list(r)}",
        self_check=check,
        feasibility="ok",
        complexity_bound="O(n * 2^n) for rook numbers",
    )


def count_with_predicate_small(
    n: int, predicate: Callable[[tuple[int, ...]], bool], max_n: int = 9
) -> Evidence:
    """Exact count of permutations of 0..n-1 satisfying a process-driven
    predicate, by full enumeration. Only honest for small n — the guard
    refuses larger instances instead of hanging.
    """
    if n > max_n:
        return Evidence(
            None, "", "not attempted",
            infeasible(f"n={n} > {max_n}", "O(n!) full enumeration"),
            "O(n!)",
        )
    count = sum(1 for perm in itertools.permutations(range(n)) if predicate(perm))
    return Evidence(
        value=count,
        certificate=f"enumerated {n}! permutations",
        self_check="full enumeration (exact by construction)",
        feasibility="ok",
        complexity_bound="O(n!)",
    )
