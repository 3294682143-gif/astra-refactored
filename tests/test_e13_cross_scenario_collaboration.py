"""Test suite for Work Package E13: Cross-Scenario Collaboration.

Verifies:
1. Delegation from Control (oscillator identification) to Data Analysis (uncertainty & residual audit).
2. Recursion depth protection (depth > max_depth refused).
3. Inherited budget exhaustion handled gracefully without executing.
4. Unregistered target scenarios rejected cleanly.
5. candidate_verified is strictly False (no phantom PASS).
"""

from __future__ import annotations

import random
import pytest
from python.astra_web.collaboration import (
    CollaborationResult,
    CollaborationTask,
    CrossScenarioDelegationRefused,
    CrossScenarioDelegator,
)


def test_e13_control_to_data_analysis_delegation_succeeds():
    coordinator = CrossScenarioDelegator(max_depth=1)
    rng = random.Random(42)
    task = CollaborationTask(
        task_id="collab_ctrl_da_001",
        parent_run_id="run_ctrl_99",
        initiating_scenario_id="control.identification",
        target_scenario_id="data_analysis.statistical_inference",
        prompt="Audit oscillator identification residual series and calculate 95% confidence bounds",
        input_artifacts=[
            {
                "holdout_rmse": 0.0046,
                "residuals": [rng.gauss(0, 0.002) for _ in range(40)],
                "parameter_estimates": {"m": 1.4915, "c": 0.3981, "k": 2.7856},
            }
        ],
        inherited_budget={"max_model_calls": 2, "max_tool_calls": 2, "remaining_deadline_ms": 5000},
        recursion_depth=1,
    )

    result = coordinator.delegate(task)

    assert result.status == "COMPLETED"
    assert result.target_scenario_id == "data_analysis.statistical_inference"
    assert result.candidate_verified is False  # Invariant: collaborative artifact is not pre-verified
    assert len(result.returned_artifacts) == 1

    artifact = result.returned_artifacts[0]
    assert artifact["artifact_kind"] == "COLLABORATIVE_UNCERTAINTY_EVALUATION"
    assert artifact["diagnosis"] == "RESIDUAL_WHITE"
    assert artifact["is_uncertainty_acceptable"] is True
    assert artifact["confidence_interval_95"][0] < 0 < artifact["confidence_interval_95"][1]
    assert result.consumed_budget["model_calls"] == 0
    assert result.consumed_budget["tool_calls"] == 1


def test_e13_blocks_infinite_recursion_depth():
    coordinator = CrossScenarioDelegator(max_depth=1)
    task = CollaborationTask(
        task_id="collab_recursive_002",
        parent_run_id="run_parent_1",
        initiating_scenario_id="control.identification",
        target_scenario_id="data_analysis.statistical_inference",
        prompt="Recursive delegation test",
        inherited_budget={"max_model_calls": 2, "max_tool_calls": 2, "remaining_deadline_ms": 5000},
        recursion_depth=2,  # Exceeds max_depth=1
    )

    with pytest.raises(CrossScenarioDelegationRefused) as excinfo:
        coordinator.delegate(task)

    assert "exceeds max permitted depth" in str(excinfo.value)


def test_e13_handles_exhausted_inherited_budget():
    coordinator = CrossScenarioDelegator(max_depth=1)
    task = CollaborationTask(
        task_id="collab_budget_exhausted_003",
        parent_run_id="run_parent_2",
        initiating_scenario_id="control.identification",
        target_scenario_id="data_analysis.statistical_inference",
        prompt="Audit with zero deadline",
        inherited_budget={"max_model_calls": 1, "max_tool_calls": 1, "remaining_deadline_ms": 0},
        recursion_depth=1,
    )

    result = coordinator.delegate(task)

    assert result.status == "FAILED"
    assert result.consumed_budget["model_calls"] == 0
    assert result.consumed_budget["tool_calls"] == 0
    assert result.candidate_verified is False
    assert "exhausted" in result.returned_artifacts[0]["error"].lower()


def test_e13_rejects_unregistered_scenario():
    coordinator = CrossScenarioDelegator(max_depth=1)
    task = CollaborationTask(
        task_id="collab_unregistered_004",
        parent_run_id="run_parent_3",
        initiating_scenario_id="control.identification",
        target_scenario_id="biology.crispr_editing",  # Not registered
        prompt="Perform off-target guide design",
        inherited_budget={"max_model_calls": 2, "max_tool_calls": 2, "remaining_deadline_ms": 5000},
        recursion_depth=1,
    )

    result = coordinator.delegate(task)

    assert result.status == "FAILED"
    assert result.consumed_budget["model_calls"] == 0
    assert result.candidate_verified is False
    assert "not registered" in result.returned_artifacts[0]["error"].lower()
