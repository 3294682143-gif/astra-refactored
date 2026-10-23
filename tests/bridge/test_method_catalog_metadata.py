"""Bounded method-catalog routing metadata at the Python catalog boundary."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest

from mathagent.lite.methods import MethodCatalog
from python.astra_bridge import p2_methods
from python.astra_bridge.p0_probe import ProbeError
from python.astra_bridge.p3_host_methods import checked_catalog

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "mathagent" / "resources" / "general_v11" / "data" / "methods.json"
TOKEN_RE = re.compile(r"^[a-z0-9_]{1,24}$")
FIELDS = ("tasks", "objects", "structures")


def _registry():
    return json.loads(REGISTRY.read_text(encoding="utf-8"))["methods"]


def _expected_tokens(value):
    return [item for item in value if isinstance(item, str) and TOKEN_RE.fullmatch(item)][:6]


def test_catalog_metadata_is_bounded_and_ids_match_the_registry():
    rows = _registry()
    # The reader's default shape stays the narrow id/title contract; the Host
    # bridge asks for metadata explicitly.
    narrow, narrow_diagnostic = MethodCatalog().catalog()
    assert narrow_diagnostic is None
    assert all(set(entry) == {"id", "title"} for entry in narrow)
    entries, diagnostic = MethodCatalog().catalog(include_metadata=True)
    assert diagnostic is None
    assert [entry["id"] for entry in entries] == [row["id"] for row in rows]
    assert [entry["id"] for entry in p2_methods.fixture_catalog()["entries"]] == [
        row["id"] for row in rows
    ]
    by_id = {row["id"]: row for row in rows}
    for entry in entries:
        source = by_id[entry["id"]]
        assert entry["title"] == source["title"]
        assert set(entry) >= {"id", "title", *FIELDS}
        for field in FIELDS:
            assert entry[field] == _expected_tokens(source[field])
            assert len(entry[field]) <= 6
            assert all(TOKEN_RE.fullmatch(token) for token in entry[field])
        assert entry["role"] == source["card_role"]
        assert entry["role"] in {"method", "decision"}
        assert "body" not in entry and "path" not in entry


class _FakeCatalog:
    def catalog(self):
        return [
            {
                "id": "linearization-spectral",
                "title": "Linearization",
                "tasks": ["solve", "x" * 25, "Free Text", 7],
                "objects": ["matrix"],
                "structures": ["rank", "eigenvalue"],
                "role": "decision",
            },
            {
                "id": "algebraic-structures",
                "title": "Algebra",
                "tasks": ["prove"],
                "objects": ["group"],
                "structures": ["homomorphism"],
                "role": "not-a-role",
            },
        ], None


def test_fixture_drops_odd_metadata_instead_of_passing_it_through():
    entries = p2_methods.fixture_catalog(_FakeCatalog())["entries"]
    first, second = entries
    assert "tasks" not in first
    assert first["objects"] == ["matrix"]
    assert first["structures"] == ["rank", "eigenvalue"]
    assert first["role"] == "decision"
    assert second["tasks"] == ["prove"]
    assert "role" not in second


@pytest.mark.parametrize(
    "field,value",
    [
        ("tasks", ["ok", "x" * 25]),
        ("objects", ["Free Text"]),
        ("structures", ["rank"] * 7),
        ("role", "ADMIN"),
    ],
)
def test_checked_catalog_refuses_out_of_shape_metadata(field, value):
    payload = p2_methods.fixture_catalog()
    payload["entries"][0][field] = value
    with pytest.raises(ProbeError) as exc:
        checked_catalog(payload)
    assert exc.value.code == "FIELD_VALUE"


def test_checked_catalog_preserves_valid_metadata():
    payload = p2_methods.fixture_catalog()
    checked = checked_catalog(copy.deepcopy(payload))
    assert checked == payload
    assert set(checked["entries"][0]) >= {"id", "title", *FIELDS, "role"}


def test_fixture_catalog_still_degrades_to_empty_when_reader_fails():
    class _RaisingCatalog:
        def catalog(self):
            raise RuntimeError("private reader failure")

    assert p2_methods.fixture_catalog(_RaisingCatalog()) == {
        "version": "1.1.0",
        "entries": [],
    }
