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
    assert data["schemaVersion"] == "1.4-unified-math-assets"
    assert data["precompiled"] is True
    assert data["requiresNpmInstall"] is False
    assert data["requiresRuntimeTsc"] is False

    # Check bundle assets: v1.4 is the primary schema, v1.3 is only a
    # compatibility entry and must never be selected as the active surface.
    bundle = data["bundle"]
    assert "bundle" in bundle
    assert bundle["bundleSchema"]["path"].endswith("agent-host-v14.schema.json")
    assert bundle["bundleSchemaV14"]["path"].endswith("agent-host-v14.schema.json")
    assert bundle["bundleLegacySchema"]["path"].endswith("agent-host-v13.schema.json")
    assert bundle["bundleLegacyManifestV12"]["path"].endswith("agent-host.schema.json")
    assert "bundleMathAssetsSchema" in bundle

    # Check canonical math assets
    assets = data["assets"]
    assert assets["protocolSchema"]["path"].endswith("agent-host-v14.schema.json")
    assert assets["protocolLegacySchema"]["path"].endswith("agent-host-v13.schema.json")
    assert assets["protocolLegacyManifestV12"]["path"].endswith("agent-host.schema.json")
    assert "canonicalMathAssets" in assets
    assert "mathAssetsTSView" in assets
    assert "mathAssetsPyView" in assets
    js_paths = {row["path"] for row in data["js"]}
    assert "apps/stdio-runtime/dist/src/agent-host-main.js" in js_paths


def test_protocol_package_exports_the_active_v14_schema():
    """The workspace dev entry resolves the v1.4 host schema via package exports.

    The release bundle ships the schema as a sibling file, so a missing export
    only breaks ``ASTRA_STDIO_RUNTIME=dev``; without this assertion the whole
    Python E2E suite can pass against the bundle while the dev entry fails at
    ``runtime.initialize`` with EOF.
    """
    package = json.loads(
        (ROOT / "packages" / "protocol" / "package.json").read_text(encoding="utf-8")
    )
    exports = package["exports"]
    relative = exports["./schema/agent-host-v14.schema.json"]
    schema = ROOT / "packages" / "protocol" / relative
    assert schema.is_file(), f"missing v1.4 schema export target: {relative}"
    data = json.loads(schema.read_text(encoding="utf-8"))
    assert data["protocolVersion"] == "1.4-unified-math-assets"
    # The package's shipped schema directory is a complete public surface; a
    # missing math-assets export is the same class of packaging defect.
    assert exports["./schema/math-assets.schema.json"] == "./schema/math-assets.schema.json"
    assert (ROOT / "packages" / "protocol" / "schema" / "math-assets.schema.json").is_file()
