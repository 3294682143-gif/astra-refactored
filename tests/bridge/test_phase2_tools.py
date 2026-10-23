"""Phase 2: all fifteen newly whitelisted operators really execute.

Executor level only. Each case drives the real ``RegisteredExecutor`` (which
spawns its own bounded child, so the audit runs independently of the producer)
with one explicit deadline and one explicit scope, then asserts:

* ``status == "ok"`` and the exact, bounded result shape — no float appears
  anywhere in the payload, and the payload is JSON round-trippable;
* the independent audit reached ``VERIFIED_FOR_INPUT`` for those exact inputs,
  which is a per-input certificate, never a proof of the original problem;
* one out-of-contract payload per tool yields a fixed ``invalid_input`` /
  ``out_of_scope`` status instead of a traceback or a fabricated result.

Every payload below was derived from that tool's ``CONTRACTS`` entry plus its
validation branch, never guessed.
"""

from __future__ import annotations

import json
import time

import pytest

from mathagent.tool_contracts import CONTRACTS
from mathagent.tools import RegisteredExecutor

DEADLINE_SECONDS = 60.0

# The three numerical tools certify a recomputed floating-point value for the
# exact inputs; the other twelve carry exact independent certificates.
NUMERICAL_TOOLS = frozenset(
    {
        "markov_expected_steps",
        "finite_difference_derivative",
        "richardson_extrapolate",
    }
)

# One documented payload per tool, with the exact expected result. Kept as data
# so the refusal table and the Host acceptance test can name the same surface.
PHASE2_BATCH1_TOOLS = (
    "solve_quadratic_diophantine",
    "symbolic_diophantine_with_timeout",
    "solve_system_guarded_expr",
    "polynomial_function_check",
    "gf2_rank",
    "gf2_nullspace",
)
PHASE2_BATCH2_TOOLS = (
    "transition_count",
    "independence_polynomial_chain",
    "count_by_digit_property",
    "rook_numbers",
    "count_avoiding_permutations",
    "markov_expected_steps",
    "cover_time_complete_graph",
    "finite_difference_derivative",
    "richardson_extrapolate",
)
PHASE2_TOOLS = PHASE2_BATCH1_TOOLS + PHASE2_BATCH2_TOOLS

CASES = {
    # a x^2 + b xy + c y^2 + d x + e y + f = 0 with a=1, c=1, f=-5, i.e.
    # x^2 + y^2 = 5: a definite ellipse, so the global integer box is certified.
    "solve_quadratic_diophantine": (
        {"a": 1, "b": 0, "c": 1, "d": 0, "e": 0, "f": -5},
        [
            [-2, -1],
            [-2, 1],
            [-1, -2],
            [-1, 2],
            [1, -2],
            [1, 2],
            [2, -1],
            [2, 1],
        ],
    ),
    # The symbolic form of the same definite quadratic; the contract demands
    # proved-string coordinates, sorted, so the pairs are quoted text.
    "symbolic_diophantine_with_timeout": (
        {
            "lhs": "x**2+y**2",
            "rhs": "5",
            "variables": ["x", "y"],
            "timeout_ms": 2000,
        },
        [
            ["-1", "-2"],
            ["-1", "2"],
            ["-2", "-1"],
            ["-2", "1"],
            ["1", "-2"],
            ["1", "2"],
            ["2", "-1"],
            ["2", "1"],
        ],
    ),
    # x + y = 3, x - y = 1 has the single full-rank affine solution (2, 1).
    "solve_system_guarded_expr": (
        {"expressions": ["x+y-3", "x-y-1"], "variables": ["x", "y"]},
        1,
    ),
    # f(x+1) - f(x) = 2x + 1 holds for f(t) = t^2, so the residual is empty and
    # the check needs no counterexample witness.
    "polynomial_function_check": (
        {
            "equation": "f(x+1)-f(x)=2*x+1",
            "function": "f",
            "argument": "x",
            "variables": ["x"],
            "expression": "x**2",
        },
        {"identity_holds": True, "residual_terms": [], "witness": None},
    ),
    # Rows 0b001, 0b010, 0b100 over GF(2) are independent: rank 3.
    "gf2_rank": ({"rows": [1, 2, 4]}, 3),
    # Kernel of the span of 0b001 and 0b010 inside width 3: only 0b100.
    "gf2_nullspace": ({"rows": [1, 2], "width": 3}, [4]),
    # Five vertex sequences of length 3 over {0,1} obeying 0->1 and 1->0/1.
    "transition_count": (
        {"length": 3, "num_states": 2, "transitions": [[0, 1], [1, 0], [1, 1]]},
        5,
    ),
    # I(P_5, x) = 1 + 5x + 6x^2 + x^3, highest coefficient first.
    "independence_polynomial_chain": ({"n": 5}, [1, 6, 5, 1]),
    # At most three digits from {1,2,3} and divisible by 3: 13 values.
    "count_by_digit_property": (
        {
            "digit_set": [1, 2, 3],
            "max_digits": 3,
            "modulus": 3,
            "residue": 0,
            "include_zero": False,
        },
        13,
    ),
    # The 3x3 diagonal forbidden board has rook numbers (1, 3, 3, 1).
    "rook_numbers": (
        {"n": 3, "forbidden": [[0, 0], [1, 1], [2, 2]]},
        [1, 3, 3, 1],
    ),
    # Derangements of four elements avoid the full diagonal: !4 = 9.
    "count_avoiding_permutations": (
        {"n": 4, "forbidden": [[0, 0], [1, 1], [2, 2], [3, 3]]},
        9,
    ),
    # 0 -> 1 with probability 1; 1 -> {0,2} uniformly; 2 is absorbing.
    # E_0 = 1 + E_1 and E_1 = 1 + E_0/2, so E_0 = 4.
    "markov_expected_steps": (
        {
            "transition": [
                [0.0, 1.0, 0.0],
                [0.5, 0.0, 0.5],
                [0.0, 0.0, 1.0],
            ],
            "start": 0,
            "targets": [2],
        },
        4.0,
    ),
    # Exact cover time of K_4: (4-1) * H_3 = 3 * 11/6 = 11/2.
    "cover_time_complete_graph": ({"num_vertices": 4}, "11/2"),
    # Central difference of x^3 at x=1 with h=0.01.
    "finite_difference_derivative": (
        {"f": "x**3", "x": 1.0, "h": 0.01, "method": "central"},
        3.0001000000000055,
    ),
    # One Richardson step on the same stencil removes the O(h^2) term.
    "richardson_extrapolate": (
        {
            "f": "x**3",
            "x": 1.0,
            "h": 0.01,
            "method": "central",
            "order": 2,
        },
        2.9999999999999063,
    ),
}

# One payload outside the documented input contract per tool. The status must be
# a fixed contract refusal, never an exception and never a result.
REFUSALS = (
    # -1 is not a nonnegative row, so the integer-domain check refuses first.
    ("gf2_rank", {"rows": [-1]}, ("invalid_input",)),
    # 0b011 does not fit a width-1 row.
    ("gf2_nullspace", {"rows": [1, 2], "width": 1}, ("invalid_input",)),
    # An empty variable list is outside the declared variable-array bound.
    (
        "solve_system_guarded_expr",
        {"expressions": ["x+y-3"], "variables": []},
        ("invalid_input",),
    ),
    # A quoted coefficient is a type violation: no implicit string coercion.
    (
        "solve_quadratic_diophantine",
        {"a": "1", "b": 0, "c": 1, "d": 0, "e": 0, "f": -5},
        ("invalid_input",),
    ),
    # A 10^7 coefficient is inside the JSON integer domain but outside the
    # documented signed-integer magnitude.
    (
        "solve_quadratic_diophantine",
        {"a": 10**7, "b": 0, "c": 1, "d": 0, "e": 0, "f": -5},
        ("out_of_scope",),
    ),
    # The variable list must be a JSON array, not one string.
    (
        "symbolic_diophantine_with_timeout",
        {"lhs": "x**2+y**2", "variables": "x"},
        ("invalid_input",),
    ),
    # A timeout above the documented 30s bound is refused, not clamped.
    (
        "symbolic_diophantine_with_timeout",
        {"lhs": "x**2+y**2", "rhs": "5", "variables": ["x", "y"], "timeout_ms": 60000},
        ("out_of_scope",),
    ),
    # The equality must carry one ``=``: a bare expression is not a check.
    (
        "polynomial_function_check",
        {
            "equation": "f(x+1)-f(x)",
            "function": "f",
            "argument": "x",
            "variables": ["x"],
            "expression": "x**2",
        },
        ("invalid_input",),
    ),
    # Only the declared function may appear in the equality.
    (
        "polynomial_function_check",
        {
            "equation": "g(x+1)-g(x)=2*x+1",
            "function": "f",
            "argument": "x",
            "variables": ["x"],
            "expression": "x**2",
        },
        ("invalid_input",),
    ),
    # Missing required field: the registry argument contract refuses it.
    (
        "polynomial_function_check",
        {
            "equation": "f(x+1)-f(x)=2*x+1",
            "function": "f",
            "argument": "x",
            "variables": ["x"],
        },
        ("invalid_input",),
    ),
    # A transition endpoint must be one of the declared states.
    (
        "transition_count",
        {"length": 3, "num_states": 2, "transitions": [[0, 2]]},
        ("invalid_input",),
    ),
    # A negative path length is outside the integer domain.
    ("independence_polynomial_chain", {"n": -1}, ("invalid_input",)),
    # A digit outside 0..9 is refused, never truncated.
    (
        "count_by_digit_property",
        {"digit_set": [10], "max_digits": 2},
        ("invalid_input",),
    ),
    # A forbidden rook cell must fit the declared board.
    ("rook_numbers", {"n": 3, "forbidden": [[3, 0]]}, ("invalid_input",)),
    # n=0 has no permutation matrix behind the counting contract.
    (
        "count_avoiding_permutations",
        {"n": 0, "forbidden": []},
        ("invalid_input",),
    ),
    # A non-stochastic row is not a transition matrix.
    (
        "markov_expected_steps",
        {"transition": [[0.5, 0.5], [0.2, 0.2]], "start": 0, "targets": [1]},
        ("invalid_input",),
    ),
    # K_1 has no cover-time chain under the declared contract.
    ("cover_time_complete_graph", {"num_vertices": 1}, ("invalid_input",)),
    # A zero step is outside the documented positive-step domain.
    (
        "finite_difference_derivative",
        {"f": "x**3", "x": 1.0, "h": 0.0, "method": "central"},
        ("invalid_input",),
    ),
    # The order is a JSON integer, never a quoted string.
    (
        "richardson_extrapolate",
        {"f": "x**3", "x": 1.0, "h": 0.01, "method": "central", "order": "2"},
        ("invalid_input",),
    ),
)


def _execute(name, args, scope="phase2 probe"):
    executor = RegisteredExecutor()
    return executor.execute(
        name, args, deadline=time.monotonic() + DEADLINE_SECONDS, scope=scope
    )


def _floats(value):
    """Every float reachable in the payload (bools are not floats)."""
    if isinstance(value, float):
        return [value]
    if isinstance(value, dict):
        return [f for key, item in value.items() for f in _floats(key) + _floats(item)]
    if isinstance(value, (list, tuple)):
        return [f for item in value for f in _floats(item)]
    return []


def test_the_fifteen_phase2_tools_are_the_tail_of_the_whitelist():
    from python.astra_bridge.p3_effect_contract import TOOL_NAMES

    assert TOOL_NAMES[-15:] == PHASE2_TOOLS
    assert TOOL_NAMES[-9:] == PHASE2_BATCH2_TOOLS
    assert set(CASES) == set(PHASE2_TOOLS)
    assert {name for name, _, _ in REFUSALS} == set(PHASE2_TOOLS)


@pytest.mark.parametrize("name", PHASE2_TOOLS)
def test_each_tool_has_a_contract_and_a_dispatch_entry(name):
    from math_families.bridge.dispatch import tool_names

    assert name in CONTRACTS, name
    assert name in set(tool_names()), name
    assert CONTRACTS[name][0] and CONTRACTS[name][1], name


@pytest.mark.parametrize("name", PHASE2_TOOLS)
def test_each_tool_returns_exactly_the_documented_result(name):
    args, expected = CASES[name]
    result = _execute(name, args)
    assert result.status == "ok", (name, result.status, result.detail)
    assert result.tool == name
    assert result.result == expected
    # The payload is bounded JSON: it round-trips. Exact tools hold no float;
    # the numerical tools return the one bounded float their checker re-derived.
    encoded = json.dumps(result.result, allow_nan=False, sort_keys=True)
    assert json.loads(encoded) == expected
    if name not in NUMERICAL_TOOLS:
        assert _floats(result.result) == []


@pytest.mark.parametrize("name", PHASE2_TOOLS)
def test_each_tool_payload_is_certified_for_these_exact_inputs(name):
    args, _ = CASES[name]
    result = _execute(name, args)
    assert result.status == "ok", (name, result.status)
    # A per-input independent audit, not a proof of any original problem.
    assert result.verification is not None
    if name in NUMERICAL_TOOLS:
        assert result.verification.status == "CHECKED_NUMERICAL_FOR_INPUT", (
            name,
            result.verification.status,
        )
        assert result.evidence_kind == "NUMERICAL_SUPPORT"
    else:
        assert result.verification.status == "VERIFIED_FOR_INPUT", (
            name,
            result.verification.status,
        )
        assert result.evidence_kind == "EXACT_FOR_INPUT"
    assert result.result == CASES[name][1]


@pytest.mark.parametrize(
    "name,args,statuses", REFUSALS, ids=[f"{c[0]}-{i}" for i, c in enumerate(REFUSALS)]
)
def test_out_of_contract_payload_is_a_fixed_refusal(name, args, statuses):
    result = _execute(name, args, scope="phase2 refusal probe")
    assert result.status in statuses, (name, result.status, result.detail)
    assert result.result is None
    assert result.tool == name
    assert result.detail  # a fixed explanation, never a traceback


def test_unknown_scope_and_deadline_refusals_stay_bounded():
    args, _ = CASES["gf2_rank"]
    executor = RegisteredExecutor()
    # A blank scope is a contract violation, not a tool execution.
    blank = executor.execute(
        "gf2_rank", args, deadline=time.monotonic() + DEADLINE_SECONDS, scope=" "
    )
    assert blank.status == "invalid_input"
    assert blank.result is None
    # A deadline already in the past refuses before any producer dispatch.
    expired = executor.execute("gf2_rank", args, deadline=time.monotonic() - 1, scope="x")
    assert expired.status == "resource_limited"
    assert expired.result is None
