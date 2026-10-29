"""graph_extremal family.

Structural criterion: extremal graph assertions — saturated / over-full
complete-bipartite counts, matching existence (Tutte-type criteria), and
forbidden-subgraph checks — decided exactly on instances small enough to
enumerate or run polynomial matching on.

Tool role: assist. These tools verify assertions, compute small instances
exactly, and emit re-checkable certificates (a matching, a Tutte set, a
triangle, an extremal subset). They never produce a competition answer.

Graphs are simple undirected: ``n`` vertices ``0..n-1`` plus an iterable of
``(u, v)`` edges. Tools:
- count_complete_bipartite_subgraphs: number of homomorphic copies of
  K_{s,t} (ordered tuples, vertices not necessarily distinct — the
  saturated-count notion), with an injective variant.
- has_perfect_matching: Edmonds' blossom algorithm; certificate is the
  matching itself.
- tutte_violation: a vertex set S with more odd components in G - S than
  |S| (Tutte's obstruction to a perfect matching).
- triangle_free_check: decides triangle-freeness; certificate is a
  triangle or a full-scan recount.
- small_case_extremal_search: maximum-cardinality subset satisfying a
  caller predicate, enumerated largest-first under a call budget.
"""
from __future__ import annotations

import math
from collections import deque
from itertools import combinations, product
from typing import Callable, Hashable, Iterable, Sequence

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

# Feasibility guardrails (log10 of elementary-op estimates).
_COUNT_LOG10_BUDGET = math.log10(5_000_000)
_MATCHING_LOG10_BUDGET = math.log10(50_000_000)
_TRIANGLE_LOG10_BUDGET = math.log10(30_000_000)
#: Below n^(s+t) tuples the saturated count is re-checked by raw enumeration.
_BRUTE_RECHECK_TUPLE_CAP = 200_000


# --------------------------------------------------------------------- #
# Graph plumbing
# --------------------------------------------------------------------- #
def _normalize_edges(n: int, edges: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    if n < 1:
        raise ValueError("n must be positive")
    out: set[tuple[int, int]] = set()
    for u, v in edges:
        if not (0 <= u < n and 0 <= v < n):
            raise ValueError(f"edge ({u}, {v}) outside 0..{n - 1}")
        if u == v:
            raise ValueError("loops are not supported (simple graphs only)")
        out.add((min(u, v), max(u, v)))
    return sorted(out)


def _adjacency(n: int, edge_list: list[tuple[int, int]]) -> list[set[int]]:
    adj: list[set[int]] = [set() for _ in range(n)]
    for u, v in edge_list:
        adj[u].add(v)
        adj[v].add(u)
    return adj


# --------------------------------------------------------------------- #
# 1. Saturated K_{s,t} counting
# --------------------------------------------------------------------- #
def count_complete_bipartite_subgraphs(
    n: int,
    edges: Iterable[tuple[int, int]],
    s: int,
    t: int,
    injective: bool = False,
) -> Evidence:
    """Count ordered copies of K_{s,t} in the graph.

    Default mode counts homomorphisms: ordered tuples
    ``(x_1..x_s, y_1..y_t)`` where letters denote *not necessarily
    distinct* vertices and every x_i y_j is an edge. ``injective=True``
    additionally requires all s + t vertices distinct.

    Method: sweep all n^s x-tuples and add |common neighbourhood|^t
    (falling factorial in the injective mode). Certificate: the sweep
    description; self-check: raw (s+t)-tuple enumeration whenever
    n^(s+t) stays under the recheck cap.
    """
    if s < 1 or t < 1:
        raise ValueError("need s >= 1 and t >= 1")
    es = _normalize_edges(n, edges)
    adj = _adjacency(n, es)

    est = (s + 1) * math.log10(n)
    if est > _COUNT_LOG10_BUDGET:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"x-tuple sweep ~10^{est:.1f} tuple-visits",
                f"O(n^{s} * (s + t)) common-neighbour sweep",
            ),
            complexity_bound=f"O(n^{s} * (s + t)) = O({n}^{s} * {s + t})",
        )

    total = 0
    for xs in product(range(n), repeat=s):
        if injective and len(set(xs)) < s:
            continue
        common = set(adj[xs[0]])
        for x in xs[1:]:
            if not common:
                break
            common &= adj[x]
        if injective:
            common -= set(xs)
        c = len(common)
        total += math.perm(c, t) if injective and c >= t else (0 if injective else c**t)

    if n ** (s + t) <= _BRUTE_RECHECK_TUPLE_CAP:
        eset = set(es)
        brute = 0
        for tup in product(range(n), repeat=s + t):
            if injective and len(set(tup)) < s + t:
                continue
            xs, ys = tup[:s], tup[s:]
            if all((min(x, y), max(x, y)) in eset for x in xs for y in ys):
                brute += 1
        ok = brute == total
        check = f"raw tuple enumeration={brute} vs sweep={total}: {'ok' if ok else 'MISMATCH'}"
    else:
        check = f"raw recheck skipped (n^(s+t)={n ** (s + t)} > cap {_BRUTE_RECHECK_TUPLE_CAP})"

    mode = "injective" if injective else "homomorphism"
    return Evidence(
        value=total,
        certificate=(
            f"{mode} count of K_{s},{t}: sum over n^{s} x-tuples of "
            f"|common-neighbourhood|^{t}"
            + (" (falling factorial, x/y vertices distinct)" if injective else "")
        ),
        self_check=check,
        feasibility="ok",
        complexity_bound=f"O(n^{s} * (s + t)) sweep; visited {n ** s} x-tuples",
    )


# --------------------------------------------------------------------- #
# 2. Perfect matching (Edmonds' blossom algorithm)
# --------------------------------------------------------------------- #
def _edmonds_max_matching(n: int, adj: list[list[int]]) -> list[int]:
    """Maximum matching in a general graph; returns the mate array (-1 = exposed)."""
    match = [-1] * n

    def find_path(root: int) -> tuple[int, list[int]]:
        used = [False] * n
        parent = [-1] * n
        base = list(range(n))
        used[root] = True
        queue = deque([root])

        def lca(a: int, b: int) -> int:
            seen = [False] * n
            while True:
                a = base[a]
                seen[a] = True
                if match[a] == -1:
                    break
                a = parent[match[a]]
            while True:
                b = base[b]
                if seen[b]:
                    return b
                b = parent[match[b]]

        def mark_path(v: int, b: int, child: int, blossom: list[bool]) -> None:
            while base[v] != b:
                blossom[base[v]] = blossom[base[match[v]]] = True
                parent[v] = child
                child = match[v]
                v = parent[match[v]]

        while queue:
            v = queue.popleft()
            for to in adj[v]:
                if base[v] == base[to] or match[v] == to:
                    continue
                if to == root or (match[to] != -1 and parent[match[to]] != -1):
                    cur = lca(v, to)
                    blossom = [False] * n
                    mark_path(v, cur, to, blossom)
                    mark_path(to, cur, v, blossom)
                    for i in range(n):
                        if blossom[base[i]]:
                            base[i] = cur
                            if not used[i]:
                                used[i] = True
                                queue.append(i)
                elif parent[to] == -1:
                    parent[to] = v
                    if match[to] == -1:
                        return to, parent
                    to = match[to]
                    used[to] = True
                    queue.append(to)
        return -1, parent

    for v in range(n):
        if match[v] == -1:
            to, parent = find_path(v)
            while to != -1:
                pv = parent[to]
                nxt = match[pv]
                match[to] = pv
                match[pv] = to
                to = nxt
    return match


def verify_matching(n: int, edges: Iterable[tuple[int, int]], matching: Sequence[tuple[int, int]]) -> bool:
    """Independent certificate checker: ``matching`` is a valid matching."""
    es = set(_normalize_edges(n, edges))
    used: set[int] = set()
    for u, v in matching:
        e = (min(u, v), max(u, v))
        if e not in es or u in used or v in used:
            return False
        used.add(u)
        used.add(v)
    return True


def verify_perfect_matching(
    n: int, edges: Iterable[tuple[int, int]], matching: Sequence[tuple[int, int]]
) -> bool:
    """Independent certificate checker: ``matching`` covers every vertex once."""
    if len(matching) * 2 != n:
        return False
    if not verify_matching(n, edges, matching):
        return False
    covered = {x for e in matching for x in e}
    return covered == set(range(n))


def has_perfect_matching(n: int, edges: Iterable[tuple[int, int]]) -> Evidence:
    """Decide whether the graph has a perfect matching.

    Certificate: the matching itself when one exists (re-checkable by
    ``verify_perfect_matching``); otherwise a maximum matching plus the
    exposed-vertex count — optimality is then certifiable independently
    through ``tutte_violation``.
    """
    es = _normalize_edges(n, edges)
    adj = _adjacency(n, es)
    est = 2 * math.log10(n) + math.log10(len(es) + 1)
    if est > _MATCHING_LOG10_BUDGET:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"blossom ~10^{est:.1f} ops", "O(n^2 * m) Edmonds blossom"
            ),
            complexity_bound="O(n^2 * m) Edmonds blossom",
        )

    mate = _edmonds_max_matching(n, [sorted(a) for a in adj])
    matching = sorted({(min(v, mate[v]), max(v, mate[v])) for v in range(n) if mate[v] != -1})
    if len(matching) * 2 == n:
        ok = verify_perfect_matching(n, es, matching)
        return Evidence(
            value=True,
            certificate=f"matching={matching}",
            self_check=f"perfect-matching certificate re-verified: {'ok' if ok else 'MISMATCH'}",
            feasibility="ok",
            complexity_bound="O(n^2 * m) Edmonds blossom",
        )
    exposed = n - 2 * len(matching)
    ok = verify_matching(n, es, matching)
    return Evidence(
        value=False,
        certificate=f"max_matching={matching} ({exposed} vertices exposed)",
        self_check=(
            f"matching valid: {'ok' if ok else 'MISMATCH'}; non-perfect, "
            "maximality rests on blossom correctness — independent witness "
            "available via tutte_violation"
        ),
        feasibility="ok",
        complexity_bound="O(n^2 * m) Edmonds blossom",
    )


# --------------------------------------------------------------------- #
# 3. Tutte violation witness
# --------------------------------------------------------------------- #
def _odd_components(
    n: int, adj: list[set[int]], removed: set[int]
) -> tuple[int, list[int]]:
    """(number of odd-size components of G - removed, component sizes desc)."""
    seen = [False] * n
    for r in removed:
        seen[r] = True
    odd = 0
    sizes: list[int] = []
    for start in range(n):
        if seen[start]:
            continue
        size = 0
        stack = [start]
        seen[start] = True
        while stack:
            v = stack.pop()
            size += 1
            for u in adj[v]:
                if not seen[u]:
                    seen[u] = True
                    stack.append(u)
        sizes.append(size)
        if size % 2 == 1:
            odd += 1
    return odd, sorted(sizes, reverse=True)


def verify_tutte_violation(n: int, edges: Iterable[tuple[int, int]], subset: Sequence[int]) -> bool:
    """Independent certificate checker: G - subset has more odd components
    than |subset| (Tutte's obstruction)."""
    es = _normalize_edges(n, edges)
    if len(set(subset)) != len(subset) or not all(0 <= x < n for x in subset):
        return False
    adj = _adjacency(n, es)
    odd, _ = _odd_components(n, adj, set(subset))
    return odd > len(subset)


def tutte_violation(n: int, edges: Iterable[tuple[int, int]], max_subsets: int = 200_000) -> Evidence:
    """Find a Tutte set S with odd_components(G - S) > |S|, or prove none exists.

    Existence is first settled by the blossom algorithm: a perfect matching
    immediately certifies *no* Tutte set (Tutte's theorem). Otherwise
    subsets are enumerated by increasing size — a violation with
    |S| <= (n - 2)/2 is guaranteed to exist, and small obstructions are
    found quickly. Certificate: the set S plus the odd-component count;
    self-check: independent recount via ``verify_tutte_violation``.
    """
    es = _normalize_edges(n, edges)
    adj = _adjacency(n, es)

    if n % 2 == 1:
        odd, sizes = _odd_components(n, adj, set())
        return Evidence(
            value=[],
            certificate=f"tutte_set=[]; odd_components(G)={odd} > 0 (|V| odd); component_sizes={sizes}",
            self_check=f"independent recount: {'ok' if verify_tutte_violation(n, es, []) else 'MISMATCH'}",
            feasibility="ok",
            complexity_bound="O(n + m)",
        )

    mate = _edmonds_max_matching(n, [sorted(a) for a in adj])
    if all(m != -1 for m in mate):
        matching = sorted({(min(v, mate[v]), max(v, mate[v])) for v in range(n) if mate[v] != -1})
        ok = verify_perfect_matching(n, es, matching)
        return Evidence(
            value=None,
            certificate=f"perfect_matching={matching}",
            self_check=(
                f"perfect matching re-verified: {'ok' if ok else 'MISMATCH'}; "
                "Tutte's theorem ⇒ no violating set"
            ),
            feasibility="ok",
            complexity_bound="O(n^2 * m) blossom settle + no enumeration",
        )

    examined = 0
    for size in range(0, (n - 2) // 2 + 1):
        for subset in combinations(range(n), size):
            examined += 1
            if examined > max_subsets:
                return Evidence(
                    value=None,
                    certificate="",
                    self_check=f"budget exhausted at |S|={size} after {max_subsets} subsets",
                    feasibility=infeasible(
                        f"subset enumeration beyond {max_subsets} sets",
                        "O(examined * (n + m)) component scans",
                    ),
                    complexity_bound="O(2^n) subsets worst case, budgeted",
                )
            odd, sizes = _odd_components(n, adj, set(subset))
            if odd > size:
                witness = list(subset)
                ok = verify_tutte_violation(n, es, witness)
                return Evidence(
                    value=witness,
                    certificate=(
                        f"tutte_set={witness}; odd_components(G-S)={odd} > |S|={size}; "
                        f"component_sizes={sizes}"
                    ),
                    self_check=f"independent recount: {'ok' if ok else 'MISMATCH'}",
                    feasibility="ok",
                    complexity_bound=f"O(examined * (n + m)); examined {examined} subsets",
                )
    # Unreachable when the blossom pass found no perfect matching (Tutte's
    # theorem guarantees a violating set with |S| <= (n-2)/2), but report
    # honestly rather than crash if it ever happens.
    return Evidence(
        value=None,
        certificate="",
        self_check=f"no Tutte set with |S| <= {(n - 2) // 2} among {examined} subsets",
        feasibility=infeasible("enumeration complete yet no witness", "O(2^n) subsets"),
        complexity_bound="O(2^n) subsets worst case",
    )


# --------------------------------------------------------------------- #
# 4. Triangle-freeness
# --------------------------------------------------------------------- #
def triangle_free_check(n: int, edges: Iterable[tuple[int, int]]) -> Evidence:
    """Decide whether the graph is triangle-free.

    Certificate: a triangle ``(u, v, w)`` when one exists; otherwise a
    full edge scan plus a second triangle-incidence recount as the
    self-check.
    """
    es = _normalize_edges(n, edges)
    adj = _adjacency(n, es)
    est = math.log10(len(es) + 1) + math.log10(n)
    if est > _TRIANGLE_LOG10_BUDGET:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"edge-intersection scan ~10^{est:.1f} ops", "O(m * min_degree)"
            ),
            complexity_bound="O(m * min_degree) edge-intersection scan",
        )

    for u, v in es:
        for w in adj[u] & adj[v]:
            if w > v:
                present = all(
                    (min(a, b), max(a, b)) in set(es) for a, b in ((u, v), (v, w), (w, u))
                )
                return Evidence(
                    value=False,
                    certificate=f"triangle=({u}, {v}, {w})",
                    self_check=f"all three edges present: {'ok' if present else 'MISMATCH'}",
                    feasibility="ok",
                    complexity_bound="O(m * min_degree)",
                )
    incidences = sum(len(adj[u] & adj[v]) for u, v in es)
    return Evidence(
        value=True,
        certificate="no triangle in full edge scan",
        self_check=f"triangle-incidence recount={incidences} (0 expected): {'ok' if incidences == 0 else 'MISMATCH'}",
        feasibility="ok",
        complexity_bound="O(m * min_degree)",
    )


# --------------------------------------------------------------------- #
# 5. Budgeted extremal-subset search
# --------------------------------------------------------------------- #
def small_case_extremal_search(
    items: Iterable[Hashable],
    feasible: Callable[[tuple], bool],
    max_calls: int = 300_000,
) -> Evidence:
    """Maximum-cardinality subset of ``items`` satisfying ``feasible``.

    Subsets are enumerated largest-first, so the first hit is a maximum
    and every larger subset has been rejected — maximality is certified by
    the rejection count, not trusted. Certificate: the subset itself;
    self-check: the predicate is re-run on it.
    """
    pool = list(items)
    k = len(pool)
    if k > 64:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"2^{k} subsets is astronomical", "O(2^|items|) predicate calls"
            ),
            complexity_bound="O(2^|items|) predicate calls worst case",
        )

    calls = 0
    for size in range(k, -1, -1):
        for combo in combinations(pool, size):
            calls += 1
            if calls > max_calls:
                return Evidence(
                    value=None,
                    certificate="",
                    self_check=f"predicate-call budget exhausted at size={size} after {max_calls} calls",
                    feasibility=infeasible(
                        f"more than {max_calls} predicate calls",
                        "O(2^|items|) predicate calls",
                    ),
                    complexity_bound="O(2^|items|) predicate calls worst case, budgeted",
                )
            if feasible(combo):
                ok = feasible(combo)
                return Evidence(
                    value=list(combo),
                    certificate=f"subset_size={size}; subset={list(combo)}",
                    self_check=(
                        f"predicate re-verified: {'ok' if ok else 'MISMATCH'}; "
                        f"all {calls - 1} larger subsets rejected (exhaustive)"
                    ),
                    feasibility="ok",
                    complexity_bound="O(2^|items|) predicate calls worst case",
                )
    # The empty subset always satisfies no predicate we reach here with;
    # if enumeration completes, nothing was feasible.
    return Evidence(
        value=[],
        certificate="subset_size=0; subset=[]",
        self_check=f"no feasible subset; all {calls} subsets rejected",
        feasibility="ok",
        complexity_bound="O(2^|items|) predicate calls",
    )


# --------------------------------------------------------------------- #
# Evidence wrappers (W3): raw checkers stay as subroutines; the
# Evidence-returning variants are what the tool tiers consume (§1.1).
# --------------------------------------------------------------------- #
def verify_perfect_matching_evidence(
    n: int, edges: Iterable[tuple[int, int]], matching: Sequence[tuple[int, int]]
) -> Evidence:
    """Independent perfect-matching certificate check, as Evidence."""
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        raise ValueError("n must be a non-negative integer")
    ok = verify_perfect_matching(n, edges, matching)
    return Evidence(
        value=ok,
        certificate=f"covers_every_vertex_once: {ok}; |matching|={len(matching)}",
        self_check="independent coverage checker executed deterministically",
        feasibility="ok",
        complexity_bound="O(|E| + |matching|)",
    )
