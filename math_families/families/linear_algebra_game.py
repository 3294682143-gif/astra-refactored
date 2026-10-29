"""linear_algebra_game family.

Structural criterion: games whose state is a GF(2) vector space element and
whose win conditions reduce to linear algebra (xor sums, nullspaces).

Reference model: a deck whose cards are all subsets of a d-digit set
(card = integer 0..2^d - 1). Players alternately take cards; at the end each
player asks whether discarding one held card makes every digit occur evenly
among their remaining cards — i.e. whether the xor of their cards is itself
one of their cards. The total xor of the full deck is 0 for d >= 2 (each
digit appears 2^(d-1) times), so both players have the same xor s, and the
holder of card s is the unique player who can — draws are impossible under
this rule, which is itself a mechanizable lemma the tests verify.

Tools:
- gf2_rank / gf2_nullspace: bit-packed GF(2) linear algebra.
- deck_game_outcome: exact minimax over the reduced deck game (d <= 3)
  classifying every first move; certificate = outcome table size; exact by
  exhaustive recursion.
"""
from __future__ import annotations

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible


def gf2_rank(rows: list[int]) -> int:
    """Rank of bit-packed rows over GF(2)."""
    pivots: dict[int, int] = {}
    for r in rows:
        x = r
        while x:
            p = x.bit_length() - 1
            if p in pivots:
                x ^= pivots[p]
            else:
                pivots[p] = x
                break
    return len(pivots)


def gf2_nullspace(rows: list[int], width: int) -> list[int]:
    """Basis of {v in GF(2)^width : <r, v> = 0 for all r in rows}."""
    pivots: dict[int, int] = {}
    for r in rows:
        x = r
        while x:
            p = x.bit_length() - 1
            if p in pivots:
                x ^= pivots[p]
            else:
                pivots[p] = x
                break
    # Back-eliminate to full RREF so each pivot row reads
    # "x_p + sum_f coeff_f x_f = 0".
    for p in sorted(pivots):
        for q in sorted(pivots):
            if q != p and (pivots[q] >> p) & 1:
                pivots[q] ^= pivots[p]
    basis = []
    for f in range(width):
        if f in pivots:
            continue
        v = 1 << f
        for p, prow in pivots.items():
            if (prow >> f) & 1:
                v |= 1 << p
        basis.append(v)
    return basis


# --------------------------------------------------------------------- #
# Evidence wrappers (W2): the GF(2) primitives above stay raw subroutines
# (bridge/dispatch.py coerces straight to them); the Evidence-returning
# variants below are what the tool tiers consume (§1.1 contract).
# --------------------------------------------------------------------- #
_GF2_MAX_ROWS = 4096
_GF2_MAX_WIDTH = 4096


def _validate_gf2_rows(rows: list[int]) -> None:
    for r in rows:
        if isinstance(r, bool) or not isinstance(r, int) or r < 0:
            raise ValueError("rows must be non-negative bit-packed integers")


def gf2_rank_evidence(rows: list[int]) -> Evidence:
    """GF(2) rank of bit-packed rows, as Evidence.

    Self-check: rank-nullity against gf2_nullspace over the implied width —
    an independent code path (full RREF back-elimination), not a re-run of
    the same elimination.
    """
    _validate_gf2_rows(rows)
    width = max((r.bit_length() for r in rows), default=0)
    if len(rows) > _GF2_MAX_ROWS or width > _GF2_MAX_WIDTH:
        return Evidence(
            None, "", "not attempted",
            infeasible(
                f"{len(rows)} rows / width {width}", "O(rows * width)"
            ),
            "O(rows * width)",
        )
    rank = gf2_rank(rows)
    nullity = len(gf2_nullspace(rows, width))
    ok = rank + nullity == width
    return Evidence(
        value=rank,
        certificate=f"width={width}, nullity={nullity}",
        self_check=(
            f"rank-nullity: {rank} + {nullity} == {width}: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(rows * width)",
    )


def gf2_nullspace_evidence(rows: list[int], width: int) -> Evidence:
    """Basis of {v : <r, v> = 0 for all r} over GF(2)^width, as Evidence."""
    if isinstance(width, bool) or not isinstance(width, int) or width < 1:
        raise ValueError("width must be a positive integer")
    _validate_gf2_rows(rows)
    if any(r >= (1 << width) for r in rows):
        raise ValueError("row bits must fit within width")
    if len(rows) > _GF2_MAX_ROWS or width > _GF2_MAX_WIDTH:
        return Evidence(
            None, "", "not attempted",
            infeasible(
                f"{len(rows)} rows / width {width}", "O(rows * width)"
            ),
            "O(rows * width)",
        )
    basis = gf2_nullspace(rows, width)
    ortho = all((r & v).bit_count() % 2 == 0 for v in basis for r in rows)
    rank = gf2_rank(rows)
    dim_ok = rank + len(basis) == width
    return Evidence(
        value=basis,
        certificate=f"rank={rank}, nullity={len(basis)}",
        self_check=(
            f"orthogonality: {'ok' if ortho else 'MISMATCH'}; "
            f"rank-nullity: {rank} + {len(basis)} == {width}: "
            f"{'ok' if dim_ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(rows * width)",
    )


def _deck_total_xor(d: int) -> int:
    """Xor of all cards 0..2^d-1: 0 for d >= 2 (each digit appears evenly)."""
    total = 0
    for digit in range(d):
        if (1 << (d - 1)) % 2 == 1:  # digit appears an odd number of times
            total |= 1 << digit
    return total


def deck_game_outcome(d: int) -> Evidence:
    """Classify every first move of the reduced deck game on 2^d cards.

    State: (a_mask, b_mask), alternating turns (A = first player). Terminal:
    full deck taken; let s = xor of A's cards (== xor of B's cards whenever
    the deck's total xor is 0). A wins iff A holds card s. Feasible only for
    d <= 3 (4^(2^d) states); larger d is refused with a feasibility marker.
    """
    if d < 1:
        raise ValueError("d must be >= 1")
    n_cards = 1 << d
    if d > 3:
        return Evidence(
            None, "", "not attempted",
            infeasible(f"d={d}: state space 4^{n_cards}", "O(4^(2^d))"),
            "O(4^(2^d))",
        )
    full = (1 << n_cards) - 1
    total_xor = _deck_total_xor(d)

    from functools import lru_cache

    @lru_cache(maxsize=None)
    def a_wins(a_mask: int, b_mask: int) -> bool:
        """Exact game value: True iff the FIRST player (A) wins from here,
        assuming the player to move is determined by popcount(taken)."""
        taken = a_mask | b_mask
        if taken == full:
            sa = 0
            m = a_mask
            while m:
                low = m & -m
                sa ^= low.bit_length() - 1
                m ^= low
            if total_xor != 0:
                sb = sa ^ total_xor
            else:
                sb = sa
            a_can = (a_mask >> sa) & 1 == 1
            b_can = (b_mask >> sb) & 1 == 1
            return a_can and not b_can  # draw counts as not-a-win
        a_turn = bin(taken).count("1") % 2 == 0
        if a_turn:
            return any(
                a_wins(a_mask | (1 << card), b_mask)
                for card in range(n_cards)
                if not taken >> card & 1
            )
        return all(
            a_wins(a_mask, b_mask | (1 << card))
            for card in range(n_cards)
            if not taken >> card & 1
        )

    losing_openings = [c for c in range(n_cards) if not a_wins(1 << c, 0)]

    return Evidence(
        value={
            "digits": d,
            "deck_size": n_cards,
            "total_xor": total_xor,
            "first_moves_after_which_second_player_wins": losing_openings,
        },
        certificate=f"exact game tree over {a_wins.cache_info().currsize} states",
        self_check="exhaustive memoized minimax (exact by construction)",
        feasibility="ok",
        complexity_bound=f"O(4^{n_cards}) states",
    )
