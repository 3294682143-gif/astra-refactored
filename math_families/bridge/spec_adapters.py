"""Structured-spec adapters: turn JSON-safe game/spec descriptions into the
controlled callables that family tools consume. The model never submits code;
the bridge builds the callables.
"""
from __future__ import annotations

from typing import Any

from math_families.core.evidence import Evidence
from math_families.families.minimax_dp import (
    gap_subsequence_discrepancy,
    minimax_value,
    win_draw_loss,
)


def _graph_callables(spec: dict[str, Any]):
    """Build (moves, terminal_value) from an explicit state-graph spec.

    spec = {
      "states": [s, ...],                      # hashable state keys (strings/ints)
      "edges": {s: [t, ...], ...},             # directed moves
      "terminal": {s: 1|0|-1, ...},            # terminal values for the mover
    }
    States absent from "terminal" are non-terminal and must have edges.
    """
    for key in ("states", "edges", "terminal"):
        if key not in spec:
            raise ValueError(f"graph spec missing {key!r}")
    states = spec["states"]
    edges = {s: list(ts) for s, ts in spec["edges"].items()}
    terminal = {s: int(v) for s, v in spec["terminal"].items()}
    known = set(states)
    if len(known) != len(states):
        raise ValueError("states must be distinct")
    for s, ts in edges.items():
        if s not in known:
            raise ValueError(f"edge source {s!r} not in states")
        for t in ts:
            if t not in known:
                raise ValueError(f"edge target {t!r} not in states")
    for s, v in terminal.items():
        if s not in known:
            raise ValueError(f"terminal state {s!r} not in states")
        if v not in (-1, 0, 1):
            raise ValueError("terminal values must be -1 (LOSS), 0 (DRAW), 1 (WIN)")

    def moves(s):
        return edges.get(s, [])

    def terminal_value(s):
        return terminal.get(s)

    return moves, terminal_value


def win_draw_loss_graph(spec: dict[str, Any], state_budget: int = 500_000) -> Evidence:
    """WIN/DRAW/LOSS for an explicitly supplied finite state graph."""
    moves, terminal_value = _graph_callables(spec)
    initial = spec.get("initial", spec["states"][0])
    if initial not in set(spec["states"]):
        raise ValueError("initial state not in states")
    return win_draw_loss(initial, moves, terminal_value, state_budget=state_budget)


def minimax_value_graph(spec: dict[str, Any], state_budget: int = 500_000) -> Evidence:
    """Numeric minimax on an explicit state graph.

    spec additionally carries "terminal": {state: number} and
    "maximizer_states": [s, ...] (all others minimize).
    """
    moves, _ = _graph_callables(spec)
    terminal_raw = spec["terminal"]
    terminal_values = {s: float(v) for s, v in terminal_raw.items()}
    max_states = set(spec.get("maximizer_states", []))
    known = set(spec["states"])
    if not max_states <= known:
        raise ValueError("maximizer_states must be a subset of states")

    def terminal_value(s):
        return terminal_values.get(s)

    def is_maximizer(s):
        return s in max_states

    initial = spec.get("initial", spec["states"][0])
    return minimax_value(initial, moves, terminal_value, is_maximizer,
                         state_budget=state_budget)


def discrepancy_spec(spec: dict[str, Any]) -> Evidence:
    """Gap-constrained subsequence discrepancy from a pure-data spec."""
    return gap_subsequence_discrepancy(
        int(spec["length"]), int(spec.get("max_gap", 2))
    )
