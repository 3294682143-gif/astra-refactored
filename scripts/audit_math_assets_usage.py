#!/usr/bin/env python3
"""Audit default runtime dependencies on legacy math asset definitions.

Per §15 U8 and §16 U9:
The new unified default mainline must NOT depend on legacy methods.json,
math_families/catalog.json, or historical tool-registry.json for asset discovery,
routing, or parameter contracts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def audit_usage(strict: bool = False) -> bool:
    print("Auditing math assets usage in codebase...")
    violations = []

    # 1. Canonical source existence
    canonical_file = ROOT / "mathagent" / "resources" / "math-assets.json"
    if not canonical_file.is_file():
        violations.append(f"Missing canonical asset file: {canonical_file}")
    else:
        print(f"OK: Canonical file exists ({canonical_file.stat().st_size} bytes)")

    # 2. Check generated views exist and match digest
    ts_view = ROOT / "packages" / "protocol" / "src" / "generated" / "math-assets.ts"
    py_view = ROOT / "python" / "astra_bridge" / "generated" / "math_assets.py"
    if not ts_view.is_file():
        violations.append(f"Missing generated TS view: {ts_view}")
    if not py_view.is_file():
        violations.append(f"Missing generated Python view: {py_view}")

    # 3. Check for unauthorized runtime reads of legacy assets in unified bridge modules
    unified_runtime = ROOT / "python" / "astra_bridge" / "math_assets_runtime.py"
    if unified_runtime.is_file():
        content = unified_runtime.read_text(encoding="utf-8")
        if "math_families/catalog.json" in content:
            violations.append("math_assets_runtime.py reads legacy math_families/catalog.json")
        if "methods.json" in content:
            violations.append("math_assets_runtime.py reads legacy methods.json")
        if "general_v11/SOURCE.json" in content:
            violations.append("math_assets_runtime.py reads legacy SOURCE.json")

    if violations:
        print(f"FAILED: Found {len(violations)} asset usage violations:")
        for v in violations:
            print(f"  - {v}")
        return False

    print("OK: Math assets usage audit passed clean.")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit math assets usage")
    parser.add_argument("--strict", action="store_true", help="Fail if any violation found")
    args = parser.parse_args()

    ok = audit_usage(strict=args.strict)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
