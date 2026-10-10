"""minimax_dp family.

Structural criterion: finite-state perfect-information games whose state
graph is acyclic, solved by memoized minimax; plus discrepancy-type
min-max quantification over sign sequences with gap-constrained
subsequences.

Tools:
- win_draw_loss: generic WIN/DRAW/LOSS solver. States encode the player to
  move; values are reported from that player's perspective and negate when
  the turn passes.
- minimax_value: numeric minimax with an explicit maximizer predicate.
- outcome_scan: evaluate a parameterized WIN/DRAW/LOSS game family over a
  range of sizes.
- gap_subsequence_discrepancy: min over +/-1 sequences of the largest
  absolute subsequence sum under a consecutive-gap bound, with the
  minimizing sequence as certificate.

All solvers carry state budgets and return infeasible Evidence instead of
hanging. Cycles are detected and reported, not silently recursed.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

WIN, DRAW, LOSS = 1, 0, -1
_OUTCOME_NAME = {1: "WIN", 0: "DRAW", -1: "LOSS"}

_DEFAULT_STATE_BUDGET = 2_000_000


def win_draw_loss(
    initial: Any,
    moves: Callable[[Any], Iterable[Any]],
    terminal_value: Callable[[Any], int | None],
    state_budget: int = _DEFAULT_STATE_BUDGET,
) -> Evidence:
    """Outcome (WIN/DRAW/LOSS) for the player to move at ``initial``.

    ``moves(state)`` yields successor states (with the turn passed).
    ``terminal_value(state)`` returns None for non-terminal states, else
    WIN/DRAW/LOSS for the player to move. A state with no moves must be
    terminal. The state graph must be acyclic.
    """
    values: dict[Any, int] = {}
    on_stack: set[Any] = set()
    nodes = 0
    cycle = False

    def v(s):
        nonlocal nodes, cycle
        if s in values:
            return values[s]
        tv = terminal_value(s)
        if tv is not None:
            values[s] = tv
            return tv
        if s in on_stack:
            cycle = True
            raise _Cycle
        nodes += 1
        if nodes > state_budget:
            raise _Budget
        on_stack.add(s)
        best = LOSS
        for nxt in moves(s):
            best = max(best, -v(nxt))
            if best == WIN:
                break
        on_stack.discard(s)
        values[s] = best
        return best

    try:
        result = v(initial)
    except _Budget:
        return Evidence(None, "", f"explored {nodes} states",
                        infeasible(f"states > {state_budget}", "O(states)"),
                        "O(states)")
    except _Cycle:
        return Evidence(None, "", "cycle detected in state graph",
                        infeasible("cyclic state graph", "needs retrograde solver"),
                        "O(states)")

    # Self-check: Bellman consistency on a sample of solved states.
    # v(t) (not values[t]) so early-break-unexplored children are computed.
    sample = list(values)[:5000]
    audit = 0
    for s in sample:
        if terminal_value(s) is None:
            child_vals = [v(t) for t in moves(s)]
            if values[s] != max((-x for x in child_vals), default=LOSS):
                audit += 1
    return Evidence(
        value=result,
        certificate=f"outcome={_OUTCOME_NAME[result]}, states={len(values)}",
        self_check=f"Bellman audit on {len(sample)} states: {audit} violations"
                   f" ({'ok' if audit == 0 else 'MISMATCH'})",
        feasibility="ok",
        complexity_bound=f"O(states); explored {len(values)}",
    )


def minimax_value(
    initial: Any,
    moves: Callable[[Any], Iterable[Any]],
    terminal_value: Callable[[Any], float | None],
    is_maximizer: Callable[[Any], bool],
    state_budget: int = _DEFAULT_STATE_BUDGET,
) -> Evidence:
    """Numeric minimax value at ``initial``.

    ``terminal_value(state)`` returns None for non-terminal states, else the
    numeric payoff. ``is_maximizer(state)`` selects max vs min over children.
    The state graph must be acyclic.
    """
    values: dict[Any, float] = {}
    on_stack: set[Any] = set()
    nodes = 0

    def v(s):
        nonlocal nodes
        if s in values:
            return values[s]
        tv = terminal_value(s)
        if tv is not None:
            values[s] = tv
            return tv
        if s in on_stack:
            raise _Cycle
        nodes += 1
        if nodes > state_budget:
            raise _Budget
        on_stack.add(s)
        agg = max if is_maximizer(s) else min
        values[s] = agg(v(t) for t in moves(s))
        on_stack.discard(s)
        return values[s]

    try:
        result = v(initial)
    except (_Budget, _Cycle):
        return Evidence(None, "", f"explored {nodes} states",
                        infeasible("budget or cycle", "O(states)"), "O(states)")

    sample = list(values)[:5000]
    audit = sum(
        1
        for s in sample
        if terminal_value(s) is None
        and values[s]
        != (max if is_maximizer(s) else min)(values[t] for t in moves(s))
    )
    return Evidence(
        value=result,
        certificate=f"value={result}, states={len(values)}",
        self_check=f"Bellman audit on {len(sample)} states: {audit} violations"
                   f" ({'ok' if audit == 0 else 'MISMATCH'})",
        feasibility="ok",
        complexity_bound=f"O(states); explored {len(values)}",
    )


def outcome_scan(
    ns: Iterable[int],
    make_game: Callable[[int], tuple[Any, Callable, Callable]],
    state_budget: int = _DEFAULT_STATE_BUDGET,
) -> Evidence:
    """Outcome of a parameterized WIN/DRAW/LOSS game for each size in ``ns``.

    ``make_game(n)`` returns (initial, moves, terminal_value). Sizes that
    exceed the budget are reported as None.
    """
    table: dict[int, int | None] = {}
    for n in ns:
        initial, moves, terminal_value = make_game(n)
        ev = win_draw_loss(initial, moves, terminal_value, state_budget)
        table[n] = ev.value if ev.feasible else None
    solved = sum(1 for v in table.values() if v is not None)
    return Evidence(
        value=table,
        certificate=f"outcomes over {len(table)} sizes, {solved} solved",
        self_check="per-size audits in individual solver calls",
        feasibility="ok",
        complexity_bound="O(sum of per-size states)",
    )


# --------------------------------------------------------------------- #
# Gap-constrained subsequence discrepancy
# --------------------------------------------------------------------- #
def _best_gap_subseq_abs(seq: tuple[int, ...], max_gap: int) -> int:
    """Largest |sum| over subsequences with consecutive index gap <= max_gap."""
    n = len(seq)
    best_hi = [0] * (n + max_gap)  # best positive-sum subseq whose last taken index is i
    best_lo = [0] * (n + max_gap)
    top, bot = 0, 0
    for i in range(n):
        hi = lo = seq[i]
        for j in range(max(0, i - max_gap), i):
            hi = max(hi, seq[i] + best_hi[j])
            lo = min(lo, seq[i] + best_lo[j])
        best_hi[i], best_lo[i] = hi, lo
        top, bot = max(top, hi), min(bot, lo)
    return max(top, -bot)


def gap_subsequence_discrepancy(length: int, max_gap: int = 2) -> Evidence:
    """C = min over +/-1 sequences of length ``length`` of the largest
    |subsequence sum| with consecutive gaps <= ``max_gap``.

    Enumerates sequences up to negation symmetry. Certificate: a minimizing
    sequence and its best-subsequence value (re-checkable in O(length *
    max_gap)); the minimality claim rests on the exhaustive enumeration,
    which is feasible only for modest lengths — the feasibility marker says
    when the enumeration was truncated.
    """
    if length < 1 or max_gap < 1:
        raise ValueError("need length >= 1 and max_gap >= 1")
    if length > 24:
        return Evidence(
            None, "", "not attempted",
            infeasible(f"2^{length - 1} sequences", "O(2^length * length * max_gap)"),
            "O(2^length * length * max_gap)",
        )

    best_val: int | None = None
    best_seq: tuple[int, ...] | None = None
    # Fix the first element to +1 (negation symmetry).
    for bits in range(1 << (length - 1)):
        seq = (1,) + tuple(1 if bits >> i & 1 else -1 for i in range(length - 1))
        val = _best_gap_subseq_abs(seq, max_gap)
        if best_val is None or val < best_val:
            best_val, best_seq = val, seq

    assert best_seq is not None and best_val is not None
    recheck = _best_gap_subseq_abs(best_seq, max_gap)
    return Evidence(
        value=best_val,
        certificate=f"minimizing_sequence={best_seq}",
        self_check=(
            f"certificate value {recheck} == reported {best_val}: "
            f"{'ok' if recheck == best_val else 'MISMATCH'}; "
            f"minimality over 2^{length - 1} sequences (post-symmetry)"
        ),
        feasibility="ok",
        complexity_bound=f"O(2^length * length * max_gap)",
    )


class _Cycle(Exception):
    pass


class _Budget(Exception):
    pass
