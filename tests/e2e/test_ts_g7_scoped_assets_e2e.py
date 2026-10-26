"""G7/PR7 Slice 7e — scoped math-asset consumption at the real engine="ts" entry.

This is a REAL TS<=>Host subprocess test: the only fake is the injected public
client; the real ``ReasoningAgent(client=..., engine="ts")`` path, the real
Python Host, the real Node ``main.js --agent-loop`` profile and the real
registered tool executor all run.

Covered:
* positive: the flagship run issues a real ``asset.scoped`` for the S1 checker
  and the S3 scope; the bounded, integrity-checked descriptor is what lets the
  revision be released (a refused descriptor is fail-closed, so no revision).
* registry enumeration of the 10 output checkers and the math families.
* negative: a checker whose bytes are tampered (a temp working tree) is detected
  against the FROZEN baseline SHA list as ``ASSET_INTEGRITY_ERROR`` (fail-closed),
  both directly and through the real entry (the candidate is NOT upgraded).
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from python.astra_bridge import agent_host as host_module  # noqa: E402
from python.astra_bridge import host_assets_registry as registry  # noqa: E402
from python.astra_bridge import scoped_asset_call as sac  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402
from test_ts_g3_flagship import G3FlagshipClient  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

_SCOPE = "a" * 64
_SCHEMA = ROOT / "packages" / "protocol" / "schema" / "agent-host-v14.schema.json"
_G3_PROBLEM = "Find all real solutions x(x-1)=0"


def _registry_roots(tmp: Path) -> Path:
    """A minimal but complete copy of the registered asset tree."""
    tmp.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "mathagent" / "output_checks", tmp / "mathagent" / "output_checks")
    shutil.copytree(ROOT / "mathagent" / "resources", tmp / "mathagent" / "resources")
    shutil.copytree(ROOT / "mathagent" / "prompts", tmp / "mathagent" / "prompts")
    (tmp / "math_families").mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / "math_families" / "catalog.json", tmp / "math_families" / "catalog.json")
    return tmp


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


def test_real_entry_consumes_scoped_assets_for_the_revision(process_tracker):
    """The real subprocess run issues asset.scoped; a refused descriptor blocks."""
    client = G3FlagshipClient()
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts",
        max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
    )
    result = agent.solve(_G3_PROBLEM, {"source": "e2e"})
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "{0,1}"
    assert result["reason"] == "REVISED_CANDIDATE"
    # A real TS->Host asset.scoped was served by the Host within a trusted scope.
    assert result["metrics"]["asset_calls"] >= 1
    assert process_tracker


def test_tampered_math_family_algorithm_is_detected(tmp_path):
    """Step 3: a single-byte change to any math_families/** algorithm file fails."""
    root = tmp_path / "fam"
    shutil.copytree(
        ROOT / "math_families",
        root / "math_families",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    victim = next(p for p in (root / "math_families").rglob("*.py"))
    victim.write_bytes(victim.read_bytes() + b"\n# tampered by the test\n")
    assert registry.verify_integrity(root)["ok"] is False
    entries = registry.registry_snapshot(root)["mathFamilies"]["entries"]
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("mathFamilies", entries[0], scope_id=_SCOPE, contract_version=1, root=root)
    assert e.value.code == "ASSET_INTEGRITY_ERROR"


def test_tampered_checker_is_detected_against_the_frozen_baseline(process_tracker, tmp_path, monkeypatch):
    root = _registry_roots(tmp_path / "assets")
    target = root / "mathagent" / "output_checks" / "symbolic.py"
    target.write_bytes(target.read_bytes() + b"\n# tampered by the test\n")

    # Direct: the frozen baseline comparison detects the 1-byte change.
    with pytest.raises(sac.AssetCallError) as e:
        sac.scoped_asset_call("outputCheckers", "symbolic.py", scope_id=_SCOPE, contract_version=1, root=root)
    assert e.value.code == "ASSET_INTEGRITY_ERROR"
    assert registry.verify_integrity(root)["ok"] is False

    # Through the real entry: the tampered tree is the Host asset root, so the
    # S1 checker descriptor is refused fail-closed and the candidate is not
    # upgraded to the revised answer.
    monkeypatch.setattr(host_module, "_REPO_ROOT", root)
    client = G3FlagshipClient()
    agent = user_agent.ReasoningAgent(
        client=client, engine="ts",
        max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
    )
    result = agent.solve(_G3_PROBLEM, {"source": "e2e"})
    # The tampered checker can never ground a revision: the run fails closed and
    # never releases the revised answer.
    assert result["reason"] != "REVISED_CANDIDATE"
    assert result["final_response"] != "{0,1}"
    assert result["metrics"]["asset_calls"] == 0
    assert process_tracker
