"""Descriptor generation: family catalog entries -> tool descriptors.

Only families whose parameters are pure structured data (no Python
callables) are exposed as directly callable tools. Callable-taking tools
(model-supplied move functions, predicates, objectives) are NEVER exposed —
they would require arbitrary code from the model; those families need a
structured-spec translator first.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).resolve().parents[1] / "catalog.json"

#: Parameter types that are safe to accept from a model as JSON.
_JSON_SAFE = {"int", "bool", "str", "set[int]", "list", "set[(int,int)]",
              "list[(int,int)]", "list[0|1]", "positive", "real", "symbol",
              "expr", "matrix", "range", "mapping", "iterable", "hashable",
              "set", "tuple", "structured-spec | None"}


def _callable_tool(params: dict[str, Any]) -> bool:
    return any("callable" in str(v) for v in params.values())


def load_catalog(path: Path = CATALOG_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def family_descriptors(path: Path = CATALOG_PATH) -> list[dict[str, Any]]:
    """Project the family catalog into per-tool descriptor dicts.

    Each entry: name, family, purpose tags, JSON-safe args schema sketch,
    resource notes, and the evidence contract pointer. Families with
    tool_role "none" and callable-parameterized tools are excluded.
    """
    catalog = load_catalog(path)
    out = []
    for entry in catalog["families"]:
        if entry["tool_role"] == "none":
            continue
        for tool_name, params in entry.get("params", {}).items():
            if isinstance(params, str):
                continue  # prose-only grouping entry
            if _callable_tool(params):
                continue
            out.append(
                {
                    "name": tool_name,
                    "family": entry["family"],
                    "tool_role": entry["tool_role"],
                    "status": entry["status"],
                    "structure_tags": entry["structure_tags"],
                    "args_schema": {
                        "type": "object",
                        "properties": {k: {"description": str(v)} for k, v in params.items()},
                        "additionalProperties": False,
                    },
                    "complexity": entry["complexity"],
                    "result_contract": "math_families.core.evidence.Evidence",
                }
            )
    return out
