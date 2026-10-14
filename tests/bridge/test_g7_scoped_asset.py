"""G7/PR7 Slice 7b — Host-side scoped asset call enforcement tests."""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import scoped_asset_call as s  # noqa: E402

SCOPE = "a" * 64


def test_registered_checker_in_scope_is_returned():
    d = s.scoped_asset_call("outputCheckers", "algebraic.py", scope_id=SCOPE, contract_version=1, root=ROOT)
    assert d["group"] == "outputCheckers" and d["assetId"] == "algebraic.py"
    assert d["scopeId"] == SCOPE and d["contractVersion"] == 1
    assert len(d["sha256"]) == 64


def test_unknown_group_asset_and_bad_scope_are_refused():
    with pytest.raises(s.AssetCallError) as e:
        s.scoped_asset_call("nope", "x", scope_id=SCOPE, contract_version=1, root=ROOT)
    assert e.value.code == "UNKNOWN_GROUP"
    with pytest.raises(s.AssetCallError) as e:
        s.scoped_asset_call("outputCheckers", "absent.py", scope_id=SCOPE, contract_version=1, root=ROOT)
    assert e.value.code == "UNKNOWN_ASSET"
    with pytest.raises(s.AssetCallError) as e:
        s.scoped_asset_call("outputCheckers", "algebraic.py", scope_id="short", contract_version=1, root=ROOT)
    assert e.value.code == "BAD_SCOPE"


def test_contract_version_is_bounded_to_the_accepted_set():
    for v in (1, 2):
        assert s.scoped_asset_call("skills", "symbolic_algebra.md", scope_id=SCOPE, contract_version=v, root=ROOT)["contractVersion"] == v
    with pytest.raises(s.AssetCallError) as e:
        s.scoped_asset_call("skills", "symbolic_algebra.md", scope_id=SCOPE, contract_version=3, root=ROOT)
    assert e.value.code == "BAD_VERSION"
