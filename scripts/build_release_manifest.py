#!/usr/bin/env python3
"""G6 (local) — build/verify the L1 precompiled release manifest.

Binds the precompiled JS artifacts, the source commit/tree SHA, the protocol
schema version, the method/math asset SHAs and the locked run profile into one
``release/BUILD_MANIFEST.json``. ``verify`` re-checks every hash against the
working tree and confirms the recorded source commit is an ancestor of HEAD — so
a clean precompiled checkout can launch ``engine="ts"`` with no ``npm install``
and no runtime ``tsc``.

No network, no build, no model call.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_VERSION = "build-manifest-v1"
PROFILE_ID = "math-agent-preview-v2"
SCHEMA_VERSION = "1.3-agent-loop-preview"

# Precompiled JS entry points (already built by `tsc -b`; never rebuilt at run
# time). The stdio runtime main is what the Python Host launches.
JS_ARTIFACTS = (
    "apps/stdio-runtime/dist/src/main.js",
    "apps/stdio-runtime/dist/src/agent-loop.js",
    "apps/stdio-runtime/dist/src/agent-host-flow.js",
)
# The self-contained precompiled bundle (esbuild) plus the schema it reads next
# to itself; together they run engine="ts" with no node_modules and no compile.
BUNDLE_ARTIFACTS = {
    "bundle": "release/stdio-runtime.bundle.mjs",
    "bundleSchema": "release/schema/agent-host-v13.schema.json",
}
ASSET_ARTIFACTS = {
    "protocolSchema": "packages/protocol/schema/agent-host-v13.schema.json",
    "methodRegistry": "mathagent/resources/tool-registry.json",
    "methodSkillMapping": "mathagent/resources/skill-mapping-manifest.json",
    "mathFamiliesCatalog": "math_families/catalog.json",
}
LOCKED_RUN_PROFILE = {
    "profileId": PROFILE_ID,
    "engine": "ts",
    "policy": "BEST_EFFORT",
    "maxModelCalls": 4,
    "maxWorkUnits": 2,
    "maxEffects": 1,
    "maxReviews": 1,
    "maxMethodLoads": 0,
    "maxRepairs": 0,
    "maxR0": 0,
}


def _git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build() -> dict:
    commit = _git("rev-parse", "HEAD")
    tree = _git("rev-parse", "HEAD^{tree}")
    js = []
    for rel in JS_ARTIFACTS:
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing precompiled JS: {rel} (run `tsc -b` first)")
        js.append({"path": rel, "sha256": _sha256(path), "bytes": path.stat().st_size})
    assets = {}
    for name, rel in ASSET_ARTIFACTS.items():
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing asset: {rel}")
        assets[name] = {"path": rel, "sha256": _sha256(path)}
    bundle = {}
    for name, rel in BUNDLE_ARTIFACTS.items():
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing bundle artifact: {rel} (run the esbuild bundle step)")
        bundle[name] = {"path": rel, "sha256": _sha256(path)}
    return {
        "manifestVersion": MANIFEST_VERSION,
        "profileId": PROFILE_ID,
        "engine": "ts",
        "schemaVersion": SCHEMA_VERSION,
        "source": {"commit": commit, "tree": tree},
        "js": js,
        "assets": assets,
        "bundle": bundle,
        "lockedRunProfile": LOCKED_RUN_PROFILE,
        "precompiled": True,
        "requiresNpmInstall": False,
        "requiresRuntimeTsc": False,
    }


def verify(manifest_path: Path) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    errors = []
    if manifest.get("manifestVersion") != MANIFEST_VERSION:
        errors.append("manifestVersion")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("schemaVersion")
    if manifest.get("precompiled") is not True or manifest.get("requiresRuntimeTsc") is not False:
        errors.append("precompiled flags")
    for row in manifest.get("js", []):
        path = ROOT / row["path"]
        if not path.is_file() or _sha256(path) != row["sha256"]:
            errors.append(f"js:{row['path']}")
    for name, row in (manifest.get("assets") or {}).items():
        path = ROOT / row["path"]
        if not path.is_file() or _sha256(path) != row["sha256"]:
            errors.append(f"asset:{name}")
    for name, row in (manifest.get("bundle") or {}).items():
        path = ROOT / row["path"]
        if not path.is_file() or _sha256(path) != row["sha256"]:
            errors.append(f"bundle:{name}")
    commit = manifest.get("source", {}).get("commit", "")
    # The recorded source commit must still be an ancestor of HEAD (the manifest
    # commit itself may move HEAD forward).
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=ROOT, capture_output=True
    )
    if ancestry.returncode != 0:
        errors.append("source.commit not an ancestor of HEAD")
    if errors:
        print("VERIFY_FAILED", json.dumps(errors))
        return 1
    print("VERIFY_OK", json.dumps({"js": len(manifest["js"]), "assets": len(manifest["assets"]), "bundle": len(manifest.get("bundle") or {}),
                                   "commit": commit}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "release" / "BUILD_MANIFEST.json")
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args(argv)
    if args.verify is not None:
        return verify(args.verify)
    manifest = build()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("BUILT", json.dumps({"out": str(args.out), "commit": manifest["source"]["commit"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
