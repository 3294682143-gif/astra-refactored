"""G8/PR8 — a real math-family algorithm executes through the bridged tool path.

Registration / descriptor / hash passing is NOT execution evidence (ADR-011 / §5):
this executes a registered tool that is bridged to a `math_families` family and
asserts a concrete computed result, while an unknown tool stays fail-closed.
"""
from __future__ import annotations

import json
from pathlib import Path

from math_families.bridge.dispatch import call_tool, tool_names
from mathagent.exact_data_checks import TOOL_FUNCTIONS

ROOT = Path(__file__).resolve().parents[2]


def test_registered_tools_are_bridged_to_math_families():
    registry = json.loads((ROOT / "mathagent/resources/tool-registry.json").read_text(encoding="utf-8"))["tools"]
    bridged = set(tool_names()) | set(TOOL_FUNCTIONS)
    assert bridged == set(registry) and len(registry) >= 20
    assert "lz78_encode" in registry and "lz78_encode" in tool_names()
    assert {"interpolation_fit_check", "stats_ols_check"} <= set(TOOL_FUNCTIONS)
    # the family manifest actually claims the tool, tying execution to a family
    manifest = json.loads((ROOT / "mathagent/resources/skill-mapping-manifest.json").read_text(encoding="utf-8"))["families"]
    owner = [row["family_id"] for row in manifest if "lz78_encode" in row.get("tools", [])]
    assert owner, "lz78_encode must belong to a declared math family"


def test_real_family_algorithm_executes_and_returns_a_concrete_result():
    evidence = call_tool("lz78_encode", {"message": "abab"})
    assert evidence["status"] == "ok", evidence
    assert evidence["method"] == "lz78_encode"
    # A concrete computed result, not a stub/None: LZ78 factorisation of "abab".
    assert evidence["result"] == [(0, "a"), (0, "b"), (1, "b")]


def test_unknown_tool_is_fail_closed_never_a_fabricated_result():
    evidence = call_tool("not_a_registered_tool", {})
    assert evidence["status"] == "unsupported"
    assert evidence["result"] is None
