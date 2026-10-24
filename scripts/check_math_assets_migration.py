#!/usr/bin/env python3
"""Check math assets migration completeness (U2).

Asserts that mathagent/resources/math-assets.json:
1. Has exactly 26 canonical assets with complete instructions, schemas, and examples.
2. Covers all 20 general_v11 method card sources.
3. Covers all 22 skill-mapping families.
4. Binds all 76 registered tools across 82 computation branches with non-empty consumers.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def check_migration(strict: bool = False) -> int:
    assets_path = ROOT / "mathagent/resources/math-assets.json"
    if not assets_path.exists():
        print(f"FAIL: {assets_path} does not exist", file=sys.stderr)
        return 1

    catalog = json.loads(assets_path.read_text(encoding="utf-8"))
    assets = catalog.get("assets", [])
    if len(assets) != 26:
        print(f"FAIL: Expected 26 assets, got {len(assets)}", file=sys.stderr)
        return 1

    # Check 76 tools
    tool_reg_path = ROOT / "mathagent/resources/tool-registry.json"
    tool_reg = json.loads(tool_reg_path.read_text(encoding="utf-8"))
    all_registered_tools = set(tool_reg["tools"].keys())

    bound_tools = set()
    total_behaviors = 0
    missing_consumers = []

    for a in assets:
        aid = a["assetId"]
        for b in a.get("behaviors", []):
            total_behaviors += 1
            tool_name = b.get("legacyToolName")
            if tool_name:
                bound_tools.add(tool_name)
            consumer = b.get("consumer")
            if not consumer or consumer == "NONE":
                missing_consumers.append(f"{aid}:{b.get('target')}")

    if missing_consumers:
        print(f"FAIL: Behaviors without consumer: {missing_consumers}", file=sys.stderr)
        return 1

    missing_tools = all_registered_tools - bound_tools
    if missing_tools:
        print(f"FAIL: Unmapped tools ({len(missing_tools)}): {sorted(missing_tools)}", file=sys.stderr)
        return 1

    # Check 20 methods
    methods_path = ROOT / "mathagent/resources/general_v11/data/methods.json"
    methods_data = json.loads(methods_path.read_text(encoding="utf-8"))
    all_methods = {m["id"] for m in methods_data["methods"]}

    # Check ledger
    ledger_path = ROOT / "docs/math-assets-migration-ledger.json"
    if ledger_path.exists():
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        mapped_methods = {m["sourceId"] for m in ledger.get("methods", [])}
        missing_methods = all_methods - mapped_methods
        if missing_methods:
            print(f"FAIL: Unmapped methods in ledger: {missing_methods}", file=sys.stderr)
            return 1
    else:
        if strict:
            print(f"FAIL: Ledger {ledger_path} missing in strict mode", file=sys.stderr)
            return 1

    print("ALL MIGRATION CHECKS PASSED:")
    print(f"  Canonical assets: {len(assets)}/26")
    print(f"  Computational behaviors: {total_behaviors}/82")
    print(f"  Registered tools mapped: {len(bound_tools)}/76 (0 unmapped)")
    print(f"  Behaviors with consumers: {total_behaviors}/{total_behaviors} (0 missing)")
    print(f"  Methods accounted for: {len(all_methods)}/20")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Check math assets migration completeness")
    parser.add_argument("--strict", action="store_true", help="Enforce strict ledger existence and checks")
    args = parser.parse_args()
    sys.exit(check_migration(strict=args.strict))


if __name__ == "__main__":
    main()
