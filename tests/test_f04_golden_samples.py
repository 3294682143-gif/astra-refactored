"""Verification test suite for F-04 Golden Case Samples across all domains."""

import csv
import json
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = REPO_ROOT / "samples"


def test_f04_golden_sample_directory_structure():
    assert SAMPLES_DIR.is_dir(), f"Samples dir missing at {SAMPLES_DIR}"

    required_domains = ["math", "control", "data_analysis", "scientific_computing"]
    for dom in required_domains:
        dom_path = SAMPLES_DIR / dom
        assert dom_path.is_dir(), f"Domain folder missing: {dom_path}"

        # Standard required files
        assert (dom_path / "problem.json").is_file(), f"problem.json missing in {dom}"
        assert (dom_path / "input_spec.json").is_file(), f"input_spec.json missing in {dom}"
        assert (dom_path / "expected_output.json").is_file(), f"expected_output.json missing in {dom}"
        assert (dom_path / "replay_package.json").is_file(), f"replay_package.json missing in {dom}"


def test_f04_math_golden_sample_integrity():
    math_dir = SAMPLES_DIR / "math"
    prob = json.loads((math_dir / "problem.json").read_text(encoding="utf-8"))
    assert prob["domainId"] == "math"
    assert "polynomial" in prob

    spec = json.loads((math_dir / "input_spec.json").read_text(encoding="utf-8"))
    assert spec["type"] == "object"
    assert "rawText" in spec["required"]

    exp = json.loads((math_dir / "expected_output.json").read_text(encoding="utf-8"))
    assert exp["status"] == "candidate"
    assert exp["candidateVerified"] is False
    assert exp["expectedResults"]["roots"] == [2.0, 3.0]


def test_f04_control_golden_sample_timeseries_and_integrity():
    ctrl_dir = SAMPLES_DIR / "control"
    csv_file = ctrl_dir / "input_timeseries.csv"
    assert csv_file.is_file(), "input_timeseries.csv missing in control"

    with open(csv_file, "r", encoding="utf-8") as f:
        reader = list(csv.reader(f))
    assert len(reader) > 500, f"Timeseries too short: {len(reader)} rows"
    header = reader[0]
    assert header == ["timestamp", "u", "x", "v"]

    # Verify numerical conversion
    first_row = [float(v) for v in reader[1]]
    assert len(first_row) == 4

    exp = json.loads((ctrl_dir / "expected_output.json").read_text(encoding="utf-8"))
    assert exp["candidateVerified"] is False
    ranges = exp["expectedParameterRanges"]
    assert ranges["m"]["expected"] == 1.0
    assert ranges["c"]["expected"] == 0.2
    assert ranges["k"]["expected"] == 1.5


def test_f04_data_analysis_golden_sample_dataset_and_integrity():
    da_dir = SAMPLES_DIR / "data_analysis"
    csv_file = da_dir / "input_dataset.csv"
    assert csv_file.is_file(), "input_dataset.csv missing in data_analysis"

    with open(csv_file, "r", encoding="utf-8") as f:
        reader = list(csv.reader(f))
    assert len(reader) == 101, f"Expected 100 samples + 1 header, got {len(reader)}"
    header = reader[0]
    assert header == ["sample_id", "group", "expression_level"]

    groups = [r[1] for r in reader[1:]]
    assert groups.count("control") == 50
    assert groups.count("treatment") == 50

    exp = json.loads((da_dir / "expected_output.json").read_text(encoding="utf-8"))
    assert exp["candidateVerified"] is False
    assert exp["expectedStatRanges"]["isSignificant"] is True


def test_f04_scicomp_golden_sample_integrity():
    sci_dir = SAMPLES_DIR / "scientific_computing"
    exp = json.loads((sci_dir / "expected_output.json").read_text(encoding="utf-8"))
    assert exp["domainId"] == "scientific_computing"
    assert exp["scheme"] == "forward_euler_finite_difference"
    assert exp["candidateVerified"] is False
    ranges = exp["expectedConvergenceRanges"]
    assert ranges["observedOrder"]["expected"] == 2.0
    assert ranges["cflMax"]["max"] <= 0.5


def test_f04_offline_replay_package_compatibility():
    """Verify all golden sample replay_package.json files are compliant with /runs/{id}/replay."""
    for dom in ["math", "control", "data_analysis", "scientific_computing"]:
        replay_path = SAMPLES_DIR / dom / "replay_package.json"
        pkg = json.loads(replay_path.read_text(encoding="utf-8"))

        assert "replayVersion" in pkg
        assert "runId" in pkg
        assert "domainId" in pkg
        assert "recordedResult" in pkg
        assert pkg["isDeterministic"] is True
        assert pkg["recordedResult"]["candidateVerified"] is False
