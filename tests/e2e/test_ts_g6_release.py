"""G6/PR6 (local) — precompiled release manifest verify + no-compile launch E2E."""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402
from scripts.build_release_manifest import verify  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

MANIFEST = ROOT / "release" / "BUILD_MANIFEST.json"


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
