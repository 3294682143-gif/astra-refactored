"""Prepare a data root with L1/L2/L3 records for t6 end-to-end level-consistency checks.
Usage: C:\\Python314\\python.exe tests/web_review/probe_t6_data.py <treeRoot> <dataRoot>
Writes only into <dataRoot> (a throwaway temp dir). Read-only wrt implementation.
"""
import json, sys
from pathlib import Path

tree = Path(sys.argv[1]).resolve()
data = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(tree))
from python.astra_web.storage import Store           # noqa: E402
from python.astra_web.archive import atomic_write_json  # noqa: E402

store = Store(data)

# run-l2: real L2 archive present
l2_rel = "runs/run-l2/details.json"
atomic_write_json(store.safe_join(l2_rel), {
    "events": [{"seq": 1, "kind": "SESSION_INIT", "payload": {"sessionId": "run-l2"}},
               {"seq": 2, "kind": "RESULT", "payload": {"status": "candidate", "stopReason": "REVIEWS_COMPLETE", "final_response": "x = 2"}}],
    "summary": {"status": "candidate", "final_response": "x = 2", "candidate_verified": False},
})
store.save_run({
    "run_id": "run-l2", "created_at": 10.0, "source": "import", "status": "candidate",
    "scenario": "level-l2", "model": None, "seed": None, "duration_s": 1.0,
    "summary_json": json.dumps({"status": "candidate", "final_response": "x = 2", "candidate_verified": False}),
    "l2_path": l2_rel, "l3_path": None, "tags": "level:L2", "checksum": None,
}, overwrite=True)

# run-l3: real asset present
asset_rel = "runs/run-l3/artifacts/proof.txt"
ap = store.safe_join(asset_rel)
ap.parent.mkdir(parents=True, exist_ok=True)
ap.write_text("QED", encoding="utf-8")
store.save_run({
    "run_id": "run-l3", "created_at": 11.0, "source": "import", "status": "candidate",
    "scenario": "level-l3", "model": None, "seed": None, "duration_s": 2.0,
    "summary_json": json.dumps({"status": "candidate", "final_response": "QED", "candidate_verified": False}),
    "l2_path": None, "l3_path": asset_rel, "tags": "level:L3", "checksum": None,
}, assets=[{"asset_id": "asset-l3-1", "run_id": "run-l3", "kind": "text",
            "rel_path": asset_rel, "mime": "text/plain", "bytes": 3, "created_at": 11.0}], overwrite=True)

print(json.dumps({"data_root": str(data), "prepared_runs": ["run-l2", "run-l3"]}))