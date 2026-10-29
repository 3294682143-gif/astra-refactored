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
SCHEMA_VERSION = "1.4-unified-math-assets"
# Only the active unified schema may be published as the primary protocol.
# Legacy schemas stay explicitly named below and are never selected as active.
LEGACY_SCHEMA_VERSION = "1.3-agent-loop-preview"
LEGACY_MANIFEST_VERSION = "1.2-agent-loop-preview"

# Precompiled JS entry points (already built by `tsc -b`; never rebuilt at run
# time). The stdio runtime main is what the Python Host launches.
JS_ARTIFACTS = (
    "apps/stdio-runtime/dist/src/main.js",
    "apps/stdio-runtime/dist/src/agent-loop.js",
    "apps/stdio-runtime/dist/src/agent-host-flow.js",
    # main.ts imports this dynamically; leaving it out of the manifest allowed
    # a stale or missing active Host entry to pass verification.
    "apps/stdio-runtime/dist/src/agent-host-main.js",
)
# The self-contained precompiled bundle (esbuild) plus the schema it reads next
# to itself; together they run engine="ts" with no node_modules and no compile.
BUNDLE_ARTIFACTS = {
    "bundle": "release/stdio-runtime.bundle.mjs",
    # Primary protocol artifact: the active --agent-loop entry loads this one.
    "bundleSchema": "release/schema/agent-host-v14.schema.json",
    # Compatibility aliases kept for old readers; never selected as active.
    "bundleSchemaV14": "release/schema/agent-host-v14.schema.json",
    "bundleLegacySchema": "release/schema/agent-host-v13.schema.json",
    "bundleLegacyManifestV12": "release/schema/agent-host.schema.json",
    "bundleMathAssetsSchema": "release/schema/math-assets.schema.json",
}
ASSET_ARTIFACTS = {
    # Primary protocol artifacts: v1.4 is the only active surface.
    "protocolSchema": "packages/protocol/schema/agent-host-v14.schema.json",
    "protocolSchemaV14": "packages/protocol/schema/agent-host-v14.schema.json",
    "protocolLegacySchema": "packages/protocol/schema/agent-host-v13.schema.json",
    "protocolLegacyManifestV12": "packages/protocol/schema/agent-host.schema.json",
    "mathAssetsSchema": "packages/protocol/schema/math-assets.schema.json",
    "canonicalMathAssets": "mathagent/resources/math-assets.json",
    "mathAssetsTSView": "packages/protocol/src/generated/math-assets.ts",
    "mathAssetsPyView": "python/astra_bridge/generated/math_assets.py",
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
    # Handoff §5 item 2: card loads are bounded-multiple now that the effect-id
    # capacity is six (tools 2 + methods 4). The locked profile ships with two
    # so the second-card path is reachable in real runs; the code default in
    # `agent_runtime` stays 1 for callers that want the old single-card shape.
    "maxMethodLoads": 2,
    "maxRepairs": 1,
    "maxR0": 1,
}


def _git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def _sha256(path: Path) -> str:
    raw = path.read_bytes()
    if b"\r\n" in raw:
        raw = raw.replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()


def build() -> dict:
    commit = _git("rev-parse", "HEAD")
    tree = _git("rev-parse", "HEAD^{tree}")
    js = []
    for rel in JS_ARTIFACTS:
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing precompiled JS: {rel} (run `tsc -b` first)")
        raw = path.read_bytes()
        if b"\r\n" in raw:
            raw = raw.replace(b"\r\n", b"\n")
        js.append({"path": Path(rel).as_posix(), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
    assets = {}
    for name, rel in ASSET_ARTIFACTS.items():
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing asset: {rel}")
        assets[name] = {"path": Path(rel).as_posix(), "sha256": _sha256(path)}
    bundle = {}
    for name, rel in BUNDLE_ARTIFACTS.items():
        path = ROOT / rel
        if not path.is_file():
            raise SystemExit(f"missing bundle artifact: {rel} (run the esbuild bundle step)")
        bundle[name] = {"path": Path(rel).as_posix(), "sha256": _sha256(path)}
    family_files = {}
    for path in sorted((ROOT / "math_families").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            family_files[path.relative_to(ROOT).as_posix()] = _sha256(path)
    return {
        "manifestVersion": MANIFEST_VERSION,
        "profileId": PROFILE_ID,
        "engine": "ts",
        "schemaVersion": SCHEMA_VERSION,
        "source": {"commit": commit, "tree": tree},
        "js": js,
        "assets": assets,
        "bundle": bundle,
        "mathFamilyFiles": family_files,
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
    for rel, expected in (manifest.get("mathFamilyFiles") or {}).items():
        path = ROOT / rel
        if not path.is_file() or _sha256(path) != expected:
            errors.append(f"mathFamilyFile:{rel}")
    commit = manifest.get("source", {}).get("commit", "")
    tree = manifest.get("source", {}).get("tree", "")
    # The recorded source commit must still be an ancestor of HEAD (the manifest
    # commit itself may move HEAD forward), and its tree must match the recorded
    # tree. This at least makes the provenance tuple internally consistent while
    # the final precompiled commit is being assembled.
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=ROOT, capture_output=True
    )
    if ancestry.returncode != 0:
        errors.append("source.commit not an ancestor of HEAD")
    recorded_tree = _git("rev-parse", commit + "^{tree}") if commit else ""
    if not tree or recorded_tree != tree:
        errors.append("source.tree does not match source.commit")
    # The active entry must resolve the v1.4 schema and every shipped schema
    # must carry the version its manifest entry claims. Hash-only checks cannot
    # catch a schema copied under the wrong name or a legacy schema promoted to
    # the primary slot.
    schema_claims = (
        (("bundle", "bundleSchema"), "1.4-unified-math-assets"),
        (("bundle", "bundleSchemaV14"), "1.4-unified-math-assets"),
        (("bundle", "bundleLegacySchema"), LEGACY_SCHEMA_VERSION),
        (("bundle", "bundleLegacyManifestV12"), LEGACY_MANIFEST_VERSION),
        (("assets", "protocolSchema"), "1.4-unified-math-assets"),
        (("assets", "protocolSchemaV14"), "1.4-unified-math-assets"),
        (("assets", "protocolLegacySchema"), LEGACY_SCHEMA_VERSION),
        (("assets", "protocolLegacyManifestV12"), LEGACY_MANIFEST_VERSION),
    )
    for (section, name), expected in schema_claims:
        row = (manifest.get(section) or {}).get(name)
        if not isinstance(row, dict):
            errors.append(f"{section}:{name}:missing")
            continue
        path = ROOT / row["path"]
        try:
            actual = json.loads(path.read_text(encoding="utf-8")).get("protocolVersion")
        except (OSError, ValueError):
            actual = None
        if actual != expected:
            errors.append(f"{section}:{name}:protocolVersion")
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
    manifest_text = json.dumps(manifest, indent=2, ensure_ascii=False)
    manifest_lines = [line.rstrip() for line in manifest_text.splitlines()]
    args.out.write_bytes(("\n".join(manifest_lines) + "\n").encode("utf-8"))
    print("BUILT", json.dumps({"out": str(args.out), "commit": manifest["source"]["commit"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
