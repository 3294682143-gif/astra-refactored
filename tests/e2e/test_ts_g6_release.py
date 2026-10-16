"""G6/PR6 (local) — precompiled release manifest verify + no-compile launch E2E."""
from __future__ import annotations
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from python.astra_bridge import agent_runtime  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402
from scripts.build_release_manifest import verify  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

MANIFEST = ROOT / "release" / "BUILD_MANIFEST.json"
BUNDLE = ROOT / "release" / "stdio-runtime.bundle.mjs"
BUNDLE_SCHEMA = ROOT / "release" / "schema"


def test_release_manifest_verifies_offline():
    assert MANIFEST.is_file()
    # Every JS/asset hash matches the working tree; the recorded source commit is
    # an ancestor of HEAD; no npm/tsc needed.
    assert verify(MANIFEST) == 0


def test_precompiled_js_launches_ts_multiturn_without_compiling(process_tracker):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["precompiled"] is True
    assert manifest["requiresNpmInstall"] is False
    assert manifest["requiresRuntimeTsc"] is False
    profile = manifest["lockedRunProfile"]
    agent = user_agent.ReasoningAgent(
        client=FakeClient(),
        engine="ts",
        max_model_calls=profile["maxModelCalls"],
        max_work_units=profile["maxWorkUnits"],
        max_effects=profile["maxEffects"],
        max_reviews=profile["maxReviews"],
        max_method_loads=profile["maxMethodLoads"],
        max_repairs=profile["maxRepairs"],
        max_r0=profile["maxR0"],
    )
    result = agent.solve("Compute 2+2", {"source": "release"})
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    # The real Node child ran the precompiled main.js (no runtime tsc/npm).
    assert any(str(arg).endswith("main.js") for arg in process_tracker[0].args)
    assert process_tracker


def test_precompiled_bundle_runs_without_node_modules(tmp_path, monkeypatch, process_tracker):
    """A self-contained precompiled bundle runs with NO node_modules and NO compile."""
    assert BUNDLE.is_file() and BUNDLE_SCHEMA.is_dir()
    work = tmp_path / "clean"
    work.mkdir()
    shutil.copy(BUNDLE, work / "stdio-runtime.bundle.mjs")
    shutil.copytree(BUNDLE_SCHEMA, work / "schema")
    # No node_modules anywhere under `work`: the bundle inlines every dependency
    # and resolves its manifest from the sibling schema directory.
    assert not (work / "node_modules").exists()
    text = (work / "stdio-runtime.bundle.mjs").read_text(encoding="utf-8")
    assert 'from "@astra' not in text and 'import("@astra' not in text

    monkeypatch.setattr(agent_runtime, "_default_script", lambda: work / "stdio-runtime.bundle.mjs")
    agent = user_agent.ReasoningAgent(
        client=FakeClient(), engine="ts",
        max_model_calls=4, max_work_units=2, max_effects=1, max_reviews=1,
    )
    result = agent.solve("Compute 2+2", {"source": "release"})
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert any(str(arg).endswith("stdio-runtime.bundle.mjs") for arg in process_tracker[0].args)
    assert process_tracker


def test_bundle_rejects_tampered_resume_without_node_modules(tmp_path, monkeypatch, process_tracker):
    """Step 2/3: the precompiled bundle also rejects a forged FINAL resume."""
    import copy

    from python.astra_bridge import host_checkpoint

    work = tmp_path / "clean_tamper"
    work.mkdir()
    shutil.copy(BUNDLE, work / "stdio-runtime.bundle.mjs")
    shutil.copytree(BUNDLE_SCHEMA, work / "schema")
    assert not (work / "node_modules").exists()
    monkeypatch.setattr(agent_runtime, "_default_script", lambda: work / "stdio-runtime.bundle.mjs")

    agent = user_agent.ReasoningAgent(
        client=FakeClient(), engine="ts", mode="local",
        max_model_calls=4, max_work_units=2, max_effects=1, max_reviews=1,
    )
    agent.solve("Compute 2+2", {"source": "release"})
    checkpoint = agent._impl.export_checkpoint("Compute 2+2")
    assert checkpoint is not None
    forged = copy.deepcopy(checkpoint)
    for row in forged["sessionLog"]:
        if row["kind"] == "FINAL":
            row["data"] = {**row["data"], "finalResponse": "FORGED"}
    forged.pop("digest", None)
    forged["digest"] = host_checkpoint._digest(forged)

    resumed = user_agent.ReasoningAgent(
        client=FakeClient(), engine="ts", mode="local",
        max_model_calls=4, max_work_units=2, max_effects=1, max_reviews=1,
    )
    result = resumed.solve("Compute 2+2", {"source": "release"}, resume_checkpoint=forged)
    assert result.get("final_response") != "FORGED"
    assert result["status"] == "unsolved"
    assert any(str(arg).endswith("stdio-runtime.bundle.mjs") for arg in process_tracker[-1].args)


def _clean_bundle_dir(tmp_path, monkeypatch, name):
    work = tmp_path / name
    work.mkdir()
    shutil.copy(BUNDLE, work / "stdio-runtime.bundle.mjs")
    shutil.copytree(BUNDLE_SCHEMA, work / "schema")
    assert not (work / "node_modules").exists()
    monkeypatch.setattr(agent_runtime, "_default_script", lambda: work / "stdio-runtime.bundle.mjs")
    return work


def test_bundle_s1_blocks_bypass_proposals(tmp_path, monkeypatch, process_tracker):
    """S1 on the precompiled bundle: format/empty/degenerate sets rejected."""
    _clean_bundle_dir(tmp_path, monkeypatch, "clean_s1")
    from test_ts_trusted_rc import RepairProposalClient
    for proposal in ("999", "x = 999", "{}", "{0}", "{0, 999}"):
        agent = user_agent.ReasoningAgent(
            client=RepairProposalClient(proposal), engine="ts",
            max_reviews=1, max_repairs=1, max_effects=1, max_model_calls=6, max_work_units=3,
        )
        result = agent.solve("Find all real solutions x(x-1)=0", {"source": "release"})
        assert result["final_response"] == "{1}", proposal
        assert result["stopReason"] == "REVISE_REJECTED", proposal


def test_bundle_s2b_midrun_resume(tmp_path, monkeypatch, process_tracker):
    """S2b on the precompiled bundle: mid-run resume runs 0 WORK, only REVIEW."""
    import copy

    from python.astra_bridge import host_checkpoint

    _clean_bundle_dir(tmp_path, monkeypatch, "clean_s2b")
    first = FakeClient()
    agent = user_agent.ReasoningAgent(
        client=first, engine="ts", mode="local",
        max_model_calls=4, max_work_units=2, max_effects=1, max_reviews=1,
    )
    agent.solve("Compute 2+2", {"source": "release"})
    checkpoint = agent._impl.export_checkpoint("Compute 2+2")
    assert checkpoint is not None
    cut = None
    for index, row in enumerate(checkpoint["sessionLog"]):
        if row["kind"] == "WORKUNIT":
            cut = index + 1
    assert cut is not None
    partial = copy.deepcopy(checkpoint)
    partial["sessionLog"] = partial["sessionLog"][:cut]
    partial["spent"] = {
        "modelCalls": sum(1 for row in partial["sessionLog"] if row["kind"] == "MODEL_REQUEST"),
        "effectCalls": sum(1 for row in partial["sessionLog"] if row["kind"] == "TOOL_OBSERVATION"),
    }
    partial.pop("digest", None)
    partial["digest"] = host_checkpoint._digest(partial)

    resumed_client = FakeClient()
    resumed = user_agent.ReasoningAgent(
        client=resumed_client, engine="ts", mode="local",
        max_model_calls=4, max_work_units=2, max_effects=1, max_reviews=1,
    )
    result = resumed.solve("Compute 2+2", {"source": "release"}, resume_checkpoint=partial)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert resumed_client.calls == 1
