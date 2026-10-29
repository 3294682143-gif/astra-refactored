"""G7/PR7 Slice 7e — the `methodCards` registry group.

The general_v11 method cards are registered as their own asset group, addressed by
card id through the authoritative `methods.json` `path` (NOT a math_families
mapping). This test exercises the real Host registry + scoped call.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from python.astra_bridge.host_assets_registry import registry_snapshot
from python.astra_bridge.scoped_asset_call import AssetCallError, scoped_asset_call

ROOT = Path(__file__).resolve().parents[2]
SCOPE = "0" * 63 + "1"  # a canonical 64-hex scope id


def _methods():
    data = json.loads((ROOT / "mathagent/resources/general_v11/data/methods.json").read_text(encoding="utf-8"))
    return {str(row["id"]): str(row["path"]) for row in data["methods"]}


def test_registry_enumerates_method_cards_from_methods_json():
    snap = registry_snapshot(ROOT)
    methods = _methods()
    assert snap["counts"]["methodCards"] == len(methods) == 20
    assert snap["methodCards"]["entries"] == sorted(methods)
    assert "domain-equivalence" in snap["methodCards"]["entries"]


def test_scoped_call_resolves_a_method_card_by_id():
    methods = _methods()
    card = ROOT / "mathagent/resources/general_v11" / methods["domain-equivalence"]
    descriptor = scoped_asset_call(
        "methodCards", "domain-equivalence", scope_id=SCOPE, contract_version=1, root=ROOT
    )
    assert descriptor["group"] == "methodCards"
    assert descriptor["assetId"] == "domain-equivalence"
    assert descriptor["sha256"] == hashlib.sha256(card.read_bytes()).hexdigest()


def test_scoped_call_refuses_unknown_or_uncanonical_inputs():
    for kwargs, code in (
        (dict(asset_id="not-a-card"), "UNKNOWN_ASSET"),
        (dict(asset_id="domain-equivalence", scope_id="short"), "BAD_SCOPE"),
        (dict(asset_id="domain-equivalence", contract_version=99), "BAD_VERSION"),
    ):
        try:
            scoped_asset_call("methodCards", kwargs.pop("asset_id"), scope_id=kwargs.pop("scope_id", SCOPE),
                              contract_version=kwargs.pop("contract_version", 1), root=ROOT)
        except AssetCallError as exc:
            assert exc.code == code, (exc.code, code)
        else:  # pragma: no cover
            raise AssertionError("expected refusal: " + code)
    try:
        scoped_asset_call("noSuchGroup", "x", scope_id=SCOPE, contract_version=1, root=ROOT)
    except AssetCallError as exc:
        assert exc.code == "UNKNOWN_GROUP"
    else:  # pragma: no cover
        raise AssertionError("unknown group accepted")
