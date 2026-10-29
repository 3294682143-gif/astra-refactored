"""Strict P0 protocol parser/validator for the Python Host side.

The single normative field specification is
``packages/protocol/schema/p0.schema.json``. This module consumes that same
manifest with the same generic schema-subset algorithm as the TypeScript side;
it does not hard-code a second, divergent set of field rules.

Failures are fixed codes. :class:`ProtocolError` never carries raw input text,
a path or an underlying exception message.
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path

__all__ = [
    "PROTOCOL_VERSION",
    "LIMITS",
    "MANIFEST_FORMAT",
    "SCHEMA_DIALECT",
    "ERROR_CODES",
    "ProtocolError",
    "load_manifest",
    "validate_manifest",
    "parse_frame",
    "validate_message",
    "validate_against_schema",
    "assert_supported_schema",
    "classify_method",
    "check_binding",
    "P0_METHODS",
    "REJECTED_METHODS",
]

PROTOCOL_VERSION = "1.0-p0"
MANIFEST_FORMAT = "astra-p0-protocol-manifest-v1"
SCHEMA_DIALECT = "astra-p0-schema-subset-v1"

LIMITS = {
    "maxFrameBytes": 65536,
    "maxFramesPerSession": 1024,
    "maxDepth": 24,
    "maxSafeInteger": 9007199254740991,
    "maxIdChars": 128,
    "maxSessionIdChars": 128,
}

ERROR_CODES = frozenset(
    {
        "FRAME_TOO_LARGE",
        "FRAME_LIMIT_EXCEEDED",
        "INVALID_UTF8",
        "INVALID_JSON",
        "DUPLICATE_KEY",
        "DEPTH_EXCEEDED",
        "UNSAFE_INTEGER",
        "NON_FINITE_NUMBER",
        "FLOAT_TOKEN",
        "EXTRA_FIELD",
        "MISSING_FIELD",
        "FIELD_TYPE",
        "FIELD_VALUE",
        "UNKNOWN_METHOD",
        "REJECTED_METHOD",
        "VERSION_MISMATCH",
        "SESSION_MISMATCH",
        "ID_MISMATCH",
        "UNKNOWN_SCHEMA_KEYWORD",
        "MANIFEST_INVALID",
        "EOF",
        # Phase and budget refusals get their own codes. Without them a run that
        # merely asked for more than the authorized budget, or outlived the root
        # deadline, was reported as a generic field failure.
        "ILLEGAL_TRANSITION",
        "BUDGET",
        "DEADLINE_EXCEEDED",
        # Stage D+ controlled exploration. The Host's capability refusal and the
        # generative-execution gate's own closed refusal vocabulary are fixed
        # codes of their own; without them every exploration refusal would be
        # reported as a generic field failure.
        "ACTION_NOT_ALLOWED",
        "REFUSED_NO_PROFILE",
        "REFUSED_PROFILE_MISMATCH",
        "REFUSED_SHA_MISMATCH",
        "REFUSED_UNBOUNDED",
        "REFUSED_EXECUTION_FAILED",
    }
)

P0_METHODS = (
    "runtime.initialize",
    "runtime.probe",
    "method.catalog",
    "session.stop",
)

REJECTED_METHODS = (
    "model.generate",
    "tool.execute",
    "session.solve",
    "method.load",
    "session.event",
)

_SUPPORTED_KEYWORDS = frozenset(
    {
        "title",
        "description",
        "type",
        "additionalProperties",
        "required",
        "properties",
        "items",
        "enum",
        "const",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "maxItems",
    }
)

_SUPPORTED_TYPES = frozenset(
    {"object", "array", "string", "boolean", "integer", "null"}
)

_INT_RE = re.compile(r"^-?(?:0|[1-9][0-9]*)$")
_JSON_WS = " \t\n\r"
_BOUND_KEYWORDS = ("minimum", "maximum", "minLength", "maxLength", "maxItems")
_LENGTH_KEYWORDS = ("minLength", "maxLength", "maxItems")
# A numeric token longer than this cannot be a safe integer; the bound is
# checked before int() so the result never depends on the interpreter's
# int-conversion digit limit.
_MAX_INT_TOKEN_DIGITS = 16


class ProtocolError(Exception):
    """Fixed-code protocol failure; never carries raw input or a path."""

    def __init__(self, code):
        if code not in ERROR_CODES:
            code = "FIELD_VALUE"
        super().__init__(code)
        self.code = code


def _fail(code):
    raise ProtocolError(code)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def load_manifest(path=None):
    """Load and cross-check the P0 manifest.

    ``path`` defaults to the repository copy located relative to this file, so
    no personal or absolute development path is required.
    """
    if path is None:
        path = (
            Path(__file__).resolve().parents[2]
            / "packages"
            / "protocol"
            / "schema"
            / "p0.schema.json"
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
    return validate_manifest(manifest)


def validate_manifest(raw):
    if not isinstance(raw, dict):
        _fail("MANIFEST_INVALID")
    if raw.get("format") != MANIFEST_FORMAT:
        _fail("MANIFEST_INVALID")
    if raw.get("schemaDialect") != SCHEMA_DIALECT:
        _fail("MANIFEST_INVALID")
    if raw.get("protocolVersion") != PROTOCOL_VERSION:
        _fail("VERSION_MISMATCH")
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
        if name not in P0_METHODS:
            _fail("MANIFEST_INVALID")
    for name in P0_METHODS:
        entry = methods.get(name)
        if not isinstance(entry, dict):
            _fail("MANIFEST_INVALID")
        expected_direction = "node-to-host" if name == "method.catalog" else "host-to-node"
        if entry.get("direction") != expected_direction:
            _fail("MANIFEST_INVALID")
        if entry.get("kind") != "request":
            _fail("MANIFEST_INVALID")
        for side in ("params", "result"):
            node = entry.get(side)
            if not isinstance(node, dict):
                _fail("MANIFEST_INVALID")
            assert_supported_schema(node)
    rejected = raw.get("rejectedMethods")
    if not isinstance(rejected, list):
        _fail("MANIFEST_INVALID")
    for name in REJECTED_METHODS:
        if name not in rejected:
            _fail("MANIFEST_INVALID")
    return raw


# ---------------------------------------------------------------------------
# Schema subset
# ---------------------------------------------------------------------------


def assert_supported_schema(schema):
    """Reject a schema node using keywords this validator does not implement."""
    if not isinstance(schema, dict):
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    for key in schema:
        if key not in _SUPPORTED_KEYWORDS:
            _fail("UNKNOWN_SCHEMA_KEYWORD")
    # A keyword that is present must carry a well-typed value. `None` is a
    # present-but-invalid value, never an absent keyword.
    if "title" in schema and not isinstance(schema["title"], str):
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "description" in schema and not isinstance(schema["description"], str):
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "type" in schema:
        node_type = schema["type"]
        types = node_type if isinstance(node_type, list) else [node_type]
        if not types:
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        for entry in types:
            if not isinstance(entry, str) or entry not in _SUPPORTED_TYPES:
                _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "additionalProperties" in schema and not isinstance(schema["additionalProperties"], bool):
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "required" in schema:
        required = schema["required"]
        if not isinstance(required, list):
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        for entry in required:
            if not isinstance(entry, str):
                _fail("UNKNOWN_SCHEMA_KEYWORD")
    for key in _BOUND_KEYWORDS:
        if key not in schema:
            continue
        bound = schema[key]
        if isinstance(bound, bool) or not isinstance(bound, int):
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        if not -LIMITS["maxSafeInteger"] <= bound <= LIMITS["maxSafeInteger"]:
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        if key in _LENGTH_KEYWORDS and bound < 0:
            _fail("UNKNOWN_SCHEMA_KEYWORD")
    minimum = schema.get("minimum")
    maximum = schema.get("maximum")
    if _is_integer(minimum) and _is_integer(maximum) and minimum > maximum:
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    min_length = schema.get("minLength")
    max_length = schema.get("maxLength")
    if _is_integer(min_length) and _is_integer(max_length) and min_length > max_length:
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "enum" in schema:
        enum_values = schema["enum"]
        if not isinstance(enum_values, list) or not enum_values:
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        for entry in enum_values:
            if not _is_scalar_literal(entry):
                _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "const" in schema and not _is_scalar_literal(schema["const"]):
        _fail("UNKNOWN_SCHEMA_KEYWORD")
    if "properties" in schema:
        properties = schema["properties"]
        if not isinstance(properties, dict):
            _fail("UNKNOWN_SCHEMA_KEYWORD")
        for name in properties:
            assert_supported_schema(properties[name])
    if "items" in schema:
        assert_supported_schema(schema["items"])


def _is_object(value):
    return isinstance(value, dict)


def _is_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_scalar_literal(value):
    """A JSON scalar admissible in ``enum``/``const``: null, string, bool, safe int, finite float."""
    if value is None or isinstance(value, (str, bool)):
        return True
    if _is_integer(value):
        return -LIMITS["maxSafeInteger"] <= value <= LIMITS["maxSafeInteger"]
    if isinstance(value, float):
        return math.isfinite(value)
    return False


def _scalar_equals(value, literal):
    """Compare against a scalar literal without Python's ``True == 1`` collapse."""
    if isinstance(literal, bool):
        return isinstance(value, bool) and value is literal
    if _is_integer(literal):
        return _is_integer(value) and value == literal
    if isinstance(literal, float):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value == literal
    if isinstance(literal, str):
        return isinstance(value, str) and value == literal
    if literal is None:
        return value is None
    return False


def _code_point_length(value):
    """Count code points; a lone surrogate returns ``None``."""
    count = 0
    index = 0
    length = len(value)
    while index < length:
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= length:
                return None
            nxt = ord(value[index + 1])
            if not 0xDC00 <= nxt <= 0xDFFF:
                return None
            index += 2
        elif 0xDC00 <= unit <= 0xDFFF:
            return None
        else:
            index += 1
        count += 1
    return count


def _schema_debug(schema_node):
    """Opt-in diagnostic: append the failing schema node, never the value.

    Enabled only with ``ASTRA_DEBUG_SCHEMA=<path>`` and used while locating a
    rejected field. It records the schema node alone, so no problem text, model
    text or tool argument is ever written.
    """
    path = os.environ.get("ASTRA_DEBUG_SCHEMA")
    if not path:
        return
    try:
        row = json.dumps(schema_node, sort_keys=True, ensure_ascii=True)
    except (TypeError, ValueError):
        row = "<unserializable>"
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(row[:2000] + "\n")
    except OSError:
        pass


def validate_against_schema(value, schema):
    """Validate one value against one schema node of the supported subset."""
    def _bad(code):
        _schema_debug(schema)
        _fail(code)

    if not isinstance(schema, dict):
        _bad("UNKNOWN_SCHEMA_KEYWORD")
    assert_supported_schema(schema)
    node_type = schema.get("type")
    if node_type is not None:
        types = node_type if isinstance(node_type, list) else [node_type]
        matched = False
        for entry in types:
            if entry == "object" and _is_object(value):
                matched = True
            elif entry == "array" and isinstance(value, list):
                matched = True
            elif entry == "string" and isinstance(value, str):
                matched = True
            elif entry == "boolean" and isinstance(value, bool):
                matched = True
            elif entry == "null" and value is None:
                matched = True
            elif (
                entry == "integer"
                and _is_integer(value)
                and -LIMITS["maxSafeInteger"] <= value <= LIMITS["maxSafeInteger"]
            ):
                matched = True
            if matched:
                break
        if not matched:
            _bad("FIELD_TYPE")
    if "const" in schema and not _scalar_equals(value, schema["const"]):
        _bad("FIELD_VALUE")
    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and not any(
        _scalar_equals(value, entry) for entry in enum_values
    ):
        _bad("FIELD_VALUE")
    if isinstance(value, str):
        length = _code_point_length(value)
        if length is None:
            _bad("FIELD_VALUE")
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and not isinstance(min_length, bool):
            if length < min_length:
                _bad("FIELD_VALUE")
        max_length = schema.get("maxLength")
        if isinstance(max_length, int) and not isinstance(max_length, bool):
            if length > max_length:
                _bad("FIELD_VALUE")
    if _is_number(value):
        minimum = schema.get("minimum")
        if _is_number(minimum) and value < minimum:
            _bad("FIELD_VALUE")
        maximum = schema.get("maximum")
        if _is_number(maximum) and value > maximum:
            _bad("FIELD_VALUE")
    if isinstance(value, list):
        max_items = schema.get("maxItems")
        if _is_integer(max_items) and len(value) > max_items:
            _bad("FIELD_VALUE")
        items = schema.get("items")
        if items is not None:
            for item in value:
                validate_against_schema(item, items)
    if _is_object(value):
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    _bad("MISSING_FIELD")
        properties = schema.get("properties")
        props = properties if isinstance(properties, dict) else {}
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    _bad("EXTRA_FIELD")
        for key in props:
            if key in value:
                validate_against_schema(value[key], props[key])


# ---------------------------------------------------------------------------
# Strict frame parsing
# ---------------------------------------------------------------------------


def _scan_depth(text):
    """String-aware depth scan; rejects depth > maxDepth before JSON parsing."""
    depth = 0
    index = 0
    length = len(text)
    while index < length:
        ch = text[index]
        if ch == '"':
            index += 1
            escaped = False
            while index < length:
                cur = text[index]
                if escaped:
                    escaped = False
                elif cur == "\\":
                    escaped = True
                elif cur == '"':
                    break
                index += 1
            if index >= length:
                _fail("INVALID_JSON")
            index += 1
            continue
        if ch in "{[":
            depth += 1
            if depth > LIMITS["maxDepth"]:
                _fail("DEPTH_EXCEEDED")
        elif ch in "}]":
            depth -= 1
        index += 1


def _object_pairs_hook(pairs):
    seen = set()
    result = {}
    for key, value in pairs:
        if key in seen:
            _fail("DUPLICATE_KEY")
        seen.add(key)
        result[key] = value
    return result


def _parse_int(token):
    digits = token[1:] if token.startswith("-") else token
    if len(digits) > _MAX_INT_TOKEN_DIGITS:
        _fail("UNSAFE_INTEGER")
    if not _INT_RE.match(token):
        _fail("FLOAT_TOKEN")
    value = int(token)
    if not -LIMITS["maxSafeInteger"] <= value <= LIMITS["maxSafeInteger"]:
        _fail("UNSAFE_INTEGER")
    return value


def _parse_float(token):
    _fail("FLOAT_TOKEN")


def _parse_finite_float(token):
    try:
        val = float(token)
    except (ValueError, OverflowError):
        _fail("FLOAT_TOKEN")
    if not math.isfinite(val):
        _fail("NON_FINITE_NUMBER")
    return val


def _parse_constant(token):
    _fail("NON_FINITE_NUMBER")


def _reject_surrogates(value):
    if isinstance(value, str):
        if _code_point_length(value) is None:
            _fail("FIELD_VALUE")
        return
    if isinstance(value, list):
        for item in value:
            _reject_surrogates(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if _code_point_length(key) is None:
                _fail("FIELD_VALUE")
            _reject_surrogates(item)


def _check_json_whitespace(text):
    """Only the four canonical JSON whitespace characters may appear outside strings."""
    index = 0
    length = len(text)
    while index < length:
        ch = text[index]
        if ch == '"':
            index += 1
            escaped = False
            while index < length:
                cur = text[index]
                if escaped:
                    escaped = False
                elif cur == "\\":
                    escaped = True
                elif cur == '"':
                    break
                index += 1
            if index >= length:
                _fail("INVALID_JSON")
            index += 1
            continue
        if ch.isspace() and ch not in _JSON_WS:
            _fail("INVALID_JSON")
        index += 1


def decode_frame(data):
    """Decode one NDJSON frame from raw bytes with strict UTF-8 and size checks."""
    if len(data) > LIMITS["maxFrameBytes"]:
        _fail("FRAME_TOO_LARGE")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail("INVALID_UTF8")
    if text.startswith("\ufeff"):
        _fail("INVALID_UTF8")
    return text


def parse_frame(data, manifest):
    """Full strict parse of one frame: UTF-8, size, depth, keys, numbers, JSON."""
    text = decode_frame(data)
    _check_json_whitespace(text)
    _scan_depth(text)
    allow_floats = isinstance(manifest, dict) and manifest.get("protocolVersion") == "1.4-unified-math-assets"
    float_parser = _parse_finite_float if allow_floats else _parse_float
    try:
        raw = json.loads(
            text,
            object_pairs_hook=_object_pairs_hook,
            parse_int=_parse_int,
            parse_float=float_parser,
            parse_constant=_parse_constant,
        )
    except ProtocolError:
        raise
    except ValueError:
        _fail("INVALID_JSON")
    _reject_surrogates(raw)
    return validate_message(raw, manifest)


def _is_valid_id(value):
    if not isinstance(value, str):
        return False
    length = _code_point_length(value)
    return length is not None and 1 <= length <= LIMITS["maxIdChars"]


def validate_message(raw, manifest):
    """Validate an already-parsed value against the P0 envelope shape."""
    if not _is_object(raw):
        _fail("FIELD_TYPE")
    if raw.get("jsonrpc") != "2.0":
        _fail("FIELD_VALUE")
    has_method = "method" in raw
    has_result = "result" in raw
    has_error = "error" in raw
    if has_method:
        shape = "request"
    elif has_result and not has_error:
        shape = "success"
    elif has_error and not has_result:
        shape = "failure"
    else:
        _fail("FIELD_VALUE")
    envelopes = manifest.get("envelopes") if isinstance(manifest, dict) else None
    if not isinstance(envelopes, dict):
        _fail("MANIFEST_INVALID")
    node = envelopes.get(shape)
    if not isinstance(node, dict):
        _fail("MANIFEST_INVALID")
    validate_against_schema(raw, node)
    if shape == "request":
        if not _is_valid_id(raw.get("id")):
            _fail("FIELD_TYPE")
        method = raw.get("method")
        if not isinstance(method, str) or not method:
            _fail("FIELD_TYPE")
        if not _is_object(raw.get("params")):
            _fail("FIELD_TYPE")
        return {
            "jsonrpc": "2.0",
            "id": raw["id"],
            "method": method,
            "params": raw["params"],
        }
    if shape == "success":
        if not _is_valid_id(raw.get("id")):
            _fail("FIELD_TYPE")
        if not _is_object(raw.get("result")):
            _fail("FIELD_TYPE")
        return {"jsonrpc": "2.0", "id": raw["id"], "result": raw["result"]}
    identifier = raw.get("id")
    if identifier is not None and not _is_valid_id(identifier):
        _fail("FIELD_TYPE")
    error = raw.get("error")
    if not _is_object(error):
        _fail("FIELD_TYPE")
    for key in error:
        if key not in ("code", "message"):
            _fail("EXTRA_FIELD")
    if "code" not in error:
        _fail("MISSING_FIELD")
    if "message" not in error:
        _fail("MISSING_FIELD")
    if not _is_integer(error["code"]):
        _fail("FIELD_TYPE")
    if not isinstance(error["message"], str):
        _fail("FIELD_TYPE")
    return {
        "jsonrpc": "2.0",
        "id": identifier,
        "error": {"code": error["code"], "message": error["message"]},
    }


def classify_method(method):
    """Classify a method name against the P0 allowlist and the rejected set."""
    if method in REJECTED_METHODS:
        _fail("REJECTED_METHOD")
    if method in P0_METHODS:
        return method
    _fail("UNKNOWN_METHOD")


def check_binding(params, expected_session_id):
    """Check protocolVersion and sessionId binding for one request."""
    if params.get("protocolVersion") != PROTOCOL_VERSION:
        _fail("VERSION_MISMATCH")
    if params.get("sessionId") != expected_session_id:
        _fail("SESSION_MISMATCH")
