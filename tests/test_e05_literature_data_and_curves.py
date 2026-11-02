"""Tests for E05: Research datasets, versioning, academic literature search, and scientific curve quality audit."""

import json
from pathlib import Path
import tempfile
import pytest

from python.astra_web.data_versioning import DataVersionManager
from python.astra_web.literature_client import SemanticScholarClient
from python.astra_web.scientific_curve_parser import (
    ScientificCurveParser,
    AxisCalibration,
)


def test_e05_data_versioning_and_invalidation():
    with tempfile.TemporaryDirectory() as tmpdir:
        storage_root = Path(tmpdir)
        mgr = DataVersionManager(storage_root)

        # 1. Register v1 dataset
        payload_v1 = {"parameters": {"alpha": 0.05, "L": 1.0}}
        ds_rec = mgr.register_dataset("pde_heat_v1", payload_v1, "Initial heat simulation dataset")
        assert ds_rec["version"] == 1
        assert ds_rec["datasetId"] == "pde_heat_v1"

        # 2. Register dependent artifact
        art_rec = mgr.register_artifact(
            artifact_id="art_heat_sim_01",
            dataset_id="pde_heat_v1",
            dataset_version=1,
            content={"output": "simulation output data"},
            kind="EXPERIMENT_REPORT",
        )
        assert art_rec["status"] == "ACTIVE"

        # 3. Update dataset to v2
        payload_v2 = {"parameters": {"alpha": 0.08, "L": 1.0}}
        ds_v2 = mgr.update_dataset("pde_heat_v1", payload_v2, "Refined thermal conductivity")
        assert ds_v2["newVersion"] == 2
        assert ds_v2["invalidatedArtifactsCount"] == 1

        # 4. Invalidation check: downstream artifact must become STALE
        assert mgr._state["artifacts"]["art_heat_sim_01"]["status"] == "STALE"


def test_e05_literature_search_and_t35_doubt():
    client = SemanticScholarClient()
    # Mocking urllib urlopen with realistic academic paper payload
    fake_api_data = {
        "total": 2,
        "data": [
            {
                "paperId": "p12345",
                "title": "Parameter Identification of Forced Damped Oscillators",
                "year": 2024,
                "authors": [{"name": "A. Euler"}, {"name": "J. Lagrange"}],
                "abstract": "We investigate parameter estimation under noise...",
                "openAccessPdf": {"status": "OPEN", "url": "https://example.org/p12345.pdf"},
            },
            {
                "paperId": "p67890",
                "title": "Closed Access Finite Difference Thermal Study",
                "year": 2025,
                "authors": [{"name": "J. Fourier"}],
                "abstract": "Thermal diffusion across boundary layers...",
                "openAccessPdf": {"status": "CLOSED", "url": None},
            },
        ],
    }

    import unittest.mock as mock
    with mock.patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = json.dumps(fake_api_data).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        res = client.search("forced damped oscillator", limit=2)
        assert res["totalHits"] == 2
        papers = res["papers"]
        assert len(papers) == 2

        # Paper 1 has full open access
        assert papers[0]["hasPdfAccess"] is True
        assert papers[0]["auditDoubt"] is None

        # Paper 2 is closed access -> must explicitly log T35 doubt code
        assert papers[1]["hasPdfAccess"] is False
        assert papers[1]["auditDoubt"]["code"] == "T35_PDF_ACCESS_UNCERTAIN"


def test_e05_scientific_curve_parsing_and_quality_audit():
    parser = ScientificCurveParser()

    calibration = AxisCalibration(
        x_name="time",
        x_unit="s",
        x_min=0.0,
        x_max=1.0,
        y_name="displacement",
        y_unit="m",
        y_min=-1.0,
        y_max=1.0,
    )

    # 1. Ground-truth curve: y = sin(2*pi*t)
    import math
    n_points = 50
    t_vals = [i / (n_points - 1) for i in range(n_points)]
    true_points = [(t, math.sin(2 * math.pi * t)) for t in t_vals]

    # Simulated extracted points with minor noise (sigma ~ 0.005)
    import random
    random.seed(42)
    extracted_points = [(t, y + random.gauss(0, 0.005)) for t, y in true_points]

    res = parser.parse_curve_trace("chart_fig_1", extracted_points, calibration)
    assert res.status == "EXTRACTED"
    assert len(res.data_points) == n_points
    assert len(res.uncertainty_envelope) == n_points
    assert res.estimated_noise_sigma < 0.015

    # 2. Independent audit against ground-truth reference points
    audit = parser.verify_against_reference(res, true_points, max_tolerable_rmse=0.02, min_tolerable_r2=0.98)
    assert audit["verified"] is True
    assert audit["r2"] > 0.99
    assert audit["rmse"] < 0.01


def test_e05_scientific_curve_fail_closed_on_ambiguity_and_low_res():
    parser = ScientificCurveParser()

    # Ambiguous axis
    ambiguous_cal = AxisCalibration(
        x_name="t?",
        x_unit="unknown",
        x_min=0.0,
        x_max=1.0,
        y_name="y?",
        y_unit="unknown",
        y_min=0.0,
        y_max=1.0,
        is_ambiguous=True,
        ambiguity_reason="Axis tick values illegible",
    )
    res_ambiguous = parser.parse_curve_trace("chart_fig_bad", [(0.1, 0.2), (0.2, 0.3)], ambiguous_cal)
    assert res_ambiguous.status == "UNCERTAIN_AMBIGUOUS_AXIS"
    assert res_ambiguous.quality_audit["passed"] is False

    # Insufficient resolution (only 3 points)
    clear_cal = AxisCalibration("t", "s", 0.0, 1.0, "y", "m", 0.0, 1.0)
    res_low_res = parser.parse_curve_trace("chart_low_res", [(0.1, 0.2), (0.2, 0.3), (0.3, 0.4)], clear_cal, min_required_points=10)
    assert res_low_res.status == "RESOLUTION_INSUFFICIENT"
    assert res_low_res.quality_audit["passed"] is False
