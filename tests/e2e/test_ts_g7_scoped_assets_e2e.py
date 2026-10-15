"""G7/PR7 Slice 7e — scoped math-asset calls (TS<=>Host) registry-layer E2E.

The TS M2/M3/M5 side may only reference a registered math asset within a trusted
scope and contract version; the Host turns such a reference into a bounded,
integrity-checked descriptor or refuses it with a fixed code. This test exercises
that contract for every registered asset (the 10 exact output checkers and the
math-family catalog entries) plus the fail-closed refusals, and asserts the
online-IPC wiring (``asset.scoped`` in the frame schema and ``AgentHost.on_asset``).

Offline: reads the working tree only; no network, no model call.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import agent_host as host_module  # noqa: E402
from python.astra_bridge import host_assets_registry as registry  # noqa: E402
from python.astra_bridge import scoped_asset_call as sac  # noqa: E402

_SCOPE = "a" * 64
_SCHEMA = ROOT / "packages" / "protocol" / "schema" / "agent-host-v13.schema.json"


def test_all_output_checkers_are_scoped_acceptable():
    ids = registry.registry_snapshot(ROOT)["outputCheckers"]["entries"]
    assert len(ids) == 10
    for asset_id in ids:
        for version in (1, 2):
            d = sac.scoped_asset_call("outputCheckers", asset_id, scope_id=_SCOPE,
                                      contract_version=version, root=ROOT)
            assert d["assetId"] == asset_id and d["scopeId"] == _SCOPE
            assert d["contractVersion"] == version and len(d["sha256"]) == 64


def test_all_math_families_are_scoped_acceptable():
    ids = registry.registry_snapshot(ROOT)["mathFamilies"]["entries"]
    assert len(ids) >= 21
    for asset_id in ids:
        d = sac.scoped_asset_call("mathFamilies", asset_id, scope_id=_SCOPE,
                                  contract_version=1, root=ROOT)
        assert d["assetId"] == asset_id and len(d["sha256"]) == 64


def test_out_of_scope_and_unregistered_are_refused_fail_closed():
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("notAGroup", "x", scope_id=_SCOPE, contract_version=1, root=ROOT)
    assert e.value.code == "UNKNOWN_GROUP"
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("outputCheckers", "does-not-exist.py", scope_id=_SCOPE, contract_version=1, root=ROOT)
    assert e.value.code == "UNKNOWN_ASSET"
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("outputCheckers", "computation.py", scope_id="not-a-hash", contract_version=1, root=ROOT)
    assert e.value.code == "BAD_SCOPE"
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("outputCheckers", "computation.py", scope_id=_SCOPE, contract_version=3, root=ROOT)
    assert e.value.code == "BAD_VERSION"


def test_asset_scoped_is_wired_into_the_online_ipc_schema_and_host():
    section = json.loads(_SCHEMA.read_text(encoding="utf-8"))["methods"]["asset.scoped"]
    assert section["direction"] == "node-to-host" and section["kind"] == "request"
    assert set(section["params"]["required"]) == {
        "protocolVersion", "sessionId", "assetGroup", "assetId", "scopeId", "contractVersion"}
    assert section["params"]["additionalProperties"] is False
    assert hasattr(host_module.AgentHost, "on_asset")
