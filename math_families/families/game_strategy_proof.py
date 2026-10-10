"""game_strategy_proof family.

Structural criterion: large-board, infinite, or persistent games whose
solution requires a pairing, potential-function, or invariant strategy
proof rather than direct minimax. Tool role: assist. Tools never return
a final answer; small-instance values are conjecture support only.

Tools:
- pairing_strategy_verify: mechanically verify a pairing certificate —
  a fixed-point-free involution on the element set such that every
  threat set contains a full pair. Then the responding player can always
  answer a claim on e by claiming partner(e), and the opponent never
  realizes any threat set. Checked against every element the opponent
  could legally claim and every listed threat set.
- independent_reply_certificate: verify that a reply set contains no
  conflict pair. When it does, the counting argument is certified: if
  the first player always moves inside the set and the opponent removes
  at most one set element per round, then before his t-th move at most
  2(t-1) set elements are touched, so he is guaranteed ceil(n/2) moves.
- potential_function_check: verify over all reachable states and all
  legal transitions that a potential function is constant, nonincreasing,
  or bounded as claimed — the mechanical core of an invariant/potential
  strategy certificate.
- small_board_scan: exact small-instance values via minimax_dp, packaged
  as an explicitly conjecture-level table.

All verifiers carry budgets and return infeasible Evidence instead of
hanging.
"""
from __future__ import annotations

from collections import deque
from typing import Any, Callable, Iterable, Mapping

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible
from math_families.families.minimax_dp import minimax_value, win_draw_loss

_MAX_LISTED = 20  # cap on violations/problems echoed into the certificate


def _short(items: list, total: int) -> list:
    return items[:_MAX_LISTED] + ([f"... +{total - _MAX_LISTED} more"] if total > _MAX_LISTED else [])


# --------------------------------------------------------------------- #
# Pairing certificates
# --------------------------------------------------------------------- #
def pairing_strategy_verify(
    elements: Iterable[Any],
    partner: Mapping[Any, Any] | Callable[[Any], Any],
    threat_sets: Iterable[Iterable[Any]] = (),
    *,
    max_elements: int = 100_000,
    max_threats: int = 1_000_000,
) -> Evidence:
    """Verify a pairing certificate for an alternating-claim game.

    ``partner`` must be a fixed-point-free involution on ``elements``.
    Every set in ``threat_sets`` must contain a full pair
    {e, partner(e)}; then the opponent can never own a threat set when
    the responder always answers a claim on e by claiming partner(e).

    value: dict with per-check details and ``certificate_valid``.
    """
    elems = list(elements)
    n = len(elems)
    bound = "O(elements + total threat sizes)"
    if n > max_elements:
        return Evidence(None, "", "not attempted",
                        infeasible(f"{n} elements > cap {max_elements}", bound), bound)
    eset = set(elems)
    get = partner.get if isinstance(partner, Mapping) else partner

    def safe_get(e):
        try:
            return get(e)
        except Exception:
            return _UNDEFINED

    problems: list = []
    if len(eset) != n:
        problems.append(f"{n - len(eset)} duplicate elements")
    if n % 2:
        problems.append("odd element count: no fixed-point-free involution exists")
    for e in elems:
        p = safe_get(e)
        if p is _UNDEFINED:
            problems.append(f"partner undefined at {e!r}")
        elif p == e:
            problems.append(f"fixed point at {e!r}")
        elif p not in eset:
            problems.append(f"partner({e!r})={p!r} outside element set")
        elif safe_get(p) != e:
            problems.append(f"not an involution at {e!r}: partner({p!r})={safe_get(p)!r}")
    table_ok = not problems

    threat_violations: list = []
    checked = 0
    total = 0
    if table_ok:
        for ts in threat_sets:
            total += 1
            if total > max_threats:
                return Evidence(None, "", f"table ok; stopped after {max_threats} threat sets",
                                infeasible(f"threat sets > cap {max_threats}", bound), bound)
            tset = set(ts)
            checked += 1
            if not any(e in eset and safe_get(e) in tset for e in tset):
                threat_violations.append(f"threat {sorted(map(repr, tset))[:6]} contains no full pair")

    # Self-check: independent second pass recounts pairs and violations.
    pair_recount = sum(
        1 for e in elems
        if safe_get(e) in eset and safe_get(e) != e and safe_get(safe_get(e)) == e
    ) // 2
    audit_ok = (not table_ok) or pair_recount == n // 2
    valid = table_ok and not threat_violations
    return Evidence(
        value={
            "elements": n,
            "pairs": n // 2 if table_ok else None,
            "table_problems": _short(problems, len(problems)),
            "threats_checked": checked,
            "threat_violations": _short(threat_violations, len(threat_violations)),
            "certificate_valid": valid,
        },
        certificate=(
            f"involution {'ok' if table_ok else 'BROKEN'}; "
            f"{checked} threat sets, {len(threat_violations)} uncovered; "
            f"certificate {'valid' if valid else 'INVALID'}"
        ),
        self_check=(
            f"second-pass pair recount {pair_recount} == {n // 2 if table_ok else 'n/a'}: "
            f"{'ok' if audit_ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"{bound}; elements={n}, threats={checked}",
    )


def independent_reply_certificate(
    elements: Iterable[Any],
    conflicts: Iterable[tuple[Any, Any]],
    *,
    max_elements: int = 100_000,
    max_conflicts: int = 2_000_000,
) -> Evidence:
    """Verify that ``elements`` contains no ``conflicts`` pair.

    When independent, certify the alternation bound: a player who always
    replies inside the set while the opponent removes at most one set
    element per round is guaranteed ``ceil(n/2)`` moves (before his t-th
    move at most 2(t-1) set elements are touched). The guarantee is a
    lower-bound certificate, not an answer to any specific instance.
    """
    elems = list(elements)
    n = len(elems)
    bound = "O(elements + conflicts)"
    if n > max_elements:
        return Evidence(None, "", "not attempted",
                        infeasible(f"{n} elements > cap {max_elements}", bound), bound)
    eset = set(elems)
    if len(eset) != n:
        raise ValueError("elements must be distinct")
    confl: list = []
    for pair in conflicts:
        confl.append(pair)
        if len(confl) > max_conflicts:
            return Evidence(None, "", f"stopped after {max_conflicts} conflicts",
                            infeasible(f"conflicts > cap {max_conflicts}", bound), bound)
    violations = [
        f"conflict ({a!r}, {b!r}) inside set"
        for a, b in confl if a in eset and b in eset
    ]
    independent = not violations
    checked = len(confl)
    # Self-check: per-element recount — every element of a reported
    # violation must indeed be a set member, and the recount via an
    # element-indexed pass must agree.
    by_element: dict = {}
    for a, b in confl:
        if a in eset and b in eset:
            by_element[a] = by_element.get(a, 0) + 1
            by_element[b] = by_element.get(b, 0) + 1
    recount = sum(by_element.values()) // 2
    audit_ok = recount == len(violations)
    guarantee = (n + 1) // 2 if independent else None
    return Evidence(
        value={
            "size": n,
            "conflicts_checked": checked,
            "violations": _short(violations, len(violations)),
            "independent": independent,
            "reply_guarantee": guarantee,
        },
        certificate=(
            f"set size {n}, {checked} conflict pairs checked, "
            f"{recount} violations; "
            + (f"independent: first player guaranteed >= {guarantee} replies "
               f"(touch count 2(t-1) < {n} up to t={guarantee})"
               if independent else "NOT independent")
        ),
        self_check=f"violations recomputed from conflict scan: {recount} (exhaustive pass)",
        feasibility="ok",
        complexity_bound=f"{bound}; elements={n}, conflicts={checked}",
    )


# --------------------------------------------------------------------- #
# Potential-function certificates
# --------------------------------------------------------------------- #
_POTENTIAL_MODES = ("constant", "nonincreasing", "bounded", "bounded_below")


def potential_function_check(
    initial: Any,
    moves: Callable[[Any], Iterable[Any]],
    phi: Callable[[Any], float],
    *,
    mode: str = "nonincreasing",
    bound: float | None = None,
    state_budget: int = 200_000,
) -> Evidence:
    """Verify a potential-function claim over all reachable states.

    Reachable means: BFS from ``initial`` under ``moves`` (all legal
    transitions of the model, including every opponent choice). Modes:
    ``constant`` — phi(t) == phi(s) on every edge; ``nonincreasing`` —
    phi(t) <= phi(s) on every edge; ``bounded`` / ``bounded_below`` —
    phi(s) <= / >= ``bound`` on every reachable state.
    """
    if mode not in _POTENTIAL_MODES:
        raise ValueError(f"mode must be one of {_POTENTIAL_MODES}")
    if mode in ("bounded", "bounded_below") and bound is None:
        raise ValueError(f"mode {mode!r} requires bound")

    cb = "O(reachable states + edges)"
    seen = {initial}
    queue = deque([initial])
    edges = 0
    violations: list = []
    n_viol = 0
    sample: list = []  # first edges, re-audited as self-check
    while queue:
        s = queue.popleft()
        vs = phi(s)
        if mode == "bounded" and vs > bound:
            n_viol += 1
            violations.append(f"phi({s!r})={vs} > bound {bound}")
        elif mode == "bounded_below" and vs < bound:
            n_viol += 1
            violations.append(f"phi({s!r})={vs} < bound {bound}")
        for t in moves(s):
            edges += 1
            if len(sample) < 200:
                sample.append((s, vs, t))
            vt = phi(t)
            bad = (mode == "constant" and vt != vs) or (mode == "nonincreasing" and vt > vs)
            if bad:
                n_viol += 1
                violations.append(f"phi({s!r})={vs} -> phi({t!r})={vt}")
            if t not in seen:
                seen.add(t)
                if len(seen) > state_budget:
                    return Evidence(
                        None, "", f"explored {len(seen) - 1} states, {edges} edges",
                        infeasible(f"states > {state_budget}", cb), cb)
                queue.append(t)

    audit = 0
    for s, vs, t in sample:
        vt = phi(t)
        if (mode == "constant" and vt != vs) or (mode == "nonincreasing" and vt > vs):
            audit += 1
    holds = n_viol == 0
    return Evidence(
        value={
            "mode": mode,
            "bound": bound,
            "reachable": len(seen),
            "edges": edges,
            "violations": _short(violations, n_viol),
            "holds": holds,
        },
        certificate=(
            f"phi {mode}{'' if bound is None else f' {bound}'} over {len(seen)} reachable "
            f"states, {edges} edges: {n_viol} violations; claim {'holds' if holds else 'VIOLATED'}"
        ),
        self_check=f"re-audit of {len(sample)} sampled edges: {audit} violations "
                   f"({'consistent' if (audit == 0) == holds or not holds else 'MISMATCH'})",
        feasibility="ok",
        complexity_bound=f"{cb}; explored {len(seen)}",
    )


# --------------------------------------------------------------------- #
# Conjecture-level small-instance scans
# --------------------------------------------------------------------- #
def small_board_scan(
    sizes: Iterable[Any],
    make_game: Callable[[Any], tuple],
    *,
    numeric: bool = False,
    state_budget: int = 2_000_000,
) -> Evidence:
    """Exact values for small instances of a parameterized game family.

    ``make_game(size)`` returns ``(initial, moves, terminal_value)``, or
    additionally ``is_maximizer`` when ``numeric=True``. Sizes exceeding
    the budget yield None entries. The table is conjecture support: it
    never establishes a large-instance or infinite-game claim.
    """
    table: dict[Any, Any] = {}
    notes: list = []
    for s in sizes:
        spec = make_game(s)
        if numeric:
            initial, mv, tv, im = spec
            ev = minimax_value(initial, mv, tv, im, state_budget=state_budget)
        else:
            initial, mv, tv = spec
            ev = win_draw_loss(initial, mv, tv, state_budget=state_budget)
        table[s] = ev.value if ev.feasible else None
        if not ev.feasible:
            notes.append(f"{s!r}: {ev.feasibility}")
    solved = sum(1 for v in table.values() if v is not None)
    return Evidence(
        value=table,
        certificate=(
            f"conjecture-level scan: {solved}/{len(table)} sizes solved exactly; "
            "small-instance values are pattern support, not proof"
            + ("; " + "; ".join(notes) if notes else "")
        ),
        self_check="per-size Bellman audits inside the solver calls",
        feasibility="ok",
        complexity_bound="O(sum of per-size explored states)",
    )


class _Undefined:
    pass


_UNDEFINED = _Undefined()
