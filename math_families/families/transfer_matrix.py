"""transfer_matrix family.

Structural criterion: counting and generating polynomials on chain or band
structures via frontier state transitions.

Tools:
- transition_count: length-n sequences over a state alphabet obeying
  pairwise transition constraints (iterative transfer DP).
- independence_polynomial_chain: independence polynomial of a path graph
  via the standard two-term recurrence, with small-n brute-force self-check.
- hamiltonian_paths_grid: directed Hamiltonian path count on a grid with
  structured moves (vertical within column, rightward, optional wrap-around
  from the last column to the first), via frontier subset DP.

On grids whose horizontal arcs only go right, path fragments never merge or
branch (every merge would violate in/out-degree 1), so the frontier state is
just the set of rows carrying an open tip plus the endpoints sealed so far —
no connectivity labels are needed.
"""
from __future__ import annotations

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible


# --------------------------------------------------------------------- #
# 1. Generic transition counting
# --------------------------------------------------------------------- #
def transition_count(
    length: int,
    num_states: int,
    transitions: set[tuple[int, int]],
    starts: set[int] | None = None,
    ends: set[int] | None = None,
) -> Evidence:
    """Number of sequences s_1..s_length over {0..num_states-1} with
    s_1 in starts, s_length in ends, and (s_i, s_{i+1}) in transitions.

    Certificate: the final DP vector. Self-check: full enumeration when
    num_states**length is small.
    """
    if length < 1 or num_states < 1:
        raise ValueError("need length >= 1 and num_states >= 1")
    starts = set(range(num_states)) if starts is None else set(starts)
    ends = set(range(num_states)) if ends is None else set(ends)
    succ = [[] for _ in range(num_states)]
    for a, b in transitions:
        succ[a].append(b)

    dp = [int(s in starts) for s in range(num_states)]
    for _ in range(length - 1):
        nxt = [0] * num_states
        for a, cnt in enumerate(dp):
            if cnt:
                for b in succ[a]:
                    nxt[b] += cnt
        dp = nxt
    total = sum(dp[s] for s in ends)

    check = "skipped (state space too large)"
    if num_states**length <= 200_000:
        brute = 0

        def rec(prefix):
            nonlocal brute
            if len(prefix) == length:
                brute += int(prefix[-1] in ends)
                return
            for s in succ[prefix[-1]] if prefix else sorted(starts):
                rec(prefix + [s])

        rec([])
        check = f"enumeration={brute} vs dp={total}: {'ok' if brute == total else 'MISMATCH'}"

    return Evidence(
        value=total,
        certificate=f"final_dp={dp}",
        self_check=check,
        feasibility="ok",
        complexity_bound=f"O(length * num_states^2) = O({length}*{num_states**2})",
    )


# --------------------------------------------------------------------- #
# 2. Independence polynomial of a path graph
# --------------------------------------------------------------------- #
def independence_polynomial_chain(n: int) -> Evidence:
    """Independence polynomial I(P_n, x) of the path graph on n vertices,
    as a coefficient tuple (highest degree first).

    Recurrence: I(P_k) = I(P_{k-1}) + x * I(P_{k-2}), I(P_0)=1, I(P_1)=1+x.
    Self-check: brute-force independent-set enumeration for min(n, 12).
    """
    if n < 0:
        raise ValueError("n must be >= 0")

    def shift(poly):  # multiply by x: poly is low-to-high
        return [0] + poly

    def add(p, q):
        return [a + b for a, b in zip(p, q + [0] * (len(p) - len(q)))] if len(p) >= len(q) else add(q, p)

    p0, p1 = [1], [1, 1]  # I(P_0), I(P_1), low-to-high
    if n == 0:
        poly = p0
    elif n == 1:
        poly = p1
    else:
        for _ in range(2, n + 1):
            p0, p1 = p1, add(p1, shift(p0))
        poly = p1
    coeffs_high_first = list(reversed(poly))

    k = min(n, 12)
    ref = [0] * (k + 1)
    for mask in range(1 << k):
        if mask & (mask << 1):
            continue
        ref[bin(mask).count("1")] += 1
    # Compare the recurrence restricted to k vertices against brute force.
    p0k, p1k = [1], [1, 1]
    if k == 0:
        poly_k = p0k
    elif k == 1:
        poly_k = p1k
    else:
        for _ in range(2, k + 1):
            p0k, p1k = p1k, add(p1k, shift(p0k))
        poly_k = p1k
    ok = ref == (poly_k + [0] * (k + 1 - len(poly_k)))

    return Evidence(
        value=tuple(coeffs_high_first),
        certificate="I(P_k) = I(P_{k-1}) + x*I(P_{k-2}); I(P_0)=1, I(P_1)=1+x",
        self_check=(
            f"brute_force independent sets n={k}: coefficients {ref} "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(n^2) coefficient arithmetic",
    )


# --------------------------------------------------------------------- #
# 3. Directed Hamiltonian paths on a grid (frontier subset DP)
# --------------------------------------------------------------------- #
def _vconfigs(height: int, vertical: bool):
    """All within-column vertical arc configs for one column.

    For each adjacent pair (j, j+1): 0 = none, 1 = down j -> j+1,
    2 = up j+1 -> j. Returns list of (v_in, v_out, segments) where segments
    are (rows, start_row, end_row); configs giving any vertex two vertical
    ins/outs are dropped.
    """
    configs = []
    for code in range(3 ** max(0, height - 1)):
        c, v_in, v_out = code, [0] * height, [0] * height
        for j in range(height - 1):
            choice = c % 3
            c //= 3
            if choice == 1:
                v_out[j] += 1
                v_in[j + 1] += 1
            elif choice == 2:
                v_out[j + 1] += 1
                v_in[j] += 1
        if not vertical and (any(v_in) or any(v_out)):
            continue
        if max(v_in + v_out, default=0) > 1:
            continue  # invalid orientation; degree checks would reject anyway
        # Segment decomposition by linkage (direction-agnostic).
        segments = []
        rows = [0]
        for j in range(height - 1):
            linked = (v_out[j] and v_in[j + 1]) or (v_in[j] and v_out[j + 1])
            if linked:
                rows.append(j + 1)
            else:
                segments.append(rows)
                rows = [j + 1]
        segments.append(rows)
        segs = []
        for seg in segments:
            start = next(r for r in seg if v_in[r] == 0)
            end = next(r for r in seg if v_out[r] == 0)
            segs.append((tuple(seg), start, end))
        configs.append((tuple(v_in), tuple(v_out), tuple(segs)))
    return configs


def hamiltonian_paths_grid(
    width: int,
    height: int,
    vertical: bool = True,
    right: bool = True,
    wrap: bool = False,
    start_rows: set[int] | None = None,
    end_rows: set[int] | None = None,
) -> Evidence:
    """Number of directed Hamiltonian paths on a width x height grid.

    Allowed arcs: within-column vertical arcs (both directions) if
    ``vertical``; right arcs (x, y) -> (x+1, y) if ``right``; wrap arcs
    (width-1, y) -> (0, y) for any subset of rows if ``wrap`` (width >= 2).
    ``start_rows``/``end_rows`` constrain the row of the path's first/last
    vertex (None = unconstrained).

    Method: column-by-column transfer over tip subsets. In the band part
    (vertical + rightward arcs) fragments cannot merge, branch, or cycle —
    every violation shows up as a degree fault — so each fragment carries a
    single label. Wrap arcs stitch fragments at the last column; a union-find
    over labels rejects closed cycles and non-single-path configurations.
    """
    if width < 1 or height < 1:
        raise ValueError("width and height must be >= 1")
    if wrap and width < 2:
        raise ValueError("wrap requires width >= 2")
    if not vertical and not right and not wrap:
        raise ValueError("no moves at all")
    start_rows = set(range(height)) if start_rows is None else set(start_rows)
    end_rows = set(range(height)) if end_rows is None else set(end_rows)

    n = width * height
    if n == 1:
        ok = 0 in start_rows and 0 in end_rows
        return Evidence(1 if ok else 0, "single vertex", "trivial", "ok", "O(1)")
    if height > 8:
        return Evidence(
            value=None, certificate="", self_check="not attempted",
            feasibility=infeasible(
                f"height {height}: frontier labelings blow up",
                "O(width * 3^(height-1) * 2^height * labelings)",
            ),
            complexity_bound="exponential in height",
        )
    if width == 1:
        # Single column: vertical arcs only; brute force over row orders.
        import itertools

        total1 = 0
        for perm in itertools.permutations(range(height)):
            if perm[0] not in start_rows or perm[-1] not in end_rows:
                continue
            if vertical and all(abs(a - b) == 1 for a, b in zip(perm, perm[1:])):
                total1 += 1
        return Evidence(
            total1, "single column brute force", "enumeration exact", "ok", "O(height!)")

    vconfigs = _vconfigs(height, vertical)
    wrap_masks: list[int] = list(range(1 << height)) if wrap else [0]

    total = 0
    for wrap_mask in wrap_masks:
        # State: (tips_mask, per-row fragment labels, sealed endpoints).
        states: dict[tuple[int, tuple, tuple], int] = {(0, (None,) * height, ()): 1}

        for x in range(width - 1):
            new_states: dict[tuple[int, tuple, tuple], int] = {}
            for (tips, labels, eps), cnt in states.items():
                for v_in, v_out, segs in vconfigs:
                    out_choices = range(1 << height) if right else (0,)
                    for out_mask in out_choices:
                        ok = True
                        for j in range(height):
                            d_in = (tips >> j & 1) + v_in[j]
                            if x == 0:
                                d_in += wrap_mask >> j & 1
                            if (out_mask >> j & 1) + v_out[j] > 1 or d_in > 1:
                                ok = False
                                break
                            if d_in + (out_mask >> j & 1) + v_out[j] == 0:
                                ok = False
                                break
                        if not ok:
                            continue
                        new_labels: list = [None] * height
                        new_eps = list(eps)
                        for rows, s, t in segs:
                            if tips >> s & 1:
                                lbl = labels[s]
                            elif x == 0 and (wrap_mask >> s & 1):
                                lbl = ("w", s)
                            else:
                                lbl = ("c", x, s)
                            d_in_s = (tips >> s & 1) + v_in[s] + (
                                wrap_mask >> s & 1 if x == 0 else 0)
                            d_out_t = (out_mask >> t & 1) + v_out[t]
                            if d_in_s == 0:
                                new_eps.append(("s", s, lbl))
                            if d_out_t == 0:
                                new_eps.append(("e", t, lbl))
                            if out_mask >> t & 1:
                                new_labels[t] = lbl
                        if len(new_eps) > 2:
                            continue
                        key = (out_mask, tuple(new_labels), tuple(sorted(new_eps)))
                        new_states[key] = new_states.get(key, 0) + cnt
            states = new_states
            if not states:
                break

        # Last column: deferred outs are exactly the wrap arcs; wrap arcs
        # stitch fragments — union-find over labels enforces one acyclic path.
        for (tips, labels, eps), cnt in states.items():
            for v_in, v_out, segs in vconfigs:
                ok = True
                for j in range(height):
                    d_in = (tips >> j & 1) + v_in[j]
                    d_out = (wrap_mask >> j & 1) + v_out[j]
                    if d_in > 1 or d_out > 1 or d_in + d_out == 0:
                        ok = False
                        break
                if not ok:
                    continue
                all_eps = list(eps)
                merges = []
                involved = []
                for rows, s, t in segs:
                    lbl = labels[s] if tips >> s & 1 else ("c", width - 1, s)
                    involved.append(lbl)
                    if (tips >> s & 1) + v_in[s] == 0:
                        all_eps.append(("s", s, lbl))
                    if (wrap_mask >> t & 1) + v_out[t] == 0:
                        all_eps.append(("e", t, lbl))
                    if wrap_mask >> t & 1:
                        merges.append((lbl, ("w", t)))
                if len(all_eps) > 2:
                    continue
                all_labels = {l for _, _, l in all_eps} | set(involved)
                all_labels |= {("w", j) for j in range(height) if wrap_mask >> j & 1}
                parent = {l: l for l in all_labels}

                def find(a):
                    while parent[a] != a:
                        parent[a] = parent[parent[a]]
                        a = parent[a]
                    return a

                cyclic = False
                for a, b in merges:
                    ra, rb = find(a), find(b)
                    if ra == rb:
                        cyclic = True
                        break
                    parent[ra] = rb
                if cyclic or len({find(l) for l in all_labels}) != 1:
                    continue
                kinds = sorted((k, r) for k, r, _ in all_eps)
                if len(kinds) != 2:
                    continue
                (k1, r1), (k2, r2) = kinds
                if k1 == "e" and k2 == "s" and r1 in end_rows and r2 in start_rows:
                    total += cnt

    return Evidence(
        value=total,
        certificate=(
            f"grid {width}x{height}, vertical={vertical}, right={right}, "
            f"wrap={wrap}, starts={sorted(start_rows)}, ends={sorted(end_rows)}"
        ),
        self_check="see tests/property/test_transfer_matrix.py (brute force on small grids)",
        feasibility="ok",
        complexity_bound=f"O(width * 3^(height-1) * 2^height * labels); {width=}, {height=}",
    )
