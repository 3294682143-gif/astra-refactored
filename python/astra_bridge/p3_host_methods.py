"""P3 Host pure method-catalog validator (no I/O, no execution).

This helper only cross-checks a catalog snapshot the Host already holds. It
reads no file, imports no context module and spawns nothing. A wire-level
violation raises the fixed code FIELD_VALUE; the caller decides separately
whether an unavailable resource should degrade to an empty catalog.
"""

from __future__ import annotations

import copy

from .p0_probe import ProbeError

__all__ = ["checked_catalog"]

_VERSION = "1.1.0"
_MAX_ENTRIES = 20
_MAX_ID_CHARS = 64
_MAX_TITLE_CHARS = 256
_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


def _fail():
    raise ProbeError("FIELD_VALUE")


def _code_points(value):
    count = 0
    index = 0
    length = len(value)
    while index < length:
        unit = ord(value[index])
        if 0xD800 <= unit <= 0xDBFF:
            if index + 1 >= length:
                return None
            if not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                return None
            index += 2
        elif 0xDC00 <= unit <= 0xDFFF:
            return None
        else:
            index += 1
        count += 1
    return count


def _canonical_id(value):
    if not isinstance(value, str) or not value or len(value) > _MAX_ID_CHARS:
        _fail()
    if value[0] == "-" or value[-1] == "-" or "--" in value:
        _fail()
    for ch in value:
        if ch not in _ID_CHARS:
            _fail()
    return value


def _title(value):
    if not isinstance(value, str) or not value.strip():
        _fail()
    length = _code_points(value)
    if length is None or length > _MAX_TITLE_CHARS:
        _fail()
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail()
    return value


def checked_catalog(raw):
    """Validate one catalog snapshot; an empty entry list is valid."""
    if not isinstance(raw, dict):
        _fail()
    if set(raw.keys()) != {"version", "entries"} or len(raw) != 2:
        _fail()
    if raw["version"] != _VERSION:
        _fail()
    entries = raw["entries"]
    if not isinstance(entries, list):
        _fail()
    if len(entries) not in (0, _MAX_ENTRIES):
        _fail()
    seen = set()
    out = []
    for entry in entries:
        if not isinstance(entry, dict):
            _fail()
        if set(entry.keys()) != {"id", "title"} or len(entry) != 2:
            _fail()
        method_id = _canonical_id(entry["id"])
        if method_id in seen:
            _fail()
        seen.add(method_id)
        out.append({"id": method_id, "title": _title(entry["title"])})
    return copy.deepcopy({"version": _VERSION, "entries": out})
