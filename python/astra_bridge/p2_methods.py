"""Fixture-only method adapter over the existing read-only MethodCatalog.

This module is a thin, dependency-free bridge for the offline P2 fixture
composition root. It does not reimplement the catalog reader, does not accept
a path or root from the caller, and never executes model code. Each CLI run is
an independent fixture process: there is no session-level cache and this is
not a formal host RPC.

Failures are fixed codes only. No absolute path, no underlying exception text
and no partial body is ever emitted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys

from mathagent.lite.methods import (
    EXPECTED_VERSION,
    MAX_METHOD_ID_CHARS,
    METHOD_ID_RE,
    MethodCatalog,
)

__all__ = ["fixture_catalog", "fixture_load", "main"]

_MAX_BODY_CHARS = 24000
_MAX_ROUTING_TOKENS = 6
_ROUTING_TOKEN_RE = re.compile(r"^[a-z0-9_]{1,24}$")
_METHOD_ROLES = frozenset({"method", "decision"})
_ROUTING_FIELDS = ("tasks", "objects", "structures")


def _catalog_or_new(catalog):
    if catalog is None:
        return MethodCatalog()
    return catalog


def _valid_routing_tokens(value):
    """True only for one bounded list of canonical routing tokens."""
    if not isinstance(value, list) or len(value) > _MAX_ROUTING_TOKENS:
        return False
    for item in value:
        if not isinstance(item, str) or not _ROUTING_TOKEN_RE.fullmatch(item):
            return False
    return True


def fixture_catalog(catalog=None):
    """Return ``{"version", "entries"}`` with bounded advisory metadata.

    Every entry keeps ``id``/``title`` and carries the optional ``tasks``,
    ``objects``, ``structures`` and ``role`` fields when they are in shape.
    An out-of-shape metadata field is dropped, never passed through. An
    unavailable catalog yields an empty entry list rather than an error, so
    the TS side can disable the port and continue direct reasoning.
    """
    try:
        active = _catalog_or_new(catalog)
        # The reader keeps its narrow id/title default for the legacy lite
        # runtime; the Host bridge is the only caller that asks for the
        # advisory routing metadata. A reader that does not accept the flag
        # (an injected stub, or an older reader) still works: it simply yields
        # the narrow rows and the prompt stays unchanged.
        try:
            entries, _diagnostic = active.catalog(include_metadata=True)
        except TypeError:
            entries, _diagnostic = active.catalog()
        rows = []
        for row in entries:
            method_id = row.get("id")
            title = row.get("title")
            if not isinstance(method_id, str) or not isinstance(title, str):
                continue
            entry = {"id": method_id, "title": title}
            for field in _ROUTING_FIELDS:
                value = row.get(field)
                if _valid_routing_tokens(value):
                    entry[field] = list(value)
            role = row.get("role")
            if isinstance(role, str) and role in _METHOD_ROLES:
                entry["role"] = role
            rows.append(entry)
        return {"version": EXPECTED_VERSION, "entries": rows}
    except Exception:
        return {"version": EXPECTED_VERSION, "entries": []}


def _refuse(status):
    return {"status": status, "asset": None}


def fixture_load(method_id, catalog=None):
    """Load one method body after a full integrity re-check.

    A non-canonical id is refused before any read. A ``loaded`` result is only
    returned when the body is non-empty, within the character bound, its
    declared length matches, its sha256 matches the actual bytes, and the title
    agrees with the catalog. Anything else is ``integrity_failed`` with no body.
    """
    if (
        not isinstance(method_id, str)
        or len(method_id) > MAX_METHOD_ID_CHARS
        or not METHOD_ID_RE.fullmatch(method_id)
    ):
        return _refuse("not_found")
    try:
        active = _catalog_or_new(catalog)
        result = active.load(method_id)
        status = getattr(result, "status", None)
        if status == "not_found":
            return _refuse("not_found")
        if status == "disabled":
            return _refuse("disabled")
        if status != "loaded":
            return _refuse("integrity_failed")
        if getattr(result, "method_id", None) != method_id:
            return _refuse("integrity_failed")
        body = getattr(result, "body", None)
        digest = getattr(result, "body_sha256", None)
        body_chars = getattr(result, "body_chars", None)
        title = getattr(result, "title", None)
        if not isinstance(body, str) or not body.strip():
            return _refuse("integrity_failed")
        if len(body) > _MAX_BODY_CHARS:
            return _refuse("integrity_failed")
        if type(body_chars) is not int or body_chars != len(body):
            return _refuse("integrity_failed")
        if not isinstance(digest, str) or hashlib.sha256(body.encode("utf-8")).hexdigest() != digest:
            return _refuse("integrity_failed")
        if not isinstance(title, str) or not title.strip() or active.title(method_id) != title:
            return _refuse("integrity_failed")
        return {
            "status": "loaded",
            "asset": {
                "id": method_id,
                "title": title,
                "version": EXPECTED_VERSION,
                "body": body,
                "bodySha256": digest,
                "bodyChars": body_chars,
            },
        }
    except Exception:
        return _refuse("disabled")


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False, exit_on_error=False, allow_abbrev=False)
    parser.add_argument("--method", dest="method", default=None)
    try:
        args, unknown = parser.parse_known_args(argv)
    except Exception:
        sys.stdout.write(json.dumps(_refuse("disabled"), ensure_ascii=False))
        sys.stdout.write("\n")
        return 2
    if unknown:
        sys.stdout.write(json.dumps(_refuse("disabled"), ensure_ascii=False))
        sys.stdout.write("\n")
        return 2
    if args.method is None:
        payload = fixture_catalog()
    else:
        payload = fixture_load(args.method)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
