"""Host acceptance for all fifteen Phase 2 operators.

Each test drives one real ``AgentHost`` through its ``on_effect`` gate with the
*real* ``p3_effects.perform_effect`` body, so what is proven is the whole Host
path rather than a stubbed one:

``tool.execute`` params -> Host admission (budget, binding, action identity,
effect id) -> ``perform_effect`` -> ``RegisteredExecutor`` -> fixed receipt.

No model is called: the model turn that produced the action is a fabricated
history record, exactly as in ``test_p3_host_effect_budget.py``. The receipt
stays PROVISIONAL/UNKNOWN — a successful execution is an observation, never a
proof.

The id capacity is six: two tool effects plus the four bounded method loads.
"""

from __future__ import annotations

import hashlib
import json
import time
from types import SimpleNamespace

import pytest

from python.astra_bridge import agent_host as host_module
from python.astra_bridge.agent_client import AgentClient
from python.astra_bridge.agent_protocol import load_manifest
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_effect_contract import EFFECT_IDS

PROBLEM = "Solve 2x + 1 = 4 for x."
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
SESSION = "sess-1"
TASK = "task-1"
SCOPE = "b" * 64
EFFECT_BUDGET = 6

# One valid payload per Phase 2 batch-1 tool, with the exact result the
# registered executor and its independent audit both produce. Mirrors
# ``tests/bridge/test_phase2_tools.py``; kept inline so this file has no
# cross-test import.
TOOL_CASES = {
    "solve_quadratic_diophantine": (
        {"a": 1, "b": 0, "c": 1, "d": 0, "e": 0, "f": -5},
        [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]],
    ),
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
    "solve_system_guarded_expr": (
        {"expressions": ["x+y-3", "x-y-1"], "variables": ["x", "y"]},
        1,
    ),
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
    "gf2_rank": ({"rows": [1, 2, 4]}, 3),
    "gf2_nullspace": ({"rows": [1, 2], "width": 3}, [4]),
    "transition_count": (
        {"length": 3, "num_states": 2, "transitions": [[0, 1], [1, 0], [1, 1]]},
        5,
    ),
    "independence_polynomial_chain": ({"n": 5}, [1, 6, 5, 1]),
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
    "rook_numbers": (
        {"n": 3, "forbidden": [[0, 0], [1, 1], [2, 2]]},
        [1, 3, 3, 1],
    ),
    "count_avoiding_permutations": (
        {"n": 4, "forbidden": [[0, 0], [1, 1], [2, 2], [3, 3]]},
        9,
    ),
    # The P0 admission parser rejects float tokens, so the Host-level payload
    # uses an equivalent integer-valued deterministic chain: E_0 = 2.
    "markov_expected_steps": (
        {
            "transition": [[0, 1, 0], [0, 0, 1], [0, 0, 1]],
            "start": 0,
            "targets": [2],
        },
        2.0,
    ),
    "cover_time_complete_graph": ({"num_vertices": 4}, "11/2"),
    # Integer x=1 and h=1 stay inside the strict P0 JSON grammar.
    "finite_difference_derivative": (
        {"f": "x**3", "x": 1, "h": 1, "method": "central"},
        4.0,
    ),
    "richardson_extrapolate": (
        {
            "f": "x**3",
            "x": 1,
            "h": 1,
            "method": "central",
            "order": 2,
        },
        3.0,
    ),
}
TOOL_NAMES = tuple(TOOL_CASES)


def _chat_client():
    def chat(messages, temperature=0.2, max_tokens=8192):
        raise AssertionError("no model call in this test")

    return SimpleNamespace(chat=chat)


def _client():
    return AgentClient(_chat_client())


def _real_catalog():
    """The real fixture method catalog plus the Host's id/title projection."""
    from python.astra_bridge.p2_methods import MethodCatalog, fixture_catalog

    method_catalog = MethodCatalog()
    raw = fixture_catalog(method_catalog)
    catalog = {
        "version": raw["version"],
        "entries": [
            {"id": entry["id"], "title": entry["title"]} for entry in raw["entries"]
        ],
    }
    return method_catalog, catalog


def host(**options):
    values = {
        "maxModelCalls": 16,
        "maxWorkUnits": 8,
        "maxEffects": 2,
        "maxReviews": 0,
        "maxMethodLoads": 4,
        "maxRepairs": 0,
        "maxConsensus": 0,
        "maxR0": 0,
        "policy": "BEST_EFFORT",
        "deriveBudget": True,
        "resumeSessionLog": None,
        "resumeContractVersion": None,
        "resumeHistory": None,
    }
    values.update(options)
    instance = host_module.AgentHost(
        load_manifest(), SESSION, time.monotonic() + 60.0, PROBLEM, PROBLEM_HASH,
        values, _client(),
    )
    method_catalog, catalog = _real_catalog()
    instance.method_catalog = method_catalog
    instance.catalog = catalog
    instance.catalog_calls = 1
    instance.sent = []
    instance.send = lambda proc, message, method: instance.sent.append((method, message))
    return instance


def _arm(instance, ordinal, action):
    """One completed WORK record whose reply text is the given action."""
    instance.history["model-" + str(ordinal)] = {
        "request": {
            "phase": "WORK",
            "taskId": TASK,
            "scopeId": SCOPE,
            "messages": [
                {"role": "system", "content": "s"},
                {"role": "user", "content": json.dumps({"allowTools": True, "allowMethods": True})},
            ],
        },
        "receipt": {"transportStatus": "COMPLETE", "text": json.dumps(action)},
    }
    instance.last_model_id = "model-" + str(ordinal)
    instance.model_requests = ordinal
    instance.callback_done = True


def _spend(instance, ordinal, action, wire="tool.execute", remaining_ms=60000):
    # A spent window has no addressable id left; the admission gate must refuse
    # before the id is validated, so a placeholder is enough there.
    effect_id = (
        EFFECT_IDS[instance.effect_calls]
        if instance.effect_calls < len(EFFECT_IDS)
        else "effect-9"
    )
    _arm(instance, ordinal, action)
    binding = {
        "sessionId": instance.session_id,
        "problemHash": instance.problem_hash,
        "contractVersion": 1,
        "taskId": TASK,
        "scopeId": SCOPE,
        "sourceRequestId": "model-" + str(ordinal),
    }
    params = {
        "request": {
            "effectId": effect_id,
            "binding": binding,
            "action": action,
            "remainingMs": remaining_ms,
        }
    }
    instance.on_effect("node-" + effect_id, params, wire)
    return instance.effects[-1]["receipt"]


def tool_action(name, args=None, scope="phase2 host probe"):
    payload = TOOL_CASES[name][0] if args is None else args
    return {"action": "tool", "name": name, "args": json.loads(json.dumps(payload)), "scope": scope}


def method_action(method_id):
    return {"action": "method", "id": method_id}


@pytest.mark.parametrize("name", TOOL_NAMES)
def test_each_phase2_tool_is_admitted_executes_and_is_recorded(name):
    instance = host()
    assert instance._effect_budget() == EFFECT_BUDGET

    receipt = _spend(instance, 1, tool_action(name))

    # The request was admitted once and produced one receipt.
    assert instance.effect_calls == 1
    assert instance.tool_effect_count == 1
    assert len(instance.effects) == 1
    assert instance.effects[0]["request"]["effectId"] == "effect-1"
    assert instance.effects[0]["request"]["action"]["name"] == name
    # The name is recorded for the funnel metrics.
    assert instance.tool_names == [name]
    # A tool effect never spends a method slot or an UNKNOWN stop.
    assert instance.method_loads == 0 and instance.stopped is False

    # The real executor ran: the receipt carries this tool's exact result.
    assert receipt["status"] == "COMPLETE"
    assert receipt["source"] == "PROGRAM_OBSERVATION"
    assert receipt["level"] == "PROVISIONAL"
    assert receipt["checkResult"] == "UNKNOWN"
    assert receipt["effectId"] == "effect-1"
    observation = receipt["observation"]
    assert receipt["observationHash"] == hashlib.sha256(observation.encode("utf-8")).hexdigest()
    payload = json.loads(observation)
    assert payload["tool"] == name
    assert payload["interpretation"] == "OBSERVATION_NOT_PROOF"
    assert payload["result"] == TOOL_CASES[name][1]


@pytest.mark.parametrize("name", TOOL_NAMES)
def test_the_callback_frame_carries_the_bound_receipt(name):
    instance = host()
    _spend(instance, 1, tool_action(name))
    method, message = instance.sent[-1]
    assert method == "tool.execute"
    assert message["id"] == "node-effect-1"
    result = message["result"]
    assert result["sessionId"] == SESSION
    assert result["receipt"] == instance.effects[-1]["receipt"]
    assert result["receipt"]["binding"]["sourceRequestId"] == "model-1"


def test_a_second_tool_call_in_the_same_run_is_admitted():
    """The two-tool half of the six-id capacity, in one session window."""
    instance = host(maxEffects=2, maxMethodLoads=4)
    first, second = "gf2_rank", "transition_count"

    first_receipt = _spend(instance, 1, tool_action(first))
    second_receipt = _spend(instance, 2, tool_action(second))

    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2
    assert [entry["request"]["effectId"] for entry in instance.effects] == [
        "effect-1",
        "effect-2",
    ]
    assert instance.tool_names == [first, second]
    for receipt, name in ((first_receipt, first), (second_receipt, second)):
        assert receipt["status"] == "COMPLETE"
        assert receipt["source"] == "PROGRAM_OBSERVATION"
        assert json.loads(receipt["observation"])["tool"] == name
    assert json.loads(second_receipt["observation"])["result"] == TOOL_CASES[second][1]

    # The tool quota, not the id table, is what closes next.
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 3, tool_action("gf2_nullspace"))
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 2
    assert instance.tool_names == [first, second]


def test_a_second_counting_tool_call_in_the_same_run_is_admitted():
    """A Phase 2 batch-2 pair shares the same two-tool admission window."""
    instance = host(maxEffects=2, maxMethodLoads=4)
    first, second = "rook_numbers", "markov_expected_steps"

    first_receipt = _spend(instance, 1, tool_action(first))
    second_receipt = _spend(instance, 2, tool_action(second))

    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2
    assert [entry["request"]["effectId"] for entry in instance.effects] == [
        "effect-1",
        "effect-2",
    ]
    assert instance.tool_names == [first, second]
    assert json.loads(first_receipt["observation"])["result"] == TOOL_CASES[first][1]
    assert json.loads(second_receipt["observation"])["result"] == TOOL_CASES[second][1]


def test_two_tools_plus_four_methods_fill_the_six_id_window():
    instance = host(maxEffects=2, maxMethodLoads=4)
    catalog_ids = [entry["id"] for entry in instance.catalog["entries"]]
    assert len(catalog_ids) >= 4
    assert instance._effect_budget() == EFFECT_BUDGET

    receipts = [_spend(instance, 1, tool_action("gf2_rank"))]
    receipts.append(_spend(instance, 2, tool_action("gf2_nullspace")))
    for ordinal, method_id in enumerate(catalog_ids[:4], start=3):
        receipts.append(
            _spend(instance, ordinal, method_action(method_id), wire="method.load")
        )

    assert instance.effect_calls == EFFECT_BUDGET
    assert instance.tool_effect_count == 2
    assert instance.method_loads == 4
    assert instance.tool_names == ["gf2_rank", "gf2_nullspace"]
    assert instance.method_ids == catalog_ids[:4]
    assert [receipt["status"] for receipt in receipts] == ["COMPLETE"] * EFFECT_BUDGET
    assert [receipt["source"] for receipt in receipts] == [
        "PROGRAM_OBSERVATION",
        "PROGRAM_OBSERVATION",
        "METHOD_REFERENCE",
        "METHOD_REFERENCE",
        "METHOD_REFERENCE",
        "METHOD_REFERENCE",
    ]

    # The window is spent: the next id is never granted.
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 7, tool_action("gf2_rank"))
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == EFFECT_BUDGET


def test_an_unlisted_tool_name_still_never_reaches_the_effect_body():
    instance = host()
    unlisted = {
        "action": "tool",
        "name": "shell_exec",
        "args": {"cmd": "id"},
        "scope": "phase2 host probe",
    }
    with pytest.raises(ProbeError):
        _spend(instance, 1, unlisted)
    assert instance.effect_calls == 0
    assert instance.tool_names == []
    assert instance.effects == []


def test_an_invalid_payload_is_admitted_but_the_receipt_is_an_error():
    """Admission and execution outcome are separate: a bad payload is refused."""
    instance = host()
    receipt = _spend(instance, 1, tool_action("gf2_nullspace", args={"rows": [1, 2], "width": 1}))
    # The Host admitted the request (name and shape are legal) ...
    assert instance.effect_calls == 1
    assert instance.tool_names == ["gf2_nullspace"]
    # ... and the fixed contract refusal came back as an ERROR receipt.
    assert receipt["status"] == "ERROR"
    assert json.loads(receipt["observation"]) == {"code": "INVALID_INPUT"}
    assert instance.stopped is False
