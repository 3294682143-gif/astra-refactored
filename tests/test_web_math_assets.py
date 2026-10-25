from __future__ import annotations

from python.astra_bridge.generated.math_assets import MATH_ASSETS
from python.astra_web.app import create_app
from python.astra_web.math_assets_catalog import detail_payload, summary_payload
from starlette.testclient import TestClient


def test_catalog_summary_comes_from_single_canonical_source():
    payload = summary_payload()
    assert payload["assetCount"] == 26
    assert payload["computationBehaviorCount"] == 82
    assert payload["guidanceOnlyCount"] == 4
    assert len(payload["catalogDigest"]) == 64
    assert {row["assetId"] for row in payload["assets"]} == {
        row["assetId"] for row in MATH_ASSETS
    }
    behavior_pairs = {
        (asset["assetId"], behavior["target"])
        for asset in MATH_ASSETS
        for behavior in asset.get("behaviors", [])
    }
    assert len(behavior_pairs) == 82


def test_every_asset_detail_is_available_and_guidance_only_is_valid():
    for asset in MATH_ASSETS:
        detail = detail_payload(asset["assetId"])
        assert detail is not None
        assert detail["assetId"] == asset["assetId"]
        assert detail["guidanceOnly"] is (len(asset.get("behaviors", [])) == 0)
        assert set(detail["instructions"]) == {
            "conditions", "procedure", "misuse", "verificationBoundary"
        }
    assert detail_payload("math.proof")["guidanceOnly"] is True
    assert detail_payload("math.linear-algebra")["behaviors"]
    assert detail_payload("math.not-real") is None


def test_http_catalog_and_runtime_info(tmp_path):
    app = create_app(data_root=tmp_path / "data", mount_static=False)
    with TestClient(app) as client:
        summary = client.get("/api/math-assets")
        assert summary.status_code == 200
        body = summary.json()
        assert body["assetCount"] == 26
        assert body["computationBehaviorCount"] == 82
        assert body["guidanceOnlyCount"] == 4

        item = client.get("/api/math-assets/math.linear-algebra")
        assert item.status_code == 200
        assert {row["target"] for row in item.json()["behaviors"]} == {
            "gf2_rank", "gf2_nullspace", "solution_set", "maximal_minors"
        }
        missing = client.get("/api/math-assets/math.not-real")
        assert missing.status_code == 404

        info = client.get("/api/runtime-info")
        assert info.status_code == 200
        assert info.json()["protocolVersion"] == "1.4-unified-math-assets"
        assert info.json()["catalogAvailable"] is True
        assert info.json()["solverConfigured"] is False
