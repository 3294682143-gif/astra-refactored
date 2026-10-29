"""On-demand, integrity-checked reader for the General Math v1.1 method cards.

The model may only name a short method id. It never supplies a path. The
catalog reads ``SOURCE.json`` first, validates the registry hash, the version,
the 20 unique ids and the canonical ``references/{id}.md`` layout, and only
then exposes ids and titles. A method body is read only on an explicit
``load`` and only when its SHA256 matches the ``SOURCE.json`` entry.

Failures are fixed codes. No absolute path, no underlying exception text and
no partial body is ever returned. A failed integrity check never fabricates a
successful load.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "MethodCatalog",
    "MethodCatalogError",
    "MethodLoad",
    "METHOD_ID_RE",
    "MAX_METHOD_ID_CHARS",
    "EXPECTED_METHOD_COUNT",
    "EXPECTED_VERSION",
    "REGISTRY_REL",
    "SOURCE_REL",
]

SOURCE_REL = "SOURCE.json"
REGISTRY_REL = "data/methods.json"
EXPECTED_METHOD_COUNT = 20
EXPECTED_VERSION = "1.1.0"
MAX_METHOD_ID_CHARS = 64

# Short, canonical, path-free ids only: lowercase letters, digits, hyphens.
METHOD_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

_REGISTRY_SCHEMA = "general-math-methods-v1"
_MAX_BODY_CHARS = 24000
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
# Advisory routing metadata is bounded at the catalog boundary. These are the
# only shapes that may reach the model before an explicit body load.
_MAX_ROUTING_TOKENS = 6
_ROUTING_TOKEN_RE = re.compile(r"^[a-z0-9_]{1,24}$")
_METHOD_ROLES = frozenset({"method", "decision"})


class MethodCatalogError(Exception):
    """Fixed-code catalog failure; never carries raw text or a path."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class MethodLoad:
    """Result of one explicit load attempt.

    ``status`` is one of ``loaded``, ``already_loaded``, ``not_found``,
    ``disabled``, ``over_budget``, ``integrity_failed``. ``body`` is non-empty
    only for ``loaded``.
    """

    status: str
    method_id: str
    title: str
    body: str
    body_sha256: str
    body_chars: int


def _sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _read_bytes(root, rel):
    """Read one fixed relative resource as bytes.

    ``root`` is either a local ``pathlib.Path`` (trusted, test-injectable) or a
    ``importlib.resources`` traversable. For a local path we refuse a symlink
    that resolves outside the allowed root. For a traversable we only ever use
    fixed relative components; the model string is never a path component.
    """
    if isinstance(root, Path):
        # Local pathlib.Path root: resolve the root boundary first so a symlink
        # that escapes the resource root is refused, not followed.
        try:
            base = root.resolve()
        except (OSError, RuntimeError):
            raise MethodCatalogError("resource_unreadable") from None
        candidate = base
        for part in rel.split("/"):
            candidate = candidate / part
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError):
            raise MethodCatalogError("resource_unreadable") from None
        if resolved != base and base not in resolved.parents:
            raise MethodCatalogError("resource_escape")
        try:
            return resolved.read_bytes()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            raise MethodCatalogError("resource_missing") from None
        except OSError:
            raise MethodCatalogError("resource_unreadable") from None
    # importlib.resources Traversable: fixed relative components only.
    target = root
    for part in rel.split("/"):
        target = target.joinpath(part)
    try:
        return target.read_bytes()
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        raise MethodCatalogError("resource_missing") from None
    except OSError:
        raise MethodCatalogError("resource_unreadable") from None


def _decode_utf8(data):
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise MethodCatalogError("resource_not_utf8") from None


def _load_json(root, rel):
    return json.loads(_decode_utf8(_read_bytes(root, rel)))


def _routing_tokens(value):
    """Return only the card's own bounded ASCII tokens, in data order.

    A missing or malformed list yields ``[]``; an odd item is dropped. Nothing
    is inferred from a title, path or body.
    """
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and _ROUTING_TOKEN_RE.fullmatch(item):
            out.append(item)
        if len(out) >= _MAX_ROUTING_TOKENS:
            break
    return out


def _method_role(value):
    return value if isinstance(value, str) and value in _METHOD_ROLES else None


class MethodCatalog:
    """Read-only catalog over the bundled General Math v1.1 resources.

    ``root`` is a trusted injection point for tests (a local directory or an
    ``importlib.resources`` traversable). It is never a model parameter.
    """

    def __init__(self, root=None):
        if root is None:
            from importlib import resources

            root = (
                resources.files("mathagent")
                .joinpath("resources")
                .joinpath("general_v11")
            )
        self._root = root
        self._source = None
        self._methods = None
        self._titles = None
        self._diagnostic = None
        self._load()

    # -- construction -----------------------------------------------------

    def _load(self):
        try:
            source = _load_json(self._root, SOURCE_REL)
            self._validate_source(source)
            registry_bytes = _read_bytes(self._root, REGISTRY_REL)
            expected = source["files"].get(REGISTRY_REL)
            if not isinstance(expected, str) or _sha256_hex(registry_bytes) != expected:
                raise MethodCatalogError("registry_hash_mismatch")
            registry = json.loads(_decode_utf8(registry_bytes))
            methods = self._validate_registry(registry)
        except MethodCatalogError as exc:
            self._diagnostic = exc.code
            return
        except (ValueError, TypeError, KeyError):
            self._diagnostic = "registry_invalid"
            return
        self._source = source
        self._methods = methods
        self._titles = {row["id"]: row["title"] for row in methods}

    def _validate_source(self, source):
        if not isinstance(source, dict):
            raise MethodCatalogError("source_invalid")
        if source.get("version") != EXPECTED_VERSION:
            raise MethodCatalogError("source_version_mismatch")
        files = source.get("files")
        if not isinstance(files, dict) or not files:
            raise MethodCatalogError("source_files_invalid")
        for rel, digest in files.items():
            if not isinstance(rel, str) or not isinstance(digest, str):
                raise MethodCatalogError("source_files_invalid")
            if rel.startswith("/") or ".." in rel.split("/"):
                raise MethodCatalogError("source_files_invalid")
            if not _HEX64_RE.fullmatch(digest):
                raise MethodCatalogError("source_files_invalid")

    def _validate_registry(self, registry):
        if not isinstance(registry, dict):
            raise MethodCatalogError("registry_invalid")
        if registry.get("schema") != _REGISTRY_SCHEMA:
            raise MethodCatalogError("registry_schema_mismatch")
        if registry.get("version") != EXPECTED_VERSION:
            raise MethodCatalogError("registry_version_mismatch")
        rows = registry.get("methods")
        if not isinstance(rows, list) or len(rows) != EXPECTED_METHOD_COUNT:
            raise MethodCatalogError("registry_count_mismatch")
        if registry.get("method_count") != EXPECTED_METHOD_COUNT:
            raise MethodCatalogError("registry_count_mismatch")
        seen = set()
        methods = []
        for row in rows:
            if not isinstance(row, dict):
                raise MethodCatalogError("registry_invalid")
            method_id = row.get("id")
            title = row.get("title")
            path = row.get("path")
            if (
                not isinstance(method_id, str)
                or len(method_id) > MAX_METHOD_ID_CHARS
                or not METHOD_ID_RE.fullmatch(method_id)
            ):
                raise MethodCatalogError("registry_invalid")
            if method_id in seen:
                raise MethodCatalogError("registry_duplicate_id")
            seen.add(method_id)
            if not isinstance(title, str) or not title.strip():
                raise MethodCatalogError("registry_invalid")
            if path != f"references/{method_id}.md":
                raise MethodCatalogError("registry_path_invalid")
            methods.append(
                {
                    "id": method_id,
                    "title": title,
                    "path": path,
                    "tasks": _routing_tokens(row.get("tasks")),
                    "objects": _routing_tokens(row.get("objects")),
                    "structures": _routing_tokens(row.get("structures")),
                    "role": _method_role(row.get("card_role")),
                }
            )
        return methods

    # -- public surface ---------------------------------------------------

    @property
    def available(self):
        return self._methods is not None

    @property
    def diagnostic(self):
        return self._diagnostic

    def catalog(self, include_metadata=False):
        """Return ``(entries, diagnostic)``.

        The default shape is exactly ``{"id", "title"}`` so the legacy lite
        runtime keeps its byte-identical contract. ``include_metadata=True`` —
        used only by the Host bridge that offers advisory routing metadata to
        the TS loop — additionally returns ``tasks`` / ``objects`` /
        ``structures`` (bounded token lists) and ``role`` (``method`` or
        ``decision`` when the card declares it). No body and no path is ever
        exposed here, on either shape.
        """
        if self._methods is None:
            return [], self._diagnostic or "catalog_unavailable"
        out = []
        for row in self._methods:
            entry = {"id": row["id"], "title": row["title"]}
            if include_metadata:
                entry["tasks"] = list(row["tasks"])
                entry["objects"] = list(row["objects"])
                entry["structures"] = list(row["structures"])
                if row["role"] is not None:
                    entry["role"] = row["role"]
            out.append(entry)
        return out, None

    def title(self, method_id):
        if self._titles is None:
            return None
        return self._titles.get(method_id)

    def known(self, method_id):
        return self._titles is not None and method_id in self._titles

    def load(self, method_id):
        """Explicitly load one method body after a full integrity check."""
        if self._methods is None:
            return MethodLoad(
                "disabled", method_id, "", "", "", 0
            )
        if (
            not isinstance(method_id, str)
            or len(method_id) > MAX_METHOD_ID_CHARS
            or not METHOD_ID_RE.fullmatch(method_id)
        ):
            return MethodLoad("not_found", method_id, "", "", "", 0)
        if method_id not in self._titles:
            return MethodLoad("not_found", method_id, "", "", "", 0)
        rel = f"references/{method_id}.md"
        expected = self._source["files"].get(rel)
        if not isinstance(expected, str):
            return MethodLoad("integrity_failed", method_id, "", "", "", 0)
        try:
            raw = _read_bytes(self._root, rel)
        except MethodCatalogError:
            return MethodLoad("integrity_failed", method_id, "", "", "", 0)
        digest = _sha256_hex(raw)
        if digest != expected:
            return MethodLoad("integrity_failed", method_id, "", "", "", 0)
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            return MethodLoad("integrity_failed", method_id, "", "", "", 0)
        if not body.strip() or len(body) > _MAX_BODY_CHARS:
            return MethodLoad("integrity_failed", method_id, "", "", "", 0)
        return MethodLoad(
            "loaded",
            method_id,
            self._titles[method_id],
            body,
            digest,
            len(body),
        )
