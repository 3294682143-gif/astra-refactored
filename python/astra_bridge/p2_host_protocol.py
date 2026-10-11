"""Strict P2 local Host protocol helpers for the Python Host side.

Reuses the P0 parser/validator primitives; the single normative field
specification is ``packages/protocol/schema/p2-host.schema.json``. Failures are
fixed codes and never carry raw input or a path.
"""

from __future__ import annotations

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
    "P2_HOST_VERSION",
    "P2_HOST_MANIFEST_FORMAT",
    "P2_HOST_SCHEMA_DIALECT",
    "P2_HOST_METHODS",
    "P2_HOST_METHOD_DIRECTION",
    "load_manifest",
    "validate_manifest",
    "parse_frame",
    "payload",
    "classify_method",
]

P2_HOST_VERSION = "1.0-p2-host-local"
P2_HOST_MANIFEST_FORMAT = "astra-p2-host-manifest-v1"
P2_HOST_SCHEMA_DIALECT = "astra-p0-schema-subset-v1"

P2_HOST_METHODS = (
    "runtime.initialize",
    "session.solve",
    "session.stop",
    "method.catalog",
    "method.load",
    "model.generate",
)

P2_HOST_METHOD_DIRECTION = {
    "runtime.initialize": "host-to-node",
    "session.solve": "host-to-node",
    "session.stop": "host-to-node",
    "method.catalog": "node-to-host",
    "method.load": "node-to-host",
    "model.generate": "node-to-host",
}


def _fail(code):
    raise ProtocolError(code)


def _default_path():
    return (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "protocol"
        / "schema"
        / "p2-host.schema.json"
    )


def load_manifest(path=None):
    """Load and cross-check the P2 Host manifest relative to this file."""
    if path is None:
        path = _default_path()
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
    return validate_manifest(manifest)


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


def validate_manifest(raw):
    if not isinstance(raw, dict):
        _fail("MANIFEST_INVALID")
    if raw.get("format") != P2_HOST_MANIFEST_FORMAT:
        _fail("MANIFEST_INVALID")
    if raw.get("schemaDialect") != P2_HOST_SCHEMA_DIALECT:
        _fail("MANIFEST_INVALID")
    if raw.get("protocolVersion") != P2_HOST_VERSION:
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
    methods = raw.get("methods")
    if not isinstance(methods, dict):
        _fail("MANIFEST_INVALID")
    if len(methods) != len(P2_HOST_METHODS):
        _fail("MANIFEST_INVALID")
    for name in methods:
        if name not in P2_HOST_METHODS:
            _fail("MANIFEST_INVALID")
    for name in P2_HOST_METHODS:
        entry = methods.get(name)
        if not isinstance(entry, dict):
            _fail("MANIFEST_INVALID")
        if entry.get("direction") != P2_HOST_METHOD_DIRECTION[name]:
            _fail("MANIFEST_INVALID")
        if entry.get("kind") != "request":
            _fail("MANIFEST_INVALID")
        for side in ("params", "result"):
            node = entry.get(side)
            if not isinstance(node, dict):
                _fail("MANIFEST_INVALID")
            assert_supported_schema(node)
    return raw


def classify_method(method):
    if method in P2_HOST_METHODS:
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
    if value.get("protocolVersion") != P2_HOST_VERSION:
        _fail("VERSION_MISMATCH")
    if session_id is not None and value.get("sessionId") != session_id:
        _fail("SESSION_MISMATCH")
