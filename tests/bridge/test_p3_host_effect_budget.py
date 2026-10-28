"""Focused Host tests: separate tool/method effect budgets + funnel metrics.

No model call, no Node child, no bundle: one ``AgentHost`` is driven through its
real ``on_effect`` gate with the boundary contract's own receipt builder and a
fabricated SessionLog for the funnel derivation.
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
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_effect_contract import EFFECT_IDS, receipt as build_receipt

PROBLEM = "Solve 2x + 1 = 4 for x."
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
SESSION = "sess-1"
TASK = "task-1"
SCOPE = "b" * 64
MID = "linearization-spectral"
TITLE = "Linearization & spectral method"
CATALOG = {"version": "1.1.0", "entries": [{"id": MID, "title": TITLE}]}
TOOL = "exact_check_expr"
TOOL_ARGS = {"expression": "(x+1)**2", "operation": "SIMPLIFY"}
METHOD_BODY = "METHOD BODY"


def _chat_client():
    def chat(messages, temperature=0.2, max_tokens=8192):
        raise AssertionError("no model call in this test")

    return SimpleNamespace(chat=chat)


def _client():
    return AgentClient(_chat_client())


def host(**options):
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
    values.update(options)
    instance = host_module.AgentHost(
        load_manifest(), SESSION, time.monotonic() + 60.0, PROBLEM, PROBLEM_HASH,
        values, _client(),
    )
    # A real catalog shape is enough: the Host only reads id/title/version here.
    instance.catalog = json.loads(json.dumps(CATALOG))
    instance.method_catalog = object()
    instance.catalog_calls = 1
    instance.sent = []
    instance.send = lambda proc, message, method: instance.sent.append((method, message))
    return instance


@pytest.fixture
def no_reads(monkeypatch):
    """The effect body is faked; nothing may touch a tool process or a card."""

    def fake_perform_effect(bound, root_deadline=None, catalog=None):
        action = bound["action"]
        if action["action"] == "method":
            body = METHOD_BODY
            asset = {
                "id": action["id"],
                "title": TITLE,
                "version": CATALOG["version"],
                "body": body,
                "bodySha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "bodyChars": len(body),
            }
            observation = json.dumps(
                {"method": action["id"], "asset": asset, "interpretation": "ADVISORY_NOT_PROOF"},
                separators=(",", ":"),
            )
        else:
            observation = json.dumps({"result": {"operation": "SIMPLIFY"}}, separators=(",", ":"))
        return build_receipt(bound, "COMPLETE", observation)

    monkeypatch.setattr(host_module, "perform_effect", fake_perform_effect)
    return fake_perform_effect


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


def _spend(instance, ordinal, action, wire="tool.execute", remaining_ms=5000):
    # A spent window has no addressable id left; the admission gate must refuse
    # before the id is ever validated, so any placeholder is enough there.
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


def tool_action():
    return {"action": "tool", "name": TOOL, "args": dict(TOOL_ARGS), "scope": "check"}


def method_action(method_id=MID):
    return {"action": "method", "id": method_id}


# -- effect budget separation ------------------------------------------------


def test_method_card_and_two_tools_fit_in_one_window(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    assert instance._effect_budget() == 3
    _spend(instance, 1, method_action(), wire="method.load")
    _spend(instance, 2, tool_action())
    _spend(instance, 3, tool_action())
    assert instance.effect_calls == 3
    assert instance.method_loads == 1
    assert instance.tool_effect_count == 2
    assert [entry["receipt"]["source"] for entry in instance.effects] == [
        "METHOD_REFERENCE", "PROGRAM_OBSERVATION", "PROGRAM_OBSERVATION",
    ]
    assert instance.method_ids == [MID]
    assert instance.tool_names == [TOOL]
    # The one-card + two-tool budget is spent even though the shared id table
    # can hold more ids.
    with pytest.raises(ProbeError):
        _spend(instance, 4, tool_action())
    assert instance.effect_calls == 3


def test_third_tool_refused_while_the_method_slot_survives(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    _spend(instance, 1, tool_action())
    _spend(instance, 2, tool_action())
    assert instance.tool_effect_count == 2
    with pytest.raises(ProbeError):
        _spend(instance, 3, tool_action())
    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2
    # The method slot is separate: it can still be spent after the tool quota.
    _spend(instance, 3, method_action(), wire="method.load")
    assert instance.effect_calls == 3
    assert instance.method_loads == 1
    with pytest.raises(ProbeError):
        _spend(instance, 4, method_action(), wire="method.load")
    assert instance.method_loads == 1


def test_four_methods_and_two_tools_fill_the_six_id_window(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=4)
    assert instance._effect_budget() == 6
    _spend(instance, 1, method_action(), wire="method.load")
    _spend(instance, 2, tool_action())
    _spend(instance, 3, tool_action())
    _spend(instance, 4, method_action(), wire="method.load")
    _spend(instance, 5, method_action(), wire="method.load")
    _spend(instance, 6, method_action(), wire="method.load")
    assert instance.effect_calls == 6
    assert instance.method_loads == 4
    assert instance.tool_effect_count == 2
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 7, tool_action())
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 6


def test_fifth_method_load_is_refused_while_ids_remain(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=4)
    for ordinal in range(1, 5):
        _spend(instance, ordinal, method_action(), wire="method.load")
    assert instance.effect_calls == 4
    assert instance.method_loads == 4
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 5, method_action(), wire="method.load")
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 4
    assert instance.method_loads == 4


def test_third_tool_effect_is_refused_while_ids_remain(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=4)
    _spend(instance, 1, tool_action())
    _spend(instance, 2, tool_action())
    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2
    with pytest.raises(ProbeError) as excinfo:
        _spend(instance, 3, tool_action())
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 2


def test_second_method_card_is_refused(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    _spend(instance, 1, method_action(), wire="method.load")
    with pytest.raises(ProbeError):
        _spend(instance, 2, method_action(), wire="method.load")
    assert instance.method_loads == 1
    assert instance.effect_calls == 1


def test_max_method_loads_zero_keeps_the_old_behaviour(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=0)
    # Without a method slot the public tool quota is the whole capacity.
    assert instance._effect_budget() == 2
    _spend(instance, 1, tool_action())
    _spend(instance, 2, tool_action())
    with pytest.raises(ProbeError):
        _spend(instance, 3, tool_action())
    assert instance.effect_calls == 2
    with pytest.raises(ProbeError):
        _spend(instance, 3, method_action(), wire="method.load")
    assert instance.method_loads == 0


def test_max_effects_zero_still_refuses_tools(no_reads):
    instance = host(maxEffects=0, maxMethodLoads=0)
    assert instance._effect_budget() == 0
    with pytest.raises(ProbeError):
        _spend(instance, 1, tool_action())
    assert instance.effect_calls == 0
    assert instance.effects == []


def test_max_effects_zero_with_methods_requested_keeps_no_capacity(no_reads):
    instance = host(maxEffects=0, maxMethodLoads=1)
    # Methods require a positive tool quota, so the method slot never opens.
    assert instance._effect_budget() == 0
    with pytest.raises(ProbeError):
        _spend(instance, 1, method_action(), wire="method.load")


def test_reserve_is_still_required_before_any_effect(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1, maxModelCalls=1)
    assert instance._effect_budget() == 2  # methods disabled: too few calls
    with pytest.raises(ProbeError):
        _spend(instance, 1, tool_action())
    assert instance.effect_calls == 0


# -- advertised grants -------------------------------------------------------


def test_advertised_grants_split_the_two_quotas(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    assert instance._advertised_actions(True, False, False) == (True, True)
    instance.effect_calls = 1
    instance.method_loads = 1
    assert instance._advertised_actions(True, False, False) == (True, False)
    instance.effect_calls = 2
    instance.tool_effect_count = 2
    assert instance._advertised_actions(True, False, False) == (False, False)
    # A cached observation keeps the action advertised after the quota is spent.
    assert instance._advertised_actions(True, True, True) == (True, True)
    # A negative reserve wins over everything.
    assert instance._advertised_actions(False, True, True) == (False, False)


def test_advertised_methods_need_a_real_catalog(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    instance.catalog = {"version": "1.1.0", "entries": []}
    assert instance._advertised_actions(True, False, False) == (True, False)


# -- funnel metrics ----------------------------------------------------------


def test_funnel_metrics_derivation(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    _spend(instance, 1, method_action(), wire="method.load")
    _spend(instance, 2, tool_action())
    rows = [
        {"seq": 1, "kind": "SESSION_INIT", "data": {"sessionId": SESSION}},
        {"seq": 2, "kind": "REPAIR", "data": {"kind": "TOOL_ROUTE", "forced": False}},
        {"seq": 3, "kind": "REPAIR", "data": {"kind": "TOOL_ROUTE", "forced": True}},
        {"seq": 4, "kind": "REPAIR", "data": {"kind": "SCHEMA_REPAIR"}},
        {"seq": 5, "kind": "TOOL_OBSERVATION", "data": {"effectId": "effect-2"}},
        {"seq": 6, "kind": "TOOL_OBSERVATION", "data": {"effectId": "effect-2", "forced": True}},
        {"seq": 7, "kind": "TOOL_OBSERVATION", "data": {"effectId": "effect-2", "routeId": "route-1"}},
        {"seq": 8, "kind": "METHOD_LOAD", "data": {"effectId": "effect-1"}},
        {"seq": 9, "kind": "CONSENSUS", "data": {"stage": "CERTIFICATE"}},
        {"seq": 10, "kind": "CONSENSUS", "data": {"stage": "ANSWER_CLOSURE", "observationUsed": True}},
        {"seq": 11, "kind": "CONSENSUS", "data": {"stage": "ANSWER_CLOSURE", "observationUsed": False}},
    ]
    metrics = agent_runtime._funnel_metrics(instance, rows)
    assert metrics == {
        "routed": 2,
        "forced": 1,
        "obeyed": 2,
        "observation_used": 1,
        "closure_evaluations": 2,
        "closure_defects": 0,
        "observation_views": 0,
        "tool_effect_calls": 1,
        "method_effect_calls": 1,
        # Stage D+: the bounded exploration counter is present and zero unless
        # an exploration was really admitted.
        "exploration_calls": 0,
        "tool_names": [TOOL],
        "method_ids": [MID],
        # Stage quota audit: the Host's split of this 16-call cap is
        # ceil(16*0.25)=4 front calls and ceil(16*0.10)=2 reserved calls, and no
        # front-stage request was admitted in this fabrication.
        "front_budget": 4,
        "tail_reserve": 2,
        "front_spent": 0,
    }
    # Identity only: no raw arguments, no observation, no model text.
    public = json.dumps(metrics)
    assert "expression" not in public
    assert METHOD_BODY not in public
    assert "(x+1)**2" not in public


def test_funnel_metrics_defaults_are_zero_without_a_log(no_reads):
    instance = host(maxEffects=2, maxMethodLoads=1)
    empty = agent_runtime._funnel_metrics(instance, None)
    assert empty == {
        "routed": 0, "forced": 0, "obeyed": 0, "observation_used": 0,
        "closure_evaluations": 0, "closure_defects": 0, "observation_views": 0,
        "tool_effect_calls": 0, "method_effect_calls": 0,
        "exploration_calls": 0,
        "tool_names": [], "method_ids": [],
        # The stage quotas are host configuration, not funnel counters, so they
        # keep their real values even when the SessionLog is missing.
        "front_budget": 4, "tail_reserve": 2, "front_spent": 0,
    }
    garbage = agent_runtime._funnel_metrics(SimpleNamespace(), ["x", 3, {"kind": "REPAIR"}])
    assert garbage["routed"] == 0 and garbage["tool_effect_calls"] == 0
    # A host that predates the stage quotas still yields the three keys.
    assert (garbage["front_budget"], garbage["tail_reserve"], garbage["front_spent"]) == (0, 0, 0)


def test_funnel_metrics_are_capped_by_the_declared_budget(no_reads):
    fake = SimpleNamespace(
        effects=[],
        tool_names=["a", "b", "c", "a", "d"],
        method_ids=[MID, "other"],
        max_effects=2,
        max_method_loads=1,
    )
    metrics = agent_runtime._funnel_metrics(fake, [])
    assert metrics["tool_names"] == ["a", "b"]
    assert metrics["method_ids"] == [MID]


def test_unsolved_result_reports_every_funnel_key():
    runtime = agent_runtime.AgentRuntime(_chat_client(), max_effects=1)
    result = runtime._unsolved(time.monotonic(), "FIELD_VALUE", True)
    assert result["status"] == "unsolved"
    metrics = result["metrics"]
    for key in (
        "routed", "forced", "obeyed", "observation_used",
        "closure_evaluations", "closure_defects", "observation_views",
        "tool_effect_calls", "method_effect_calls", "tool_names", "method_ids",
    ):
        assert key in metrics, key
        assert metrics[key] in (0, []), key


def test_failed_run_still_reports_real_funnel_numbers(no_reads):
    """The error path may not wash the funnel to a fabricated zero."""
    instance = host(maxEffects=2, maxMethodLoads=1)
    _spend(instance, 1, method_action(), wire="method.load")
    _spend(instance, 2, tool_action())
    runtime = agent_runtime.AgentRuntime(_chat_client(), max_effects=2, max_method_loads=1)
    rows = [
        {"seq": 1, "kind": "REPAIR", "data": {"kind": "TOOL_ROUTE", "forced": True}},
        {"seq": 2, "kind": "TOOL_OBSERVATION", "data": {"effectId": "effect-2", "forced": True}},
    ]
    result = runtime._finish(
        time.monotonic(), instance, {"sessionLog": rows}, "FIELD_VALUE", True, 0, 0,
    )
    assert result["status"] == "unsolved"
    metrics = result["metrics"]
    assert metrics["routed"] == 1
    assert metrics["forced"] == 1
    assert metrics["obeyed"] == 1
    assert metrics["observation_used"] == 0
    assert metrics["tool_effect_calls"] == 1
    assert metrics["method_effect_calls"] == 1
    assert metrics["tool_names"] == [TOOL]
    assert metrics["method_ids"] == [MID]
    assert metrics["effect_calls"] == 2
    assert metrics["method_loads"] == 1


def test_math_asset_uses_the_tool_quota_not_the_total_effect_count(no_reads, monkeypatch):
    """A method card must not consume one of the two math-asset/tool slots.

    Regression for the real 100-item BUDGET stops: the Host used to compare
    ``effect_calls`` against ``max_effects`` in ``on_math_asset``. After one
    method load (effect-1) and one asset (effect-2), a second asset was refused
    even though the public tool quota was only half spent and the shared id
    capacity still had room for effect-3.
    """
    import python.astra_bridge.math_assets_runtime as math_assets_runtime

    def fake_use_math_asset(request, *, context, deadline):
        return {
            "status": "COMPLETE",
            "assetId": request["assetId"],
            "observations": [
                {
                    "quantity": request["target"],
                    "value": {"ok": True},
                }
            ],
        }

    monkeypatch.setattr(math_assets_runtime, "use_math_asset", fake_use_math_asset)
    instance = host(maxEffects=2, maxMethodLoads=1)
    _spend(instance, 1, method_action(), wire="method.load")
    instance.sent.clear()

    def asset_params(ordinal):
        return {
            "sessionId": SESSION,
            "request": {
                "action": "math_asset",
                "assetId": "math.numerics",
                "target": ("interpolation_fit" if ordinal == 2 else "finite_difference"),
                "input": {"points": [], "expression": "x", "variable": "x"},
                "binding": {
                    "taskId": TASK,
                    "goalId": "goal-1",
                    "scopeId": SCOPE,
                    "contractVersion": 1,
                    "sourceRequestId": "model-" + str(ordinal),
                },
            },
        }

    instance.on_math_asset("node-effect-2", asset_params(2))
    assert instance.effect_calls == 2
    assert instance.tool_effect_count == 1
    assert instance.effects[-1]["receipt"]["effectId"] == "effect-2"

    instance.on_math_asset("node-effect-3", asset_params(3))
    assert instance.effect_calls == 3
    assert instance.tool_effect_count == 2
    assert instance.effects[-1]["receipt"]["effectId"] == "effect-3"
    assert len(instance.tool_names) == 2

    with pytest.raises(ProbeError) as excinfo:
        instance.on_math_asset("node-effect-4", asset_params(4))
    assert excinfo.value.code == "BUDGET"
    assert instance.effect_calls == 3


def test_capability_metrics_are_invocation_counts(no_reads):
    instance = host(
        maxR0=1, maxRepairs=1, maxReviews=2, maxConsensus=2,
    )
    rows = [
        {"seq": 1, "kind": "MODEL_REQUEST", "data": {"phase": "R0", "requestId": "model-1"}},
        {"seq": 2, "kind": "MODEL_REQUEST", "data": {"phase": "R0", "requestId": "model-2"}},
        {"seq": 3, "kind": "MODEL_REQUEST", "data": {"phase": "R0", "requestId": "model-3"}},
        {"seq": 4, "kind": "R0_REVIEW", "data": {"role": "MEANING"}},
        {"seq": 5, "kind": "R0_REVIEW", "data": {"role": "METHOD"}},
        {"seq": 6, "kind": "R0_REVIEW", "data": {"role": "TASK_TOOL"}},
        {"seq": 7, "kind": "R0_REVIEW", "data": {"role": "AGGREGATE"}},
        {"seq": 8, "kind": "CONTRACT_REVISED", "data": {"fromVersion": 1, "toVersion": 2}},
        {"seq": 9, "kind": "CONSENSUS", "data": {"stage": "INDEPENDENT", "nextCandidate": "4"}},
        {"seq": 10, "kind": "CONSENSUS", "data": {"stage": "AUDIT", "nextCandidate": "4"}},
        {"seq": 11, "kind": "CONSENSUS", "data": {"stage": "CERTIFICATE", "nextCandidate": "4"}},
        {"seq": 12, "kind": "CONSENSUS", "data": {"stage": "ANSWER_CLOSURE"}},
        {"seq": 13, "kind": "MODEL_REQUEST", "data": {"phase": "R2", "requestId": "model-4"}},
        {"seq": 14, "kind": "REPAIR", "data": {"kind": "G2_ROUTE_ADMIT"}},
        {"seq": 15, "kind": "REPAIR", "data": {"kind": "G2_ROUTE_PICK"}},
        {"seq": 16, "kind": "REPAIR", "data": {"kind": "G2_ROUTE_RESULT", "candidatePresent": True, "agrees": True}},
        {"seq": 17, "kind": "MODEL_REQUEST", "data": {"phase": "REPAIR", "requestId": "model-5"}},
        {"seq": 18, "kind": "MODEL_REQUEST", "data": {"phase": "R4", "requestId": "model-6"}},
        {"seq": 19, "kind": "REPAIR", "data": {"accepted": False, "reason": "REVISE_REJECTED"}},
        {"seq": 20, "kind": "REPAIR", "data": {"kind": "CAPABILITY_PROBE", "stage": "R4", "accepted": False}},
    ]
    metrics = agent_runtime._capability_metrics(instance, rows)
    assert metrics["capability_profile"] == "FULL"
    assert metrics["r0_model_calls"] == 3
    assert metrics["r0_role_reviews"] == 3
    assert metrics["r0_aggregates"] == 1
    assert metrics["r0_plan_revisions"] == 1
    assert metrics["consensus_independent_calls"] == 1
    assert metrics["consensus_audit_calls"] == 1
    assert metrics["consensus_certificate_calls"] == 1
    assert metrics["consensus_closure_calls"] == 1
    assert metrics["consensus_independent_ballots"] == 1
    assert metrics["consensus_audit_ballots"] == 1
    assert metrics["consensus_certificate_ballots"] == 1
    assert metrics["r2_review_calls"] == 1
    assert metrics["repair_model_calls"] == 1
    assert metrics["r4_review_calls"] == 1
    assert metrics["g2_route_attempts"] == 1
    assert metrics["g2_routes_admitted"] == 1
    assert metrics["g2_route_picks"] == 1
    assert metrics["g2_route_workunits"] == 1
    assert metrics["g2_route_candidates"] == 1
    assert metrics["g2_route_agreements"] == 1
    assert metrics["repair_decisions"] == 1
    assert metrics["repair_rejected"] == 1
    assert metrics["capability_probe_calls"] == 1
    assert metrics["capability_probe_accepted"] == 0
    # Only counts, never raw text.
    assert "problem" not in json.dumps(metrics).lower()
