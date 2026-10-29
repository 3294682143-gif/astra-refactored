"""constrained_tiling family.

Structural criterion: tiling existence / counting / extremum on boards with
extra constraints (local-square conditions, color bounds, coverage
multiplicity, uniqueness). Constraints are structured data, never executable
code.

Tiles are described by ``tile_shape_spec`` mappings:

- ``{"cells": [(r, c), ...], "allow_rotations": bool, "allow_reflections": bool}``
  — a base polyomino; orientations are generated from it.
- ``{"orientations": [[(r, c), ...], ...]}`` — explicit orientations.
- a list of the above describes a mixed tile set (several tile types).

The legacy keyword ``tile_area=2`` remains as a shorthand for the domino;
any other bare area is shape-ambiguous and rejected with ``ValueError``.

Constraints are described by ``constraint_spec`` mappings (all optional):

- ``"exact_tiles": int`` — place exactly this many tiles (partial mode).
- ``"exact_tiles_per_type": [int | None, ...]`` — per-type counts; at most
  one entry may be ``None``, meaning "fill the rest with this type"
  (full-cover mode). ``None``-free lists leave the remaining cells uncovered.
- ``"min_uncovered_per_2x2": int`` — every 2x2 subsquare has >= m uncovered
  cells (blocked cells count as uncovered).
- ``"two_uncovered_aligned_per_2x2": True`` — every 2x2 subsquare contains
  two uncovered cells sharing a row or a column.
- ``"forbid_full_2x2": True`` — shorthand for ``min_uncovered_per_2x2 >= 1``.
- ``"blocked_cells": [[r, c], ...]`` — cells no tile may cover.
- ``"marked_cells": [[r, c], ...]`` plus ``"forbid_two_marked_per_tile":
  True`` — no tile may contain two marked cells.

Tools:
- count_tilings: exact-cover backtracking counter with a feasibility guard
  (static estimate for full covers, cell-count cap + node budget for partial
  placement mode) — oversized workloads are refused, never hung on.
- coloring_bound: coloring-invariant lower-bound calculator (target color
  class size vs per-tile maximum occupancy of that class).
- min_tiles_cover: minimum number of tiles covering a target cell set
  (branch and bound; small boards only).
- unique_tiling_check: uniqueness of a full tiling under the
  no-tile-with-two-marked-cells rule, with a witness certificate.

The F2 feasibility-guard semantics is preserved: oversized full-cover
counting requests return ``feasibility="infeasible: ..."`` immediately.
"""
from __future__ import annotations

from math_families.core.evidence import Evidence
from math_families.core.feasibility import (
    backtracking_log10_estimate,
    infeasible,
    require_within_budget,
)

#: Hard node budget for the backtracking engine (keeps searches interruptible).
_DEFAULT_NODE_BUDGET = 2_000_000
#: Partial-placement mode is refused above this many free cells; the static
#: estimate is uninformative there, so the node budget is the guard.
_PARTIAL_MAX_CELLS = 256
#: min_tiles_cover is exponential; boards above this are refused.
_COVER_MAX_CELLS = 64
#: Reversed-order recount self-check is skipped above these limits.
_SELFCHECK_MAX_CELLS = 64
_SELFCHECK_MAX_NODES = 200_000

_UNDECIDED, _COVERED, _UNCOVERED = 0, 1, 2
#: Local index pairs inside a 2x2 block that share a row or a column.
_ALIGNED_PAIRS_2X2 = ((0, 1), (2, 3), (0, 2), (1, 3))

_TILE_SPEC_KEYS = frozenset(
    {"cells", "orientations", "allow_rotations", "allow_reflections"}
)
_CONSTRAINT_KEYS = frozenset(
    {
        "exact_tiles",
        "exact_tiles_per_type",
        "min_uncovered_per_2x2",
        "two_uncovered_aligned_per_2x2",
        "forbid_full_2x2",
        "blocked_cells",
        "marked_cells",
        "forbid_two_marked_per_tile",
    }
)


class _BudgetExceeded(Exception):
    """Internal: the node budget ran out mid-search."""


# --------------------------------------------------------------------- #
# Structured spec parsing
# --------------------------------------------------------------------- #
def _normalize(shape) -> tuple:
    """Canonical form of one orientation: sorted offsets, min row/col at 0."""
    pts = [tuple(p) for p in shape]
    min_r = min(r for r, _ in pts)
    min_c = min(c for _, c in pts)
    return tuple(sorted((r - min_r, c - min_c) for r, c in pts))


def _orientations_from_cells(cells, allow_rotations, allow_reflections) -> list:
    base = [tuple(map(int, p)) for p in cells]
    if not base:
        raise ValueError("tile shape must be non-empty")
    shapes = [base]
    if allow_rotations:
        shapes.append([(c, -r) for r, c in base])
        shapes.append([(-r, -c) for r, c in base])
        shapes.append([(-c, r) for r, c in base])
    if allow_reflections:
        shapes += [[(-r, c) for r, c in s] for s in list(shapes)]
    return sorted({_normalize(s) for s in shapes})


def _parse_tile_spec(spec, tile_area=None) -> list:
    """Return a list of orientation lists, one per tile type."""
    if spec is None:
        if tile_area is None:
            raise ValueError("need tile_shape_spec (or tile_area=2 for dominoes)")
        if tile_area != 2:
            raise ValueError(
                "bare tile_area only defines the area-2 domino; other areas are "
                "shape-ambiguous — pass tile_shape_spec={'cells': ..., ...}"
            )
        spec = {"cells": [(0, 0), (0, 1)], "allow_rotations": True}
    specs = [spec] if isinstance(spec, dict) else list(spec)
    if not specs:
        raise ValueError("empty tile set")
    per_type = []
    for s in specs:
        if not isinstance(s, dict):
            raise TypeError(f"tile_shape_spec entries must be mappings, got {type(s).__name__}")
        unknown = set(s) - _TILE_SPEC_KEYS
        if unknown:
            raise ValueError(f"unknown tile_shape_spec keys: {sorted(unknown)}")
        if "orientations" in s:
            orients = {_normalize(o) for o in s["orientations"]}
        elif "cells" in s:
            orients = set(
                _orientations_from_cells(
                    s["cells"],
                    bool(s.get("allow_rotations", False)),
                    bool(s.get("allow_reflections", False)),
                )
            )
        else:
            raise ValueError("tile_shape_spec needs 'cells' or 'orientations'")
        if not orients:
            raise ValueError("tile shape produced no orientations")
        if len({len(o) for o in orients}) != 1:
            raise ValueError("orientations disagree on tile area")
        per_type.append(sorted(orients))
    return per_type


def _spec_area_estimate(spec, tile_area) -> int:
    """Cheap tile-area read for the feasibility guard (full parse comes later)."""
    if tile_area is not None:
        if not isinstance(tile_area, int) or isinstance(tile_area, bool) or tile_area < 1:
            raise ValueError("tile_area must be a positive int")
        return tile_area
    try:
        specs = [spec] if isinstance(spec, dict) else list(spec)
        areas = []
        for s in specs:
            src = s["orientations"][0] if "orientations" in s else s["cells"]
            areas.append(len(src))
        return min(areas)
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("cannot read tile area from tile_shape_spec") from exc


def _parse_constraints(constraint_spec) -> dict:
    con = {
        "exact_tiles": None,
        "exact_per_type": None,
        "min_uncovered": 0,
        "aligned": False,
        "blocked": frozenset(),
        "marked": frozenset(),
        "forbid_two_marked": False,
    }
    if constraint_spec is None:
        return con
    if not isinstance(constraint_spec, dict):
        raise TypeError("constraint_spec must be a mapping of structured data")
    unknown = set(constraint_spec) - _CONSTRAINT_KEYS
    if unknown:
        raise ValueError(f"unknown constraint keys: {sorted(unknown)}")
    if "exact_tiles" in constraint_spec:
        v = constraint_spec["exact_tiles"]
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError("exact_tiles must be a non-negative int")
        con["exact_tiles"] = v
    if "exact_tiles_per_type" in constraint_spec:
        seq = constraint_spec["exact_tiles_per_type"]
        if not isinstance(seq, (list, tuple)) or not seq:
            raise ValueError("exact_tiles_per_type must be a non-empty list")
        parsed = []
        for v in seq:
            if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0):
                raise ValueError("exact_tiles_per_type entries must be non-negative ints or None")
            parsed.append(v)
        con["exact_per_type"] = tuple(parsed)
    if con["exact_tiles"] is not None and con["exact_per_type"] is not None:
        raise ValueError("exact_tiles and exact_tiles_per_type are mutually exclusive")
    if "min_uncovered_per_2x2" in constraint_spec:
        v = constraint_spec["min_uncovered_per_2x2"]
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 4:
            raise ValueError("min_uncovered_per_2x2 must be an int in 0..4")
        con["min_uncovered"] = max(con["min_uncovered"], v)
    if constraint_spec.get("forbid_full_2x2"):
        con["min_uncovered"] = max(con["min_uncovered"], 1)
    con["aligned"] = bool(constraint_spec.get("two_uncovered_aligned_per_2x2", False))
    con["blocked"] = frozenset(
        tuple(map(int, p)) for p in (constraint_spec.get("blocked_cells") or [])
    )
    con["marked"] = frozenset(
        tuple(map(int, p)) for p in (constraint_spec.get("marked_cells") or [])
    )
    con["forbid_two_marked"] = bool(constraint_spec.get("forbid_two_marked_per_tile", False))
    if con["marked"] and not con["forbid_two_marked"]:
        raise ValueError("marked_cells requires forbid_two_marked_per_tile")
    if con["forbid_two_marked"] and not con["marked"]:
        raise ValueError("forbid_two_marked_per_tile requires marked_cells")
    return con


# --------------------------------------------------------------------- #
# Backtracking engine
# --------------------------------------------------------------------- #
def _build_structures(rows, cols, orientations_per_type, con):
    """Precompute placements per cell, 2x2 blocks, and initial cell states."""
    n = rows * cols
    blocked_idx = set()
    for r, c in con["blocked"]:
        if not (0 <= r < rows and 0 <= c < cols):
            raise ValueError(f"blocked cell {(r, c)} out of board")
        blocked_idx.add(r * cols + c)
    marked_idx = set()
    for r, c in con["marked"]:
        if not (0 <= r < rows and 0 <= c < cols):
            raise ValueError(f"marked cell {(r, c)} out of board")
        marked_idx.add(r * cols + c)

    placements: list[list] = [[] for _ in range(n)]
    for t, orients in enumerate(orientations_per_type):
        for orient in orients:
            span_r = max(r for r, _ in orient)
            span_c = max(c for _, c in orient)
            for ar in range(rows - span_r):
                for ac in range(cols - span_c):
                    cells = tuple(sorted((ar + dr) * cols + (ac + dc) for dr, dc in orient))
                    if any(cell in blocked_idx for cell in cells):
                        continue
                    if con["forbid_two_marked"] and sum(
                        cell in marked_idx for cell in cells
                    ) >= 2:
                        continue
                    for cell in cells:
                        placements[cell].append((cells, t))

    blocks = []
    cell_blocks: list[list] = [[] for _ in range(n)]
    for r in range(rows - 1):
        for c in range(cols - 1):
            b = (r * cols + c, r * cols + c + 1, (r + 1) * cols + c, (r + 1) * cols + c + 1)
            idx = len(blocks)
            blocks.append(b)
            for cell in b:
                cell_blocks[cell].append(idx)

    st0 = bytearray(n)
    for cell in blocked_idx:
        st0[cell] = _UNCOVERED  # blocked cells behave as pre-decided uncovered
    return placements, blocks, cell_blocks, st0


def _search(
    rows,
    cols,
    placements,
    blocks,
    cell_blocks,
    st0,
    budgets,
    areas,
    unc_budget,
    min_unc,
    aligned,
    max_nodes,
    *,
    reverse=False,
    cap=None,
    want_witness=False,
):
    """Exact-cover backtracking over first-undecided-cell decisions.

    ``budgets[t]`` is the exact number of tiles of type t to place, or None
    for a flexible type (at most one flexible type is given a divisibility
    prune). ``unc_budget`` is the exact number of free cells to leave
    uncovered. Returns a dict with count / nodes / witness / branch split.
    """
    n = rows * cols
    step = -1 if reverse else 1
    st = bytearray(st0)
    n_types = len(areas)
    flex = [t for t in range(n_types) if budgets[t] is None]
    state = {
        "count": 0,
        "nodes": 0,
        "witness": None,
        "branches": {},
    }
    placed = [0] * n_types
    stack: list = []
    root_label = [None]

    def blocks_ok(changed_cells):
        seen = set()
        for cell in changed_cells:
            for b in cell_blocks[cell]:
                if b in seen:
                    continue
                seen.add(b)
                bc = blocks[b]
                s0, s1, s2, s3 = st[bc[0]], st[bc[1]], st[bc[2]], st[bc[3]]
                cov = (s0 == _COVERED) + (s1 == _COVERED) + (s2 == _COVERED) + (s3 == _COVERED)
                und = (s0 == _UNDECIDED) + (s1 == _UNDECIDED) + (s2 == _UNDECIDED) + (s3 == _UNDECIDED)
                unc = 4 - cov - und
                if min_unc and unc + und < min_unc:
                    return False
                if aligned:
                    satisfied = any(
                        st[bc[i]] == _UNCOVERED and st[bc[j]] == _UNCOVERED
                        for i, j in _ALIGNED_PAIRS_2X2
                    )
                    if not satisfied and not any(
                        st[bc[i]] != _COVERED and st[bc[j]] != _COVERED
                        for i, j in _ALIGNED_PAIRS_2X2
                    ):
                        return False
        return True

    undecided = [sum(1 for v in st if v == _UNDECIDED)]
    unc_used = [0]

    def rec(pos, depth):
        if cap is not None and state["count"] >= cap:
            return
        state["nodes"] += 1
        if state["nodes"] > max_nodes:
            raise _BudgetExceeded
        i = pos
        while 0 <= i < n and st[i] != _UNDECIDED:
            i += step
        if i < 0 or i >= n:
            state["count"] += 1
            if want_witness and state["witness"] is None:
                state["witness"] = list(stack)
            if root_label[0] is not None:
                branches = state["branches"]
                branches[root_label[0]] = branches.get(root_label[0], 0) + 1
            return
        # Balance prune: remaining cells must be able to absorb the remaining
        # uncovered quota plus the remaining fixed tile counts.
        needed = unc_budget - unc_used[0]
        for t in range(n_types):
            if budgets[t] is not None:
                needed += (budgets[t] - placed[t]) * areas[t]
        if undecided[0] < needed:
            return
        if len(flex) == 1 and (undecided[0] - needed) % areas[flex[0]] != 0:
            return
        # Option A: leave the cell uncovered.
        if unc_used[0] < unc_budget:
            st[i] = _UNCOVERED
            unc_used[0] += 1
            undecided[0] -= 1
            if blocks_ok((i,)):
                if depth == 0:
                    root_label[0] = "uncovered"
                rec(i + step, depth + 1)
                if depth == 0:
                    root_label[0] = None
            unc_used[0] -= 1
            undecided[0] += 1
            st[i] = _UNDECIDED
        # Option B: cover the cell with a tile.
        for pcells, t in placements[i]:
            if budgets[t] is not None and placed[t] >= budgets[t]:
                continue
            if any(st[j] != _UNDECIDED for j in pcells):
                continue
            for j in pcells:
                st[j] = _COVERED
            placed[t] += 1
            undecided[0] -= len(pcells)
            stack.append((t, pcells))
            if blocks_ok(pcells):
                if depth == 0:
                    root_label[0] = f"type{t}:{pcells}"
                rec(i + step, depth + 1)
                if depth == 0:
                    root_label[0] = None
            stack.pop()
            placed[t] -= 1
            undecided[0] += len(pcells)
            for j in pcells:
                st[j] = _UNDECIDED

    rec(n - 1 if reverse else 0, 0)
    return state


def _infeasible_evidence(marker, self_check="not attempted") -> Evidence:
    return Evidence(
        value=None,
        certificate="",
        self_check=self_check,
        feasibility=marker,
        complexity_bound="O(branching^(cells/tile_area)) worst case",
    )


# --------------------------------------------------------------------- #
# 1. Tiling counting
# --------------------------------------------------------------------- #
def count_tilings(
    rows,
    cols,
    tile_shape_spec=None,
    constraint_spec=None,
    tile_area=None,
    max_nodes=None,
) -> Evidence:
    """Count tilings of a ``rows x cols`` board under structured constraints.

    Full-cover mode (no exact counts) keeps the F2 static feasibility guard.
    Partial mode (``exact_tiles`` / ``exact_tiles_per_type``) is limited to
    small boards and guarded by the node budget. Certificate: branch split of
    the count over the first cell's choices; self-check: reversed-order
    recount on small instances.
    """
    for name, v in (("rows", rows), ("cols", cols)):
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValueError(f"{name} must be a positive int")
    con = _parse_constraints(constraint_spec)
    area_est = _spec_area_estimate(tile_shape_spec, tile_area)
    free = rows * cols - len(con["blocked"])
    partial = con["exact_tiles"] is not None or con["exact_per_type"] is not None

    if not partial:
        marker = require_within_budget(backtracking_log10_estimate(free, area_est))
        if marker is not None:
            return _infeasible_evidence(marker)
    elif free > _PARTIAL_MAX_CELLS:
        return _infeasible_evidence(
            infeasible(
                f"partial-placement search capped at {_PARTIAL_MAX_CELLS} free cells "
                f"(board has {free}); node budget is the guard there",
                "exact-cover backtracking",
            )
        )

    orientations = _parse_tile_spec(tile_shape_spec, tile_area)
    areas = [len(t[0]) for t in orientations]
    n_types = len(areas)

    if con["exact_tiles"] is not None:
        if n_types > 1:
            raise ValueError("exact_tiles is ambiguous for mixed tiles; use exact_tiles_per_type")
        budgets = [con["exact_tiles"]]
        unc_budget = free - con["exact_tiles"] * areas[0]
    elif con["exact_per_type"] is not None:
        budgets = list(con["exact_per_type"])
        if len(budgets) != n_types:
            raise ValueError("exact_tiles_per_type length must match the number of tile types")
        if sum(b is None for b in budgets) > 1:
            raise ValueError("at most one tile type may be flexible (None)")
        known = sum(b * a for b, a in zip(budgets, areas) if b is not None)
        unc_budget = 0 if any(b is None for b in budgets) else free - known
    else:
        budgets = [None] * n_types
        unc_budget = 0
    if unc_budget < 0:
        return Evidence(
            value=0,
            certificate="budget arithmetic: required tiles exceed free cells",
            self_check="no search needed",
            feasibility="ok",
            complexity_bound="O(1)",
        )
    if max_nodes is None:
        max_nodes = _DEFAULT_NODE_BUDGET

    placements, blocks, cell_blocks, st0 = _build_structures(rows, cols, orientations, con)
    try:
        res = _search(
            rows, cols, placements, blocks, cell_blocks, st0,
            budgets, areas, unc_budget, con["min_uncovered"], con["aligned"],
            max_nodes, cap=None,
        )
    except _BudgetExceeded:
        return _infeasible_evidence(
            infeasible(
                f"node budget {max_nodes} exhausted mid-search",
                "exact-cover backtracking",
            ),
            self_check="budget exhausted",
        )

    count = res["count"]
    if free <= _SELFCHECK_MAX_CELLS and res["nodes"] <= _SELFCHECK_MAX_NODES:
        try:
            rev = _search(
                rows, cols, placements, blocks, cell_blocks, st0,
                budgets, areas, unc_budget, con["min_uncovered"], con["aligned"],
                max_nodes, reverse=True, cap=None,
            )
            ok = rev["count"] == count
            self_check = (
                f"reversed-order recount={rev['count']} vs {count}: "
                f"{'ok' if ok else 'MISMATCH'}"
            )
        except _BudgetExceeded:
            self_check = "reversed-order recount skipped: budget exhausted"
    else:
        self_check = (
            f"reversed-order recount skipped at this scale "
            f"(free={free}, nodes={res['nodes']})"
        )

    return Evidence(
        value=count,
        certificate=(
            f"mode={'partial' if partial else 'full_cover'}, free_cells={free}, "
            f"budgets={budgets}, unc_budget={unc_budget}, "
            f"branches={res['branches']}"
        ),
        self_check=self_check,
        feasibility="ok",
        complexity_bound=(
            f"O(branching^(cells/tile_area)) worst case; "
            f"nodes={res['nodes']} (budget {max_nodes})"
        ),
    )


# --------------------------------------------------------------------- #
# 2. Coloring-invariant lower bound
# --------------------------------------------------------------------- #
def _parse_coloring(coloring_spec):
    if not isinstance(coloring_spec, dict):
        raise TypeError("coloring_spec must be a mapping of structured data")
    kind = coloring_spec.get("kind")
    if kind == "checkerboard":
        p = coloring_spec.get("target_parity", 0)
        if p not in (0, 1):
            raise ValueError("target_parity must be 0 or 1")
        # color(r, c) = (r + c) % 2
        return ("checkerboard", 2, 2, None, p)
    if kind == "product_mod":
        a, b = coloring_spec.get("row_mod"), coloring_spec.get("col_mod")
        target = coloring_spec.get("target")
        if (
            not isinstance(a, int) or not isinstance(b, int)
            or a < 1 or b < 1 or a > 10**6 or b > 10**6
        ):
            raise ValueError("row_mod/col_mod must be ints in 1..10^6")
        if (
            not isinstance(target, (list, tuple)) or len(target) != 2
            or not (0 <= int(target[0]) < a) or not (0 <= int(target[1]) < b)
        ):
            raise ValueError("target must be [i, j] with 0 <= i < row_mod, 0 <= j < col_mod")
        # color(r, c) = (r % a, c % b)
        return ("product_mod", a, b, (int(target[0]), int(target[1])), None)
    raise ValueError(f"unknown coloring kind: {kind!r}")


def _target_count(rows, cols, parsed_coloring) -> int:
    kind, a, b, target, parity = parsed_coloring
    if kind == "checkerboard":
        n = rows * cols
        half = n // 2
        return half + (n % 2 if parity == 0 else 0)

    def axis(length, mod, residue):
        if residue >= length:
            return 0
        return (length - 1 - residue) // mod + 1

    return axis(rows, a, target[0]) * axis(cols, b, target[1])


def _occupancy_range(orientations, parsed_coloring):
    """(min, max, witness) number of target-class cells over all placements."""
    kind, a, b, target, parity = parsed_coloring
    best = {"min": None, "max": None, "witness": None}
    for orient in orientations:
        for r0 in range(a):
            for c0 in range(b):
                if kind == "checkerboard":
                    occ = sum(((r0 + dr) + (c0 + dc)) % 2 == parity for dr, dc in orient)
                else:
                    occ = sum(
                        ((r0 + dr) % a, (c0 + dc) % b) == target for dr, dc in orient
                    )
                if best["min"] is None or occ < best["min"]:
                    best["min"] = occ
                if best["max"] is None or occ > best["max"]:
                    best["max"] = occ
                    best["witness"] = (orient, (r0, c0), occ)
    return best


def coloring_bound(board_spec, tile_shape_spec, coloring_spec) -> Evidence:
    """Coloring-invariant lower bound for covering a target color class.

    Counts the target-class cells and computes, per tile type, the maximum
    number of target cells any single placement can cover. The lower bound
    is ceil(target / max_per_tile) when there is exactly one tile type; with
    mixed types the per-type occupancies are returned as the inequality
    ``target <= sum_i max_i * n_i`` for the caller to combine.

    Certificate: per-type occupancy witness (orientation + phase).
    Self-check: target count closed form vs direct summation.
    """
    if not isinstance(board_spec, dict):
        raise TypeError("board_spec must be a mapping {'rows': int, 'cols': int}")
    rows, cols = board_spec.get("rows"), board_spec.get("cols")
    for name, v in (("rows", rows), ("cols", cols)):
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValueError(f"board_spec {name} must be a positive int")
    if rows * cols > 10**12:
        return _infeasible_evidence(
            infeasible(f"board {rows}x{cols} beyond counting range", "closed-form counting")
        )
    parsed = _parse_coloring(coloring_spec)
    orientations = _parse_tile_spec(tile_shape_spec)

    target_cells = _target_count(rows, cols, parsed)
    tiles = {}
    for t, orients in enumerate(orientations):
        occ = _occupancy_range(orients, parsed)
        tiles[f"tile_{t}"] = {
            "area": len(orients[0]),
            "max_per_tile": occ["max"],
            "min_per_tile": occ["min"],
        }
        tiles[f"tile_{t}"]["_witness"] = occ["witness"]

    single = len(orientations) == 1
    max_occ = tiles["tile_0"]["max_per_tile"] if single else None
    lower = None
    if single and max_occ:
        lower = -(-target_cells // max_occ)
    cover_impossible = target_cells > 0 and all(
        v["max_per_tile"] == 0 for v in tiles.values()
    )

    kind, a, b, target, parity = parsed
    if rows * cols <= 10**6:
        direct = 0
        for r in range(rows):
            for c in range(cols):
                if kind == "checkerboard":
                    direct += (r + c) % 2 == parity
                else:
                    direct += (r % a, c % b) == target
        ok = direct == target_cells
        self_check = f"target count direct={direct} vs formula={target_cells}: {'ok' if ok else 'MISMATCH'}"
    else:
        # Cross-check the closed form by row/column decomposition.
        if kind == "checkerboard":
            # Each row pair contributes exactly `cols` target cells; a lone
            # last row contributes the cells with the matching column parity.
            alt = (rows // 2) * cols
            if rows % 2:
                want = (parity - (rows - 1)) % 2
                alt += cols // 2 + (1 if cols % 2 and want == 0 else 0)
        else:
            full_r, rem_r = divmod(rows, a)
            full_c, rem_c = divmod(cols, b)
            alt = (
                full_r * full_c * _target_count(a, b, parsed)
                + full_r * _target_count(a, rem_c, parsed)
                + full_c * _target_count(rem_r, b, parsed)
                + _target_count(rem_r, rem_c, parsed)
            )
        ok = alt == target_cells
        self_check = f"target count cycle-decomposition={alt} vs formula={target_cells}: {'ok' if ok else 'MISMATCH'}"

    cert_tiles = {
        label: {
            "max_per_tile": v["max_per_tile"],
            "min_per_tile": v["min_per_tile"],
            "witness": v["_witness"],
        }
        for label, v in tiles.items()
    }
    value = {
        "target_cells": target_cells,
        "tiles": {label: {k: v[k] for k in ("area", "max_per_tile", "min_per_tile")} for label, v in tiles.items()},
        "lower_bound_tiles": lower,
        "cover_impossible": cover_impossible,
        "inequality": "target_cells <= sum_i max_per_tile_i * n_i",
    }
    return Evidence(
        value=value,
        certificate=f"coloring={coloring_spec}, occupancy_witness={cert_tiles}",
        self_check=self_check,
        feasibility="ok",
        complexity_bound="O(orientations * row_mod * col_mod * tile_area)",
    )


# --------------------------------------------------------------------- #
# 3. Minimum cover of a target cell set
# --------------------------------------------------------------------- #
def _parse_targets(target_spec, rows, cols) -> list:
    if not isinstance(target_spec, dict):
        raise TypeError("target_spec must be a mapping of structured data")
    kind = target_spec.get("kind")
    if kind == "cells":
        cells = [tuple(map(int, p)) for p in target_spec.get("cells", [])]
        for r, c in cells:
            if not (0 <= r < rows and 0 <= c < cols):
                raise ValueError(f"target cell {(r, c)} out of board")
        return sorted({r * cols + c for r, c in cells})
    if kind == "checkerboard":
        p = target_spec.get("parity", 0)
        if p not in (0, 1):
            raise ValueError("parity must be 0 or 1")
        return [r * cols + c for r in range(rows) for c in range(cols) if (r + c) % 2 == p]
    if kind == "product_mod":
        a, b = target_spec.get("row_mod"), target_spec.get("col_mod")
        target = target_spec.get("target")
        if not isinstance(a, int) or not isinstance(b, int) or a < 1 or b < 1:
            raise ValueError("row_mod/col_mod must be positive ints")
        if not isinstance(target, (list, tuple)) or len(target) != 2:
            raise ValueError("target must be [i, j]")
        i, j = int(target[0]), int(target[1])
        if not (0 <= i < a) or not (0 <= j < b):
            raise ValueError("target residues out of range")
        return [
            r * cols + c
            for r in range(rows) if r % a == i
            for c in range(cols) if c % b == j
        ]
    raise ValueError(f"unknown target kind: {kind!r}")


def min_tiles_cover(rows, cols, tile_shape_spec, target_spec, max_nodes=None) -> Evidence:
    """Minimum number of tiles covering every target cell (non-overlapping).

    Tiles may also cover non-target cells. Branch and bound over the first
    uncovered target cell; small boards only. Certificate: the achieving
    placement list, re-checkable with check_cover_certificate. Optimality
    rests on exhaustive search within the node budget.
    """
    for name, v in (("rows", rows), ("cols", cols)):
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValueError(f"{name} must be a positive int")
    n = rows * cols
    if n > _COVER_MAX_CELLS:
        return _infeasible_evidence(
            infeasible(
                f"cover search capped at {_COVER_MAX_CELLS} cells (board has {n})",
                "branch and bound",
            )
        )
    if max_nodes is None:
        max_nodes = _DEFAULT_NODE_BUDGET
    targets = _parse_targets(target_spec, rows, cols)
    if not targets:
        return Evidence(
            value=0,
            certificate="empty target set",
            self_check="no search needed",
            feasibility="ok",
            complexity_bound="O(1)",
        )
    orientations = _parse_tile_spec(tile_shape_spec)
    target_set = set(targets)

    # Placements covering at least one target cell.
    placements = []
    for t, orients in enumerate(orientations):
        for orient in orients:
            span_r = max(r for r, _ in orient)
            span_c = max(c for _, c in orient)
            for ar in range(rows - span_r):
                for ac in range(cols - span_c):
                    cells = tuple(sorted((ar + dr) * cols + (ac + dc) for dr, dc in orient))
                    tmask = 0
                    pmask = 0
                    for pos, cell in enumerate(cells):
                        pmask |= 1 << cell
                    for idx, cell in enumerate(targets):
                        if cell in cells:
                            tmask |= 1 << idx
                    if tmask:
                        placements.append((pmask, tmask, cells))
    by_target: list[list] = [[] for _ in targets]
    for pidx, (_, tmask, _) in enumerate(placements):
        m = tmask
        while m:
            low = m & -m
            by_target[low.bit_length() - 1].append(pidx)
            m ^= low
    uncoverable = [targets[i] for i in range(len(targets)) if not by_target[i]]
    if uncoverable:
        r, c = divmod(uncoverable[0], cols)
        return _infeasible_evidence(
            infeasible(
                f"target cell ({r}, {c}) cannot be covered by any placement (exhaustive)",
                "branch and bound",
            )
        )
    max_occ = max(tmask.bit_count() for _, tmask, _ in placements)

    best: list = [None]
    nodes = [0]

    def greedy():
        chosen = []
        occupied = 0
        uncovered = (1 << len(targets)) - 1
        while uncovered:
            t = (uncovered & -uncovered).bit_length() - 1
            cand = None
            cand_gain = -1
            for pidx in by_target[t]:
                pmask, tmask, _ = placements[pidx]
                if pmask & occupied:
                    continue
                gain = (tmask & uncovered).bit_count()
                if gain > cand_gain:
                    cand_gain, cand = gain, pidx
            if cand is None:
                return None
            pmask, tmask, cells = placements[cand]
            chosen.append(cells)
            occupied |= pmask
            uncovered &= ~tmask
        return chosen

    first = greedy()
    if first is not None:
        best[0] = first

    def rec(uncovered, occupied, chosen):
        nodes[0] += 1
        if nodes[0] > max_nodes:
            raise _BudgetExceeded
        if best[0] is not None and len(chosen) >= len(best[0]):
            return
        if uncovered == 0:
            best[0] = list(chosen)
            return
        lower = -(-uncovered.bit_count() // max_occ)
        if best[0] is not None and len(chosen) + lower >= len(best[0]):
            return
        t = (uncovered & -uncovered).bit_length() - 1
        for pidx in by_target[t]:
            pmask, tmask, cells = placements[pidx]
            if pmask & occupied:
                continue
            chosen.append(cells)
            rec(uncovered & ~tmask, occupied | pmask, chosen)
            chosen.pop()

    try:
        rec((1 << len(targets)) - 1, 0, [])
    except _BudgetExceeded:
        return _infeasible_evidence(
            infeasible(f"node budget {max_nodes} exhausted mid-search", "branch and bound"),
            self_check="budget exhausted",
        )
    if best[0] is None:
        return _infeasible_evidence(
            infeasible("no valid cover exists (exhaustive search)", "branch and bound")
        )

    cert = [[list(divmod(cell, cols)) for cell in cells] for cells in best[0]]
    ok = check_cover_certificate(rows, cols, tile_shape_spec, target_spec, cert)
    return Evidence(
        value=len(best[0]),
        certificate=f"placements={cert}",
        self_check=(
            f"certificate verified: {'ok' if ok else 'MISMATCH'}; "
            f"optimality by exhaustive branch-and-bound (nodes={nodes[0]})"
        ),
        feasibility="ok",
        complexity_bound=(
            f"O(branching^targets) worst case; nodes={nodes[0]} (budget {max_nodes})"
        ),
    )


# --------------------------------------------------------------------- #
# 4. Uniqueness check under a marking constraint
# --------------------------------------------------------------------- #
def unique_tiling_check(
    rows, cols, marked_cells, tile_shape_spec=None, tile_area=None, max_nodes=None
) -> Evidence:
    """Check whether exactly one full tiling avoids two-marked-cell tiles.

    Returns ``{"tilings_found": n, "unique": n == 1, "capped_at_two": ...}``
    with n capped at 2 (early exit). Certificate: a witness tiling;
    self-check: the witness is re-verified by check_tiling_certificate.
    Uniqueness rests on the exhaustive search.
    """
    for name, v in (("rows", rows), ("cols", cols)):
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValueError(f"{name} must be a positive int")
    con = _parse_constraints(
        {"marked_cells": marked_cells, "forbid_two_marked_per_tile": True}
    )
    area_est = _spec_area_estimate(tile_shape_spec, tile_area)
    free = rows * cols
    marker = require_within_budget(backtracking_log10_estimate(free, area_est))
    if marker is not None:
        return _infeasible_evidence(marker)
    if max_nodes is None:
        max_nodes = _DEFAULT_NODE_BUDGET

    orientations = _parse_tile_spec(tile_shape_spec, tile_area)
    areas = [len(t[0]) for t in orientations]
    budgets = [None] * len(areas)
    placements, blocks, cell_blocks, st0 = _build_structures(rows, cols, orientations, con)
    try:
        res = _search(
            rows, cols, placements, blocks, cell_blocks, st0,
            budgets, areas, 0, 0, False, max_nodes, cap=2, want_witness=True,
        )
    except _BudgetExceeded:
        return _infeasible_evidence(
            infeasible(f"node budget {max_nodes} exhausted mid-search", "exact-cover backtracking"),
            self_check="budget exhausted",
        )

    found = min(res["count"], 2)
    witness = res["witness"]
    cert_cells = None
    if witness is not None:
        cert_cells = [[list(divmod(cell, cols)) for cell in cells] for _, cells in witness]
    witness_ok = None
    if cert_cells is not None:
        witness_ok = check_tiling_certificate(
            rows,
            cols,
            cert_cells,
            tile_shape_spec=tile_shape_spec,
            tile_area=tile_area,
            constraint_spec={
                "marked_cells": marked_cells,
                "forbid_two_marked_per_tile": True,
            },
        )
    value = {
        "tilings_found": found,
        "unique": found == 1,
        "capped_at_two": found == 2,
    }
    return Evidence(
        value=value,
        certificate=f"witness={cert_cells}" if cert_cells else "no tiling found",
        self_check=(
            f"witness verified: {'ok' if witness_ok else 'MISMATCH'}; "
            if witness_ok is not None
            else "no witness; "
        )
        + "uniqueness by exhaustive search (cap 2)",
        feasibility="ok",
        complexity_bound=(
            f"O(branching^(cells/tile_area)) worst case; nodes={res['nodes']} (budget {max_nodes})"
        ),
    )


# --------------------------------------------------------------------- #
# Certificate checkers
# --------------------------------------------------------------------- #
def check_tiling_certificate(
    rows, cols, placements, tile_shape_spec=None, tile_area=None, constraint_spec=None
) -> bool:
    """Verify a tiling certificate: every placement is a valid orientation of
    some tile type, placements are disjoint, respect blocked/marked rules,
    and meet the coverage requirement (full cover unless exact counts given).
    """
    orientations = _parse_tile_spec(tile_shape_spec, tile_area)
    orient_set = set()
    for orients in orientations:
        orient_set.update(orients)
    con = _parse_constraints(constraint_spec)
    blocked = set(con["blocked"])
    marked = set(con["marked"])

    used = set()
    type_counts = [0] * len(orientations)
    for placement in placements:
        pts = [tuple(map(int, p)) for p in placement]
        if not pts:
            return False
        if any(not (0 <= r < rows and 0 <= c < cols) for r, c in pts):
            return False
        if _normalize(pts) not in orient_set:
            return False
        for t, orients in enumerate(orientations):
            if _normalize(pts) in set(orients):
                type_counts[t] += 1
                break
        if any(p in blocked for p in pts):
            return False
        if con["forbid_two_marked"] and sum(p in marked for p in pts) >= 2:
            return False
        for p in pts:
            if p in used:
                return False
            used.add(p)

    # A certificate must satisfy the same local uncovered-cell constraints
    # as the counting search; coverage and tile counts alone are insufficient.
    for r in range(rows - 1):
        for c in range(cols - 1):
            block = {(r, c), (r + 1, c), (r, c + 1), (r + 1, c + 1)}
            uncovered = block - used
            if len(uncovered) < con["min_uncovered"]:
                return False
            if con["aligned"] and not any(
                a != b and (a[0] == b[0] or a[1] == b[1])
                for a in uncovered for b in uncovered
            ):
                return False
    free = {(r, c) for r in range(rows) for c in range(cols)} - blocked
    if con["exact_tiles"] is not None:
        return sum(type_counts) == con["exact_tiles"]
    if con["exact_per_type"] is not None:
        for t, b in enumerate(con["exact_per_type"]):
            if b is not None and type_counts[t] != b:
                return False
        if any(b is None for b in con["exact_per_type"]):
            return used == free
        return True
    return used == free


def check_cover_certificate(rows, cols, tile_shape_spec, target_spec, placements) -> bool:
    """Verify a cover certificate: valid orientations, disjoint placements,
    and every target cell covered at least once."""
    orientations = _parse_tile_spec(tile_shape_spec)
    orient_set = set()
    for orients in orientations:
        orient_set.update(orients)
    targets = set(_parse_targets(target_spec, rows, cols))

    used = set()
    covered_targets = set()
    for placement in placements:
        pts = [tuple(map(int, p)) for p in placement]
        if any(not (0 <= r < rows and 0 <= c < cols) for r, c in pts):
            return False
        if _normalize(pts) not in orient_set:
            return False
        for p in pts:
            if p in used:
                return False
            used.add(p)
        covered_targets |= {p for p in pts if p in targets}
    return targets <= covered_targets
