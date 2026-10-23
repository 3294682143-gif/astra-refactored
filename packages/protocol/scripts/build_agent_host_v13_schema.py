#!/usr/bin/env python3
"""Generate the 1.3-agent-loop-preview Agent Host manifest from the 1.2 base.

Mechanical, deterministic transformation only: the existing 1.2 manifest and
the existing P3 host manifest are read as data, deep-copied, and rewritten into
the 1.3 field manifest. No source file is modified, no network or git access,
no environment access. ``build(base, p3)`` is exported for tests; the entry
point prints exactly one JSON document on stdout.

The base manifest must be the frozen 1.2 preview and the P3 manifest must be
the frozen 1.1-p3-host-local; anything else is a fixed error, so arbitrary
fields cannot be smuggled in to bypass the guard.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

OLD_VERSION = "1.2-agent-loop-preview"
NEW_VERSION = "1.3-agent-loop-preview"
P3_VERSION = "1.1-p3-host-local"
OLD_PROFILE = "math-agent-preview-v1"
NEW_PROFILE = "math-agent-preview-v2"

METHOD_CATALOG = "method.catalog"
METHOD_LOAD = "method.load"


class BuildError(Exception):
    """Fixed-code failure; never carries raw input or a path."""


def _fail(code):
    raise BuildError(code)


def _require(condition, code):
    if not condition:
        _fail(code)


def _replace_version(node):
    """Recursively rewrite only the protocolVersion consts of this manifest.

    A schema node stores the version as ``{"type": "string", "const": ...}``,
    so the replacement must look one level into that dict and change only the
    ``const`` value. A bare scalar ``protocolVersion`` (the manifest root) is
    replaced directly. No other key is ever touched, so asset versions such as
    ``1.1.0`` can never be rewritten by accident.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "protocolVersion":
                if isinstance(value, dict):
                    if value.get("const") in (OLD_VERSION, P3_VERSION):
                        value["const"] = NEW_VERSION
                elif value in (OLD_VERSION, P3_VERSION):
                    node[key] = NEW_VERSION
            else:
                _replace_version(value)
    elif isinstance(node, list):
        for item in node:
            _replace_version(item)


def _replace_profile(node):
    """Recursively rewrite only the profileId const of this manifest."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "profileId":
                if isinstance(value, dict):
                    if value.get("const") == OLD_PROFILE:
                        value["const"] = NEW_PROFILE
                elif value == OLD_PROFILE:
                    node[key] = NEW_PROFILE
            else:
                _replace_profile(value)
    elif isinstance(node, list):
        for item in node:
            _replace_profile(item)


def _init_params(manifest):
    entry = manifest["methods"]["runtime.initialize"]
    params = entry["params"]
    required = params["required"]
    if "maxMethodLoads" not in required:
        required.append("maxMethodLoads")
    params["properties"]["maxMethodLoads"] = {
        "type": "integer",
        "minimum": 0,
        "maximum": 4,
    }
    # G3/PR4: the single evidence-triggered repair call budget (0 or 1). Optional
    # so an older sender that omits it still validates; the loop then runs with
    # no repair.
    params["properties"]["maxRepairs"] = {
        "type": "integer",
        "minimum": 0,
        "maximum": 1,
    }
    caps = params["properties"]["capabilities"]["properties"]
    caps["methodLoad"] = {"type": "string", "enum": ["AVAILABLE", "UNAVAILABLE"]}


def _solve_result(manifest):
    summary = manifest["methods"]["session.solve"]["result"]["properties"]["summary"]
    required = summary["required"]
    for name in ("catalogCalls", "methodLoads", "repairCalls"):
        if name not in required:
            required.append(name)
        summary["properties"][name] = {
            "type": "integer",
            "minimum": 0,
            "maximum": 1,
        }
    summary["properties"]["methodLoads"] = {
        "type": "integer",
        "minimum": 0,
        "maximum": 4,
    }
    for name in ("reason", "stopReason"):
        enum = summary["properties"][name]["enum"]
        for value in ("REPAIR", "REVISED_CANDIDATE", "REVISE_REJECTED"):
            if value not in enum:
                enum.append(value)
    summary["properties"]["stopReason"]["enum"] = [
        "WORK", "R2", "REPAIR", "COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN",
        "ADMITTED", "BUDGET_EXHAUSTED", "DEADLINE_EXCEEDED", "ILLEGAL_TRANSITION",
        "NO_CANDIDATE", "NO_REVIEW", "CONTROL_REJECTED", "PACKET_REJECTED",
        "CONTEXT_REJECTED", "REVIEW_STOP", "REVIEWS_COMPLETE",
        "WORK_UNITS_COMPLETE", "REVISED_CANDIDATE", "REVISE_REJECTED",
        "PORT_REJECTED", "STOPPED",
    ]


def _catalog_method(p3):
    entry = p3["methods"].get(METHOD_CATALOG)
    _require(isinstance(entry, dict), "P3_METHOD_MISSING")
    entry = copy.deepcopy(entry)
    _replace_version(entry)
    params = entry["params"]
    properties = params["properties"]
    if "remainingMs" not in properties:
        properties["remainingMs"] = {
            "type": "integer",
            "minimum": 1,
            "maximum": 3600000,
        }
    required = params["required"]
    if "remainingMs" not in required:
        required.append("remainingMs")
    return entry


def _load_method(base):
    entry = copy.deepcopy(base["methods"]["tool.execute"])
    request = entry["params"]["properties"]["request"]
    request["properties"]["action"] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["action", "id"],
        "properties": {
            "action": {"type": "string", "const": "method"},
            "id": {"type": "string", "minLength": 1, "maxLength": 64},
        },
    }
    receipt = entry["result"]["properties"]["receipt"]
    receipt["properties"]["source"] = {"type": "string", "const": "METHOD_REFERENCE"}
    return entry


def _model_generate(manifest):
    """Allow the single G3/PR4 REPAIR phase on model.generate params."""
    params = manifest["methods"]["model.generate"]["params"]
    enum = params["properties"]["phase"]["enum"]
    for value in ("REPAIR",):
        if value not in enum:
            enum.append(value)


def build(base, p3):
    """Return the 1.3 manifest dict derived from the 1.2 base and P3 manifest."""
    _require(isinstance(base, dict), "BASE_INVALID")
    _require(isinstance(p3, dict), "P3_INVALID")
    _require(base.get("protocolVersion") == OLD_VERSION, "BASE_VERSION_MISMATCH")
    _require(p3.get("protocolVersion") == P3_VERSION, "P3_VERSION_MISMATCH")
    _require(base.get("format") == "astra-agent-host-manifest-v1", "BASE_INVALID")
    _require(p3.get("format") == "astra-p3-host-manifest-v1", "P3_INVALID")

    manifest = copy.deepcopy(base)
    _replace_version(manifest)
    _replace_profile(manifest)
    manifest["title"] = "Astra unified AgentLoop local Host<->Node protocol manifest"
    manifest["description"] = (
        "Single normative field specification for the unified AgentLoop local "
        "Host<->Node NDJSON channel. Preview profile: explicit engine=ts, no "
        "provider access from Node, no arbitrary code; bounded method "
        "capabilities are advisory only and never a mathematical obligation."
    )

    _init_params(manifest)
    _solve_result(manifest)
    _model_generate(manifest)
    manifest["methods"][METHOD_CATALOG] = _catalog_method(p3)
    manifest["methods"][METHOD_LOAD] = _load_method(base)
    _replace_version(manifest)
    _replace_profile(manifest)
    return manifest


def _repo_root():
    return Path(__file__).resolve().parents[3]


def _read_json(path):
    try:
        raw = Path(path).read_bytes()
    except OSError:
        _fail("MANIFEST_INVALID")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        _fail("MANIFEST_INVALID")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        _fail("ARGS_UNSUPPORTED")
    root = _repo_root()
    schema_dir = root / "packages" / "protocol" / "schema"
    base = _read_json(schema_dir / "agent-host.schema.json")
    p3 = _read_json(schema_dir / "p3-host.schema.json")
    manifest = build(base, p3)
    sys.stdout.write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as error:
        sys.stderr.write(str(error) + "\n")
        raise SystemExit(2)
