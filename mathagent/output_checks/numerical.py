"""Independent numeric/witness checks, deliberately separate from exact proof."""

from __future__ import annotations

import ast
import itertools as it
import math
import random
from fractions import Fraction as F

from .common import bound, exact, fraction, near, number, require
from .expressions import evaluate, tree

CONTRACTS = {
    "normal_overflow_seats": (
        "smallest capacity satisfying the stated normal-tail approximation",
        "groups>=2,total<=1000; erfc scan; not true binomial/union probability certification",
    ),
    "cover_time_complete_graph": (
        "exact expected cover time of uniform no-self-loop walk from one visited vertex",
        "2<=N<=8; rational visited-count chain equations",
    ),
    "markov_expected_steps": (
        "finite expected first hitting time, numerically compared to rational Cramer solution",
        "<=6 states; exact decimal stochastic rows; targets stop reachability; tolerance 1e-9",
    ),
    "finite_difference_derivative": (
        "recomputed finite-difference value at the requested step",
        "bounded scalar AST; |x|<=100,h in [1e-6,1]; tolerance 1e-7+1e-8 relative; not derivative accuracy",
    ),
    "richardson_extrapolate": (
        "recomputed fine Richardson combination",
        "same stencil scope,1<=order<=8; no certified truncation error/convergence claim",
    ),
    "verify_fd_certificate": (
        "finite sample/stencil certificate acceptance under its stated tolerance",
        "bounded AST and stencil scope, certificate order<=64; full finite field re-evaluation; not mathematical derivative certification",
    ),
    "closed_form_conjecture": (
        "numeric consistency of a closed-form proposal with the supplied decimal",
        "bounded constant AST, tolerance 1e-9 relative/absolute; remains a conjecture",
    ),
    "identify_constant": (
        "numeric consistency of the proposed constant",
        "bounded constant AST and finite input, tolerance 1e-9 relative/absolute; remains a conjecture",
    ),
    "subset_gap_worst_case": (
        "feasible supplied integer sequence, exact nearest subset sum and achieved gap",
        "n_terms<=6,bound<=20,integer target; all subsets checked; global maximin NOT certified",
    ),
    "numeric_extremum_search_expr": (
        "box feasibility and independently re-evaluated objective at reported point",
        "<=3 variables, bounded scalar AST; numeric tolerance 1e-9; no optimum or search-history certification",
    ),
    "certificate_check_expr": (
        "seed-bound finite sample count, argmin, margin, violations and threshold flag",
        "<=3 variables,<=2000 samples,bounded scalar AST; flags refer to specified floating-point thresholds; not a universal inequality proof",
    ),
}
MODES = {name: "NUMERICAL" for name in CONTRACTS}
MODES.update(
    cover_time_complete_graph="EXACT",
    closed_form_conjecture="CONJECTURE",
    identify_constant="CONJECTURE",
    subset_gap_worst_case="WITNESS",
)


def normalize(name, p):
    p = dict(p)
    if name == "normal_overflow_seats":
        require(p["groups"] >= 2, "at least two groups required")
        p.setdefault("continuity_correction", False)
    elif name == "cover_time_complete_graph":
        require(p["num_vertices"] >= 2, "at least two vertices required")
        bound(p["num_vertices"] <= 8, "rational cover-chain scope")
    elif name == "markov_expected_steps":
        bound(len(p["transition"]) <= 6, "determinant checker state bound")
        require(bool(p["targets"]), "nonempty hitting target required")
        bound(
            all(sum(map(fraction, row)) == 1 for row in p["transition"]),
            "exact decimal stochastic rows required for independent reference",
        )
    elif name in {
        "finite_difference_derivative",
        "richardson_extrapolate",
        "verify_fd_certificate",
    }:
        p.setdefault("method", "central")
        p.setdefault("order", 2 if p["method"] == "central" else 1)
        bound(
            abs(p["x"]) <= 100 and 1e-6 <= p["h"] <= 1 and p["order"] <= 8,
            "bounded stable stencil inputs",
        )
        for offset in _offsets(p["method"]):
            evaluate(p["f"], {"x": float(p["x"]) + offset * float(p["h"])})
    elif name in {"closed_form_conjecture", "identify_constant"}:
        bound(abs(p["value"]) <= 10**6, "constant magnitude audit bound")
    elif name == "subset_gap_worst_case":
        require(
            type(p["target"]) is int and p["target"] >= 0,
            "integer target required; no bridge truncation",
        )
        bound(
            p["target"] <= p["bound"] * p["n_terms"],
            "no feasible sequence at this target",
        )
    elif name in {"numeric_extremum_search_expr", "certificate_check_expr"}:
        bound(len(p["variables"]) <= 3, "numeric checker dimension bound")
        require(bool(p["variables"]), "nonempty variable binding")
        tree(p["expression"])
        evaluate(
            p["expression"],
            {v: (a + b) / 2 for v, (a, b) in zip(p["variables"], p["bounds"])},
        )
        p.setdefault("maximize", False)
        if name == "certificate_check_expr":
            p.setdefault("n_samples", 2000)
            p.setdefault("seed", 0)
            bound(p["n_samples"] <= 2000, "sample re-evaluation audit bound")
    return p


def _offsets(method):
    return (
        [-1, -0.5, -0.25, 0.25, 0.5, 1]
        if method == "central"
        else [0, 0.25, 0.5, 1]
        if method == "forward"
        else [-1, -0.5, -0.25, 0]
    )


def _stencil(p, h):
    x = float(p["x"])
    f = lambda v: evaluate(p["f"], {"x": v})
    if p["method"] == "central":
        return (f(x + h) - f(x - h)) / (2 * h)
    if p["method"] == "forward":
        return (f(x + h) - f(x)) / h
    return (f(x) - f(x - h)) / h


def _fd_certificate(p):
    try:
        pairs = [part.strip().split("=", 1) for part in p["certificate"].split(";")]
        if any(len(pair) != 2 for pair in pairs):
            return False
        fields = dict(pairs)
        if len(fields) != len(pairs):
            return False
        required = {"method", "x", "h", "order", "samples", "D_h", "D_h2", "D_h4"}
        if not required <= fields.keys() or fields.keys() - required - {
            "R_fine",
            "R_coarse",
        }:
            return False
        if (
            fields["method"] != p["method"]
            or float(fields["x"]) != p["x"]
            or float(fields["h"]) != p["h"]
        ):
            return False
        order = int(fields["order"])
        if not 1 <= order <= 64:
            return False
        samples = ast.literal_eval(fields["samples"])
        if (
            type(samples) not in {list, tuple}
            or len(samples) != len(_offsets(p["method"]))
            or not all(number(v) for v in samples)
        ):
            return False
        ds = [float(fields[k]) for k in ("D_h", "D_h2", "D_h4")]
        if not all(number(v) for v in ds):
            return False
        tolerance = 1e-9 * max(1, *map(abs, samples), *map(abs, ds))
        fresh = [
            evaluate(p["f"], {"x": float(p["x"]) + v * float(p["h"])})
            for v in _offsets(p["method"])
        ]
        if not all(near(a, b, atol=tolerance, rtol=0) for a, b in zip(samples, fresh)):
            return False
        table = dict(zip(_offsets(p["method"]), samples))
        derived = []
        for factor in (1, 0.5, 0.25):
            lo, hi = (
                (-factor, factor)
                if p["method"] == "central"
                else (0, factor)
                if p["method"] == "forward"
                else (-factor, 0)
            )
            derived.append((table[hi] - table[lo]) / ((hi - lo) * p["h"]))
        if not all(near(a, b, atol=tolerance, rtol=0) for a, b in zip(ds, derived)):
            return False
        if "R_coarse" in fields or "R_fine" in fields:
            if not {"R_coarse", "R_fine"} <= fields.keys():
                return False
            expected = [(2**order * ds[i + 1] - ds[i]) / (2**order - 1) for i in (0, 1)]
            return all(
                near(float(fields[k]), v, atol=tolerance, rtol=0)
                for k, v in zip(("R_coarse", "R_fine"), expected)
            )
        return True
    except (KeyError, TypeError, ValueError, SyntaxError, OverflowError):
        return False


def _determinant(matrix):
    n = len(matrix)
    return sum(
        (-1) ** sum(perm[i] > perm[j] for i in range(n) for j in range(i + 1, n))
        * math.prod(matrix[i][perm[i]] for i in range(n))
        for perm in it.permutations(range(n))
    )


def _markov(p):
    target = set(p["targets"])
    if p["start"] in target:
        return F(0)
    reachable, todo = set(), [p["start"]]
    while todo:
        s = todo.pop()
        if s in reachable or s in target:
            continue
        reachable.add(s)
        todo.extend(t for t, v in enumerate(p["transition"][s]) if v > 0)
    states = sorted(reachable)
    matrix = [
        [F(int(a == b)) - fraction(p["transition"][a][b]) for b in states]
        for a in states
    ]
    det = _determinant(matrix)
    bound(
        det != 0,
        "divergent/underdetermined hitting expectation has no finite numeric certificate",
    )
    column = states.index(p["start"])
    replaced = [
        [F(1) if j == column else v for j, v in enumerate(row)] for row in matrix
    ]
    return _determinant(replaced) / det


def check(name, p, result):
    if name == "normal_overflow_seats":
        mean = p["total"] / p["groups"]
        sigma = math.sqrt(mean * (1 - 1 / p["groups"]))
        tail = lambda x: (
            p["groups"]
            * math.erfc(
                (x + (0.5 if p["continuity_correction"] else 0) - mean)
                / (sigma * math.sqrt(2))
            )
            / 2
        )
        expected = next(
            (x for x in range(p["total"] + 1) if tail(x) <= p["overflow_bound"]), None
        )
        return exact(result, expected)
    if name == "cover_time_complete_graph":
        n = p["num_vertices"]
        expected = F(0)
        for visited in range(n - 1, 0, -1):
            new = F(n - visited, n - 1)
            expected = (1 + new * expected) / new
        return exact(result, str(expected))
    if name == "markov_expected_steps":
        return near(result, float(_markov(p)))
    if name in {"finite_difference_derivative", "richardson_extrapolate"}:
        h = float(p["h"])
        if name == "finite_difference_derivative":
            value = _stencil(p, h)
        else:
            factor = 2 ** p["order"]
            value = (factor * _stencil(p, h / 4) - _stencil(p, h / 2)) / (factor - 1)
        return near(result, value, atol=1e-7, rtol=1e-8)
    if name == "verify_fd_certificate":
        return exact(result, _fd_certificate(p))
    if name in {"closed_form_conjecture", "identify_constant"}:
        return type(result) is str and near(evaluate(result), p["value"])
    if name == "subset_gap_worst_case":
        if type(result) is not dict or result.keys() != {
            "gap",
            "sequence",
            "nearest_sum",
            "subset",
        }:
            return False
        seq, subset = result["sequence"], result["subset"]
        if (
            type(seq) is not list
            or len(seq) != p["n_terms"]
            or not all(type(v) is int and 0 <= v <= p["bound"] for v in seq)
            or sum(seq) < p["target"]
        ):
            return False
        if (
            type(subset) is not list
            or not all(type(v) is int and 0 <= v < len(seq) for v in subset)
            or subset != sorted(set(subset))
        ):
            return False
        sums = {
            sum(seq[i] for i in range(len(seq)) if mask >> i & 1)
            for mask in range(1 << len(seq))
        }
        nearest = sum(seq[i] for i in subset)
        gap = min(abs(s - p["target"]) for s in sums)
        return (
            exact(result["gap"], gap)
            and exact(result["nearest_sum"], nearest)
            and abs(nearest - p["target"]) == gap
        )
    if name == "numeric_extremum_search_expr":
        if type(result) is not dict or result.keys() != {
            "extremum",
            "point",
            "violation",
            "mode",
            "restarts",
        }:
            return False
        point = result["point"]
        if (
            type(point) is not list
            or len(point) != len(p["variables"])
            or not all(
                number(v) and a <= v <= b for v, (a, b) in zip(point, p["bounds"])
            )
        ):
            return False
        return (
            near(
                result["extremum"],
                evaluate(p["expression"], dict(zip(p["variables"], point))),
            )
            and near(result["violation"], 0, atol=0, rtol=0)
            and result["mode"] == ("max" if p["maximize"] else "min")
            and type(result["restarts"]) is int
            and result["restarts"] == 24
        )
    if name == "certificate_check_expr":
        if type(result) is not dict or result.keys() != {
            "min_margin",
            "argmin",
            "violations",
            "samples",
            "tight",
        }:
            return False
        rng = random.Random(p["seed"])
        observations = []
        for _ in range(p["n_samples"]):
            point = [rng.uniform(a, b) for a, b in p["bounds"]]
            observations.append(
                (evaluate(p["expression"], dict(zip(p["variables"], point))), point)
            )
        margin, point = min(observations, key=lambda row: row[0])
        return (
            near(result["min_margin"], margin)
            and exact(result["argmin"], point)
            and exact(result["violations"], sum(v < -1e-9 for v, _ in observations))
            and exact(result["samples"], p["n_samples"])
            and exact(result["tight"], margin <= 1e-6)
        )
    raise ValueError("unknown numeric checker")
