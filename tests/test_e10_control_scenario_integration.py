"""E10: Dynamics & Control Full Scenario Integration & Parameter Estimation Test.

Verifies:
1. CONTROL_SCENARIO_CONTRACT metadata and schema conformance.
2. Ingestion and parameter identification on forced damped oscillator data.
3. Physical validity: mass > 0, damping > 0, stiffness > 0.
4. Independent holdout prediction: RMSE < 0.05.
5. Invariant I15: candidate_verified remains False.
6. Data leakage protection: train/validation partition audited (T36).
"""
from __future__ import annotations

import json
from pathlib import Path
import pytest

from python.astra_bridge.scenario_contracts import CONTROL_SCENARIO_CONTRACT
from python.astra_web.solver_adapter import SolverAdapter


def test_e10_contract_specification():
    """Verify CONTROL_SCENARIO_CONTRACT manifest, inputs, and results."""
    manifest = CONTROL_SCENARIO_CONTRACT.manifest
    assert manifest.scenario_id == "control.identification"
    assert manifest.domain_type == "engineering_control"
    assert "SYSTEM_IDENTIFICATION" in manifest.goals
    assert "INDEPENDENT_PREDICTION" in manifest.goals
    assert manifest.requires_code_isolation is True

    inputs = CONTROL_SCENARIO_CONTRACT.inputs
    assert inputs.input_kind == "TIMESERIES_DATA"
    assert ".csv" in inputs.supported_extensions

    results = CONTROL_SCENARIO_CONTRACT.results
    assert results.primary_artifact_kind == "DYNAMICS_IDENTIFICATION_PACK"
    assert "holdoutRmse" in results.required_metrics


def test_e10_real_sample_exists():
    """Verify standard benchmark sample exists and has valid time series structure."""
    sample_path = Path(__file__).resolve().parent.parent / "data" / "benchmarks" / "control" / "oscillator_real_sample.csv"
    assert sample_path.is_file(), f"Missing benchmark sample: {sample_path}"

    lines = sample_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 100, f"Expected at least 100 sample rows, got {len(lines)}"
    header = lines[0].split(",")
    assert any("time" in h or h == "t" for h in header)
    assert any("u" in h for h in header)
    assert any("x" in h or "displacement" in h for h in header)


def test_e10_solver_identification_and_holdout():
    """Verify real numerical identification pipeline executes with honest metrics."""
    adapter = SolverAdapter(client_factory=lambda: None)
    problem = "辨识非线性阻尼受迫振子质量阻尼刚度三参数 (m=1.5, c=0.4, k=2.8)"
    run_payload = {
        "run_id": "run_ctl_e10_verify_001",
        "domain_id": "control.identification",
        "problem": problem,
        "metadata": {"allowSyntheticData": True},
    }

    result = adapter._solve_control(problem, run_payload)
    assert result["status"] == "candidate"
    assert result["executed"] is True
    # Invariant I15
    assert result["candidate_verified"] is False

    details = json.loads(result["final_response"])
    assert details["domainId"] == "control.identification"
    assert details["targetSystem"] == "forced_damped_oscillator"

    # Physical validity: parameters must be strictly positive
    params = details["parameters"]
    assert params["mass"] > 0, "Mass must be positive"
    assert params["damping"] > 0, "Damping must be positive"
    assert params["stiffness"] > 0, "Stiffness must be positive"

    # Precision check against target (m=1.5, c=0.4, k=2.8)
    assert abs(params["mass"] - 1.5) < 0.1
    assert abs(params["damping"] - 0.4) < 0.1
    assert abs(params["stiffness"] - 2.8) < 0.15

    # Holdout independent validation
    holdout = details["holdoutValidation"]
    assert holdout["passed"] is True
    assert holdout["holdoutRmse"] < 0.05, f"Holdout RMSE {holdout['holdoutRmse']} exceeded 0.05"

    # Data leakage check
    leakage = details["leakageGuard"]
    assert leakage["leakageDetected"] is False
    assert leakage["trainSamplesCount"] > 0
    assert leakage["valSamplesCount"] > 0
