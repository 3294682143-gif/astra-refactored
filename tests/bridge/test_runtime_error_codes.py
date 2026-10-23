"""The unsolved projection keeps a fixed, closed error vocabulary.

Two failure classes used to collapse into one generic code:

* a clean child exit that never delivered ``session.solve`` (a protocol defect,
  now ``NO_SOLVE_RESULT``), and
* an unexpected exception inside the protocol driver, whose *type* is now
  reported as ``EXC_<Type>``.

Neither path may ever carry exception text, problem text, model text or a tool
argument: only the type name is read, and the alphabet/length are bounded.
"""

from __future__ import annotations

import time

import pytest

from python.astra_bridge import agent_runtime

SECRET = "PRIVATE problem text and an answer 42"


class _Blocked:
    blocked = False


def _runtime():
    runtime = object.__new__(agent_runtime.AgentRuntime)
    runtime.client = _Blocked()
    return runtime


def test_unexpected_exception_reports_only_its_type():
    assert agent_runtime._exception_code(KeyError(SECRET)) == "EXC_KeyError"
    assert agent_runtime._exception_code(IndexError(SECRET)) == "EXC_IndexError"
    assert agent_runtime._exception_code(ValueError(SECRET)) == "EXC_ValueError"


def test_exception_code_never_carries_the_message():
    code = agent_runtime._exception_code(RuntimeError(SECRET))
    assert SECRET not in code
    assert code == "EXC_RuntimeError"


def test_unusual_exception_type_names_collapse_to_a_fixed_code():
    class _Weird:
        # A local class name is legal Python but must not become a free string.
        pass

    assert agent_runtime._exception_code(_Weird()) == "EXC__Weird"

    class Ünicode:
        pass

    assert agent_runtime._exception_code(Ünicode()) == "EXC_UNKNOWN"

    long_name = type("A" * 40, (Exception,), {})
    assert agent_runtime._exception_code(long_name()) == "EXC_UNKNOWN"


def test_closed_vocabulary_accepts_contract_codes_and_exception_families():
    assert agent_runtime._fixed_unsolved_code("TIMEOUT") == "TIMEOUT"
    assert agent_runtime._fixed_unsolved_code("CHILD_FAILED") == "CHILD_FAILED"
    assert agent_runtime._fixed_unsolved_code("NO_SOLVE_RESULT") == "NO_SOLVE_RESULT"
    assert agent_runtime._fixed_unsolved_code("DEADLINE_EXCEEDED") == "DEADLINE_EXCEEDED"
    assert agent_runtime._fixed_unsolved_code("EXC_KeyError") == "EXC_KeyError"
    assert agent_runtime._fixed_unsolved_code("BUDGET") == "BUDGET"


@pytest.mark.parametrize(
    "code",
    ["", "some free text", "FIELD_VALUE and more", "EXC_", "EXC_" + "A" * 40, None, 7],
)
def test_closed_vocabulary_rejects_anything_else(code):
    assert agent_runtime._fixed_unsolved_code(code) == "FIELD_VALUE"


def test_unsolved_projection_is_never_verified_and_keeps_metrics():
    runtime = _runtime()
    result = runtime._unsolved(time.monotonic(), "NO_SOLVE_RESULT", True)

    assert result["status"] == "unsolved"
    assert result["code"] == "NO_SOLVE_RESULT"
    assert result["reason"] == "NO_CANDIDATE"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["trace"] == []
    assert result["final_response"] == agent_runtime._UNSOLVED
    # The route/observation funnel counters exist on every path, so a lost item
    # stays auditable instead of looking like a run that never happened.
    for key in (
        "routed",
        "forced",
        "obeyed",
        "observation_used",
        "tool_effect_calls",
        "method_effect_calls",
    ):
        assert result["metrics"][key] == 0


def test_unsolved_projection_replaces_a_free_string_code():
    runtime = _runtime()
    result = runtime._unsolved(time.monotonic(), SECRET, True)
    assert result["code"] == "FIELD_VALUE"
    assert SECRET not in result["code"]


def test_host_budget_refusals_use_their_own_code():
    """A budget refusal is not a field failure.

    The Host used to answer every refusal with ``FIELD_VALUE``, so a run that
    merely asked for one review too many looked identical to a malformed frame.
    """
    import hashlib
    import json

    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge.agent_client import AgentClient
    from python.astra_bridge.agent_protocol import load_manifest
    from python.astra_bridge.p0_probe import ProbeError

    problem = "Compute 2+2."
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    values = {
        "maxModelCalls": 1,
        "maxWorkUnits": 1,
        "maxEffects": 0,
        "maxReviews": 0,
        "maxMethodLoads": 0,
        "maxRepairs": 0,
        "maxConsensus": 0,
        "maxR0": 0,
        "policy": "BEST_EFFORT",
        "deriveBudget": True,
        "resumeSessionLog": None,
        "resumeContractVersion": None,
        "resumeHistory": None,
    }
    client = AgentClient(type("C", (), {"chat": staticmethod(lambda *a, **k: {})})())
    instance = host_module.AgentHost(
        load_manifest(), "sess-1", time.monotonic() + 60.0, problem, problem_hash,
        values, client,
    )
    instance.catalog = {"version": "1.1.0", "entries": []}
    instance.catalog_calls = 1
    instance.callback_done = True
    instance.model_requests = 1
    with pytest.raises(ProbeError) as excinfo:
        instance.on_model("node-model-2", {"request": {"requestId": "model-2"}})
    assert excinfo.value.code == "BUDGET"


def test_host_deadline_floor_uses_its_own_code():
    import hashlib

    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge.agent_client import AgentClient
    from python.astra_bridge.agent_protocol import load_manifest
    from python.astra_bridge.p0_probe import ProbeError

    problem = "Compute 2+2."
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    values = {
        "maxModelCalls": 4,
        "maxWorkUnits": 1,
        "maxEffects": 0,
        "maxReviews": 0,
        "maxMethodLoads": 0,
        "maxRepairs": 0,
        "maxConsensus": 0,
        "maxR0": 0,
        "policy": "BEST_EFFORT",
        "deriveBudget": True,
        "resumeSessionLog": None,
        "resumeContractVersion": None,
        "resumeHistory": None,
    }
    client = AgentClient(type("C", (), {"chat": staticmethod(lambda *a, **k: {})})())
    # A deadline already inside the floor: the very first model turn is refused.
    instance = host_module.AgentHost(
        load_manifest(), "sess-1", time.monotonic() + 0.001, problem, problem_hash,
        values, client,
    )
    instance.catalog = {"version": "1.1.0", "entries": []}
    instance.catalog_calls = 1
    instance.callback_done = True
    with pytest.raises(ProbeError) as excinfo:
        instance.on_model("node-model-1", {"request": {"requestId": "model-1"}})
    assert excinfo.value.code == "DEADLINE_EXCEEDED"
