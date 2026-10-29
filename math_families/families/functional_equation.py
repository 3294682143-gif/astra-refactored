"""functional_equation family.

Structural criterion: functional equations/inequalities over explicit
domains, attacked by substitution probes (evaluate equation instances at
chosen variable tuples against named candidate functions), exhaustive
enumeration of all functions over a finite domain/codomain under a
constraint list, and must-differ constraint propagation over relation
graphs.

Tool role: assist. Tools emit constraint tables and function tables as
evidence; classification proofs stay with the caller.

Tools:
- substitution_probe: evaluate a residual at probe points for each
  candidate function; report per-candidate satisfaction/violation tables.
- finite_domain_solve: enumerate every function from a finite domain into
  a finite codomain satisfying a constraint list; the certificate is the
  solution tables. Constraints may read lookup-computed points (e.g.
  f(f(x))), so iterated/nested equations are expressible.
- constraint_propagation_2coloring: propagate pinned colors through a
  graph of must-differ edges; report the forced partial assignment, any
  conflict edges, and unconstrained vertices, with a replayable reason
  chain as certificate.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any, Callable, Hashable, Iterable, Mapping, Sequence

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

#: Hard refusal ceiling on log10(raw enumeration space).
_LOG10_SPACE_CEILING = 12.0
#: Assignment nodes the backtracking search may visit before giving up.
_DEFAULT_NODE_BUDGET = 5_000_000
#: Probe evaluations (points x candidates) allowed per call.
_DEFAULT_EVAL_BUDGET = 5_000_000
#: Violating points stored per candidate in probe tables/certificates.
_MAX_STORED_VIOLATIONS = 8
#: Solution tables rendered into the enumeration certificate.
_MAX_CERT_TABLES = 16


class UnassignedPoint(Exception):
    """Raised by the solver lookup when a constraint touches a domain
    point that is still unassigned; the solver then defers the constraint."""


# --------------------------------------------------------------------- #
# 1. Substitution probe
# --------------------------------------------------------------------- #
def substitution_probe(
    constraint: Callable[..., Any],
    points: Iterable[tuple],
    candidates: Mapping[str, Callable[..., Any]],
    tol: float = 1e-9,
    eval_budget: int = _DEFAULT_EVAL_BUDGET,
) -> Evidence:
    """Probe candidate functions against a functional equation/inequality.

    ``constraint(f, *vars)`` returns either a bool (True = the instance is
    satisfied) or a numeric residual (satisfied iff ``abs(r) <= tol``).
    ``points`` supplies the free-variable tuples; ``candidates`` maps a
    name to a callable. If evaluation raises (e.g. the candidate is
    undefined at a computed argument), the probe is marked unevaluable.

    Value: per candidate, counts of satisfied/violated/unevaluable probes
    and the first few violating tuples. Certificate: those violation
    witnesses; self-check: a deterministic replay of every probe.
    """
    if tol <= 0:
        raise ValueError("tol must be positive")
    pts = [tuple(p) for p in points]
    if not candidates:
        raise ValueError("need at least one candidate function")
    total_evals = len(pts) * len(candidates)
    if total_evals > eval_budget:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{total_evals:.3g} probe evaluations > budget {eval_budget:.3g}",
                "O(points * candidates)",
            ),
            complexity_bound="O(points * candidates)",
        )

    def run_pass() -> dict[str, dict[str, Any]]:
        report: dict[str, dict[str, Any]] = {}
        for name, f in candidates.items():
            satisfied = 0
            unevaluable = 0
            violation_count = 0
            witnesses: list[tuple] = []
            for p in pts:
                try:
                    r = constraint(f, *p)
                except Exception:
                    unevaluable += 1
                    continue
                ok = r if isinstance(r, bool) else abs(r) <= tol
                if ok:
                    satisfied += 1
                else:
                    violation_count += 1
                    if len(witnesses) < _MAX_STORED_VIOLATIONS:
                        witnesses.append(p)
            report[name] = {
                "satisfied": satisfied,
                "violation_count": violation_count,
                "unevaluable": unevaluable,
                "violation_witnesses": witnesses,
            }
        return report

    report = run_pass()
    replay = run_pass()
    replay_ok = all(
        (r["satisfied"], r["violation_count"], r["unevaluable"])
        == (q["satisfied"], q["violation_count"], q["unevaluable"])
        for r, q in zip(report.values(), replay.values())
    )
    totals_ok = all(
        r["satisfied"] + r["violation_count"] + r["unevaluable"] == len(pts)
        for r in report.values()
    )

    value = {
        name: {
            "points": len(pts),
            "satisfied": r["satisfied"],
            "violation_count": r["violation_count"],
            "unevaluable": r["unevaluable"],
            "violation_witnesses": r["violation_witnesses"],
        }
        for name, r in report.items()
    }
    certificate = "; ".join(
        f"{name}: violation_witnesses={r['violation_witnesses']}"
        for name, r in report.items()
    )
    ok = replay_ok and totals_ok
    return Evidence(
        value=value,
        certificate=certificate,
        self_check=(
            f"replay of {total_evals} probes identical: {'ok' if replay_ok else 'MISMATCH'}; "
            f"per-candidate totals cover {len(pts)} points: {'ok' if totals_ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(points * candidates) = O({len(pts)}*{len(candidates)})",
    )


# --------------------------------------------------------------------- #
# 2. Finite-domain exhaustive solve
# --------------------------------------------------------------------- #
def finite_domain_solve(
    domain: Sequence[Hashable],
    codomain: Sequence[Hashable],
    constraints: Iterable[tuple[tuple[Hashable, ...], Callable[..., bool]]],
    max_solutions: int = 10_000,
    node_budget: int = _DEFAULT_NODE_BUDGET,
    log10_ceiling: float = _LOG10_SPACE_CEILING,
) -> Evidence:
    """Enumerate all functions ``f: domain -> codomain`` satisfying every
    constraint.

    Each constraint is ``(points, predicate)``; the predicate is called as
    ``predicate(lookup, *points)`` and must return bool. ``lookup(p)``
    returns the current value of ``f(p)``; it raises :class:`KeyError` for
    points outside ``domain`` (predicates decide themselves how to treat
    escapes, e.g. as satisfied) and :class:`UnassignedPoint` for unassigned
    domain points (the solver defers the constraint in that case). Because
    predicates may call ``lookup`` on computed points, nested/iterated
    constraints such as ``lookup(lookup(x)) == x`` are expressible.

    Value: ``{"count": n, "truncated": bool, "solutions": [table, ...]}``
    where a table is a dict over ``domain``. Certificate: the stored
    tables; self-check: an independent re-verification of every stored
    table against all constraints.
    """
    dom = list(domain)
    cod = list(codomain)
    if not cod:
        raise ValueError("codomain must be non-empty")
    if len(set(dom)) != len(dom):
        raise ValueError("domain points must be distinct")
    if len(set(cod)) != len(cod):
        raise ValueError("codomain values must be distinct")
    if max_solutions < 1 or node_budget < 1:
        raise ValueError("max_solutions and node_budget must be positive")
    cons = [(tuple(points), pred) for points, pred in constraints]
    dom_set = set(dom)
    for points, _ in cons:
        if not points:
            raise ValueError("constraint must reference at least one point")
        for p in points:
            if p not in dom_set:
                raise ValueError(f"constraint references non-domain point {p!r}")

    log10_space = len(dom) * math.log10(len(cod))
    if log10_space > log10_ceiling:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"raw space {len(cod)}^{len(dom)} = 10^{log10_space:.1f} > ceiling 10^{log10_ceiling:.1f}",
                "O(|codomain|^|domain| * |constraints|)",
            ),
            complexity_bound="O(|codomain|^|domain| * |constraints|)",
        )

    # Assign most-constrained points first for pruning; stable tie-break.
    involvement = {p: 0 for p in dom}
    for points, _ in cons:
        for p in set(points):
            involvement[p] += 1
    order = sorted(range(len(dom)), key=lambda i: (-involvement[dom[i]], i))

    assignment: dict[Hashable, Hashable] = {}
    solutions: list[dict[Hashable, Hashable]] = []
    nodes = 0
    truncated = False
    blown = False

    def lookup(point: Hashable) -> Hashable:
        if point not in dom_set:
            raise KeyError(point)
        if point not in assignment:
            raise UnassignedPoint(point)
        return assignment[point]

    def backtrack(depth: int) -> None:
        nonlocal nodes, truncated, blown
        if truncated or blown:
            return
        if depth == len(order):
            for points, pred in cons:
                if not pred(lookup, *points):
                    return  # deferred constraint failed at the leaf
            solutions.append(dict(assignment))
            if len(solutions) >= max_solutions:
                truncated = True
            return
        p = dom[order[depth]]
        for v in cod:
            nodes += 1
            if nodes > node_budget:
                blown = True
                return
            assignment[p] = v
            decided_ok = True
            for points, pred in cons:
                try:
                    if not pred(lookup, *points):
                        decided_ok = False
                        break
                except UnassignedPoint:
                    pass
            if decided_ok:
                backtrack(depth + 1)
            del assignment[p]
            if truncated or blown:
                return

    backtrack(0)

    if blown:
        return Evidence(
            value=None,
            certificate="",
            self_check=(
                f"node budget exhausted after {nodes} nodes; "
                f"{len(solutions)} solutions found before abort"
            ),
            feasibility=infeasible(
                f"nodes > {node_budget}", "backtracking with constraint checks"
            ),
            complexity_bound="O(|codomain|^|domain| * |constraints|)",
        )

    # Self-check: independently re-verify each stored table.
    def full_lookup_factory(table: dict[Hashable, Hashable]) -> Callable[[Hashable], Hashable]:
        def full_lookup(point: Hashable) -> Hashable:
            if point not in dom_set:
                raise KeyError(point)
            return table[point]

        return full_lookup

    recheck_ok = True
    for table in solutions:
        fl = full_lookup_factory(table)
        for points, pred in cons:
            if not pred(fl, *points):
                recheck_ok = False
    frozen = {tuple(sorted((repr(k), repr(v)) for k, v in t.items())) for t in solutions}
    unique_ok = len(frozen) == len(solutions)
    count_ok = truncated or True  # count == len(solutions) by construction
    ok = recheck_ok and unique_ok and count_ok

    shown = solutions[:_MAX_CERT_TABLES]
    cert_tables = [
        "{" + ", ".join(f"{k!r}: {t[k]!r}" for k in dom) + "}" for t in shown
    ]
    certificate = f"tables=[{'; '.join(cert_tables)}]"
    if len(solutions) > len(shown):
        certificate += f" ... ({len(solutions)} tables total)"

    return Evidence(
        value={
            "count": None if truncated else len(solutions),
            "truncated": truncated,
            "solutions": solutions,
        },
        certificate=certificate,
        self_check=(
            f"re-verified {len(solutions)} tables against {len(cons)} constraints: "
            f"{'ok' if recheck_ok else 'MISMATCH'}; "
            f"tables unique: {'ok' if unique_ok else 'MISMATCH'}"
            + ("; storage truncated at max_solutions" if truncated else "")
        ),
        feasibility="ok",
        complexity_bound=(
            f"O(|codomain|^|domain| * |constraints|) worst case; "
            f"visited {nodes} nodes"
        ),
    )


# --------------------------------------------------------------------- #
# 3. Must-differ 2-coloring propagation
# --------------------------------------------------------------------- #
def constraint_propagation_2coloring(
    points: Iterable[Hashable],
    edges: Iterable[tuple[Hashable, Hashable]],
    fixed: Mapping[Hashable, int],
) -> Evidence:
    """Propagate pinned colors through must-differ constraints.

    ``edges`` are pairs whose endpoints must receive different colors in
    {0, 1}; ``fixed`` pins some points. Value: the forced partial
    assignment, the conflict edges (where propagation contradicts a color),
    and the vertices no pin reaches. A non-empty conflict list is evidence
    that the instance is inconsistent; vertices in conflicted components
    are still colored from the first pin that reached them. Certificate:
    per-vertex reason (pin or forcing edge) allowing a replay; self-check:
    replay consistency plus an audit that every non-conflicted edge with
    both endpoints colored really has distinct colors.
    """
    pts = list(points)
    pset = set(pts)
    if len(pset) != len(pts):
        raise ValueError("points must be distinct")
    edge_list: list[tuple[Hashable, Hashable]] = []
    for u, v in edges:
        if u not in pset or v not in pset:
            raise ValueError(f"edge ({u!r}, {v!r}) leaves the point set")
        if u == v:
            raise ValueError("self-loop edge is an immediate inconsistency; model it explicitly")
        edge_list.append((u, v))
    pins = dict(fixed)
    for p, c in pins.items():
        if p not in pset:
            raise ValueError(f"pinned point {p!r} not in the point set")
        if c not in (0, 1):
            raise ValueError("colors must be 0 or 1")

    adjacency: dict[Hashable, list[Hashable]] = {p: [] for p in pts}
    for u, v in edge_list:
        adjacency[u].append(v)
        adjacency[v].append(u)

    color: dict[Hashable, int] = {}
    reason: dict[Hashable, tuple] = {}
    conflicts: set[frozenset] = set()
    queue: deque = deque()
    for p, c in pins.items():
        if p in color and color[p] != c:
            conflicts.add(frozenset({p}))
        elif p not in color:
            color[p] = c
            reason[p] = ("pin",)
            queue.append(p)
    while queue:
        u = queue.popleft()
        for v in adjacency[u]:
            want = 1 - color[u]
            if v in color:
                if color[v] != want:
                    conflicts.add(frozenset((u, v)))
            else:
                color[v] = want
                reason[v] = ("via", u)
                queue.append(v)

    unconstrained = [p for p in pts if p not in color]

    # Self-check: replay reasons and audit colored non-conflicted edges.
    edge_set = {frozenset((u, v)) for u, v in edge_list}
    replay_ok = True
    for p, r in reason.items():
        if r[0] == "pin":
            if color[p] != pins[p]:
                replay_ok = False
        else:
            u = r[1]
            if frozenset((u, p)) not in edge_set or color[p] != 1 - color[u]:
                replay_ok = False
    audit_ok = True
    audited = 0
    for u, v in edge_list:
        if u in color and v in color and frozenset((u, v)) not in conflicts:
            audited += 1
            if color[u] == color[v]:
                audit_ok = False
    ok = replay_ok and audit_ok

    conflict_list = sorted(sorted(e) for e in conflicts)
    reason_items = [f"{p!r}<-{r}" for p, r in sorted(reason.items(), key=lambda kv: repr(kv[0]))]
    certificate = f"reasons={reason_items}"
    return Evidence(
        value={
            "assignment": dict(color),
            "conflicts": conflict_list,
            "unconstrained": unconstrained,
        },
        certificate=certificate,
        self_check=(
            f"reason replay over {len(color)} colored points: "
            f"{'ok' if replay_ok else 'MISMATCH'}; "
            f"audited {audited} colored non-conflicted edges, all differ: "
            f"{'ok' if audit_ok else 'MISMATCH'}; "
            f"{len(conflict_list)} conflict edges, {len(unconstrained)} unconstrained points"
        ),
        feasibility="ok",
        complexity_bound="O(|points| + |edges|)",
    )
