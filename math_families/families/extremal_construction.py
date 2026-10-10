"""extremal_construction family.

Structural criterion: extremal constructions proved by an explicit
construction plus an invariant / double-counting / potential upper bound.
This is a WORKFLOW family, not a single algorithm: tools produce evidence
(small-instance extremal tables, verified invariant claims, bound
computations) and never output a competition final answer.

Tools:
- small_case_search: exhaustive/heuristic search over structured instances
  at small sizes, producing a size -> extremum conjecture table with
  witness objects.
- invariant_certificate_check: mechanically verify a claimed invariant
  (equality preserved under a move relation) on enumerated instances.
- double_counting_bound: compute a bound from two counts of the same
  structured object set, with both counts explicit.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

_DEFAULT_NODE_BUDGET = 2_000_000


def small_case_search(
    sizes: Iterable[int],
    enumerate_instances: Callable[[int], Iterable[Any]],
    evaluate: Callable[[Any], float],
    select: str = "max",
    witness: bool = True,
    node_budget: int = _DEFAULT_NODE_BUDGET,
) -> Evidence:
    """Extremal value table over small sizes.

    ``enumerate_instances(size)`` yields candidate objects; ``evaluate`` maps
    each to a comparable number; ``select`` is "max" or "min". The value is
    a dict size -> {"extremum", "witness"}. Certificate: per-size witnesses;
    the table is conjecture support and always labeled as such.
    """
    if select not in ("max", "min"):
        raise ValueError("select must be 'max' or 'min'")
    table: dict[int, Any] = {}
    nodes = 0
    for s in sizes:
        best_val = None
        best_obj = None
        for obj in enumerate_instances(s):
            nodes += 1
            if nodes > node_budget:
                return Evidence(
                    None, "", f"budget exhausted at size {s}",
                    infeasible(f"nodes > {node_budget}", "O(instances)"),
                    "O(instances)",
                )
            val = evaluate(obj)
            if best_val is None or (select == "max" and val > best_val) or (
                select == "min" and val < best_val
            ):
                best_val, best_obj = val, obj
        table[s] = {
            "extremum": best_val,
            "witness": repr(best_obj)[:120] if witness else None,
        }
    return Evidence(
        value=table,
        certificate=f"per-size witnesses included; nodes={nodes}",
        self_check="CONJECTURE-LEVEL: small-size extremal table; no"
                   " large-instance claim is made or implied",
        feasibility="ok",
        complexity_bound=f"O(instances); nodes={nodes}",
    )


def invariant_certificate_check(
    initial: Any,
    moves: Callable[[Any], Iterable[Any]],
    invariant: Callable[[Any], Any],
    state_budget: int = 200_000,
) -> Evidence:
    """Verify a claimed invariant over the reachable state graph: BFS from
    ``initial``; the invariant must be identical on every reached successor.
    Certificate: number of states/edges audited.
    """
    from collections import deque

    inv0 = invariant(initial)
    seen = {initial}
    queue = deque([initial])
    edges = 0
    violations = 0
    while queue:
        s = queue.popleft()
        for t in moves(s):
            edges += 1
            if invariant(t) != inv0:
                violations += 1
            if t not in seen:
                seen.add(t)
                if len(seen) > state_budget:
                    return Evidence(
                        None, "", f"explored {len(seen)} states",
                        infeasible(f"states > {state_budget}", "O(reachable)"),
                        "O(reachable)",
                    )
                queue.append(t)
    holds = violations == 0
    return Evidence(
        value={"holds": holds, "states": len(seen), "edges": edges},
        certificate=f"invariant value {inv0!r} constant over {len(seen)} states",
        self_check=f"{edges} edges audited, {violations} violations",
        feasibility="ok",
        complexity_bound="O(reachable states + edges)",
    )


def double_counting_bound(
    count_a: int, count_b: int, description: str = ""
) -> Evidence:
    """The double-counting bound: two counts of the same object set must be
    equal, yielding whatever bound the caller derives. The tool only
    certifies the equality of the two supplied counts."""
    consistent = count_a == count_b
    return Evidence(
        value={"count": count_a if consistent else None, "consistent": consistent},
        certificate=f"count_a={count_a}, count_b={count_b} ({description})",
        self_check=(
            "equality holds: ok" if consistent
            else "MISMATCH: the two counts disagree — the claimed bijection fails"
        ),
        feasibility="ok",
        complexity_bound="O(1)",
    )
