"""Tests for E02: Scenario contracts, team mappings, benchmark datasets, and scientific acceptance matrix."""

import json
from pathlib import Path
import pandas as pd
import pytest

from python.astra_bridge.scenario_contracts import (
    ALL_SCENARIO_CONTRACTS,
    MATH_SCENARIO_CONTRACT,
    CONTROL_SCENARIO_CONTRACT,
    SCI_COMPUTING_SCENARIO_CONTRACT,
    DATA_ANALYSIS_SCENARIO_CONTRACT,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_DIR = REPO_ROOT / "data" / "benchmarks"


def test_e02_scenario_contracts_integrity():
    assert len(ALL_SCENARIO_CONTRACTS) == 4
    expected_ids = {
        "math.research",
        "control.identification",
        "scientific_computing.heat_transfer",
        "data_analysis.statistical_inference",
    }
    assert set(ALL_SCENARIO_CONTRACTS.keys()) == expected_ids

    for sid, contract in ALL_SCENARIO_CONTRACTS.items():
        assert contract.manifest.scenario_id == sid
        assert len(contract.manifest.goals) >= 2
        assert len(contract.team.roles) >= 4

        # Check category distribution
        categories = {r.role_category for r in contract.team.roles}
        assert "PLANNER" in categories
        assert "WORKER" in categories
        assert "REVIEWER" in categories

        # Validate input & output contracts
        assert len(contract.inputs.required_fields) >= 1
        assert len(contract.results.exported_file_names) >= 1


def test_e02_control_benchmark_data_and_metadata():
    ctl_dir = BENCHMARK_DIR / "control"
    assert ctl_dir.is_dir()

    meta_file = ctl_dir / "metadata.json"
    assert meta_file.is_file()
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert meta["samplingFrequencyHz"] == 100.0
    assert meta["antiAliasingPassed"] is True

    csv_file = ctl_dir / "oscillator_real_sample.csv"
    assert csv_file.is_file()
    df = pd.read_csv(csv_file)
    assert len(df) >= 50
    assert "time_s" in df.columns
    assert "excitation_u_N" in df.columns
    assert "measured_displacement_x_m" in df.columns

    # Verify physics bounds: time monotonic, displacement finite
    assert df["time_s"].is_monotonic_increasing
    assert not df["measured_displacement_x_m"].isna().any()


def test_e02_thermal_benchmark_data_and_metadata():
    sci_dir = BENCHMARK_DIR / "scientific_computing"
    assert sci_dir.is_dir()

    meta_file = sci_dir / "metadata.json"
    assert meta_file.is_file()
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert meta["thermalDiffusivityAlpha"] == 0.05
    assert meta["rodLengthMeters"] == 1.0

    csv_file = sci_dir / "heat_rod_experimental_sample.csv"
    assert csv_file.is_file()
    df = pd.read_csv(csv_file)
    assert len(df) >= 50
    assert "time_s" in df.columns
    assert "position_x_m" in df.columns
    assert "temperature_degC" in df.columns

    # Verify boundary condition adherence: at x=0, T should be close to 100
    at_x0 = df[df["position_x_m"] == 0.0]
    assert len(at_x0) > 0
    assert (at_x0["temperature_degC"] == 100.0).all()


def test_e02_data_analysis_benchmark_data_and_metadata():
    da_dir = BENCHMARK_DIR / "data_analysis"
    assert da_dir.is_dir()

    meta_file = da_dir / "metadata.json"
    assert meta_file.is_file()
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert meta["groupColumn"] == "group"
    assert meta["valueColumn"] == "score_change"

    csv_file = da_dir / "clinical_trial_sample.csv"
    assert csv_file.is_file()
    df = pd.read_csv(csv_file)
    assert len(df) == 70
    assert set(df["group"].unique()) == {"Control", "Treatment"}
    assert "subject_id" in df.columns
    assert "score_change" in df.columns


def test_e02_scientific_acceptance_matrix():
    matrix_file = BENCHMARK_DIR / "acceptance_matrix.json"
    assert matrix_file.is_file()
    matrix = json.loads(matrix_file.read_text(encoding="utf-8"))

    assert matrix["matrixVersion"] == "1.1.0-current-source"
    assert len(matrix["domains"]) == 4

    # Every domain must define at least one passing case and one rejection/violation diagnosis case
    for domain_key, domain_spec in matrix["domains"].items():
        assert len(domain_spec["cases"]) >= 2
        states = {c["expectedTerminalState"] for c in domain_spec["cases"]}
        assert "ACCEPTED_WITHIN_SCOPE" in states
        assert ("CORRECT_REJECTION" in states or "REFUTED" in states)
