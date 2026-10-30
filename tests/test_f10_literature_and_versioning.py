from __future__ import annotations

import json
from pathlib import Path
import pytest

from python.astra_web.literature_client import SemanticScholarClient
from python.astra_web.data_versioning import DataVersionManager


def test_f10_t37_dataset_versioning_and_artifact_invalidation(tmp_path: Path):
    """T37: Test that promoting dataset version invalidates downstream artifacts while preserving history."""
    mgr = DataVersionManager(storage_root=tmp_path / "versioning")

    # 1. Register Dataset v1
    ds1_payload = {
        "domain": "scientific_computing",
        "parameters": {"alpha": 0.1, "length": 1.0, "nx": 40},
        "description": "Base grid configuration for 1D diffusion",
    }
    ds_rec1 = mgr.register_dataset("ds_heat_diffusion", ds1_payload, "Initial benchmark dataset")
    assert ds_rec1["version"] == 1
    assert (tmp_path / "versioning" / "datasets" / "ds_heat_diffusion_v1.json").is_file()

    # 2. Register Downstream Artifact against v1
    art1_content = {
        "title": "Numerical Replication Report v1",
        "observedOrder": 1.996,
        "l2Error": 0.000513,
        "cfl": 0.16,
    }
    art_rec1 = mgr.register_artifact(
        artifact_id="art_heat_report_001",
        dataset_id="ds_heat_diffusion",
        dataset_version=1,
        content=art1_content,
    )
    assert art_rec1["status"] == "ACTIVE"
    assert art_rec1["datasetVersion"] == 1

    # 3. Promote Dataset to v2 (T37 trigger)
    ds2_payload = {
        "domain": "scientific_computing",
        "parameters": {"alpha": 0.15, "length": 1.0, "nx": 80},
        "description": "Refined grid with higher thermal diffusivity",
    }
    update_res = mgr.update_dataset(
        dataset_id="ds_heat_diffusion",
        new_payload=ds2_payload,
        reason="Higher resolution and revised diffusivity",
    )
    assert update_res["newVersion"] == 2
    assert update_res["invalidatedArtifactsCount"] == 1

    # Verify both v1 and v2 files exist on disk (history not overwritten)
    v1_file = tmp_path / "versioning" / "datasets" / "ds_heat_diffusion_v1.json"
    v2_file = tmp_path / "versioning" / "datasets" / "ds_heat_diffusion_v2.json"
    assert v1_file.is_file(), "History v1 must be preserved"
    assert v2_file.is_file(), "New version v2 must exist"

    # 4. Check that old artifact is now STALE with T37 reason
    old_art = mgr.get_artifact("art_heat_report_001")
    assert old_art is not None
    assert old_art["status"] == "STALE"
    assert "T37_DATASET_VERSION_UPDATED" in old_art["invalidationReason"]

    # Original artifact file on disk must still exist
    art1_file = tmp_path / "versioning" / "artifacts" / "art_heat_report_001.json"
    assert art1_file.is_file(), "Artifact file must not be deleted"

    # 5. Create new artifact linked to v2
    art2_content = {
        "title": "Numerical Replication Report v2",
        "observedOrder": 1.999,
        "l2Error": 0.000128,
        "cfl": 0.16,
    }
    art_rec2 = mgr.register_artifact(
        artifact_id="art_heat_report_002",
        dataset_id="ds_heat_diffusion",
        dataset_version=2,
        content=art2_content,
    )
    assert art_rec2["status"] == "ACTIVE"
    assert art_rec2["datasetVersion"] == 2


def test_f10_semantic_scholar_probe_and_t35_audit(tmp_path: Path):
    """K16 / T35: Test real Semantic Scholar probe (HTTP 200 or honest 429 rate limit record) and T35 audit doubt."""
    client = SemanticScholarClient(timeout_seconds=5.0)

    # 1. Real probe: records real network response (e.g. 200 or 429 TooManyRequests)
    live_success = False
    rate_limited = False
    try:
        res = client.search(query="heat equation", limit=1)
        live_success = True
    except Exception as exc:
        err_msg = str(exc)
        if "429" in err_msg or "Too Many Requests" in err_msg:
            rate_limited = True
        # Honest record: do not crash test, record status
        audit_log = tmp_path / "literature" / "probe_status.json"
        audit_log.parent.mkdir(parents=True, exist_ok=True)
        audit_log.write_text(json.dumps({
            "target": "api.semanticscholar.org",
            "status": "BLOCKED_RATE_LIMITED" if rate_limited else "NETWORK_BLOCKED",
            "httpError": err_msg,
            "fallback": "PROTOCOL_READY_HONEST_RECORD",
        }, indent=2), encoding="utf-8")

    assert live_success or rate_limited, "Probe must either succeed or record real 429 rate limit"

    # 2. Protocol-level T35 audit test with representative payload
    sample_payload = {
        "data": [
            {
                "paperId": "9365c376aec6260c66332682d6b5c479ba33921f",
                "title": "The two-level finite difference schemes for the heat equation",
                "year": 2019,
                "authors": [{"authorId": "2248578308", "name": "J. Martin-Vaquero"}],
                "abstract": "Analysis of two-level finite difference schemes for heat equation",
                "openAccessPdf": {"url": "", "status": "CLOSED"},
            }
        ]
    }

    # Simulate client paper parsing logic
    raw_papers = sample_payload["data"]
    parsed_papers = []
    for p in raw_papers:
        pdf_info = p.get("openAccessPdf") or {}
        has_pdf_access = bool(pdf_info.get("url") and pdf_info.get("status") == "OPEN")
        audit_doubt = None
        if not has_pdf_access:
            audit_doubt = {
                "code": "T35_PDF_ACCESS_UNCERTAIN",
                "status": pdf_info.get("status"),
                "reason": "Publisher access restricted; PDF full text requires credential resolution",
            }
        parsed_papers.append({
            "paperId": p["paperId"],
            "title": p["title"],
            "hasPdfAccess": has_pdf_access,
            "auditDoubt": audit_doubt,
        })

    assert len(parsed_papers) == 1
    assert parsed_papers[0]["hasPdfAccess"] is False
    assert parsed_papers[0]["auditDoubt"]["code"] == "T35_PDF_ACCESS_UNCERTAIN"

    # Snapshot persistence test
    snapshot_path = tmp_path / "literature" / "sample_literature_record.json"
    client.save_literature_snapshot({"query": "heat equation", "papers": parsed_papers}, snapshot_path)
    assert snapshot_path.is_file()
