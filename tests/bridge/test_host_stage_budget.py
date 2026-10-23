"""Focused Host tests: the stage quotas of HANDOFF §5 item 4 (阶段配额).

The design document splits the one flat ``max_model_calls`` cap into a
front-stage ceiling (planning ``R0`` plus review ``R2``/``R4`` at a quarter of
the budget) and a finalization reserve (a tenth of the budget that a
candidate-bearing turn must leave untouched for ``R2``/``R4``/``REPAIR``).

No model call reaches a provider, no Node child, no bundle: one ``AgentHost`` is
driven through its real ``on_model`` admission gate with a real ``AgentClient``
over a non-calling chat stub, and the inner work context is faked the same way
``test_p3_host_effect_budget`` fakes the effect body -- these tests are about
admission arithmetic, not about context shape.
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
from python.astra_bridge.agent_progress import PROGRESS_POLICY
from python.astra_bridge.agent_protocol import load_manifest
from python.astra_bridge.p0_probe import ProbeError

PROBLEM = "Solve 2x + 1 = 4 for x."
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
SESSION = "sess-1"
TASK = "task-1"
SCOPE = "b" * 64


def _envelope(text):
    return {
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ]
    }


def _chat_client():
    """A public client that answers COMPLETE without any provider access."""

    def chat(messages, temperature=0.2, max_tokens=8192):
        return _envelope("ok")

    return SimpleNamespace(chat=chat)


def host(**options):
    values = {
        "maxModelCalls": 16,
        "maxWorkUnits": 8,
        "maxEffects": 0,
        "maxReviews": 2,
        "maxMethodLoads": 0,
        "maxRepairs": 1,
        "maxConsensus": 1,
        # The R0 stage is opt-in and raises the front allowance to its fixed
        # 5-call shape, so the pure-quota cases below switch it off explicitly.
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
        values, AgentClient(_chat_client()),
    )
    instance.catalog = {"version": "1.1.0", "entries": []}
    instance.method_catalog = object()
    instance.catalog_calls = 1
    instance.callback_done = True
    instance.sent = []
    instance.send = lambda proc, message, method: instance.sent.append((method, message))
    return instance


@pytest.fixture
def work_body(monkeypatch):
    """Fake the inner work context body only.

    The context *shape* is owned by ``agent_context`` and covered elsewhere;
    here the subject is the stage arithmetic, so the Host sees a body that
    satisfies exactly the fields its own posterior checks read. It deliberately
    carries no ``schemaVersion``, so the history projections treat these
    fabricated turns as non-progress records and no artifact is invented.
    """

    def fake_validate_context(request, problem, session_id, problem_hash, history,
                             effects, catalog=None, method_assets=None):
        return {
            "problemFullText": problem,
            "progressPolicy": json.loads(json.dumps(PROGRESS_POLICY)),
            "routeProvenance": None,
            "dependencyProvenance": None,
            "revisionProvenance": None,
            "protectedCandidate": None,
            "allowTools": False,
            "allowMethods": False,
            "allowFinal": False,
        }

    monkeypatch.setattr(host_module, "validate_context", fake_validate_context)
    return fake_validate_context


def _request(instance, ordinal, phase, task_id=TASK, scope_id=SCOPE):
    """One Host-shaped model request, as the Node side would build it."""
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": json.dumps({"phase": phase}, separators=(",", ":"))},
    ]
    serialized = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    encoded = serialized.encode("utf-8")
    return {
        "sessionId": instance.session_id,
        "problemHash": instance.problem_hash,
        "requestId": "model-" + str(ordinal),
        "phase": phase,
        "taskId": task_id,
        "scopeId": scope_id,
        "messages": messages,
        "contextHash": hashlib.sha256(encoded).hexdigest(),
        "contextBytes": len(encoded),
        "remainingMs": 5000,
        "maxTokens": 8192,
    }


def _drive(instance, phase, **kwargs):
    """One admission attempt at the next ordinal the Host expects."""
    ordinal = instance.model_requests + 1
    request = _request(instance, ordinal, phase, **kwargs)
    instance.on_model("node-model-" + str(ordinal), {"request": request})
    return ordinal


def _refused(instance, phase, **kwargs):
    before = (instance.model_requests, instance.front_spent)
    with pytest.raises(ProbeError) as excinfo:
        _drive(instance, phase, **kwargs)
    assert excinfo.value.code == "BUDGET"
    # A refusal spends nothing.
    assert (instance.model_requests, instance.front_spent) == before
    return excinfo.value


# -- arithmetic --------------------------------------------------------------


def test_enabling_r0_lifts_the_front_allowance_to_the_stage_shape():
    """R0 is a fixed 3-review + 1-recheck stage, so it needs four front calls.

    Without the lift a profile that explicitly enables `maxR0=1` would refuse
    its own third review with BUDGET, i.e. the quota would starve the stage it
    was meant to protect.
    """
    small = host(maxModelCalls=6, maxR0=1)
    assert small.front_budget == 4  # ceil(6*0.25)=2, lifted to the R0 shape
    assert small.tail_reserve == 1
    plain = host(maxModelCalls=6, maxR0=0)
    assert plain.front_budget == 2
    # A large budget is never narrowed by the R0 floor.
    wide = host(maxModelCalls=100, maxR0=1)
    assert wide.front_budget == 25


@pytest.mark.parametrize(
    "cap, front, tail",
    [(4, 1, 1), (10, 3, 1), (100, 25, 10)],
)
def test_stage_quota_arithmetic_matches_the_design_ceilings(cap, front, tail):
    instance = host(maxModelCalls=cap)
    # ceil(cap * 0.25) and ceil(cap * 0.10), with a floor of one call each.
    assert instance.front_budget == front
    assert instance.tail_reserve == tail
    assert instance.model_requests == 0
    assert instance.front_spent == 0
    assert instance.candidate_stage_seen is False
    # Integer-only arithmetic: no float ever enters a comparison.
    assert isinstance(instance.front_budget, int)
    assert isinstance(instance.tail_reserve, int)


def test_locked_profile_allows_one_review_and_keeps_one_call_reserved(work_body):
    instance = host(maxModelCalls=4, maxReviews=2)
    assert (instance.front_budget, instance.tail_reserve) == (1, 1)
    # Exactly one front-stage call fits: the single review of the locked run.
    _drive(instance, "R2")
    assert instance.front_spent == 1
    assert instance.review_calls == 1
    _refused(instance, "R2")
    # The last call is the reserve: a fresh WORK cannot eat it once the review
    # has really happened.
    instance.model_requests = 3
    assert instance.candidate_stage_seen is True
    _refused(instance, "WORK")


# -- front-stage ceiling -----------------------------------------------------


def test_second_review_beyond_the_front_budget_is_refused(work_body):
    # cap 8 -> front_budget = ceil(8 * 0.25) = 2, tail_reserve = 1.
    instance = host(maxModelCalls=8, maxReviews=3)
    assert (instance.front_budget, instance.tail_reserve) == (2, 1)
    _drive(instance, "R2")
    _drive(instance, "R2")
    assert instance.front_spent == 2
    assert instance.review_calls == 2
    # The review quota itself still has room: it is the front-stage ceiling
    # that refuses, and it refuses with the existing BUDGET vocabulary.
    assert instance.review_calls < instance.max_reviews
    _refused(instance, "R2")
    assert instance.review_calls == 2
    assert instance.front_spent == 2


def test_r0_counts_against_the_same_front_budget(work_body):
    instance = host(maxModelCalls=8, maxReviews=3)
    assert instance.front_budget == 2
    _drive(instance, "R0")
    assert instance.front_spent == 1
    _drive(instance, "R2")
    # One planning call plus one review already fills the quarter.
    assert instance.front_spent == 2
    _refused(instance, "R2")
    assert instance.front_spent == 2


# -- finalization reserve ----------------------------------------------------


def test_tail_reserve_refuses_work_but_not_review(work_body):
    # cap 10 -> front_budget = 3, tail_reserve = 1.
    instance = host(maxModelCalls=10, maxReviews=2, maxConsensus=1)
    assert (instance.front_budget, instance.tail_reserve) == (3, 1)
    _drive(instance, "WORK")
    _drive(instance, "CONSENSUS")
    # A post-candidate phase was admitted, so the reserve is armed.
    assert instance.candidate_stage_seen is True
    # Only tail_reserve calls are left.
    instance.model_requests = 9
    _refused(instance, "WORK")
    # The reserve exists for exactly the finalization turns: the review is
    # still admitted with that same single call left.
    _drive(instance, "R2")
    assert instance.model_requests == 10
    assert instance.review_calls == 1
    assert instance.front_spent == 1


def test_reserve_does_not_bar_work_before_a_candidate_stage(work_body):
    instance = host(maxModelCalls=10, maxReviews=2, maxConsensus=1)
    assert instance.tail_reserve == 1
    _drive(instance, "WORK")
    assert instance.candidate_stage_seen is False
    # Same low-remaining state, but no candidate-bearing turn has happened, so
    # the reserve protects nothing and the WORK turn is admitted.
    instance.model_requests = 9
    _drive(instance, "WORK")
    assert instance.model_requests == 10
    assert instance.candidate_stage_seen is False
    assert instance.front_spent == 0


# -- funnel metrics ----------------------------------------------------------


def test_funnel_metrics_report_the_stage_quota(work_body):
    instance = host(maxModelCalls=16, maxReviews=2)
    _drive(instance, "R0")
    _drive(instance, "R2")
    assert instance.front_spent == 2
    rows = [{"seq": 1, "kind": "SESSION_INIT", "data": {"sessionId": SESSION}}]
    metrics = agent_runtime._funnel_metrics(instance, rows)
    assert metrics["front_budget"] == 4
    assert metrics["tail_reserve"] == 2
    assert metrics["front_spent"] == 2
    # Identity only: the quota keys carry numbers, never model text.
    assert "ok" not in json.dumps(metrics)


def test_unsolved_projection_keeps_the_stage_quota_keys():
    runtime = agent_runtime.AgentRuntime(_chat_client(), max_effects=0)
    result = runtime._unsolved(time.monotonic(), "FIELD_VALUE", True)
    metrics = result["metrics"]
    for key in ("front_budget", "tail_reserve", "front_spent"):
        assert key in metrics, key
        assert metrics[key] == 0, key
    # A host that predates the quotas still yields the three keys.
    legacy = agent_runtime._funnel_metrics(SimpleNamespace(), [])
    assert (legacy["front_budget"], legacy["tail_reserve"], legacy["front_spent"]) == (0, 0, 0)
