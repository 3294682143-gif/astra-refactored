"""lattice_counting family.

Structural criterion: enumeration of geometric objects on lattice
structures (with orientation classes) and translation-structure counting.

Coordinates: the Eisenstein/triangular lattice in oblique coordinates —
point (a, b) means a + b*omega with omega = exp(2*pi*i/3); multiplication
by the primitive 6th root of unity is rot60(a, b) = (a - b, a). The squared
norm is a^2 - a*b + b^2.

Tools:
- hexagon_lattice_points: vertex set / count of the side-n regular hexagon
  triangulation lattice (centered hexagonal number 3n(n+1)+1).
- count_lattice_hexagons: number of regular hexagons (all orientations)
  whose six vertices lie in that lattice. The center of such a hexagon is
  always a lattice point (2c and vertex minus offset both force c into L),
  so enumeration is over (center, radius-vector) pairs divided by 6, with
  per-radius closed interval counting.
- lattice_points_in_polygon: Pick's theorem counts for lattice polygons.
"""
from __future__ import annotations

import math

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible


def rot60(p: tuple[int, int]) -> tuple[int, int]:
    """Multiply by the primitive 6th root of unity: (a, b) -> (a - b, a)."""
    a, b = p
    return (a - b, a)


def hex_norm(p: tuple[int, int]) -> int:
    """Hexagonal norm: max(|a|, |b|, |a - b|); the side-n board is norm <= n."""
    a, b = p
    return max(abs(a), abs(b), abs(a - b))


def hexagon_lattice_points(n: int) -> Evidence:
    """Lattice points of the side-n hexagon board, as a sorted list."""
    if n < 0:
        raise ValueError("n must be >= 0")
    pts = sorted(
        (a, b)
        for a in range(-n, n + 1)
        for b in range(-n, n + 1)
        if abs(a - b) <= n
    )
    expected = 3 * n * (n + 1) + 1
    return Evidence(
        value=pts,
        certificate=f"count={len(pts)}",
        self_check=(
            f"centered hexagonal number 3n(n+1)+1 = {expected}: "
            f"{'ok' if len(pts) == expected else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(n^2)",
    )


def _count_centers(n: int, z: tuple[int, int]) -> int:
    """Number of lattice centers c with c + z*rot60^k inside the side-n
    board for all k, computed as a lattice-point count in the intersection
    of the six translated boards (an interval hexagon)."""
    w = [z]
    for _ in range(5):
        w.append(rot60(w[-1]))
    wa = [p[0] for p in w]
    wb = [p[1] for p in w]
    wd = [p[0] - p[1] for p in w]
    # |c_a + w_a| <= n for all k  ->  c_a in [ -n - min, n - max ]
    a_lo, a_hi = -n - min(wa), n - max(wa)
    b_lo, b_hi = -n - min(wb), n - max(wb)
    d_lo, d_hi = -n - min(wd), n - max(wd)
    if a_lo > a_hi or b_lo > b_hi or d_lo > d_hi:
        return 0
    total = 0
    for ca in range(a_lo, a_hi + 1):
        lo = max(b_lo, ca - d_hi)
        hi = min(b_hi, ca - d_lo)
        if lo <= hi:
            total += hi - lo + 1
    return total


def count_lattice_hexagons(n: int) -> Evidence:
    """Number of regular hexagons (any size, any orientation) whose six
    vertices are lattice points of the side-n hexagon board.

    Method: sum over radius vectors z of the number of admissible centers
    (closed-interval hexagon count), divide by 6 (each hexagon appears once
    per rotation of its radius vector). Guards at n > 600 (the O(n^3) sum
    gets slow); brute-force cross-check embedded for n <= 2.
    """
    if n < 1:
        raise ValueError("n must be >= 1")
    if n > 600:
        return Evidence(
            None, "", "not attempted",
            infeasible(f"n={n}", "O(n^3) interval sum"),
            "O(n^3)",
        )
    total = 0
    bound = 2 * n  # generous superset of radius vectors with nonempty center set
    for za in range(-bound, bound + 1):
        for zb in range(-bound, bound + 1):
            z = (za, zb)
            if z == (0, 0) or hex_norm(z) > bound:
                continue
            total += _count_centers(n, z)
    value, rem = divmod(total, 6)
    if rem:
        return Evidence(
            None, f"raw_pair_count={total}", "sum not divisible by 6: MISMATCH",
            infeasible("internal inconsistency", "—"), "O(n^3)",
        )

    check = "skipped (n too large for subset brute force)"
    if n <= 2:
        brute = _brute_count_hexagons(n)
        check = f"subset brute force n={n}: {brute} vs {value}: " \
                f"{'ok' if brute == value else 'MISMATCH'}"

    return Evidence(
        value=value,
        certificate=f"pair_sum={total}, /6 rotation orbits",
        self_check=check,
        feasibility="ok",
        complexity_bound="O(n^3) interval sums",
    )


def _brute_count_hexagons(n: int) -> int:
    """Independent brute force: enumerate 6-subsets of board points, keep
    those forming a regular hexagon (equal squared norms about the centroid
    and closure under 60-degree rotation)."""
    pts = hexagon_lattice_points(n).value
    ptset = set(pts)
    count = 0
    import itertools

    for combo in itertools.combinations(pts, 6):
        sa = sum(p[0] for p in combo)
        sb = sum(p[1] for p in combo)
        if sa % 6 or sb % 6:
            continue  # centroid off lattice -> cannot be a lattice hexagon
        ca, cb = sa // 6, sb // 6
        offsets = [(p[0] - ca, p[1] - cb) for p in combo]
        norms = {a * a - a * b + b * b for a, b in offsets}
        if len(norms) != 1 or 0 in norms:
            continue
        if all(rot60(o) in offsets for o in offsets):
            count += 1
    return count


def lattice_points_in_polygon(vertices: list[tuple[int, int]]) -> Evidence:
    """Pick's theorem counts for a lattice polygon: (total, interior,
    boundary). Certificate: shoelace double area and boundary gcd sum."""
    n = len(vertices)
    if n < 3:
        raise ValueError("need at least 3 vertices")
    area2 = 0
    boundary = 0
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        area2 += x1 * y2 - x2 * y1
        boundary += math.gcd(abs(x2 - x1), abs(y2 - y1))
    area2 = abs(area2)
    interior = (area2 - boundary) // 2 + 1
    if (area2 - boundary) % 2:
        return Evidence(
            None, f"area2={area2}, boundary={boundary}",
            "Pick parity failure: MISMATCH",
            infeasible("non-lattice input", "—"), "O(n)",
        )
    total = interior + boundary
    return Evidence(
        value={"total": total, "interior": interior, "boundary": boundary},
        certificate=f"area2={area2}, boundary_gcd_sum={boundary}",
        self_check="Pick: I = (area2 - B)/2 + 1, T = I + B",
        feasibility="ok",
        complexity_bound="O(n)",
    )
