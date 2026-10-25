#!/usr/bin/env python3
"""Generate the 1.4-unified-math-assets Agent Host manifest from the 1.3 base.

Mechanical, deterministic transformation: the existing 1.3 manifest is read as data,
deep-copied, and updated with unified math_asset capabilities, runtime catalog summary,
math_asset.execute RPC method, and MathAssetResult definitions.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

BASE_VERSION = "1.3-agent-loop-preview"
NEW_VERSION = "1.4-unified-math-assets"
BASE_PROFILE = "math-agent-preview-v2"
NEW_PROFILE = "math-agent-preview-v2"

MATH_ASSET_EXECUTE = "math_asset.execute"


class BuildError(Exception):
    """Fixed-code failure."""


def _fail(code: str) -> None:
    raise BuildError(code)


def _require(condition: bool, code: str) -> None:
    if not condition:
        _fail(code)


def _replace_version(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "protocolVersion":
                if isinstance(value, dict):
                    if value.get("const") == BASE_VERSION:
                        value["const"] = NEW_VERSION
                elif value == BASE_VERSION:
                    node[key] = NEW_VERSION
            elif key == "version" and value == BASE_VERSION:
                node[key] = NEW_VERSION
            else:
                _replace_version(value)
    elif isinstance(node, list):
        for item in node:
            _replace_version(item)


def _build_math_asset_execute_method():
    return {
        "direction": "node-to-host",
        "kind": "request",
        "params": {
            "type": "object",
            "additionalProperties": False,
            "required": ["protocolVersion", "sessionId", "request"],
            "properties": {
                "protocolVersion": {
                    "type": "string",
                    "const": NEW_VERSION,
                },
                "sessionId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                },
                "request": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["action", "assetId", "input", "binding"],
                    "properties": {
                        "action": {
                            "type": "string",
                            "const": "math_asset",
                        },
                        "assetId": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 64,
                        },
                        "target": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 64,
                        },
                        "input": {
                            "type": "object",
                        },
                        "binding": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["taskId", "goalId", "scopeId", "contractVersion"],
                            "properties": {
                                "taskId": {"type": "string", "minLength": 1, "maxLength": 128},
                                "goalId": {"type": "string", "minLength": 1, "maxLength": 128},
                                "scopeId": {"type": "string", "minLength": 1, "maxLength": 128},
                                "contractVersion": {"type": "integer", "minimum": 1, "maximum": 2},
                                "sourceRequestId": {"type": "string", "minLength": 1, "maxLength": 128},
                            },
                        },
                    },
                },
            },
        },
        "result": {
            "type": "object",
            "additionalProperties": False,
            "required": ["protocolVersion", "sessionId", "result", "remainingMs"],
            "properties": {
                "protocolVersion": {
                    "type": "string",
                    "const": NEW_VERSION,
                },
                "sessionId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                },
                "remainingMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 3600000,
                },
                "result": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "schemaVersion",
                        "assetId",
                        "assetVersion",
                        "catalogDigest",
                        "requestId",
                        "binding",
                        "normalizedInput",
                        "inputHash",
                        "status",
                        "guidance",
                        "observations",
                        "checks",
                        "usage",
                        "limitations",
                        "resultHash",
                    ],
                    "properties": {
                        "schemaVersion": {"type": "string", "const": "math-assets-v1"},
                        "assetId": {"type": "string"},
                        "assetVersion": {"type": "string"},
                        "catalogDigest": {"type": "string", "minLength": 64, "maxLength": 64},
                        "requestId": {"type": "string"},
                        "binding": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["taskId", "goalId", "scopeId", "contractVersion"],
                            "properties": {
                                "taskId": {"type": "string"},
                                "goalId": {"type": "string"},
                                "scopeId": {"type": "string"},
                                "contractVersion": {"type": "integer"},
                                "sourceRequestId": {"type": "string"},
                            },
                        },
                        "normalizedInput": {"type": "object"},
                        "inputHash": {"type": "string", "minLength": 64, "maxLength": 64},
                        "status": {
                            "type": "string",
                            "enum": [
                                "COMPLETE",
                                "NEEDS_INPUT",
                                "OUT_OF_SCOPE",
                                "UNAVAILABLE",
                                "ERROR",
                                "UNKNOWN",
                            ],
                        },
                        "guidance": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "observations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": [
                                    "quantity",
                                    "value",
                                    "domain",
                                    "exactness",
                                    "coverage",
                                    "sourceInputHash",
                                    "taskId",
                                    "contractVersion",
                                ],
                                "properties": {
                                    "quantity": {"type": "string"},
                                    "value": {},
                                    "domain": {"type": "string"},
                                    "exactness": {
                                        "type": "string",
                                        "enum": [
                                            "EXACT_FOR_INPUT",
                                            "NUMERICAL_FOR_INPUT",
                                            "WITNESS_FOR_INPUT",
                                            "SAMPLED_OBSERVATION",
                                            "CONJECTURE",
                                            "GUIDANCE",
                                        ],
                                    },
                                    "coverage": {"type": "string"},
                                    "sourceInputHash": {
                                        "type": "string",
                                        "minLength": 64,
                                        "maxLength": 64,
                                    },
                                    "taskId": {"type": "string"},
                                    "contractVersion": {"type": "integer"},
                                },
                            },
                        },
                        "checks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": [
                                    "checkerId",
                                    "version",
                                    "scope",
                                    "inputHash",
                                    "resultHash",
                                    "status",
                                ],
                                "properties": {
                                    "checkerId": {"type": "string"},
                                    "version": {"type": "string"},
                                    "scope": {"type": "string"},
                                    "inputHash": {
                                        "type": "string",
                                        "minLength": 64,
                                        "maxLength": 64,
                                    },
                                    "resultHash": {
                                        "type": "string",
                                        "minLength": 64,
                                        "maxLength": 64,
                                    },
                                    "status": {"type": "string"},
                                },
                            },
                        },
                        "usage": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["durationMs", "computationType"],
                            "properties": {
                                "durationMs": {"type": "integer", "minimum": 0},
                                "computationType": {"type": "string"},
                            },
                        },
                        "limitations": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "resultHash": {
                            "type": "string",
                            "minLength": 64,
                            "maxLength": 64,
                        },
                    },
                },
            },
        },
    }


def build(base: dict) -> dict:
    _require(isinstance(base, dict), "BASE_INVALID")
    _require(base.get("protocolVersion") == BASE_VERSION, "BASE_VERSION_MISMATCH")

    manifest = copy.deepcopy(base)
    _replace_version(manifest)
    manifest["protocolVersion"] = NEW_VERSION
    manifest["title"] = "Astra unified AgentLoop local Host<->Node protocol manifest (v1.4 unified math assets)"
    manifest["description"] = (
        "Single normative field specification for the unified AgentLoop local "
        "Host<->Node NDJSON channel with unified math_asset action and MathAssetResult."
    )

    # runtime.initialize capabilities & catalog summary
    init_params = manifest["methods"]["runtime.initialize"]["params"]
    init_params["properties"]["mathAssetCatalog"] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["version", "digest", "assets"],
        "properties": {
            "version": {"type": "string"},
            "digest": {"type": "string", "minLength": 64, "maxLength": 64},
            "assets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["assetId", "name", "version", "summary"],
                    "properties": {
                        "assetId": {"type": "string"},
                        "name": {"type": "string"},
                        "version": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                },
            },
        },
    }
    caps = init_params["properties"]["capabilities"]["properties"]
    caps["mathAsset"] = {"type": "string", "enum": ["AVAILABLE", "UNAVAILABLE"]}

    # session.solve summary
    summary = manifest["methods"]["session.solve"]["result"]["properties"]["summary"]
    summary["properties"]["mathAssetCalls"] = {
        "type": "integer",
        "minimum": 0,
        "maximum": 64,
    }

    # math_asset.execute
    manifest["methods"][MATH_ASSET_EXECUTE] = _build_math_asset_execute_method()

    return manifest


def main() -> int:
    check_mode = "--check" in sys.argv
    root = Path(__file__).resolve().parents[3]
    schema_dir = root / "packages" / "protocol" / "schema"
    release_dir = root / "release" / "schema"
    base_path = schema_dir / "agent-host-v13.schema.json"
    if not base_path.is_file():
        _fail("BASE_FILE_MISSING")
    base = json.loads(base_path.read_text(encoding="utf-8"))
    manifest = build(base)
    generated_text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    out_path = schema_dir / "agent-host-v14.schema.json"
    release_path = release_dir / "agent-host-v14.schema.json"

    if check_mode:
        for p in (out_path, release_path):
            if not p.is_file():
                sys.stderr.write(f"ERROR: Schema file missing: {p}\n")
                return 1
            if json.loads(p.read_text(encoding="utf-8")) != manifest:
                sys.stderr.write(f"ERROR: Schema drift detected in {p}\n")
                return 1
        print("CHECK_OK: agent-host-v14 schema matches committed files")
        return 0

    out_path.write_text(generated_text, encoding="utf-8")
    if release_dir.is_dir():
        release_path.write_text(generated_text, encoding="utf-8")
    print(f"Generated {out_path} and {release_path} ({len(json.dumps(manifest))} bytes)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as err:
        sys.stderr.write(f"ERROR: {err}\n")
        raise SystemExit(1)
