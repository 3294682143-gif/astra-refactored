"""Read-only Web projection of the single canonical math-assets catalog.

No second catalog is maintained here. The projection is built from the same
generated view (and therefore the same canonical JSON digest) as the Host.
"""
from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

from python.astra_bridge.generated.math_assets import (
    MATH_ASSET_CATALOG_DIGEST,
    MATH_ASSET_CATALOG_VERSION,
    MATH_ASSET_SCHEMA_VERSION,
    MATH_ASSETS,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG_PATH = REPO_ROOT / "mathagent" / "resources" / "math-assets.json"


class CatalogUnavailable(RuntimeError):
    """The canonical catalog or its generated view is missing or drifted."""


@lru_cache(maxsize=1)
def _verified_catalog() -> tuple[dict[str, dict[str, Any]], str]:
    if not CATALOG_PATH.is_file():
        raise CatalogUnavailable("canonical math-assets.json is missing")
    raw = CATALOG_PATH.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != MATH_ASSET_CATALOG_DIGEST:
        raise CatalogUnavailable(
            "canonical catalog digest does not match the generated Host view"
        )
    by_id: dict[str, dict[str, Any]] = {}
    for asset in MATH_ASSETS:
        asset_id = asset.get("assetId")
        if not isinstance(asset_id, str) or not asset_id:
            raise CatalogUnavailable("canonical catalog contains an invalid assetId")
        by_id[asset_id] = dict(asset)
    return by_id, digest


def summary_payload() -> dict[str, Any]:
    by_id, digest = _verified_catalog()
    assets = list(by_id.values())
    behavior_count = sum(len(asset.get("behaviors", [])) for asset in assets)
    rows = [
        {
            "assetId": asset["assetId"],
            "name": asset.get("name", asset["assetId"]),
            "version": asset.get("version", "1.0.0"),
            "summary": asset.get("summary", ""),
            "behaviorCount": len(asset.get("behaviors", [])),
            "targets": [
                behavior.get("target") for behavior in asset.get("behaviors", [])
            ],
            "guidanceOnly": len(asset.get("behaviors", [])) == 0,
        }
        for asset in sorted(assets, key=lambda row: row["assetId"])
    ]
    return {
        "schemaVersion": MATH_ASSET_SCHEMA_VERSION,
        "catalogVersion": MATH_ASSET_CATALOG_VERSION,
        "catalogDigest": digest,
        "assetCount": len(rows),
        "computationBehaviorCount": behavior_count,
        "guidanceOnlyCount": sum(1 for row in rows if row["guidanceOnly"]),
        "assets": rows,
    }


def detail_payload(asset_id: str) -> dict[str, Any] | None:
    by_id, digest = _verified_catalog()
    asset = by_id.get(asset_id)
    if asset is None:
        return None
    instructions = asset.get("instructions") or {}
    behaviors = []
    for behavior in asset.get("behaviors", []):
        behaviors.append(
            {
                "target": behavior.get("target"),
                "declaredScope": behavior.get("declaredScope", ""),
                "requiredParams": list(behavior.get("requiredParams", [])),
                "optionalParams": list(behavior.get("optionalParams", [])),
                "resultType": behavior.get("resultType", ""),
                "evidenceCeiling": behavior.get("evidenceCeiling", ""),
            }
        )
    return {
        "schemaVersion": MATH_ASSET_SCHEMA_VERSION,
        "catalogVersion": MATH_ASSET_CATALOG_VERSION,
        "catalogDigest": digest,
        "assetId": asset["assetId"],
        "name": asset.get("name", asset["assetId"]),
        "version": asset.get("version", "1.0.0"),
        "summary": asset.get("summary", ""),
        "guidanceOnly": len(behaviors) == 0,
        "instructions": {
            "conditions": list(instructions.get("conditions", [])),
            "procedure": list(instructions.get("procedure", [])),
            "misuse": list(instructions.get("misuse", [])),
            "verificationBoundary": instructions.get("verificationBoundary", ""),
        },
        "behaviors": behaviors,
        "examples": asset.get("examples", {}),
        "inputSchema": asset.get("inputSchema"),
    }


def runtime_info(solver_configured: bool) -> dict[str, Any]:
    try:
        summary = summary_payload()
        available = True
        error = None
    except CatalogUnavailable as exc:
        summary = {}
        available = False
        error = str(exc)
    return {
        "service": "astra-web-bff",
        "protocolVersion": "1.4-unified-math-assets",
        "catalogAvailable": available,
        "catalogError": error,
        "catalogVersion": summary.get("catalogVersion"),
        "catalogDigest": summary.get("catalogDigest"),
        "assetCount": summary.get("assetCount"),
        "computationBehaviorCount": summary.get("computationBehaviorCount"),
        "solverConfigured": solver_configured,
        "nodeVersion": "v24.17.0",
        "commitHash": "3ea58190144b82d0e707c04ca52921a3019182be",
    }


__all__ = [
    "CatalogUnavailable",
    "summary_payload",
    "detail_payload",
    "runtime_info",
]
