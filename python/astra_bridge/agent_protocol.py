"""Strict unified AgentLoop local Host protocol helpers for the Python Host.

Reuses the P0 parser/validator primitives; the single normative field
specification is ``packages/protocol/schema/agent-host.schema.json``. Failures
are fixed codes and never carry raw input or a path.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from .p0_protocol import (
    LIMITS,
    ProtocolError,
    assert_supported_schema,
    parse_frame,
    validate_against_schema,
)

__all__ = [
    "AGENT_HOST_VERSION",
    "AGENT_HOST_LEGACY_VERSION",
    "AGENT_HOST_MANIFEST_FORMAT",
    "AGENT_HOST_SCHEMA_DIALECT",
    "AGENT_HOST_METHODS",
    "AGENT_HOST_LEGACY_METHODS",
    "AGENT_HOST_METHOD_DIRECTION",
    "load_manifest",
    "load_legacy_manifest",
    "validate_manifest",
    "validate_legacy_manifest",
    "parse_frame",
    "payload",
    "classify_method",
]

AGENT_HOST_VERSION = "1.3-agent-loop-preview"
AGENT_HOST_LEGACY_VERSION = "1.2-agent-loop-preview"
AGENT_HOST_MANIFEST_FORMAT = "astra-agent-host-manifest-v1"
AGENT_HOST_SCHEMA_DIALECT = "astra-p0-schema-subset-v1"

AGENT_HOST_METHODS = (
    "runtime.initialize",
    "session.solve",
    "session.stop",
    "model.generate",
    "tool.execute",
    "method.catalog",
    "method.load",
    "asset.scoped",
)

AGENT_HOST_LEGACY_METHODS = (
    "runtime.initialize",
    "session.solve",
    "session.stop",
    "model.generate",
    "tool.execute",
)

AGENT_HOST_METHOD_DIRECTION = {
    "runtime.initialize": "host-to-node",
    "session.solve": "host-to-node",
    "session.stop": "host-to-node",
    "model.generate": "node-to-host",
    "tool.execute": "node-to-host",
    "method.catalog": "node-to-host",
    "method.load": "node-to-host",
    "asset.scoped": "node-to-host",
}


def _fail(code):
    raise ProtocolError(code)


def _packaged_path(name):
    """Schema shipped beside the Python package in the wheel/release bundle."""
    return Path(__file__).resolve().parent / "release" / "schema" / name


def _source_path(name):
    return Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schema" / name


def _default_path():
    packaged = _packaged_path("agent-host-v13.schema.json")
    if packaged.is_file():
        return packaged
    return _source_path("agent-host-v13.schema.json")


def _legacy_path():
    packaged = _packaged_path("agent-host.schema.json")
    if packaged.is_file():
        return packaged
    return _source_path("agent-host.schema.json")


def _read_manifest(path):
    if path is None:
        _fail("MANIFEST_INVALID")
    try:
        raw = Path(path).read_bytes()
    except OSError:
        _fail("MANIFEST_INVALID")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _fail("MANIFEST_INVALID")
    try:
        manifest = json.loads(text)
    except ValueError:
        _fail("MANIFEST_INVALID")
    return manifest


def load_manifest(path=None):
    """Load and cross-check the active 1.3 Agent Host manifest."""
    return validate_manifest(_read_manifest(path if path is not None else _default_path()))


def load_legacy_manifest(path=None):
    """Load the frozen 1.2 manifest for read-only replay; never live."""
    return validate_legacy_manifest(_read_manifest(path if path is not None else _legacy_path()))


def _same_limits(raw):
    if not isinstance(raw, dict):
        return False
    if len(raw) != len(LIMITS):
        return False
    for key, expected in LIMITS.items():
        if key not in raw:
            return False
        value = raw[key]
        if isinstance(value, bool) or not isinstance(value, int):
            return False
        if value != expected:
            return False
    return True


def _validate(raw, version, methods):
    if not isinstance(raw, dict):
        _fail("MANIFEST_INVALID")
    if raw.get("format") != AGENT_HOST_MANIFEST_FORMAT:
        _fail("MANIFEST_INVALID")
    if raw.get("schemaDialect") != AGENT_HOST_SCHEMA_DIALECT:
        _fail("MANIFEST_INVALID")
    if raw.get("protocolVersion") != version:
        _fail("VERSION_MISMATCH")
    if not _same_limits(raw.get("limits")):
        _fail("MANIFEST_INVALID")
    envelopes = raw.get("envelopes")
    if not isinstance(envelopes, dict):
        _fail("MANIFEST_INVALID")
    if len(envelopes) != 3:
        _fail("MANIFEST_INVALID")
    for key in ("request", "success", "failure"):
        node = envelopes.get(key)
        if not isinstance(node, dict):
            _fail("MANIFEST_INVALID")
        assert_supported_schema(node)
    declared = raw.get("methods")
    if not isinstance(declared, dict):
        _fail("MANIFEST_INVALID")
    if len(declared) != len(methods):
        _fail("MANIFEST_INVALID")
    for name in declared:
        if name not in methods:
            _fail("MANIFEST_INVALID")
    for name in methods:
        entry = declared.get(name)
        if not isinstance(entry, dict):
            _fail("MANIFEST_INVALID")
        if entry.get("direction") != AGENT_HOST_METHOD_DIRECTION[name]:
            _fail("MANIFEST_INVALID")
        if entry.get("kind") != "request":
            _fail("MANIFEST_INVALID")
        for side in ("params", "result"):
            node = entry.get(side)
            if not isinstance(node, dict):
                _fail("MANIFEST_INVALID")
            assert_supported_schema(node)
    return copy.deepcopy(raw)


def validate_manifest(raw):
    """Validate the active 1.3 manifest; a 1.2 document is refused."""
    return _validate(raw, AGENT_HOST_VERSION, AGENT_HOST_METHODS)


def validate_legacy_manifest(raw):
    """Validate the frozen 1.2 manifest for read-only replay only."""
    return _validate(raw, AGENT_HOST_LEGACY_VERSION, AGENT_HOST_LEGACY_METHODS)


def classify_method(method):
    if method in AGENT_HOST_METHODS:
        return method
    _fail("UNKNOWN_METHOD")


def payload(manifest, method, side, value, session_id=None):
    """Validate one payload against the manifest node for that method side."""
    methods = manifest.get("methods") if isinstance(manifest, dict) else None
    if not isinstance(methods, dict):
        _fail("MANIFEST_INVALID")
    entry = methods.get(method)
    if not isinstance(entry, dict):
        _fail("UNKNOWN_METHOD")
    node = entry.get(side)
    if not isinstance(node, dict):
        _fail("MANIFEST_INVALID")
    validate_against_schema(value, node)
    if not isinstance(value, dict):
        _fail("FIELD_TYPE")
    declared = manifest.get("protocolVersion")
    if value.get("protocolVersion") != declared:
        _fail("VERSION_MISMATCH")
    if session_id is not None and value.get("sessionId") != session_id:
        _fail("SESSION_MISMATCH")
