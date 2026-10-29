#!/usr/bin/env python3
"""Copy the canonical release manifest into the frontend static snapshot.

The Web UI must not maintain a second hand-written version record. This script
requires the canonical manifest to be the v1.4 unified-math schema and copies
its bytes to ``apps/web-demo/public/BUILD_MANIFEST.json``. ``--check`` fails on
drift without writing.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "release" / "BUILD_MANIFEST.json"
TARGET = ROOT / "apps" / "web-demo" / "public" / "BUILD_MANIFEST.json"
EXPECTED_SCHEMA = "1.4-unified-math-assets"


def _text() -> str:
    if not SOURCE.is_file():
        raise SystemExit(f"canonical manifest missing: {SOURCE}")
    manifest = json.loads(SOURCE.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != EXPECTED_SCHEMA:
        raise SystemExit(
            f"canonical manifest schemaVersion is {manifest.get('schemaVersion')!r}, "
            f"expected {EXPECTED_SCHEMA!r}"
        )
    return SOURCE.read_text(encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    expected = _text()
    if args.check:
        if not TARGET.is_file() or TARGET.read_text(encoding="utf-8") != expected:
            print(f"WEB_MANIFEST_DRIFT {TARGET}")
            return 1
        print(f"WEB_MANIFEST_OK {TARGET}")
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(expected, encoding="utf-8", newline="\n")
    print(f"SYNCED {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
