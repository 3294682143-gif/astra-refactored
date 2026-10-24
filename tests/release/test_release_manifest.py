"""Tests for release manifest and bundle artifact integrity."""

from __future__ import annotations

import json
from pathlib import Path
import pytest

from scripts.build_release_manifest import verify, ROOT


def test_build_manifest_exists_and_verifies():
    manifest_path = ROOT / "release" / "BUILD_MANIFEST.json"
    assert manifest_path.is_file(), "release/BUILD_MANIFEST.json must exist"
    assert verify(manifest_path) == 0, "BUILD_MANIFEST.json must pass strict verification"


def test_build_manifest_contents():
    manifest_path = ROOT / "release" / "BUILD_MANIFEST.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert data["manifestVersion"] == "build-manifest-v1"
    assert data["schemaVersion"] in ("1.4-unified-math-assets", "1.3-agent-loop-preview")
    assert data["precompiled"] is True
    assert data["requiresNpmInstall"] is False
    assert data["requiresRuntimeTsc"] is False

    # Check bundle assets
    bundle = data["bundle"]
    assert "bundle" in bundle
    assert "bundleSchemaV14" in bundle
    assert "bundleMathAssetsSchema" in bundle

    # Check canonical math assets
    assets = data["assets"]
    assert "canonicalMathAssets" in assets
    assert "mathAssetsTSView" in assets
    assert "mathAssetsPyView" in assets
