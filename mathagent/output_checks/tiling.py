"""Placement-subset enumeration, independent of producer first-cell backtracking."""

from __future__ import annotations

import itertools as it

from .common import bound, exact, require

CONTRACTS = {
    "count_tilings": (
        "complete count of disjoint full/partial placements satisfying all declared constraints",
        "one tile type, board<=16 cells; rotations/reflections, blocked/marked cells, exact counts and 2x2 rules",
    ),
    "unique_tiling_check": (
        "tiling count capped at two and exact uniqueness under marked-cell restriction",
        "one tile type, board<=16 cells; independent placement subsets",
    ),
    "check_tiling_certificate": (
        "truth of the supplied complete placement certificate including all 2x2 constraints",
        "one tile type, board<=16 cells; duplicate/overlap/out-of-board witnesses are false",
    ),
    "min_tiles_cover": (
        "minimum number of disjoint placements covering the explicit target",
        "one tile type, board<=16 cells; complete placement subsets, no claim for refused/no-result execution",
    ),
    "coloring_bound": (
        "target-cell count, min/max tile occupancy over periodic translations and induced lower bound",
        "one tile type; board<=36 cells; coloring periods<=8; not existence of an achieving tiling",
    ),
}


def _canonical(cells):
    r, c = min(x for x, _ in cells), min(y for _, y in cells)
    return tuple(sorted((x - r, y - c) for x, y in cells))


def orientations(spec):
    cells = spec["cells"]
    result = set()
    for reflect in range(2 if spec.get("allow_reflections", False) else 1):
        for rotation in range(4 if spec.get("allow_rotations", False) else 1):
            transformed = []
            for r, c in cells:
                for _ in range(rotation):
                    r, c = -c, r
                transformed.append((-r if reflect else r, c))
            result.add(_canonical(transformed))
    return sorted(result)


def normalize(name, p):
    p = dict(p)
    if name == "coloring_bound":
        p.update(p["board_spec"])
    bound(
        p["rows"] * p["cols"] <= (36 if name == "coloring_bound" else 16),
        "finite board checker bound",
    )
    if "tile_shape_spec" not in p:
        require(
            p.get("tile_area") == 2,
            "missing tile shape; only tile_area=2 defines a domino",
        )
        p["tile_shape_spec"] = {"cells": [[0, 0], [0, 1]], "allow_rotations": True}
    cells = p["tile_shape_spec"]["cells"]
    require(len(set(map(tuple, cells))) == len(cells), "duplicate cells in tile shape")
    bound(all(abs(v) <= 16 for cell in cells for v in cell), "tile coordinate bound")
    con = dict(p.get("constraint_spec", {}))
    if name == "unique_tiling_check":
        con = {"marked_cells": p["marked_cells"], "forbid_two_marked_per_tile": True}
    require(
        not ("exact_tiles" in con and "exact_tiles_per_type" in con),
        "exclusive tile-count constraints",
    )
    if "exact_tiles_per_type" in con:
        require(
            len(con["exact_tiles_per_type"]) == 1,
            "one count for the single registered tile type",
        )
    require(con.get("min_uncovered_per_2x2", 0) <= 4, "2x2 uncovered count must be <=4")
    require(
        bool(con.get("marked_cells"))
        == bool(con.get("forbid_two_marked_per_tile", False)),
        "marked cells require matching exclusion flag",
    )
    for key in ("blocked_cells", "marked_cells"):
        require(
            all(0 <= r < p["rows"] and 0 <= c < p["cols"] for r, c in con.get(key, [])),
            "constraint cell outside board",
        )
    p["constraint_spec"] = con
    for key in ("coloring_spec", "target_spec"):
        if key not in p:
            continue
        spec = p[key]
        if spec["kind"] == "product_mod":
            require(
                {"row_mod", "col_mod", "target"} <= spec.keys(),
                "periodic target fields required",
            )
            require(
                all(
                    0 <= v < m
                    for v, m in zip(spec["target"], (spec["row_mod"], spec["col_mod"]))
                ),
                "target residues out of range",
            )
            bound(
                max(spec["row_mod"], spec["col_mod"]) <= 8,
                "coloring period audit bound",
            )
        if spec["kind"] == "cells":
            require(key == "target_spec", "coloring must be periodic")
            require(
                all(
                    0 <= r < p["rows"] and 0 <= c < p["cols"]
                    for r, c in spec.get("cells", [])
                ),
                "target cell outside board",
            )
    return p


def _selected(spec, r, c, *, coloring=False):
    if spec["kind"] == "checkerboard":
        return (r + c) % 2 == spec.get("target_parity" if coloring else "parity", 0)
    if spec["kind"] == "product_mod":
        return [r % spec["row_mod"], c % spec["col_mod"]] == spec["target"]
    return [r, c] in spec.get("cells", [])


def _placements(p):
    blocked = set(map(tuple, p["constraint_spec"].get("blocked_cells", [])))
    marked = set(map(tuple, p["constraint_spec"].get("marked_cells", [])))
    placements = set()
    for orient in orientations(p["tile_shape_spec"]):
        for r, c in it.product(range(p["rows"]), range(p["cols"])):
            cells = frozenset((r + x, c + y) for x, y in orient)
            if any(x >= p["rows"] or y >= p["cols"] for x, y in cells):
                continue
            if cells & blocked or len(cells & marked) >= 2:
                continue
            placements.add(sum(1 << (x * p["cols"] + y) for x, y in cells))
    return sorted(placements)


def _allowed(p, covered, count, *, coverage=True):
    con, cols = p["constraint_spec"], p["cols"]
    board = (1 << (p["rows"] * cols)) - 1
    blocked = sum(
        1 << (r * cols + c) for r, c in set(map(tuple, con.get("blocked_cells", [])))
    )
    if covered & blocked:
        return False
    if coverage:
        expected = con.get(
            "exact_tiles", (con.get("exact_tiles_per_type") or [None])[0]
        )
        if expected is not None:
            if count != expected:
                return False
        elif covered != board ^ blocked:
            return False
    minimum = max(
        con.get("min_uncovered_per_2x2", 0), int(con.get("forbid_full_2x2", False))
    )
    for r, c in it.product(range(p["rows"] - 1), range(cols - 1)):
        cells = [(r + i, c + j) for i, j in ((0, 0), (0, 1), (1, 0), (1, 1))]
        unc = {(x, y) for x, y in cells if not covered >> (x * cols + y) & 1}
        if len(unc) < minimum:
            return False
        if con.get("two_uncovered_aligned_per_2x2", False) and not any(
            a[0] == b[0] or a[1] == b[1] for a, b in it.combinations(unc, 2)
        ):
            return False
    return True


def check(name, p, result):
    if name == "coloring_bound":
        spec = p["coloring_spec"]
        periods = (
            (2, 2)
            if spec["kind"] == "checkerboard"
            else (spec["row_mod"], spec["col_mod"])
        )
        occupancies = [
            sum(_selected(spec, r + x, c + y, coloring=True) for x, y in orient)
            for orient in orientations(p["tile_shape_spec"])
            for r, c in it.product(range(periods[0]), range(periods[1]))
        ]
        targets = sum(
            _selected(spec, r, c, coloring=True)
            for r, c in it.product(range(p["rows"]), range(p["cols"]))
        )
        top = max(occupancies)
        expected = {
            "target_cells": targets,
            "tiles": {
                "tile_0": {
                    "area": len(p["tile_shape_spec"]["cells"]),
                    "max_per_tile": top,
                    "min_per_tile": min(occupancies),
                }
            },
            "lower_bound_tiles": (targets + top - 1) // top if top else None,
            "cover_impossible": targets > 0 and top == 0,
            "inequality": "target_cells <= sum_i max_per_tile_i * n_i",
        }
        return exact(result, expected)
    placements = _placements(p)
    if name == "check_tiling_certificate":
        covered, valid = 0, True
        for placement in p["placements"]:
            if (
                not placement
                or len(set(map(tuple, placement))) != len(placement)
                or any(
                    not (0 <= r < p["rows"] and 0 <= c < p["cols"])
                    for r, c in placement
                )
            ):
                valid = False
                break
            mask = sum(1 << (r * p["cols"] + c) for r, c in placement)
            if mask not in placements or covered & mask:
                valid = False
                break
            covered |= mask
        valid = valid and _allowed(p, covered, len(p["placements"]))
        return exact(result, valid)
    # Each physical placement is considered once. Multiplicities count different
    # tile partitions producing the same occupied cells; no source recursion used.
    ways = {0: 1}
    for mask in placements:
        for occupied, count in tuple(ways.items()):
            if not mask & occupied:
                union = occupied | mask
                ways[union] = ways.get(union, 0) + count
    area = len(p["tile_shape_spec"]["cells"])
    if name == "min_tiles_cover":
        targets = sum(
            1 << (r * p["cols"] + c)
            for r, c in it.product(range(p["rows"]), range(p["cols"]))
            if _selected(p["target_spec"], r, c)
        )
        minimum = min(
            (mask.bit_count() // area for mask in ways if mask & targets == targets),
            default=None,
        )
        return exact(result, minimum)
    total = sum(
        count
        for mask, count in ways.items()
        if _allowed(p, mask, mask.bit_count() // area)
    )
    if name == "unique_tiling_check":
        return exact(
            result,
            {
                "tilings_found": min(total, 2),
                "unique": total == 1,
                "capped_at_two": total >= 2,
            },
        )
    return exact(result, total)
