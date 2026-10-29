"""combinatorial_geometry family.

Structural criterion: worst-configuration extrema in covering and
separation problems on planar point sets and convex polygons. Instances
ask for an extremal value over ALL configurations (e.g. the smallest
number of lines that always separates a bicolored point set, or the
largest point set whose line-covering number drops below a threshold
only after deleting any single point), not for one fixed configuration.

Tool role: assist. The tools compute exact small-scale values
(per-configuration covering/separation numbers, polygon bisection
coverage) and search small configuration spaces for the worst case.
Scaling laws suggested by the resulting small-case tables stay at
conjecture level; responsibility for the final answer stays with the
caller.

Tools:
- line_cover_number: exact minimum number of lines covering a point set
  (capped by a budget), with a re-checkable line-list certificate.
- line_separation_number: exact minimum number of lines whose arrangement
  splits a bicolored point set in general position into monochromatic
  regions; certificate = explicit rational separating lines, checkable by
  verify_separation_certificate.
- worst_configuration_search: extremal search over small configurations;
  objective "covering_critical" (largest S on a grid whose line-covering
  number exceeds a budget but drops to the budget after deleting any
  point; exhaustive on the grid) or "separation" (maximize
  line_separation_number over structured + random configurations;
  heuristic lower bound on the true worst case).
- area_bisection_coverage: number of sides of a convex n-gon hit by the n
  area-halving chords from its vertices, in exact rational arithmetic.
"""
from __future__ import annotations

import random
from fractions import Fraction
from itertools import combinations
from math import comb, gcd, log10

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

#: Scale guards (keep every search interruptible and honest).
_SEP_MAX_POINTS = 12          # set cover over O(n^2) line splits
_SEP_DFS_NODE_BUDGET = 300_000
_COVER_MAX_POINTS = 64
_COVER_DFS_NODE_BUDGET = 100_000
_GRID_SCAN_BUDGET = 400_000   # subsets examined by the covering search
_SEARCH_SAMPLES_CAP = 5_000
_POLYGON_MAX_SIDES = 400      # O(n^2) boundary walk


class _BudgetExceeded(Exception):
    pass


# --------------------------------------------------------------------- #
# Shared exact-arithmetic helpers
# --------------------------------------------------------------------- #
def _to_points(points) -> list[tuple[Fraction, Fraction]]:
    pts = [(Fraction(x), Fraction(y)) for x, y in points]
    if len(set(pts)) != len(pts):
        raise ValueError("duplicate points")
    return pts


def _cross(d, u, v) -> Fraction:
    """Signed area x2 of triangle d, u, v (exact)."""
    return (u[0] - d[0]) * (v[1] - d[1]) - (u[1] - d[1]) * (v[0] - d[0])


def _require_general_position(pts) -> None:
    for a, b, c in combinations(pts, 3):
        if _cross(a, b, c) == 0:
            raise ValueError("points must be in general position (no three collinear)")


def _pair_lines(pts) -> list[tuple[tuple[int, int, int], int]]:
    """All normalized lines through >= 2 points; returns (A,B,C), bitmask."""
    idx = {p: i for i, p in enumerate(pts)}
    seen: dict[tuple[int, int, int], int] = {}
    for i, j in combinations(range(len(pts)), 2):
        (x1, y1), (x2, y2) = pts[i], pts[j]
        af, bf = y2 - y1, x1 - x2
        cf = af * x1 + bf * y1
        scale = af.denominator * bf.denominator * cf.denominator
        a, b, c = int(af * scale), int(bf * scale), int(cf * scale)
        g = gcd(gcd(abs(a), abs(b)), abs(c))
        a, b, c = a // g, b // g, c // g
        if a < 0 or (a == 0 and b < 0):
            a, b, c = -a, -b, -c
        seen.setdefault((a, b, c), 0)
    lines = []
    for abc in seen:
        a, b, c = abc
        mask = 0
        for p, i in idx.items():
            if a * p[0] + b * p[1] == c:
                mask |= 1 << i
        lines.append((abc, mask))
    return lines


# --------------------------------------------------------------------- #
# 1. Exact line covering number (budget-capped)
# --------------------------------------------------------------------- #
def _min_cover(uncovered: int, line_masks: list[int], cap: int) -> tuple[int | None, list[int]]:
    """Exact minimum number of pair-lines covering the point bitmask,
    or None when more than ``cap`` lines are needed. Depth-first with an
    uncovered/max-coverage lower bound; raises _BudgetExceeded."""
    if uncovered == 0:
        return 0, []
    nodes = 0

    def dfs(rest: int, depth: int) -> list[int] | None:
        nonlocal nodes
        nodes += 1
        if nodes > _COVER_DFS_NODE_BUDGET:
            raise _BudgetExceeded
        if rest == 0:
            return []
        if depth == 0:
            return None
        best = max((m & rest).bit_count() for m in line_masks)
        if best == 0 or -(-rest.bit_count() // best) > depth:
            return None
        # branch on the uncovered point hit by the fewest useful lines
        pts_left = [i for i in range(rest.bit_length()) if rest >> i & 1]
        pivot = min(
            pts_left,
            key=lambda i: sum(1 for m in line_masks if m >> i & 1 and m & rest),
        )
        options = [m for m in line_masks if m >> pivot & 1 and m & rest]
        options.sort(key=lambda m: -(m & rest).bit_count())
        for m in options:
            sub = dfs(rest & ~m, depth - 1)
            if sub is not None:
                return [m] + sub
        return None

    lower = -(-uncovered.bit_count() // max((m & uncovered).bit_count() for m in line_masks))
    for k in range(max(1, lower), cap + 1):
        got = dfs(uncovered, k)
        if got is not None:
            return k, got
    return None, []


def line_cover_number(points, max_lines: int) -> Evidence:
    """Exact minimum number of lines covering ``points`` (duplicates
    rejected), capped at ``max_lines``. Only lines through >= 2 points
    need consideration (a line covering a single point can be pivoted
    onto a second one without losing coverage).

    Certificate: the covering lines as normalized A*x + B*y = C triples;
    self-check: incidence re-verification plus the exhaustive deepening
    scan behind the minimality claim.
    """
    if max_lines < 0:
        raise ValueError("max_lines must be >= 0")
    pts = _to_points(points)
    n = len(pts)
    if n > _COVER_MAX_POINTS:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{n} points > {_COVER_MAX_POINTS}",
                f"O(lines^cover) deepening, lines = O(n^2) = O({n * n})",
            ),
            complexity_bound="O(n^2) lines; set cover deepening in O(lines^k)",
        )
    if n <= 1:
        k = min(n, 1)
        return Evidence(
            value=k if k <= max_lines else None,
            certificate="trivial set",
            self_check="ok: |S| <= 1",
            feasibility="ok" if k <= max_lines else infeasible(
                "single point needs 1 line > budget", "O(1)"),
            complexity_bound="O(1)",
        )

    lines = _pair_lines(pts)
    masks = [m for _, m in lines]
    full = (1 << n) - 1
    try:
        k, chosen = _min_cover(full, masks, max_lines)
    except _BudgetExceeded:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"node budget {_COVER_DFS_NODE_BUDGET} exhausted",
            feasibility=infeasible(
                f"cover search > {_COVER_DFS_NODE_BUDGET} nodes",
                "O(lines^k) deepening",
            ),
            complexity_bound="O(n^2) lines; O(lines^k) deepening",
        )
    if k is None:
        return Evidence(
            value=None,
            certificate=f"no cover with <= {max_lines} lines (exhaustive deepening)",
            self_check=f"ok: all depths <= {max_lines} exhausted without a cover",
            feasibility="ok",
            complexity_bound="O(n^2) lines; O(lines^max_lines) deepening",
        )

    abc = {m: t for t, m in lines}
    cert_lines = [abc[m] for m in chosen]
    # Self-check: the listed lines really cover every point.
    covered = all(
        any(a * p[0] + b * p[1] == c for a, b, c in cert_lines) for p in pts
    )
    return Evidence(
        value=k,
        certificate=f"covering_lines={cert_lines}",
        self_check=(
            f"listed {len(cert_lines)} lines cover all {n} points: "
            f"{'ok' if covered and len(cert_lines) == k else 'MISMATCH'}; "
            f"minimality by iterative deepening over {len(lines)} pair-lines"
        ),
        feasibility="ok",
        complexity_bound=f"O(n^2) lines = {len(lines)}; O(lines^{k}) deepening",
    )


# --------------------------------------------------------------------- #
# 2. Exact bichromatic separation number
# --------------------------------------------------------------------- #
def _split_masks(pts) -> list[int]:
    """All strict line-realizable bipartitions, as point bitmasks.

    Every combinatorially distinct split arises from a line through two
    points rotated infinitesimally; for the ordered pair (i, j) the split
    is {k: cross(i, j, k) > 0} + {j}. Complements separate the same
    pairs, so one representative per complementary class is kept.
    """
    n = len(pts)
    seen: set[tuple[int, ...]] = set()
    out = []
    for i, j in combinations(range(n), 2):
        pos = 0
        for k in range(n):
            if k not in (i, j) and _cross(pts[i], pts[j], pts[k]) > 0:
                pos |= 1 << k
        for m in (pos | (1 << j), pos | (1 << i)):
            comp = ((1 << n) - 1) & ~m
            key = min(tuple(sorted(_bits(m))), tuple(sorted(_bits(comp))))
            if key not in seen:
                seen.add(key)
                out.append(m)
    return out


def _bits(mask: int):
    i = 0
    while mask:
        if mask & 1:
            yield i
        mask >>= 1
        i += 1


def _separation(pts, colors) -> tuple[int, list[tuple[int, int]]]:
    """Exact minimum number of line splits separating every bichromatic
    pair; returns (k, ordered pairs witnessing the splits)."""
    n = len(pts)
    pairs = [(i, j) for i, j in combinations(range(n), 2) if colors[i] != colors[j]]
    if not pairs:
        return 0, []
    # candidate splits with their separated-pair coverage
    cov_of: dict[int, int] = {}
    for m in _split_masks(pts):
        cov = 0
        for t, (i, j) in enumerate(pairs):
            if (m >> i & 1) != (m >> j & 1):
                cov |= 1 << t
        if cov:
            cov_of.setdefault(cov, m)
    covers = sorted(cov_of, key=lambda c: -c.bit_count())
    full = (1 << len(pairs)) - 1
    pair_hits = [
        [t for t, c in enumerate(covers) if c >> u & 1] for u in range(len(pairs))
    ]
    nodes = 0

    def dfs(rest: int, depth: int) -> list[int] | None:
        nonlocal nodes
        nodes += 1
        if nodes > _SEP_DFS_NODE_BUDGET:
            raise _BudgetExceeded
        if rest == 0:
            return []
        if depth == 0:
            return None
        if -(-rest.bit_count() // covers[0].bit_count()) > depth:
            return None
        u = min(
            (u for u in range(len(pairs)) if rest >> u & 1),
            key=lambda u: len(pair_hits[u]),
        )
        for t in sorted(pair_hits[u], key=lambda t: -(covers[t] & rest).bit_count()):
            sub = dfs(rest & ~covers[t], depth - 1)
            if sub is not None:
                return [t] + sub
        return None

    lower = -(-len(pairs) // covers[0].bit_count())
    for k in range(max(1, lower), len(covers) + 1):
        got = dfs(full, k)
        if got is not None:
            # map back to split witnesses (i, j, s): the line through
            # points i, j rotated infinitesimally so that endpoint j
            # (s=1) or i (s=0) joins the positive-cross side
            masks = {cov_of[covers[t]] for t in got}
            witness = []
            for m in masks:
                for i, j in combinations(range(n), 2):
                    pos = 0
                    for q in range(n):
                        if q not in (i, j) and _cross(pts[i], pts[j], pts[q]) > 0:
                            pos |= 1 << q
                    if pos | (1 << j) == m:
                        witness.append((i, j, 1))
                        break
                    if pos | (1 << i) == m:
                        witness.append((i, j, 0))
                        break
            return k, witness
    raise _BudgetExceeded  # unreachable: all singleton splits cover


def line_separation_number(points, colors) -> Evidence:
    """Exact minimum number of lines (avoiding the points) whose
    arrangement leaves every region monochromatic, for a bicolored point
    set in general position (no three collinear). Two points share a
    region iff no drawn line separates them, so this is an exact set
    cover of the bichromatic pairs by line-realizable splits.

    Certificate: ordered point pairs (i, j); the split is realized by the
    line through them rotated infinitesimally so that point j joins the
    positive side — verify_separation_certificate rebuilds explicit
    rational lines and re-checks every pair.
    """
    pts = _to_points(points)
    n = len(pts)
    if n < 2:
        raise ValueError("need at least 2 points")
    if len(colors) != n or any(c not in (0, 1) for c in colors):
        raise ValueError("colors must be a 0/1 list matching points")
    if n > _SEP_MAX_POINTS:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{n} points > {_SEP_MAX_POINTS}",
                f"set cover over O(n^2) = O({n * n}) splits",
            ),
            complexity_bound="O(n^2) splits; exact set cover exponential in k",
        )
    _require_general_position(pts)
    try:
        k, witness = _separation(pts, list(colors))
    except _BudgetExceeded:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"node budget {_SEP_DFS_NODE_BUDGET} exhausted",
            feasibility=infeasible(
                f"set cover > {_SEP_DFS_NODE_BUDGET} nodes",
                "O(splits^k) deepening",
            ),
            complexity_bound="O(n^2) splits; O(splits^k) deepening",
        )
    ok = verify_separation_certificate(pts, list(colors), witness)
    return Evidence(
        value=k,
        certificate=f"separating_splits={witness}",
        self_check=(
            f"certificate re-check: {'ok' if ok and len(witness) == k else 'MISMATCH'}; "
            f"minimality by iterative deepening over line splits "
            f"(budget {_SEP_DFS_NODE_BUDGET} nodes)"
        ),
        feasibility="ok",
        complexity_bound="O(n^2) splits; O(splits^k) exact set cover",
    )


def verify_separation_certificate(points, colors, splits) -> bool:
    """Independent checker: each ordered pair (i, j) yields an explicit
    rational line (the line through them sheared around the midpoint by
    an exactly computed epsilon) that strictly realizes the claimed
    split; every bichromatic pair must be separated by >= 1 split."""
    pts = _to_points(points)
    colors = list(colors)
    n = len(pts)
    covered = set()
    for entry in splits:
        if len(entry) == 3:
            i, j, s = entry
        else:
            i, j = entry
            s = 1
        if s == 0:
            i, j = j, i  # re-orient so endpoint j joins the positive side
        if not (0 <= i < n and 0 <= j < n) or i == j:
            return False
        d = (pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])
        w = (-d[1], d[0])
        cross_dw = d[0] * w[1] - d[1] * w[0]  # = |d|^2 > 0
        # side(k) of the sheared line is cross(d, u_k) - eps*U_k with
        # u_k = p_k - p_i and U_k = cross(d, w) + 2*cross(w, u_k); pick
        # eps exactly so every strict side sign is preserved.
        ts, us = [], []
        for k in range(n):
            if k in (i, j):
                continue
            t = _cross(pts[i], pts[j], pts[k])
            if t == 0:
                return False
            u = (pts[k][0] - pts[i][0], pts[k][1] - pts[i][1])
            ts.append(abs(t))
            us.append(abs(cross_dw + 2 * (w[0] * u[1] - w[1] * u[0])))
        den = 2 * max(us, default=Fraction(1))
        eps = min(ts, default=Fraction(1)) / (den if den > 0 else Fraction(1))
        a = (pts[i][0] + eps * w[0], pts[i][1] + eps * w[1])
        b = (pts[j][0] - eps * w[0], pts[j][1] - eps * w[1])
        side = {}
        for k in range(n):
            s = _cross(a, b, pts[k])
            if s == 0:
                return False
            side[k] = s > 0
        # the explicit line must realize the claimed split
        for k in range(n):
            if k in (i, j):
                continue
            if side[k] != (_cross(pts[i], pts[j], pts[k]) > 0):
                return False
        if side[i] or not side[j]:
            return False
        for u, v in combinations(range(n), 2):
            if colors[u] != colors[v] and side[u] != side[v]:
                covered.add((u, v))
    want = {(u, v) for u, v in combinations(range(n), 2) if colors[u] != colors[v]}
    return covered == want


# --------------------------------------------------------------------- #
# 3. Worst-configuration search (two objectives)
# --------------------------------------------------------------------- #
def worst_configuration_search(
    objective: str,
    *,
    red: int = 0,
    blue: int = 0,
    line_budget: int = 0,
    grid: int = 4,
    samples: int = 200,
    seed: int = 0,
) -> Evidence:
    """Search small configurations for the worst case of a covering or
    separation extremal.

    objective="covering_critical": largest S on the ``grid`` x ``grid``
    lattice whose line-covering number exceeds ``line_budget`` while
    S minus any point is coverable by ``line_budget`` lines. Exhaustive
    over grid subsets, scanned by decreasing size; the value is exact
    FOR THE GRID, and the plane-wise scaling law stays conjecture-level.

    objective="separation": maximize line_separation_number over
    structured candidates (alternating colors on a parabola, red points
    inside the blue hull) plus ``samples`` seeded random configurations.
    The value is an exact evaluation of the best found configuration,
    i.e. a heuristic lower bound on the true worst case.
    """
    if objective == "covering_critical":
        return _covering_critical_search(line_budget, grid)
    if objective == "separation":
        return _separation_search(red, blue, grid, samples, seed)
    raise ValueError(f"unknown objective {objective!r}")


def _covering_critical_search(budget: int, grid: int) -> Evidence:
    if budget < 0 or grid < 2:
        raise ValueError("need line_budget >= 0 and grid >= 2")
    est = grid * grid * log10(2)
    if est > log10(_GRID_SCAN_BUDGET):
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"up to 10^{est:.1f} subsets on {grid}x{grid} grid",
                "sum_s C(grid^2, s) scans with per-set cover deepening",
            ),
            complexity_bound="O(2^(grid^2)) subsets; per-set O(lines^budget)",
        )

    pts = [(Fraction(x), Fraction(y)) for x in range(grid) for y in range(grid)]
    lines = _pair_lines(pts)
    masks = [m for _, m in lines]
    abc = {m: t for t, m in lines}
    scanned = 0
    try:
        for size in range(grid * grid, 0, -1):
            for subset in combinations(range(grid * grid), size):
                scanned += 1
                if scanned > _GRID_SCAN_BUDGET:
                    raise _BudgetExceeded
                sm = sum(1 << i for i in subset)
                if _min_cover(sm, masks, budget)[0] is not None:
                    continue  # coverable within budget: not critical
                witness_covers = []
                ok = True
                for i in subset:
                    k, chosen = _min_cover(sm & ~(1 << i), masks, budget)
                    if k is None:
                        ok = False
                        break
                    witness_covers.append((i, [abc[m] for m in chosen]))
                if ok:
                    return _critical_evidence(pts, subset, sm, masks, budget,
                                              grid, witness_covers, scanned)
    except _BudgetExceeded:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"scan budget exhausted after {scanned} subsets",
            feasibility=infeasible(
                f"scanned > {_GRID_SCAN_BUDGET} subsets or cover nodes",
                "O(2^(grid^2)) subsets",
            ),
            complexity_bound="O(2^(grid^2)) subsets; per-set O(lines^budget)",
        )
    return Evidence(
        value=None,
        certificate=f"no covering-critical subset on {grid}x{grid} grid",
        self_check=f"ok: {scanned} subsets exhausted, none critical",
        feasibility=infeasible(
            f"no critical subset of any size on {grid}x{grid} grid",
            "O(2^(grid^2)) subsets",
        ),
        complexity_bound="O(2^(grid^2)) subsets; per-set O(lines^budget)",
    )


def _critical_evidence(pts, subset, sm, masks, budget, grid, witness_covers, scanned):
    """Re-verify the witness before packaging the Evidence."""
    covers_ok = True
    for i, cert_lines in witness_covers:
        for j in subset:
            if j == i:
                continue
            x, y = pts[j]
            if not any(a * x + b * y == c for a, b, c in cert_lines):
                covers_ok = False
    # independent minimality re-check: blind scan of <= budget line tuples
    blind_ok = True
    if comb(len(masks), min(budget, len(masks))) <= 300_000:
        for r in range(budget + 1):
            for combo in combinations(range(len(masks)), r):
                u = 0
                for t in combo:
                    u |= masks[t]
                if u & sm == sm:
                    blind_ok = False
    else:
        blind_ok = _min_cover(sm, masks, budget)[0] is None
    size = len(subset)
    return Evidence(
        value=size,
        certificate=(
            f"grid={grid}x{grid}; witness={sorted(pts[i] for i in subset)}; "
            f"deletion_covers={[(pts[i], ls) for i, ls in witness_covers]}; "
            f"no critical subset of size > {size} on this grid "
            f"({scanned} subsets exhausted, decreasing size)"
        ),
        self_check=(
            f"deletion covers re-verified: {'ok' if covers_ok else 'MISMATCH'}; "
            f"covering number > {budget} re-checked blindly: "
            f"{'ok' if blind_ok else 'MISMATCH'}; exact on the grid, "
            f"plane-wise scaling law conjecture-level"
        ),
        feasibility="ok",
        complexity_bound=(
            f"O(2^(grid^2)) subsets (scanned {scanned}); per-set O(lines^{budget})"
        ),
    )


def _separation_search(red: int, blue: int, grid: int, samples: int, seed: int) -> Evidence:
    if red < 1 or blue < 1:
        raise ValueError("need red >= 1 and blue >= 1")
    n = red + blue
    if n > _SEP_MAX_POINTS:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{n} points > {_SEP_MAX_POINTS} per evaluation",
                "O(samples) exact separation evaluations",
            ),
            complexity_bound="O(samples * splits^k)",
        )
    if samples > _SEARCH_SAMPLES_CAP:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{samples} samples > {_SEARCH_SAMPLES_CAP}",
                "O(samples * splits^k)",
            ),
            complexity_bound="O(samples * splits^k)",
        )

    candidates: list[tuple[list, list]] = []

    def _add(pts, cols):
        try:
            if len(set(pts)) == len(pts):
                _require_general_position(pts)
                candidates.append((pts, cols))
        except ValueError:
            pass

    # structured: alternating colors on the parabola y = x^2 (convex position)
    alt_pts = [(Fraction(t), Fraction(t * t)) for t in range(n)]
    alt_cols, rr, bb = [], red, blue
    for t in range(n):
        if rr and (t % 2 == 0 or not bb):
            alt_cols.append(0)
            rr -= 1
        else:
            alt_cols.append(1)
            bb -= 1
    _add(alt_pts, alt_cols)
    # structured: red points inside the blue convex hull (centroids + jitter)
    in_pts = [(Fraction(t), Fraction(t * t)) for t in range(blue)]
    in_cols = [1] * blue
    for i in range(red):
        cx = sum(in_pts[(i + s) % blue][0] for s in range(3)) / 3 + Fraction(i + 1, 97)
        cy = sum(in_pts[(i + s) % blue][1] for s in range(3)) / 3 + Fraction(i + 1, 89)
        in_pts.append((cx, cy))
        in_cols.append(0)
    _add(in_pts, in_cols)
    # seeded random lattice configurations in general position
    rng = random.Random(seed)
    cell = [(Fraction(x), Fraction(y)) for x in range(grid) for y in range(grid)]
    made, tries = 0, 0
    while made < samples and tries < 50 * samples + 100:
        tries += 1
        sel = rng.sample(cell, n)
        cols = [0] * red + [1] * blue
        rng.shuffle(cols)
        try:
            _require_general_position(sel)
        except ValueError:
            continue
        candidates.append((sel, cols))
        made += 1

    best_k, best = -1, None
    for pts, cols in candidates:
        try:
            k, witness = _separation(pts, cols)
        except (ValueError, _BudgetExceeded):
            continue
        if k > best_k:
            best_k, best = k, (pts, cols, witness)

    if best is None:
        return Evidence(
            value=None,
            certificate="",
            self_check="no valid configuration evaluated",
            feasibility=infeasible("all evaluations failed", "O(samples) evaluations"),
            complexity_bound="O(samples * splits^k)",
        )
    pts, cols, witness = best
    ok = verify_separation_certificate(pts, cols, witness)
    return Evidence(
        value=best_k,
        certificate=(
            f"configuration={list(zip(pts, cols))}; separating_splits={witness}"
        ),
        self_check=(
            f"certificate re-check: {'ok' if ok else 'MISMATCH'}; "
            f"max over {len(candidates)} evaluated configurations — heuristic "
            f"lower bound on the true worst case, not an upper-bound proof"
        ),
        feasibility="ok",
        complexity_bound=f"O({len(candidates)} evaluations * splits^k)",
    )


# --------------------------------------------------------------------- #
# 4. Area-bisection coverage of a convex polygon
# --------------------------------------------------------------------- #
def _area2(poly) -> Fraction:
    s = Fraction(0)
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        s += x1 * y2 - x2 * y1
    return s


def area_bisection_coverage(vertices) -> Evidence:
    """Number of sides of a strictly convex n-gon hit by the n
    area-halving chords from the vertices: for vertex i, the chord from
    it to the unique boundary point that halves the polygon area. Exact
    rational arithmetic; degenerate instances (a chord endpoint landing
    exactly on a vertex) are rejected because the extremal problem
    excludes them by hypothesis.

    Certificate: per-vertex (hit side, exact interpolation ratio t);
    self-check: every reported chord re-halves the doubled area exactly.
    """
    poly = _to_points(vertices)
    n = len(poly)
    if n < 3:
        raise ValueError("need at least 3 vertices")
    if n > _POLYGON_MAX_SIDES:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(
                f"{n} sides > {_POLYGON_MAX_SIDES}", "O(n^2) boundary walk"
            ),
            complexity_bound="O(n^2)",
        )
    a2 = _area2(poly)
    if a2 == 0:
        raise ValueError("degenerate polygon")
    reversed_input = a2 < 0
    if reversed_input:
        poly = poly[::-1]
        a2 = -a2
    # strict convexity
    signs = set()
    for i in range(n):
        cr = _cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n])
        if cr == 0:
            raise ValueError("polygon must be strictly convex")
        signs.add(cr > 0)
    if len(signs) != 1:
        raise ValueError("polygon must be convex")

    half = a2 / 2
    hits = []  # (vertex i, side j, ratio t)
    for i in range(n):
        b = poly[i]
        acc = Fraction(0)
        for step in range(1, n):
            j = (i + step) % n
            k = (i + step + 1) % n
            vj, vk = poly[j], poly[k]
            add = _cross(b, vj, vk)
            if acc <= half < acc + add:
                t = (half - acc) / add
                if t == 0:
                    raise ValueError(
                        f"bisecting chord from vertex {i} lands exactly on "
                        f"vertex {j}; the extremal problem excludes this"
                    )
                hits.append((i, j, t))
                break
            acc += add
        else:  # pragma: no cover - monotone sweep always crosses half
            raise AssertionError("bisection sweep failed")
    k = len({j for _, j, _ in hits})

    # Self-check: recompute each halving area independently.
    ok = True
    for i, j, t in hits:
        chain = [poly[i]] + [poly[(i + s) % n] for s in range(1, (j - i) % n + 1)]
        vj, vk = poly[j], poly[(j + 1) % n]
        q = (vj[0] + t * (vk[0] - vj[0]), vj[1] + t * (vk[1] - vj[1]))
        if abs(_area2(chain + [q])) != half:
            ok = False
    return Evidence(
        value=k,
        certificate=(
            f"hits={hits}; doubled_area={a2}"
            + ("; input re-oriented CCW" if reversed_input else "")
        ),
        self_check=(
            f"all {n} chord areas re-verified exactly (doubled area {half}): "
            f"{'ok' if ok and len(hits) == n else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(n^2) = O({n}^2) boundary walk",
    )


# --------------------------------------------------------------------- #
# Evidence wrappers (W4): the raw checker above stays a subroutine; the
# Evidence-returning variant is what the tool tiers consume (§1.1).
# --------------------------------------------------------------------- #
def verify_separation_certificate_evidence(points, colors, splits) -> Evidence:
    """Independent separation-certificate check, as Evidence.

    The value is exactly the deterministic checker's verdict: each ordered
    pair (i, j[, s]) is expanded into an explicit rational line and every
    bichromatic pair must be separated by at least one split.
    """
    pts = list(points)
    split_list = [tuple(entry) for entry in splits]
    ok = verify_separation_certificate(pts, colors, split_list)
    return Evidence(
        value=ok,
        certificate=(
            f"{len(split_list)} claimed splits over {len(pts)} points; "
            f"every bichromatic pair separated: {ok}"
        ),
        self_check="independent explicit-line checker executed deterministically",
        feasibility="ok",
        complexity_bound="O(splits * n^2)",
    )


__all__ = [
    "area_bisection_coverage",
    "line_cover_number",
    "line_separation_number",
    "verify_separation_certificate",
    "verify_separation_certificate_evidence",
    "worst_configuration_search",
]
