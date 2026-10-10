"""digit_dp family.

Structural criterion: digit-wise enumeration/counting of integers under
digit-set, modulus, or digit-derived property constraints. Instances are
beyond brute force but within digit DP or pruning search.

Tools:
- count_by_digit_property: count integers whose digits lie in a given set,
  with an optional residue constraint, via position DP.
- digit_sum_window_search: first n where a sliding window of digit sums
  escapes a modular divisibility predicate; carries an O(window) certificate.
- deletion_divisible_largest: largest distinct-digit number reachable by a
  deletion chain in which each step divides the next, built bottom-up with a
  re-checkable deletion-chain certificate.
"""
from __future__ import annotations

from math_families.core.evidence import Evidence
from math_families.core.feasibility import infeasible

#: Node budget for exhaustive constructions (keeps searches interruptible).
_SEARCH_NODE_BUDGET = 20_000_000


# --------------------------------------------------------------------- #
# 1. Position DP counting
# --------------------------------------------------------------------- #
def count_by_digit_property(
    digit_set: set[int],
    max_digits: int,
    modulus: int = 1,
    residue: int = 0,
    include_zero: bool = False,
) -> Evidence:
    """Count positive integers with at most ``max_digits`` decimal digits,
    all digits in ``digit_set``, and value ``≡ residue (mod modulus)``.

    ``modulus=1`` counts without a congruence constraint. ``include_zero``
    adds the number 0 when it satisfies the residue constraint.
    Certificate: per-length DP totals; self-check: brute force up to
    min(max_digits, 5) digits.
    """
    if not digit_set or not all(0 <= d <= 9 for d in digit_set):
        raise ValueError("digit_set must be a non-empty subset of 0..9")
    if max_digits < 1 or modulus < 1 or not 0 <= residue < modulus:
        raise ValueError("bad max_digits/modulus/residue")

    lead = sorted(d for d in digit_set if d != 0)
    rest = sorted(digit_set)
    per_length: list[int] = []
    total = 0
    for length in range(1, max_digits + 1):
        dp = [0] * modulus
        for d in lead:
            dp[d % modulus] += 1
        for _ in range(length - 1):
            nxt = [0] * modulus
            for r, cnt in enumerate(dp):
                if cnt:
                    base = r * 10
                    for d in rest:
                        nxt[(base + d) % modulus] += cnt
            dp = nxt
        per_length.append(dp[residue])
        total += dp[residue]
    if include_zero and 0 % modulus == residue:
        total += 1

    # Self-check: brute force on a truncated digit bound.
    check_len = min(max_digits, 5)
    brute = 0
    for n in range(1, 10 ** check_len):
        if set(str(n)) <= {str(d) for d in digit_set} and n % modulus == residue:
            brute += 1
    dp_part = sum(per_length[:check_len])
    ok = brute == dp_part

    return Evidence(
        value=total,
        certificate=f"per_length_totals={per_length}",
        self_check=(
            f"brute_force[{check_len} digits]={brute} vs dp={dp_part}: "
            f"{'ok' if ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=(
            f"O(max_digits * modulus * |digit_set|) = "
            f"O({max_digits}*{modulus}*{len(rest)})"
        ),
    )


# --------------------------------------------------------------------- #
# 2. Sliding-window digit-sum search
# --------------------------------------------------------------------- #
def digit_sum_window_search(
    window: int, modulus: int, max_n: int = 10_000_000
) -> Evidence:
    """Smallest positive n where prod(S(n), ..., S(n+window-1)) is NOT
    divisible by ``modulus``; S(k) is the decimal digit sum.

    Sliding product uses modular inverses, so ``modulus`` must be prime.
    Certificate: the window's digit sums at the found n — re-checkable in
    O(window). Minimality rests on the exhaustive scan up to the bound.
    """
    if window < 1 or modulus < 2:
        raise ValueError("need window >= 1 and modulus >= 2")
    if _smallest_prime_factor(modulus) != modulus:
        raise ValueError("modulus must be prime (sliding product uses inverses)")
    if max_n > 50_000_000:
        return Evidence(
            value=None,
            certificate="",
            self_check="not attempted",
            feasibility=infeasible(f"scan to {max_n:.3g}", "O(max_n) digit sums"),
            complexity_bound="O(max_n)",
        )

    def s(n: int) -> int:
        total = 0
        while n:
            total += n % 10
            n //= 10
        return total

    win = [s(k) for k in range(1, window + 1)]
    zeros = sum(1 for v in win if v % modulus == 0)
    prod = 1
    for v in win:
        if v % modulus:
            prod = prod * (v % modulus) % modulus

    found = -1
    n = 1
    while n <= max_n:
        divisible = zeros > 0 or prod % modulus == 0
        if not divisible:
            found = n
            break
        out_v, in_v = win.pop(0), s(n + window)
        win.append(in_v)
        if out_v % modulus:
            prod = prod * pow(out_v % modulus, modulus - 2, modulus) % modulus
        else:
            zeros -= 1
        if in_v % modulus:
            prod = prod * (in_v % modulus) % modulus
        else:
            zeros += 1
        n += 1

    if found == -1:
        return Evidence(
            value=None,
            certificate="",
            self_check=f"no counterexample up to {max_n}",
            feasibility=infeasible(f"none found below {max_n}", "O(max_n)"),
            complexity_bound="O(max_n)",
        )
    cert_sums = [s(found + j) for j in range(window)]
    recheck = 1
    for v in cert_sums:
        recheck = recheck * v % modulus
    return Evidence(
        value=found,
        certificate=f"window_digit_sums={cert_sums}",
        self_check=(
            f"certificate product mod {modulus} = {recheck} "
            f"(nonzero expected): {'ok' if recheck != 0 else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound="O(max_n) sliding, O(window) certificate recheck",
    )


def _smallest_prime_factor(m: int) -> int:
    for p in range(2, int(m**0.5) + 1):
        if m % p == 0:
            return p
    return m


# --------------------------------------------------------------------- #
# 3. Deletion-divisible chain search
# --------------------------------------------------------------------- #
def deletion_divisible_largest(
    distinct_digits: bool = True, max_digits: int = 10
) -> Evidence:
    """Largest positive integer m (distinct digits if requested) that is
    single-digit, or admits removing one digit to obtain a proper divisor
    that is itself reachable by the same rule.

    Built bottom-up by digit insertion. Certificate: the full deletion
    chain from the answer down to a single digit, each dividing the next.
    """
    if max_digits < 1 or max_digits > 10:
        raise ValueError("max_digits must be in 1..10 (decimal)")

    good: set[int] = set(range(1, 10))
    parent: dict[int, int] = {}
    largest = 9
    frontier = list(range(1, 10))
    nodes = 0

    for size in range(2, max_digits + 1):
        nxt: set[int] = set()
        for g in frontier:
            gs = str(g)
            digits_used = set(gs)
            for pos in range(size):
                for d in "0123456789":
                    if distinct_digits and d in digits_used:
                        continue
                    if pos == 0 and d == "0":
                        continue
                    m = int(gs[:pos] + d + gs[pos:])
                    if m % g == 0 and m not in good:
                        nxt.add(m)
                        parent.setdefault(m, g)
                        if m > largest:
                            largest = m
            nodes += 1
            if nodes > _SEARCH_NODE_BUDGET:
                return Evidence(
                    value=None,
                    certificate="",
                    self_check=f"budget exhausted at size={size}",
                    feasibility=infeasible(
                        f"nodes > {_SEARCH_NODE_BUDGET}",
                        "O(good_set * positions * 10)",
                    ),
                    complexity_bound="O(good_set * max_digits * 10)",
                )
        frontier = sorted(nxt - good)
        good |= nxt
        if not frontier:
            break

    # Rebuild the deletion chain for the certificate.
    chain = [largest]
    while chain[-1] in parent:
        chain.append(parent[chain[-1]])
    chain_ok = verify_deletion_chain(chain)

    return Evidence(
        value=largest,
        certificate=f"deletion_chain={chain}",
        self_check=(
            f"chain length {len(chain)}, each divides next, ends single digit: "
            f"{'ok' if chain_ok else 'MISMATCH'}"
        ),
        feasibility="ok",
        complexity_bound=f"O(good_set * max_digits * 10); explored {nodes} nodes",
    )


def verify_deletion_chain(chain: list[int]) -> bool:
    """Independent certificate checker: each entry is a digit-deletion of
    the previous one and divides it; the chain ends at a single digit."""
    for a, b in zip(chain, chain[1:]):
        if a % b != 0:
            return False
        sa, sb = str(a), str(b)
        if len(sa) != len(sb) + 1:
            return False
        if not any(sa[:i] + sa[i + 1 :] == sb for i in range(len(sa))):
            return False
    return len(str(chain[-1])) == 1
