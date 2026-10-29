"""Strict P1 offline protocol helpers for the Python Host side.

Reuses the P0 parser/validator primitives; the single normative field
specification is ``packages/protocol/schema/p1.schema.json``. Failures are
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
    "P1_PROTOCOL_VERSION",
    "P1_MANIFEST_FORMAT",
    "P1_SCHEMA_DIALECT",
    "P1_METHODS",
    "P1_METHOD_DIRECTION",
    "P1_MODE",
    "P1_TARGET_ENVIRONMENT",
    "P1_MAX_TOKENS",
    "P1_MAX_MODEL_CALLS",
    "P1_MAX_REMAINING_MS",
    "P1_MODEL_REQUEST_ID",
    "load_p1_manifest",
    "validate_p1_manifest",
    "parse_p1_frame",
    "validate_p1_payload",
    "check_p1_binding",
    "classify_p1_method",
]

P1_PROTOCOL_VERSION = "1.0-p1-local"
P1_MANIFEST_FORMAT = "astra-p1-local-manifest-v1"
P1_SCHEMA_DIALECT = "astra-p0-schema-subset-v1"
P1_MODE = "MOCK_ONLY"
P1_TARGET_ENVIRONMENT = "TARGET_UNVERIFIED"
P1_MAX_TOKENS = 8192
P1_MAX_MODEL_CALLS = 1
P1_MAX_REMAINING_MS = 5000
P1_MODEL_REQUEST_ID = "model-1"

P1_METHODS = (
    "runtime.initialize",
    "session.solve",
    "model.generate",
    "session.stop",
)

P1_METHOD_DIRECTION = {
    "runtime.initialize": "host-to-node",
    "session.solve": "host-to-node",
    "model.generate": "node-to-host",
    "session.stop": "host-to-node",
}


def _fail(code):
    raise ProtocolError(code)


def load_p1_manifest(path=None):
    """Load and cross-check the P1 manifest relative to this file."""
    if path is None:
        path = (
            Path(__file__).resolve().parents[2]
            / "packages"
            / "protocol"
            / "schema"
            / "p1.schema.json"
        )
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
    return validate_p1_manifest(manifest)


def validate_p1_manifest(raw):
    if not isinstance(raw, dict):
        _fail("MANIFEST_INVALID")
    if raw.get("format") != P1_MANIFEST_FORMAT:
        _fail("MANIFEST_INVALID")
    if raw.get("schemaDialect") != P1_SCHEMA_DIALECT:
        _fail("MANIFEST_INVALID")
    if raw.get("protocolVersion") != P1_PROTOCOL_VERSION:
        _fail("VERSION_MISMATCH")
    prompt = raw.get("systemPrompt")
    if not isinstance(prompt, str) or not prompt or len(prompt) > 8192:
        _fail("MANIFEST_INVALID")
    limits = raw.get("limits")
    if not isinstance(limits, dict):
        _fail("MANIFEST_INVALID")
    for key, expected in LIMITS.items():
        if limits.get(key) != expected:
            _fail("MANIFEST_INVALID")
    envelopes = raw.get("envelopes")
    if not isinstance(envelopes, dict):
        _fail("MANIFEST_INVALID")
    for key in ("request", "success", "failure"):
        node = envelopes.get(key)
        if not isinstance(node, dict):
            _fail("MANIFEST_INVALID")
        assert_supported_schema(node)
    methods = raw.get("methods")
    if not isinstance(methods, dict):
        _fail("MANIFEST_INVALID")
    for name in methods:
        if name not in P1_METHODS:
            _fail("MANIFEST_INVALID")
    for name in P1_METHODS:
        entry = methods.get(name)
        if not isinstance(entry, dict):
            _fail("MANIFEST_INVALID")
        if entry.get("direction") != P1_METHOD_DIRECTION[name]:
            _fail("MANIFEST_INVALID")
        if entry.get("kind") != "request":
            _fail("MANIFEST_INVALID")
        for side in ("params", "result"):
            node = entry.get(side)
            if not isinstance(node, dict):
                _fail("MANIFEST_INVALID")
            assert_supported_schema(node)
    return raw


def parse_p1_frame(data, manifest):
    """Strict parse of one P1 frame using the shared P0 parser."""
    return parse_frame(data, manifest)


def validate_p1_payload(method, side, value, manifest):
    """Validate one P1 payload against the manifest node for that method side."""
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


def classify_p1_method(method):
    if method in P1_METHODS:
        return method
    _fail("UNKNOWN_METHOD")


def check_p1_binding(params, expected_session_id):
    if params.get("protocolVersion") != P1_PROTOCOL_VERSION:
        _fail("VERSION_MISMATCH")
    if params.get("sessionId") != expected_session_id:
        _fail("SESSION_MISMATCH")
