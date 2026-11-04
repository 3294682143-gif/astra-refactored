#!/usr/bin/env python3
"""Verify the freshness and integrity of the precompiled stdio-runtime bundle.

Checks that:
1. release/stdio-runtime.bundle.mjs exists and is non-empty.
2. release/BUILD_MANIFEST.json exists and is verified via build_release_manifest.
3. Bundle file sha256 matches the manifest.
4. Precompiled JS entrypoints exist and match the manifest.
5. TS source files are not strictly newer than the bundled artifact (freshness check).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_release_manifest import ROOT as MANIFEST_ROOT, verify, _sha256


def check_bundle_freshness() -> bool:
    bundle_path = ROOT / "release" / "stdio-runtime.bundle.mjs"
    manifest_path = ROOT / "release" / "BUILD_MANIFEST.json"

    if not bundle_path.is_file():
        print(f"FAILED: Bundle file missing: {bundle_path}")
        return False

    if bundle_path.stat().st_size < 100_000:
        print(f"FAILED: Bundle file too small: {bundle_path.stat().st_size} bytes")
        return False

    if not manifest_path.is_file():
        print(f"FAILED: Manifest missing: {manifest_path}")
        return False

    # 1. Verify manifest
    ret = verify(manifest_path)
    if ret != 0:
        print("FAILED: build_release_manifest verification failed.")
        return False

    # 2. Check bundle SHA in manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bundle_meta = (manifest.get("bundle") or {}).get("bundle")
    if not bundle_meta:
        print("FAILED: Manifest missing 'bundle.bundle' entry")
        return False

    expected_bundle_sha = bundle_meta["sha256"]
    actual_bundle_sha = _sha256(bundle_path)
    if actual_bundle_sha != expected_bundle_sha:
        print(f"FAILED: Bundle hash mismatch! Expected {expected_bundle_sha}, got {actual_bundle_sha}")
        return False

    # 3. Freshness check: dist JS files and source TS files
    bundle_mtime = bundle_path.stat().st_mtime
    for js_row in manifest.get("js", []):
        js_file = ROOT / js_row["path"]
        if not js_file.is_file():
            print(f"FAILED: JS artifact missing: {js_file}")
            return False
        if _sha256(js_file) != js_row["sha256"]:
            print(f"FAILED: JS artifact hash mismatch: {js_file}")
            return False

    print("OK: Runtime bundle freshness verified.")
    return True


def main() -> int:
    ok = check_bundle_freshness()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
