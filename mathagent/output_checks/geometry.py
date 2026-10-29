"""Independent exact incidence/convex-hull and bounded numerical geometry checks."""

from __future__ import annotations

import itertools as it
import math
import re

from .common import (
    bound,
    certificate_data,
    cross,
    exact,
    fraction,
    near,
    on_segment,
    point_location,
    require,
    simple_polygon,
)

CONTRACTS = {
    "line_cover_number": (
        "minimum pair-line cover, or no cover within the explicit cap",
        "<=9 distinct points, |coordinates|<=32; subset-cover DP",
    ),
    "line_separation_number": (
        "minimum lines separating every bichromatic pair",
        "2..7 distinct general-position points; exhaustive convex-hull separability, not producer infinitesimal split construction",
    ),
    "area_bisection_coverage": (
        "number of polygon sides hit by vertex area-halving chords",
        "strictly convex simple polygon<=12 vertices, coordinates within32, vertex hits excluded; rational subpolygon areas",
    ),
    "worst_configuration_search": (
        "checked separation value of supplied colored witness, or grid-bounded critical maximum",
        "separation:<=7 points and supplied certificate, no search-history/global optimum claim; covering_critical:grid<=3,line_budget<=3",
    ),
    "line_through": (
        "nonzero rational line coefficients incident to both supplied points",
        "distinct integer points within1000; equivalent scalings accepted, no canonical-sign claim",
    ),
    "angle_at_vertex": (
        "recomputed unoriented angle in degrees",
        "nonzero finite arms, coordinates within1000; atan2(cross,dot), tolerance1e-9; numerical only",
    ),
    "count_angle_ratio_locus": (
        "numeric solution count checked by analytic segment intersections",
        "distinct P,Q and noncollinear R; ratio2..16; roots separated from endpoints by1e-7; not a general numerical root-count proof",
    ),
}
MODES = {
    "worst_configuration_search": "WITNESS",
    "angle_at_vertex": "NUMERICAL",
    "count_angle_ratio_locus": "NUMERICAL",
}
USES_CERTIFICATE = True


def _points(points, cap):
    require(
        len(set(map(tuple, points))) == len(points), "distinct geometry points required"
    )
    bound(
        len(points) <= cap and all(abs(v) <= 32 for p in points for v in p),
        "finite point checker bound",
    )
    return [tuple(map(fraction, p)) for p in points]


def normalize(name, p):
    p = dict(p)
    if name in {"line_cover_number", "line_separation_number"}:
        pts = _points(p["points"], 9 if name == "line_cover_number" else 7)
        if name == "line_separation_number":
            require(
                len(pts) >= 2 and all(v in {0, 1} for v in p["colors"]),
                "bichromatic 0/1 input required",
            )
            require(
                all(cross(a, b, c) != 0 for a, b, c in it.combinations(pts, 3)),
                "separation requires general position",
            )
    elif name == "area_bisection_coverage":
        _bisections(p["vertices"])
    elif name == "worst_configuration_search":
        p.setdefault("grid", 4)
        p.setdefault("line_budget", 0)
        p.setdefault("red", 0)
        p.setdefault("blue", 0)
        if p["objective"] == "covering_critical":
            bound(
                p["grid"] <= 3 and p["line_budget"] <= 3,
                "critical grid exhaustive bound",
            )
        else:
            require(p["red"] >= 1 and p["blue"] >= 1, "both colors required")
            bound(p["red"] + p["blue"] <= 7, "separation witness checker size bound")
    elif name in {"line_through", "angle_at_vertex", "count_angle_ratio_locus"}:
        bound(
            all(
                abs(v) <= 1000
                for key in ("p", "q", "r", "v")
                if key in p
                for v in p[key]
            ),
            "coordinate audit bound",
        )
        if name == "line_through":
            bound(
                all(type(v) is int for key in ("p", "q") for v in p[key]),
                "exact line scope is integral input; no float rationalization",
            )
        if name == "count_angle_ratio_locus":
            p.setdefault("ratio", 2)
            require(2 <= p["ratio"], "ratio must be at least two")
            bound(p["ratio"] <= 16, "angle-ratio scope")
            _angle_roots(p)
    return p


def _cover(points):
    n = len(points)
    if n <= 1:
        return n
    masks = {
        sum(1 << k for k, c in enumerate(points) if cross(a, b, c) == 0)
        for a, b in it.combinations(points, 2)
    }
    distances = {0: 0}
    for mask in masks:
        for occupied, cost in tuple(distances.items()):
            union = occupied | mask
            distances[union] = min(distances.get(union, n), cost + 1)
    return distances[(1 << n) - 1]


def _hull(points):
    pts = sorted(points)
    if len(pts) <= 1:
        return pts

    def chain(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and cross(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    return chain(pts)[:-1] + chain(pts[::-1])[:-1]


def _inside(p, hull):
    if len(hull) == 1:
        return p == hull[0]
    if len(hull) == 2:
        return on_segment(p, *hull)
    return point_location(p, hull) >= 0


def _disjoint(a, b):
    ha, hb = _hull(a), _hull(b)
    if _inside(ha[0], hb) or _inside(hb[0], ha):
        return False
    for p, q in zip(ha, ha[1:] + ha[:1]):
        for r, s in zip(hb, hb[1:] + hb[:1]):
            if (
                cross(p, q, r) * cross(p, q, s) < 0
                and cross(r, s, p) * cross(r, s, q) < 0
            ) or any(
                (
                    on_segment(r, p, q),
                    on_segment(s, p, q),
                    on_segment(p, r, s),
                    on_segment(q, r, s),
                )
            ):
                return False
    return True


def separation(points, colors):
    n = len(points)
    pairs = [(i, j) for i, j in it.combinations(range(n), 2) if colors[i] != colors[j]]
    if not pairs:
        return 0
    covers = set()
    for split in range(1, (1 << n) - 1, 2):
        if _disjoint(
            [p for i, p in enumerate(points) if split >> i & 1],
            [p for i, p in enumerate(points) if not split >> i & 1],
        ):
            covers.add(
                sum(
                    1 << k
                    for k, (i, j) in enumerate(pairs)
                    if ((split >> i) ^ (split >> j)) & 1
                )
            )
    full = (1 << len(pairs)) - 1
    visited, front = {0}, {0}
    for count in range(1, len(pairs) + 1):
        front = {state | cover for state in front for cover in covers} - visited
        if full in front:
            return count
        visited |= front
    require(False, "no separating cover for distinct finite points")


def _area(vertices):
    return abs(
        sum(
            a[0] * b[1] - a[1] * b[0]
            for a, b in zip(vertices, vertices[1:] + vertices[:1])
        )
    )


def _bisections(vertices):
    pts = simple_polygon(vertices)
    n = len(pts)
    signs = {cross(pts[i - 1], pts[i], pts[(i + 1) % n]) > 0 for i in range(n)}
    require(
        len(signs) == 1
        and all(cross(pts[i - 1], pts[i], pts[(i + 1) % n]) for i in range(n)),
        "strict convex polygon required",
    )
    half = _area(pts) / 2
    hits = set()
    for i in range(n):
        for distance in range(1, n):
            chain = [pts[(i + k) % n] for k in range(distance + 1)]
            a, b = _area(chain), _area(chain + [pts[(i + distance + 1) % n]])
            require(a != half, "bisection hits a vertex; excluded input")
            if a < half < b:
                hits.add((i + distance) % n)
    return len(hits)


def _angle_roots(p):
    a, b, r = p["p"], p["q"], p["r"]
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    require(length > 0, "distinct line endpoints required")
    height = abs(cross(a, b, r)) / length
    bound(height > 1e-7, "noncollinear angle locus with stable altitude required")
    projection = ((r[0] - a[0]) * dx + (r[1] - a[1]) * dy) / length
    shift = height / math.tan(math.pi / (p["ratio"] + 1))
    roots = (projection - shift, projection + shift)
    bound(
        all(min(abs(x), abs(x - length)) > 1e-7 for x in roots),
        "angle roots too near excluded endpoints",
    )
    return sum(0 < x < length for x in roots)


def check(name, p, result, *, certificate=None):
    if name == "line_cover_number":
        count = _cover(_points(p["points"], 9))
        return exact(result, count if count <= p["max_lines"] else None)
    if name == "line_separation_number":
        return exact(result, separation(_points(p["points"], 7), p["colors"]))
    if name == "area_bisection_coverage":
        return exact(result, _bisections(p["vertices"]))
    if name == "worst_configuration_search":
        if p["objective"] == "covering_critical":
            grid = list(it.product(range(p["grid"]), repeat=2))
            critical = [
                size
                for size in range(1, len(grid) + 1)
                for subset in it.combinations(grid, size)
                if _cover(list(subset)) > p["line_budget"]
                and all(
                    _cover([pt for pt in subset if pt != removed]) <= p["line_budget"]
                    for removed in subset
                )
            ]
            return exact(result, max(critical, default=None))
        config = certificate_data(certificate, "configuration=", "; separating_splits=")
        if (
            type(config) is not list
            or len(config) != p["red"] + p["blue"]
            or not all(
                type(row) is list
                and len(row) == 2
                and type(row[0]) is list
                and len(row[0]) == 2
                and type(row[1]) is int
                and row[1] in {0, 1}
                for row in config
            )
        ):
            return False
        points = _points([row[0] for row in config], 7)
        colors = [row[1] for row in config]
        if (
            colors.count(0) != p["red"]
            or colors.count(1) != p["blue"]
            or any(cross(a, b, c) == 0 for a, b, c in it.combinations(points, 3))
        ):
            return False
        return exact(result, separation(points, colors))
    if name == "line_through":
        if (
            type(result) is not list
            or len(result) != 3
            or not all(
                type(v) is str
                and re.fullmatch(r"[+-]?[0-9]{1,16}(?:/[1-9][0-9]{0,15})?", v)
                for v in result
            )
        ):
            return False
        a, b, c = map(fraction, result)
        return (a != 0 or b != 0) and all(
            a * x + b * y + c == 0 for x, y in (p["p"], p["q"])
        )
    if name == "angle_at_vertex":
        a, v, b = p["p"], p["v"], p["q"]
        dot = (a[0] - v[0]) * (b[0] - v[0]) + (a[1] - v[1]) * (b[1] - v[1])
        return near(result, math.degrees(math.atan2(abs(cross(v, a, b)), dot)))
    if name == "count_angle_ratio_locus":
        return exact(result, _angle_roots(p))
    raise ValueError("unknown geometry checker")
