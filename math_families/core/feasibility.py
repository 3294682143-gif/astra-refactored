"""Feasibility pre-checks.

A tool must refuse work it cannot finish, immediately, with a state-space
estimate — instead of hanging. Estimates are kept on a log10 scale so
astronomical workloads are cheap to represent.
"""
from __future__ import annotations

import math

#: Default budget: about five million elementary operations.
DEFAULT_LOG10_BUDGET = math.log10(5_000_000)


def infeasible(reason: str, bound: str) -> str:
    """Canonical infeasibility marker for Evidence.feasibility."""
    return f"infeasible: {reason}; bound {bound}"


def backtracking_log10_estimate(cells: int, tile_area: int, branching: int = 4) -> float:
    """log10 upper bound on exact-cover backtracking nodes.

    Returns -inf when the area divisibility check already settles it.
    """
    if tile_area <= 0:
        raise ValueError("tile_area must be positive")
    if cells % tile_area != 0:
        return float("-inf")
    return (cells // tile_area) * math.log10(branching)


def require_within_budget(
    log10_ops: float, log10_budget: float = DEFAULT_LOG10_BUDGET
) -> str | None:
    """Return an infeasible marker when the estimate exceeds the budget."""
    if log10_ops > log10_budget:
        return infeasible(
            f"estimated 10^{log10_ops:.1f} ops > budget 10^{log10_budget:.1f}",
            "exact-cover backtracking",
        )
    return None
