"""E11: Scientific Computing (Thermal Physics Numerical PDE) Full Scenario Integration Test.

Verifies:
1. SCI_COMPUTING_SCENARIO_CONTRACT metadata and schema conformance.
2. Ingestion of heat transfer benchmark sample.
3. Second-order spatial convergence rate via Richardson extrapolation (~2.0).
4. CFL stability condition verification (dt <= dx^2 / (2*alpha)).
5. Fault injection detection: CFL violation and missing Dirichlet boundary conditions.
6. Invariant I15: candidate_verified remains False.
"""
from __future__ import annotations

import json
from pathlib import Path
import pytest

from python.astra_bridge.scenario_contracts import SCI_COMPUTING_SCENARIO_CONTRACT
from python.astra_web.solver_adapter import SolverAdapter


def test_e11_contract_specification():
    """Verify SCI_COMPUTING_SCENARIO_CONTRACT manifest, inputs, and results."""
    manifest = SCI_COMPUTING_SCENARIO_CONTRACT.manifest
    assert manifest.scenario_id == "scientific_computing.heat_transfer"
    assert manifest.domain_type == "computational_science"
    assert "NUMERICAL_EXPERIMENT" in manifest.goals
    assert manifest.requires_code_isolation is True

    inputs = SCI_COMPUTING_SCENARIO_CONTRACT.inputs
    assert inputs.input_kind == "PDE_EXPERIMENT_SPEC"
    assert ".csv" in inputs.supported_extensions

    results = SCI_COMPUTING_SCENARIO_CONTRACT.results
    assert results.primary_artifact_kind == "THERMAL_SIMULATION_PACK"
    assert "observedConvergenceOrder" in results.required_metrics


def test_e11_benchmark_sample_exists():
    """Verify benchmark sample data/benchmarks/scientific_computing/heat_rod_experimental_sample.csv exists."""
    sample_path = (
        Path(__file__).resolve().parent.parent
        / "data"
        / "benchmarks"
        / "scientific_computing"
        / "heat_rod_experimental_sample.csv"
    )
    assert sample_path.is_file(), f"Missing benchmark sample: {sample_path}"

    lines = sample_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) >= 50
    header = lines[0].split(",")
    assert any("x" in h for h in header)
    assert any("t" in h for h in header)
    assert any("temp" in h.lower() or "u" in h.lower() for h in header)


def test_e11_solver_convergence_and_cfl_stability():
    """Verify PDE numerical solver achieves second-order convergence and validates CFL."""
    adapter = SolverAdapter(client_factory=lambda: None)
    problem = "数值求解一维导热方程 alpha=0.05, tFinal=0.2"
    run_payload = {
        "run_id": "run_pde_e11_verify_001",
        "domain_id": "scientific_computing",
        "problem": problem,
        "metadata": {"allowSyntheticData": True},
    }

    result = adapter._solve_scientific_computing(problem, run_payload)
    assert result["status"] == "candidate"
    assert result["executed"] is True
    assert result["candidate_verified"] is False

    details = result["details"]
    assert details["domainId"] == "scientific_computing"

    # Richardson extrapolation observed spatial order should be ~2.0
    observed_order = details["observedOrder"]
    assert 1.8 <= observed_order <= 2.2, f"Expected second-order convergence (~2.0), got {observed_order}"

    # CFL stability
    cfl = details["cflDiagnosis"]
    assert cfl["isStable"] is True
    assert cfl["maxCfl"] <= 0.5, f"CFL number {cfl['maxCfl']} exceeded stability threshold 0.5"

    # Boundary Dirichlet match
    boundary = details["boundaryDiagnosis"]
    assert boundary["dirichletMatched"] is True
    assert details["allObligationsMet"] is True


def test_e11_fault_injection_diagnostics():
    """Verify CFL violation and missing boundary faults are caught honestly."""
    adapter = SolverAdapter(client_factory=lambda: None)

    # 1. CFL violation fault
    res_cfl = adapter._solve_scientific_computing(
        "数值求解一维导热方程 alpha=0.05 CFL违例",
        {"run_id": "run_cfl_fault", "metadata": {"allowSyntheticData": True}},
    )
    assert res_cfl["details"]["allObligationsMet"] is False
    assert res_cfl["details"]["cflDiagnosis"]["isStable"] is False

    # 2. Missing boundary fault
    res_bnd = adapter._solve_scientific_computing(
        "数值求解一维导热方程 遗漏边界",
        {"run_id": "run_bnd_fault", "metadata": {"allowSyntheticData": True}},
    )
    assert res_bnd["details"]["allObligationsMet"] is False
    assert res_bnd["details"]["boundaryDiagnosis"]["dirichletMatched"] is False
