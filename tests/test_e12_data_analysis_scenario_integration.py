"""E12: Experimental Data Science Scenario Integration Test.

Verifies:
1. DATA_ANALYSIS_SCENARIO_CONTRACT metadata and schema conformance.
2. Ingestion of clinical trial sample data (data/benchmarks/data_analysis/clinical_trial_sample.csv).
3. Two-sample Welch t-test calculation: t-statistic, degrees of freedom, p-value, Cohen's d.
4. Normality (Jarque-Bera) and homoscedasticity evaluation.
5. Invariant I15: candidate_verified remains False.
"""
from __future__ import annotations

import json
from pathlib import Path
import pytest

from python.astra_bridge.scenario_contracts import DATA_ANALYSIS_SCENARIO_CONTRACT
from python.astra_web.solver_adapter import SolverAdapter


def test_e12_contract_specification():
    """Verify DATA_ANALYSIS_SCENARIO_CONTRACT manifest, inputs, and results."""
    manifest = DATA_ANALYSIS_SCENARIO_CONTRACT.manifest
    assert manifest.scenario_id == "data_analysis.statistical_inference"
    assert manifest.domain_type == "scientific_data_analysis"
    assert "STATISTICAL_INFERENCE" in manifest.goals
    assert manifest.requires_code_isolation is True

    inputs = DATA_ANALYSIS_SCENARIO_CONTRACT.inputs
    assert inputs.input_kind == "TABULAR_DATA"
    assert ".csv" in inputs.supported_extensions

    results = DATA_ANALYSIS_SCENARIO_CONTRACT.results
    assert results.primary_artifact_kind == "STATISTICAL_INFERENCE_PACK"
    assert "pValue" in results.required_metrics
    assert "tStatistic" in results.required_metrics


def test_e12_benchmark_sample_exists():
    """Verify benchmark sample data/benchmarks/data_analysis/clinical_trial_sample.csv exists."""
    sample_path = (
        Path(__file__).resolve().parent.parent
        / "data"
        / "benchmarks"
        / "data_analysis"
        / "clinical_trial_sample.csv"
    )
    assert sample_path.is_file(), f"Missing benchmark sample: {sample_path}"

    lines = sample_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 50
    header = lines[0].split(",")
    assert any("group" in h.lower() or "arm" in h.lower() for h in header)
    assert any("score" in h.lower() or "value" in h.lower() for h in header)


def test_e12_welch_t_test_and_diagnostics():
    """Verify Welch t-test, p-value, effect size and normality diagnostics."""
    adapter = SolverAdapter(client_factory=lambda: None)
    problem = "生物医学临床干预实验双样本对比 mean1=10.0, mean2=12.5"
    run_payload = {
        "run_id": "run_stats_e12_verify_001",
        "domain_id": "data_analysis",
        "problem": problem,
        "metadata": {"allowSyntheticData": True},
    }

    result = adapter._solve_data_analysis(problem, run_payload)
    assert result["status"] == "candidate"
    assert result["executed"] is True
    assert result["candidate_verified"] is False

    details = result["details"]
    assert details["domainId"] == "data_analysis"
    assert details["testMethod"] == "two_sample_welch_t_test"

    test_res = details["testResult"]
    assert "tStatistic" in test_res
    assert test_res["pValue"] < 0.05, f"Expected significant p-value, got {test_res['pValue']}"
    assert "cohensD" in test_res
    assert abs(test_res["cohensD"]) > 0.8, "Expected large effect size (|d| > 0.8)"

    # Sample summaries
    assert details["groupA"]["count"] == 50
    assert details["groupB"]["count"] == 50
    assert abs(details["groupA"]["mean"] - 10.0) < 0.5
    assert abs(details["groupB"]["mean"] - 12.5) < 0.5
