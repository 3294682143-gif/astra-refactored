"""Focused tests for answer-closure funnel telemetry.

No model call, Node child, or bundle is involved: each test fabricates the
SessionLog rows the Node side appends and asks ``_funnel_metrics`` to derive
the bounded closure counters from them.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

from python.astra_bridge import agent_runtime


def _host():
    return SimpleNamespace(
        effects=[],
        tool_names=[],
        method_ids=[],
        max_effects=0,
        max_method_loads=0,
    )


def _closure(seq, **fields):
    data = {
        "stage": "ANSWER_CLOSURE",
        "requestId": "closure-" + str(seq),
        "defects": [],
        "observationViews": 0,
        "observationUsed": False,
        "closureRequested": True,
        "candidateChanged": False,
        "remainingDefects": [],
    }
    data.update(fields)
    return {"seq": seq, "kind": "CONSENSUS", "data": data}


def _runtime():
    runtime = object.__new__(agent_runtime.AgentRuntime)
    runtime.client = SimpleNamespace(blocked=False)
    return runtime


def test_no_closure_rows_yields_zero_metrics():
    metrics = agent_runtime._funnel_metrics(
        _host(),
        [
            {"seq": 1, "kind": "SESSION_INIT", "data": {}},
            {"seq": 2, "kind": "CONSENSUS", "data": {"stage": "CERTIFICATE"}},
            {"seq": 3, "kind": "CONSENSUS", "data": {"observationUsed": True}},
            "not-a-row",
        ],
    )
    assert metrics["closure_evaluations"] == 0
    assert metrics["closure_defects"] == 0
    assert metrics["observation_views"] == 0
    assert metrics["observation_used"] == 0


def test_zero_defect_closure_evaluation_is_visible():
    metrics = agent_runtime._funnel_metrics(
        _host(),
        [_closure(1, defects=[], observationUsed=False, observationViews=2)],
    )
    assert metrics["closure_evaluations"] == 1
    assert metrics["closure_defects"] == 0
    assert metrics["observation_views"] == 2
    assert metrics["observation_used"] == 0


def test_observation_grounded_closure_counts_as_used():
    metrics = agent_runtime._funnel_metrics(
        _host(),
        [
            _closure(
                1,
                defects=["DEGREE_CONSERVATION"],
                observationViews=3,
                observationUsed=True,
                candidateChanged=True,
            )
        ],
    )
    assert metrics["closure_evaluations"] == 1
    assert metrics["closure_defects"] == 1
    assert metrics["observation_views"] == 3
    assert metrics["observation_used"] == 1


def test_observation_views_reports_the_maximum_row():
    metrics = agent_runtime._funnel_metrics(
        _host(),
        [
            _closure(1, observationViews=1),
            _closure(2, observationViews=4),
            _closure(3, observationViews=2),
        ],
    )
    assert metrics["closure_evaluations"] == 3
    assert metrics["closure_defects"] == 0
    assert metrics["observation_views"] == 4


def test_malformed_closure_fields_are_ignored_without_raising():
    metrics = agent_runtime._funnel_metrics(
        _host(),
        [
            _closure(1, defects="x", observationViews="many"),
            _closure(2, observationUsed="true"),
            _closure(3, requestId=7),
            _closure(4, closureRequested=1),
            _closure(5, candidateChanged=None),
            _closure(6, remainingDefects=[1]),
            _closure(7, defects=["OK"], observationViews=-1),
        ],
    )
    assert metrics["closure_evaluations"] == 0
    assert metrics["closure_defects"] == 0
    assert metrics["observation_views"] == 0
    assert metrics["observation_used"] == 0


def test_unsolved_projection_carries_the_closure_metrics():
    result = _runtime()._unsolved(time.monotonic(), "FIELD_VALUE", True)
    metrics = result["metrics"]
    assert result["status"] == "unsolved"
    for key in (
        "closure_evaluations",
        "closure_defects",
        "observation_views",
    ):
        assert key in metrics, key
        assert metrics[key] == 0, key
