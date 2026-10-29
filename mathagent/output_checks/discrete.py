"""Finite exhaustive checks independent of production DP, transfer and blossom."""

from __future__ import annotations

import heapq
import itertools as it
import math
from functools import lru_cache

from .common import bound, exact, point_location, require, simple_polygon

CONTRACTS = {
    "digit_sum_window_search": (
        "first positive digit-sum window with nonzero product modulo prime",
        "window<=16, max_n<=10000; finite minimum only",
    ),
    "deletion_divisible_largest": (
        "largest deletion-divisible number in finite decimal range",
        "max_digits<=5; exhaustive downward deletion, distinct flag respected",
    ),
    "hamiltonian_paths_grid": (
        "number of directed spanning vertex paths",
        "width*height<=12; independent visited-subset search; row endpoints, wrap and moves respected",
    ),
    "win_draw_loss_graph": (
        "finite acyclic game payoff from player-to-move perspective",
        "<=64 explicit states; reachable DAG, terminal payoff -1/0/1",
    ),
    "minimax_value_graph": (
        "finite acyclic max/min payoff",
        "<=64 explicit states; reachable DAG with explicit terminal leaves",
    ),
    "gap_subsequence_discrepancy": (
        "minimum worst gap-bounded subsequence absolute sum",
        "length<=10; all signs and all admissible subsequences",
    ),
    "hexagon_lattice_points": (
        "complete sorted axial lattice board",
        "1<=n<=12; independent row construction",
    ),
    "count_lattice_hexagons": (
        "number of distinct regular hexagon vertex sets",
        "1<=n<=5; enumerate opposite vertex pairs and deduplicate full vertex sets",
    ),
    "lattice_points_in_polygon": (
        "complete boundary/interior/total lattice counts",
        "simple integer polygon, <=12 vertices, coordinates in [-32,32]; ray casting not Pick",
    ),
    "deck_game_outcome": (
        "first moves after which A cannot force an exclusive win",
        "1<=d<=3; all ownership states; draw is not an A win, not proof of B winning",
    ),
    "frobenius_semigroup": (
        "nonrepresentable positives and largest gap within supplied window only",
        "limit<=10000; <=16 generators; does not assert global Frobenius number",
    ),
    "lz78_bit_string": (
        "fixed-width binary serialization of explicit phrase pairs",
        "<=64 phrases; index_bits<=32; injective fixed-width symbol code; no decode/canonicality claim",
    ),
    "format_phrases": (
        "exact text rendering and optional decoded words",
        "<=64 phrases; supported presets/overrides; no canonical encoding claim",
    ),
    "tutte_violation": (
        "returned Tutte witness, or absence of all witnesses for null",
        "1<=n<=10; exhaustive vertex deletion, no blossom backend",
    ),
    "double_counting_bound": (
        "equality of the two supplied counts only",
        "execution integer bounds; does not verify a bijection or original counting argument",
    ),
    "pairing_strategy_verify": (
        "involution and full-pair containment for every supplied threat",
        "<=64 elements and threats; finite input certificate only",
    ),
    "independent_reply_certificate": (
        "absence of explicit conflicts and conditional ceil(size/2) reply bound",
        "<=64 elements and conflicts; alternation assumptions remain separate",
    ),
}


def normalize(name, p):
    p = dict(p)
    if name == "digit_sum_window_search":
        p.setdefault("max_n", 10000000)
        require(
            p["modulus"] >= 2
            and all(p["modulus"] % d for d in range(2, math.isqrt(p["modulus"]) + 1)),
            "prime modulus required by source semantics",
        )
        bound(
            p["window"] <= 16 and p["max_n"] <= 10000, "digit window enumeration bound"
        )
    elif name == "deletion_divisible_largest":
        p.setdefault("max_digits", 10)
        p.setdefault("distinct_digits", True)
        bound(p["max_digits"] <= 5, "decimal exhaustive bound")
    elif name == "hamiltonian_paths_grid":
        for k, v in {"vertical": True, "right": True, "wrap": False}.items():
            p.setdefault(k, v)
        require(not p["wrap"] or p["width"] >= 2, "wrap requires width>=2")
        require(any(p[k] for k in ("vertical", "right", "wrap")), "no grid moves")
        p.setdefault("start_rows", list(range(p["height"])))
        p.setdefault("end_rows", list(range(p["height"])))
    elif name in {"win_draw_loss_graph", "minimax_value_graph"}:
        _game_value(name, p["spec"])
    elif name == "gap_subsequence_discrepancy":
        bound(p["spec"]["length"] <= 10, "sign/subsequence exhaustive bound")
    elif name in {"hexagon_lattice_points", "count_lattice_hexagons"}:
        bound(
            p["n"] <= (12 if name == "hexagon_lattice_points" else 5),
            "lattice enumeration bound",
        )
    elif name == "lattice_points_in_polygon":
        simple_polygon(p["vertices"], integral=True)
    elif name == "frobenius_semigroup":
        bound(
            p["limit"] <= 10000 and len(p["generators"]) <= 16,
            "semigroup closure bound",
        )
    elif name == "lz78_bit_string":
        bound(p["index_bits"] <= 32, "binary width audit bound")
        require(
            all(c in p["symbol_code"] for _, c in p["phrases"]),
            "every symbol needs a code; empty tails unsupported",
        )
        bound(
            all(i < 2 ** p["index_bits"] for i, _ in p["phrases"]),
            "phrase index exceeds serialization width",
        )
    elif name == "format_phrases":
        require(
            all(not (set(c) & set("(),{}_\\ \t")) for _, c in p["phrases"]),
            "ambiguous phrase symbol",
        )
        layout = {
            "plain": [" ", False, False, "paren"],
            "comma": [", ", False, False, "paren"],
            "latex": [",\\ ", True, False, "paren"],
            "subscript": ["\\ ", True, False, "subscript"],
            "words": [" ", False, True, "paren"],
        }[p.get("style", "comma")]
        for k, v in zip(("sep", "latex", "with_words", "pair"), layout):
            p.setdefault(k, v)
        if p["with_words"]:
            _words(p["phrases"])
    elif name == "tutte_violation":
        bound(p["n"] <= 10, "Tutte subset bound")
    elif name == "pairing_strategy_verify":
        p.setdefault("threat_sets", [])
        bound(
            len(p["elements"]) <= 64 and len(p["threat_sets"]) <= 64,
            "pairing audit bound",
        )
    elif name == "independent_reply_certificate":
        require(
            len(set(p["elements"])) == len(p["elements"]), "elements must be distinct"
        )
        bound(
            len(p["elements"]) <= 64 and len(p["conflicts"]) <= 64,
            "conflict audit bound",
        )
    return p


def _game_value(name, spec):
    start = spec.get("initial", spec["states"][0])
    leaves, edges = spec["terminal"], spec["edges"]
    reachable, todo = set(), [start]
    while todo:
        s = todo.pop()
        if s in reachable:
            continue
        reachable.add(s)
        if s not in leaves:
            require(bool(edges.get(s)), "reachable leaf needs explicit terminal payoff")
            todo.extend(edges[s])
    values = {s: v for s, v in leaves.items() if s in reachable}
    while len(values) < len(reachable):
        ready = [
            s
            for s in reachable - values.keys()
            if all(t in values for t in edges.get(s, []))
        ]
        require(bool(ready), "reachable game graph must be acyclic")
        for s in ready:
            children = [values[t] for t in edges[s]]
            values[s] = (
                max(-v for v in children)
                if name == "win_draw_loss_graph"
                else (max if s in spec.get("maximizer_states", []) else min)(children)
            )
    return values[start] if name == "win_draw_loss_graph" else float(values[start])


def _words(phrases):
    dictionary, emitted = [()], []
    for i, c in phrases:
        require(i < len(dictionary), "invalid phrase dictionary back-reference")
        word = dictionary[i] + tuple(c)
        emitted.append("".join(word))
        if word not in dictionary:
            dictionary.append(word)
    return emitted


def _hex_board(n):
    return {
        (a, b)
        for a in range(-n, n + 1)
        for b in range(max(-n, a - n), min(n, a + n) + 1)
    }


def _odd_components(n, edges, removed):
    unseen, odd = set(range(n)) - set(removed), 0
    while unseen:
        component, todo = set(), [next(iter(unseen))]
        while todo:
            v = todo.pop()
            if v not in unseen:
                continue
            unseen.remove(v)
            component.add(v)
            todo.extend(b if a == v else a for a, b in edges if v in (a, b))
        odd += len(component) % 2
    return odd


def check(name, p, result):
    if name == "tutte_violation":
        if result is None:
            return all(
                _odd_components(p["n"], p["edges"], s) <= len(s)
                for k in range(p["n"] + 1)
                for s in it.combinations(range(p["n"]), k)
            )
        return (
            type(result) is list
            and all(type(v) is int and 0 <= v < p["n"] for v in result)
            and len(set(result)) == len(result)
            and _odd_components(p["n"], p["edges"], result) > len(result)
        )
    return exact(result, expected(name, p))


def expected(name, p):
    if name == "digit_sum_window_search":
        return next(
            (
                n
                for n in range(1, p["max_n"] + 1)
                if math.prod(sum(map(int, str(n + j))) for j in range(p["window"]))
                % p["modulus"]
            ),
            None,
        )
    if name == "deletion_divisible_largest":

        @lru_cache(None)
        def good(n):
            s = str(n)
            if p["distinct_digits"] and len(set(s)) != len(s):
                return False
            if n < 10:
                return n > 0
            return any(
                t and t[0] != "0" and n % int(t) == 0 and good(int(t))
                for i in range(len(s))
                if (t := s[:i] + s[i + 1 :])
            )

        return next(n for n in range(10 ** p["max_digits"] - 1, 0, -1) if good(n))
    if name in {"win_draw_loss_graph", "minimax_value_graph"}:
        return _game_value(name, p["spec"])
    if name == "gap_subsequence_discrepancy":
        n, gap = p["spec"]["length"], p["spec"].get("max_gap", 2)
        subsets = [
            s
            for k in range(1, n + 1)
            for s in it.combinations(range(n), k)
            if all(b - a <= gap for a, b in it.pairwise(s))
        ]
        return min(
            max(abs(sum(signs[i] for i in s)) for s in subsets)
            for signs in it.product((-1, 1), repeat=n)
        )
    if name == "hamiltonian_paths_grid":
        w, h = p["width"], p["height"]
        vertices = list(it.product(range(w), range(h)))
        neighbors = {
            i: [
                j
                for j, (b, s) in enumerate(vertices)
                if (p["vertical"] and a == b and abs(r - s) == 1)
                or (p["right"] and b == a + 1 and r == s)
                or (p["wrap"] and a == w - 1 and b == 0 and r == s)
            ]
            for i, (a, r) in enumerate(vertices)
        }

        @lru_cache(None)
        def paths(i, used):
            if used.bit_count() == len(vertices):
                return int(vertices[i][1] in p["end_rows"])
            return sum(
                paths(j, used | 1 << j) for j in neighbors[i] if not used >> j & 1
            )

        return sum(
            paths(i, 1 << i)
            for i, (_, r) in enumerate(vertices)
            if r in p["start_rows"]
        )
    if name == "hexagon_lattice_points":
        return [list(v) for v in sorted(_hex_board(p["n"]))]
    if name == "count_lattice_hexagons":
        board, shapes = _hex_board(p["n"]), set()
        for (a, b), (c, d) in it.combinations(board, 2):
            if (a + c) % 2 or (b + d) % 2:
                continue
            x, y = (a + c) // 2, (b + d) // 2
            u, v = a - x, b - y
            offsets = [
                (u, v),
                (u - v, u),
                (-v, u - v),
                (-u, -v),
                (v - u, -u),
                (v, v - u),
            ]
            shape = frozenset((x + i, y + j) for i, j in offsets)
            if len(shape) == 6 and shape <= board:
                shapes.add(shape)
        return len(shapes)
    if name == "lattice_points_in_polygon":
        vs = simple_polygon(p["vertices"], integral=True)
        counts = {0: 0, 1: 0, -1: 0}
        for x in range(int(min(v[0] for v in vs)), int(max(v[0] for v in vs)) + 1):
            for y in range(int(min(v[1] for v in vs)), int(max(v[1] for v in vs)) + 1):
                counts[point_location((x, y), vs)] += 1
        return {
            "total": counts[0] + counts[1],
            "interior": counts[1],
            "boundary": counts[0],
        }
    if name == "frobenius_semigroup":
        generators = set(p["generators"])
        modulus = min(generators)
        distances = {0: 0}
        queue = [(0, 0)]
        while queue:
            value, residue = heapq.heappop(queue)
            if value != distances[residue]:
                continue
            for g in generators:
                nxt = (residue + g) % modulus
                if value + g < distances.get(nxt, math.inf):
                    distances[nxt] = value + g
                    heapq.heappush(queue, (value + g, nxt))
        missing = [
            n
            for n in range(1, p["limit"] + 1)
            if n < distances.get(n % modulus, math.inf)
        ]
        return {
            "non_representable": missing,
            "frobenius_number": max(missing, default=-1),
            "count": len(missing),
        }
    if name == "deck_game_outcome":
        cards = tuple(range(2 ** p["d"]))

        @lru_cache(None)
        def win(a, b):
            free = set(cards) - set(a) - set(b)
            if not free:
                xa = xb = 0
                for c in a:
                    xa ^= c
                for c in b:
                    xb ^= c
                return xa in a and xb not in b
            if (len(a) + len(b)) % 2 == 0:
                return any(win(tuple(sorted(a + (c,))), b) for c in free)
            return all(win(a, tuple(sorted(b + (c,)))) for c in free)

        xor = 0
        for c in cards:
            xor ^= c
        return {
            "digits": p["d"],
            "deck_size": len(cards),
            "total_xor": xor,
            "first_moves_after_which_second_player_wins": [
                c for c in cards if not win((c,), ())
            ],
        }
    if name == "lz78_bit_string":
        return "".join(
            "".join(str((i >> bit) & 1) for bit in range(p["index_bits"] - 1, -1, -1))
            + p["symbol_code"][c]
            for i, c in p["phrases"]
        )
    if name == "format_phrases":
        body = p["sep"].join(
            f"({i},{c})" if p["pair"] == "paren" else f"{c}_{{{i}}}"
            for i, c in p["phrases"]
        )
        text = "\\[" + body + "\\]" if p["latex"] else body
        return (
            text + " : " + " ".join(_words(p["phrases"])) if p["with_words"] else text
        )
    if name == "double_counting_bound":
        ok = p["count_a"] == p["count_b"]
        return {"count": p["count_a"] if ok else None, "consistent": ok}
    if name == "independent_reply_certificate":
        es = set(p["elements"])
        violations = [
            f"conflict ({a!r}, {b!r}) inside set"
            for a, b in p["conflicts"]
            if {a, b} <= es
        ]
        return {
            "size": len(es),
            "conflicts_checked": len(p["conflicts"]),
            "violations": _short(violations),
            "independent": not violations,
            "reply_guarantee": None if violations else (len(es) + 1) // 2,
        }
    if name == "pairing_strategy_verify":
        return _pairing(p)
    raise ValueError("unknown independent discrete checker")


def _short(items):
    return items[:20] + ([f"... +{len(items) - 20} more"] if len(items) > 20 else [])


def _pairing(p):
    elems, table = p["elements"], p["partner"]
    n, es, problems = len(elems), set(elems), []
    if len(es) != n:
        problems.append(f"{n - len(es)} duplicate elements")
    if n % 2:
        problems.append("odd element count: no fixed-point-free involution exists")
    for e in elems:
        partner = table.get(str(e))
        if partner == e:
            problems.append(f"fixed point at {e!r}")
        elif partner not in es:
            problems.append(f"partner({e!r})={partner!r} outside element set")
        elif table.get(str(partner)) != e:
            problems.append(
                f"not an involution at {e!r}: partner({partner!r})={table.get(str(partner))!r}"
            )
    violations = []
    if not problems:
        for threat in p["threat_sets"]:
            ts = set(threat)
            if not any(e in es and table[str(e)] in ts for e in ts):
                violations.append(
                    f"threat {sorted(map(repr, ts))[:6]} contains no full pair"
                )
    return {
        "elements": n,
        "pairs": None if problems else n // 2,
        "table_problems": _short(problems),
        "threats_checked": 0 if problems else len(p["threat_sets"]),
        "threat_violations": _short(violations),
        "certificate_valid": not problems and not violations,
    }
