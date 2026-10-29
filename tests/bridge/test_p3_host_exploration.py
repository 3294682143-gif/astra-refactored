"""Stage D+ — the one controlled P3 ``explore`` action, end to end on the Host.

Three layers are covered without a Node child, a WASI runtime or a provider:

* the strict action shape: `{"action":"explore","code":...,"scope":...}` with an
  exact key set, a non-empty `code` of at most 65536 UTF-8 bytes and a non-blank
  `scope` of at most 256 code points — everything else is a fixed refusal on
  both the Python mirror and the TS parser;
* the default path: no profile means the Host reports `UNAVAILABLE`, an explore
  action is refused with `ACTION_NOT_ALLOWED`, **no effect id is consumed**, no
  code runs and the funnel metrics are unchanged;
* the admitted path: a stub sandbox plus an admitting gate admit exactly one
  exploration, whose receipt is an explicitly untrusted `BOUNDED_OBSERVATION`
  (`BOUNDED_OBSERVATION_NOT_PROOF`, `source: GENERATED_OBSERVATION`,
  `level: OBSERVED`), counted once against the tool-kind effect quota and
  recorded as `generated_exploration`.

Every assertion is about admission, refusal and bounded bookkeeping. A generated
observation is never a proof, never a certificate and never an obligation
discharge.
"""

from __future__ import annotations

import hashlib
import json
import time
from types import SimpleNamespace

import pytest

from python.astra_bridge import agent_host as host_module
from python.astra_bridge import agent_runtime
from python.astra_bridge.agent_client import AgentClient
from python.astra_bridge.agent_protocol import load_manifest
from python.astra_bridge.generated_execution_gate import GenerativeExecutionGate
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_effect_contract import (
    EFFECT_IDS,
    TOOL_NAMES,
    parse_request,
    receipt as build_receipt,
)
from python.astra_bridge.p3_host_context import parse_action

PROBLEM = "Find the smallest n > 1 with exactly five divisors."
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
SESSION = "sess-explore"
TASK = "task-1"
SCOPE_ID = "b" * 64
CODE = "print(sum(i for i in range(10)))"
CODE_SHA = hashlib.sha256(CODE.encode("utf-8")).hexdigest()
EXPLORATION = "generated_exploration"
BINDING = {
    "sessionId": SESSION,
    "problemHash": PROBLEM_HASH,
    "contractVersion": 1,
    "taskId": TASK,
    "scopeId": SCOPE_ID,
    "sourceRequestId": "model-1",
}


# -- fixtures / helpers ---------------------------------------------------


def _chat_client():
    def chat(messages, temperature=0.2, max_tokens=8192):
        raise AssertionError("no model call in this test")

    return SimpleNamespace(chat=chat)


def _client():
    return AgentClient(_chat_client())


def _options(**over):
    values = {
        "maxModelCalls": 16,
        "maxWorkUnits": 8,
        "maxEffects": 2,
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
    values.update(over)
    return values


def host(**over):
    """One Host with the test options overridden by keyword (maxEffects, ...)."""
    gate = over.pop("generated_python_gate", None)
    instance = host_module.AgentHost(
        load_manifest(), SESSION, time.monotonic() + 60.0, PROBLEM, PROBLEM_HASH,
        _options(**over), _client(), generated_python_gate=gate,
    )
    instance.sent = []
    instance.send = lambda proc, message, method: instance.sent.append((method, message))
    return instance


class StubSandbox:
    """A deterministic stand-in for ``mathagent.tools.PythonSandbox``."""

    identity = "stub-identity"
    reason = "stub"

    def __init__(self, *, status="ok", result=None, error=None):
        self.available = True
        self.status = status
        self.payload = {"output": "45\n", "truncated": False} if result is None else result
        self.error = error
        self.calls = []

    def execute(self, code, *, deadline, problem_id, scope="bounded generated exploration"):
        self.calls.append(
            {"code": code, "deadline": deadline, "problem_id": problem_id, "scope": scope}
        )
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            status=self.status,
            tool="generated_python",
            result=self.payload,
            evidence_kind="BOUNDED_OBSERVATION" if self.status == "ok" else "NONE",
            declared_scope=scope,
            detail="WASI execution is not a proof.",
        )


def approving_gate(**over):
    approved = {
        "profile_id": host_module.EXPLORE_PROFILE_ID,
        "code_sha256": CODE_SHA,
        "max_seconds": host_module._EXPLORE_MAX_SECONDS,
        "max_bytes": host_module._EXPLORE_MAX_BYTES,
    }
    approved.update(over)
    return GenerativeExecutionGate(approved)


def explore_action(code=CODE, scope="sum the first ten integers"):
    return {"action": "explore", "code": code, "scope": scope}


def _arm(instance, ordinal, action, *, allow_tools=True):
    """One completed WORK record whose reply text is the given action."""
    instance.history["model-" + str(ordinal)] = {
        "request": {
            "phase": "WORK",
            "taskId": TASK,
            "scopeId": SCOPE_ID,
            "messages": [
                {"role": "system", "content": "s"},
                {
                    "role": "user",
                    "content": json.dumps({"allowTools": allow_tools}),
                },
            ],
        },
        "receipt": {"transportStatus": "COMPLETE", "text": json.dumps(action)},
    }
    instance.last_model_id = "model-" + str(ordinal)
    instance.model_requests = ordinal
    instance.callback_done = True


def _spend(instance, ordinal, action, wire="tool.execute", remaining_ms=5000):
    effect_id = (
        EFFECT_IDS[instance.effect_calls]
        if instance.effect_calls < len(EFFECT_IDS)
        else "effect-9"
    )
    _arm(instance, ordinal, action)
    binding = dict(BINDING, sourceRequestId="model-" + str(ordinal))
    params = {
        "request": {
            "effectId": effect_id,
            "binding": binding,
            "action": action,
            "remainingMs": remaining_ms,
        }
    }
    instance.on_effect("node-" + effect_id, params, wire)


# -- default path ---------------------------------------------------------


def test_default_host_reports_unavailable_generated_python():
    instance = host()
    assert instance.python_sandbox is None
    assert instance.generated_python_capability() == "UNAVAILABLE"
    # The default gate carries no approved profile, so it can only refuse.
    assert instance.generated_python_gate.decision(
        instance._exploration_request(CODE)
    ) == "REFUSED_NO_PROFILE"


def test_an_explore_action_without_a_profile_is_refused_without_spending_an_id():
    instance = host()
    before_metrics = agent_runtime._funnel_metrics(instance, None)
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    assert excinfo.value.code == "ACTION_NOT_ALLOWED"
    # No budget was burned and no record was written.
    assert instance.effect_calls == 0
    assert instance.tool_effect_count == 0
    assert instance.exploration_calls == 0
    assert instance.tool_names == []
    assert instance.effects == []
    assert instance.sent == []
    assert agent_runtime._funnel_metrics(instance, None) == before_metrics


def test_a_sandbox_without_an_approved_profile_never_executes_and_spends_no_id():
    instance = host()
    sandbox = StubSandbox()
    instance.python_sandbox = sandbox
    # A usable sandbox alone flips the advertised capability ...
    assert instance.generated_python_capability() == "AVAILABLE_BOUNDED"
    # ... but the default gate still has no approved profile.
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    assert excinfo.value.code == "REFUSED_NO_PROFILE"
    assert sandbox.calls == []
    assert instance.effect_calls == 0
    assert instance.exploration_calls == 0
    assert instance.effects == []


def test_the_capability_is_unavailable_when_holding_no_sandbox():
    instance = host(generated_python_gate=approving_gate())
    assert instance.generated_python_capability() == "UNAVAILABLE"
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    # The capability refusal precedes the gate, so an approving gate is inert.
    assert excinfo.value.code == "ACTION_NOT_ALLOWED"
    assert instance.effect_calls == 0


def test_the_unavailable_sandbox_identity_reports_the_fixed_refusal():
    sandbox = StubSandbox()
    sandbox.available = False
    instance = host(generated_python_gate=approving_gate())
    instance.python_sandbox = sandbox
    assert instance.generated_python_capability() == "UNAVAILABLE"
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    assert excinfo.value.code == "ACTION_NOT_ALLOWED"
    assert sandbox.calls == []


# -- admitted path --------------------------------------------------------


def test_one_admitted_exploration_is_a_bounded_untrusted_observation():
    sandbox = StubSandbox()
    instance = host(generated_python_gate=approving_gate())
    instance.python_sandbox = sandbox
    metrics_before = agent_runtime._funnel_metrics(instance, None)

    _spend(instance, 1, explore_action())

    assert len(sandbox.calls) == 1
    assert sandbox.calls[0]["code"] == CODE
    assert sandbox.calls[0]["problem_id"] == SESSION
    assert sandbox.calls[0]["scope"] == "sum the first ten integers"
    assert sandbox.calls[0]["deadline"] == instance.deadline

    assert instance.effect_calls == 1
    assert instance.tool_effect_count == 1
    assert instance.exploration_calls == 1
    assert instance.tool_names == [EXPLORATION]
    assert len(instance.effects) == 1
    record = instance.effects[0]
    assert record["request"]["effectId"] == "effect-1"
    receipt = record["receipt"]
    assert receipt["status"] == "COMPLETE"
    assert receipt["source"] == "GENERATED_OBSERVATION"
    assert receipt["level"] == "OBSERVED"
    assert receipt["checkResult"] == "UNKNOWN"
    observation = json.loads(receipt["observation"])
    assert observation == {
        "kind": "BOUNDED_OBSERVATION",
        "interpretation": "BOUNDED_OBSERVATION_NOT_PROOF",
        "status": "ok",
        "result": {"output": "45\n", "truncated": False},
    }
    # Exactly one frame was answered, on the tool wire, with the receipt.
    assert [method for method, _ in instance.sent] == ["tool.execute"]
    assert instance.sent[0][1]["result"]["receipt"] == receipt

    metrics = agent_runtime._funnel_metrics(instance, None)
    assert metrics["exploration_calls"] == 1
    assert metrics["tool_effect_calls"] == 1
    assert metrics["tool_names"] == [EXPLORATION]
    assert metrics_before["exploration_calls"] == 0
    assert metrics_before["tool_names"] == []


def test_the_recorded_identity_is_not_a_registered_tool():
    """A closure lookup keys on registered tool names only, so this never matches."""
    assert EXPLORATION not in TOOL_NAMES
    assert EXPLORATION == host_module._EXPLORATION_TOOL_NAME


def test_a_failing_sandbox_yields_a_fixed_error_receipt_and_never_a_proof():
    sandbox = StubSandbox(error=RuntimeError("private provider detail"))
    instance = host(generated_python_gate=approving_gate())
    instance.python_sandbox = sandbox
    _spend(instance, 1, explore_action())
    receipt = instance.effects[0]["receipt"]
    assert receipt["status"] == "ERROR"
    assert receipt["source"] == "GENERATED_OBSERVATION"
    assert receipt["level"] == "OBSERVED"
    assert json.loads(receipt["observation"]) == {"code": "REFUSED_EXECUTION_FAILED"}
    assert "private" not in json.dumps(instance.effects)
    assert instance.exploration_calls == 1


# -- budget ---------------------------------------------------------------


def test_a_second_exploration_beyond_the_effect_capacity_burns_no_id():
    sandbox = StubSandbox()
    instance = host(maxEffects=1, generated_python_gate=approving_gate())
    instance.python_sandbox = sandbox
    _spend(instance, 1, explore_action())
    assert instance.effect_calls == 1
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 2, explore_action())
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 1
    assert instance.tool_effect_count == 1
    assert instance.exploration_calls == 1
    assert len(sandbox.calls) == 1
    assert len(instance.effects) == 1


def test_an_exploration_spends_the_same_tool_kind_quota_as_a_tool(monkeypatch):
    calls = []

    def fake_perform_effect(bound, root_deadline=None, catalog=None, python_sandbox=None):
        calls.append(bound["action"])
        observation = json.dumps({"result": {"operation": "SIMPLIFY"}})
        return build_receipt(bound, "COMPLETE", observation)

    monkeypatch.setattr(host_module, "perform_effect", fake_perform_effect)
    sandbox = StubSandbox()
    instance = host(maxEffects=2, generated_python_gate=approving_gate())
    instance.python_sandbox = sandbox
    tool = {
        "action": "tool",
        "name": "exact_check_expr",
        "args": {"expression": "(x+1)**2", "operation": "SIMPLIFY"},
        "scope": "check",
    }
    _spend(instance, 1, explore_action())
    _spend(instance, 2, tool)
    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2
    assert instance.tool_names == [EXPLORATION, "exact_check_expr"]
    # A third tool-kind effect is refused without burning an id.
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 3, tool)
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 2
    assert len(calls) == 1


# -- gate refusals --------------------------------------------------------


@pytest.mark.parametrize(
    "approved,code",
    [
        (
            {"profile_id": "another-profile", "code_sha256": CODE_SHA},
            "REFUSED_PROFILE_MISMATCH",
        ),
        ({"code_sha256": "d" * 64}, "REFUSED_SHA_MISMATCH"),
        ({"max_seconds": 1}, "REFUSED_UNBOUNDED"),
    ],
)
def test_gate_refusals_propagate_as_fixed_codes_and_never_execute(approved, code):
    sandbox = StubSandbox()
    instance = host(generated_python_gate=approving_gate(**approved))
    instance.python_sandbox = sandbox
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    assert excinfo.value.code == code
    assert sandbox.calls == []
    assert instance.effect_calls == 0
    assert instance.tool_effect_count == 0
    assert instance.exploration_calls == 0
    assert instance.effects == []


def test_a_broken_gate_can_only_refuse():
    class BrokenGate:
        def decision(self, request):
            raise RuntimeError("gate broken")

    sandbox = StubSandbox()
    instance = host(generated_python_gate=BrokenGate())
    instance.python_sandbox = sandbox
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 1, explore_action())
    assert excinfo.value.code == "REFUSED_NO_PROFILE"
    assert sandbox.calls == []
    assert instance.effect_calls == 0


# -- parse tests (Python side) --------------------------------------------


def _parse(payload):
    return parse_action(json.dumps(payload), dict(BINDING))


def test_a_well_formed_explore_action_parses():
    action = _parse(explore_action())
    assert action == {"action": "explore", "code": CODE, "scope": "sum the first ten integers"}


@pytest.mark.parametrize(
    "payload",
    [
        # overlong source: > 65536 UTF-8 bytes
        {"action": "explore", "code": "x" * 65537, "scope": "s"},
        # empty scope / empty code / blank code
        {"action": "explore", "code": CODE, "scope": ""},
        {"action": "explore", "code": "", "scope": "s"},
        {"action": "explore", "code": "   ", "scope": "s"},
        # overlong scope: > 256 code points
        {"action": "explore", "code": CODE, "scope": "s" * 257},
        # extra / missing keys
        {"action": "explore", "code": CODE, "scope": "s", "extra": 1},
        {"action": "explore", "code": CODE},
        {"action": "explore", "scope": "s"},
        # wrong types
        {"action": "explore", "code": 1, "scope": "s"},
        {"action": "explore", "code": CODE, "scope": 1},
        {"action": "explore", "code": [CODE], "scope": "s"},
    ],
)
def test_strict_explore_parse_refusals(payload):
    with pytest.raises(ProbeError) as excinfo:
        _parse(payload)
    assert excinfo.value.code == "FIELD_VALUE"


def test_the_effect_contract_mirror_accepts_the_same_shape():
    request = {
        "effectId": "effect-1",
        "binding": dict(BINDING),
        "action": explore_action(),
        "remainingMs": 1000,
    }
    parsed = parse_request(json.dumps(request).encode("utf-8"))
    assert parsed["action"]["action"] == "explore"
    built = build_receipt(parsed, "COMPLETE", '{"kind":"BOUNDED_OBSERVATION"}')
    assert built["source"] == "GENERATED_OBSERVATION"
    assert built["level"] == "OBSERVED"
    assert built["checkResult"] == "UNKNOWN"


@pytest.mark.parametrize(
    "action",
    [
        {"action": "explore", "code": "x" * 65537, "scope": "s"},
        {"action": "explore", "code": CODE, "scope": ""},
        {"action": "explore", "code": CODE, "scope": "s", "extra": 1},
        {"action": "explore", "code": None, "scope": "s"},
    ],
)
def test_the_effect_contract_refuses_the_same_malformed_shapes(action):
    from python.astra_bridge.p0_protocol import ProtocolError

    request = {
        "effectId": "effect-1",
        "binding": dict(BINDING),
        "action": action,
        "remainingMs": 1000,
    }
    with pytest.raises(ProtocolError):
        parse_request(json.dumps(request).encode("utf-8"))
