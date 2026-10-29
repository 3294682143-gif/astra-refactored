#!/usr/bin/env python3
"""Check that frozen assets and schemas have not drifted from their baseline hashes.

Ensures math_families/**, historical 1.2 schema, outputCheckers, etc. are untouched.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python.astra_bridge.host_assets_registry import verify_integrity

FROZEN_SCHEMA_12 = ROOT / "packages" / "protocol" / "schema" / "agent-host.schema.json"
FROZEN_SCHEMA_12_SHA = "d21953e28965de0497f6dd186b716f388256dd4b95500351729a7dd7d9fe80dd"


def check_frozen_assets() -> bool:
    print("Verifying asset baseline integrity...")
    res = verify_integrity(ROOT)
    if not res.get("ok"):
        print(f"FAILED: Asset integrity check failed: {res.get('errors')}")
        return False
    counts = res.get("counts", {})
    print(f"OK: Verified baseline assets: {counts}")

    # Check 1.2 schema SHA
    if not FROZEN_SCHEMA_12.is_file():
        print(f"FAILED: Missing frozen schema {FROZEN_SCHEMA_12}")
        return False
    actual_sha = hashlib.sha256(FROZEN_SCHEMA_12.read_bytes()).hexdigest()
    if actual_sha != FROZEN_SCHEMA_12_SHA:
        print(f"FAILED: 1.2 schema hash mismatch. Expected {FROZEN_SCHEMA_12_SHA}, got {actual_sha}")
        return False
    print("OK: Frozen 1.2 schema hash verified.")

    return True


def main() -> int:
    ok = check_frozen_assets()
    if not ok:
        return 1
    print("ALL FROZEN ASSETS VERIFIED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
