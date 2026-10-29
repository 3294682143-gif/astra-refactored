"""Consistency of runtime-visible tools; counts are not mathematical coverage."""

import json
from importlib.resources import files


def validate_inventory():
    from math_families.bridge.dispatch import tool_names
    from .exact_data_checks import TOOL_FUNCTIONS

    root = files("mathagent").joinpath("resources")
    registry = json.loads(
        root.joinpath("tool-registry.json").read_text(encoding="utf-8")
    )
    families = json.loads(
        root.joinpath("skill-mapping-manifest.json").read_text(encoding="utf-8")
    )["families"]
    tools = registry["tools"]
    # The frozen family dispatcher is extended at the mathagent seam with exact
    # data tools whose implementations live outside ``math_families``.
    if set(tools) != set(tool_names()) | set(TOOL_FUNCTIONS):
        raise ValueError("registered and bridged tool inventories differ")
    if registry["summary"]["total_tools"] != len(tools):
        raise ValueError("registered tool count metadata differs")
    declared = []
    for family in families:
        expected = {
            name
            for name, spec in tools.items()
            if spec["family"] == family["family_id"]
        }
        if set(family["tools"]) != expected:
            raise ValueError(
                "family/tool capability mapping differs: " + family["family_id"]
            )
        declared.extend(family["tools"])
    if len(declared) != len(tools) or set(declared) != set(tools):
        raise ValueError("each tool must have exactly one visible family")
    return {"families": len(families), "tools": len(tools)}
