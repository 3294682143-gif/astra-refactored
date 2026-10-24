"""Independent probe: (a) four-class terminal mapping, (b) SSE close-frame facts.

Usage: C:\\Python314\\python.exe tests/web_review/probe_sse_terminals.py <treeRoot>
Read-only. Demonstrates that abnormal terminations map to distinct statuses and that the
SSE close frame carries the real terminal facts (which the SolvePage close-listener does not consume).
"""
from __future__ import annotations
import asyncio, json, sys, tempfile, traceback
from pathlib import Path

tree = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(tree))
from python.astra_web.app import create_app, sse_events  # noqa: E402
from python.astra_web.contracts import mapping as M     # noqa: E402
from python.astra_web.contracts.enums import StopReason  # noqa: E402
from starlette.requests import Request                   # noqa: E402

out = {"tree": str(tree)}
TMP = Path(tempfile.mkdtemp(prefix="astra_probe_sse_"))


def mkreq(app, path_params):
    return Request({"type": "http", "app": app, "method": "GET", "path": "/",
                    "query_string": b"", "headers": [], "path_params": path_params})


# ---- (a) terminal mapping ----------------------------------------------------
try:
    rows = {}
    for r in [StopReason.TIMEOUT, StopReason.SPAWN_FAILED, StopReason.CANCELLED,
              StopReason.ERROR, StopReason.NO_CANDIDATE, StopReason.BUDGET_EXHAUSTED,
              StopReason.REVIEWS_COMPLETE]:
        fn = getattr(M, "classify_terminal_kind", None)
        tk = fn(r) if fn else None
        rows[r.value] = {
            "status": M.classify_stop_reason(r).value,
            "terminalKind": (tk.value if hasattr(tk, "value") else tk),
        }
    out["terminal_mapping"] = rows
except Exception:
    out["terminal_mapping"] = {"probe_error": traceback.format_exc()}


# ---- (b) SSE close frame for a run with no solver ----------------------------
async def sse_probe():
    app = create_app(data_root=TMP / "app", mount_static=False)
    mgr = app.state.execution_manager
    store = app.state.store
    res = await mgr.enqueue_run(problem="no-solver probe")
    rid = res["run_id"] if isinstance(res, dict) else res
    if hasattr(mgr, "wait_idle"):
        await mgr.wait_idle(timeout=10.0)
    else:
        await asyncio.sleep(2.0)
    run = store.get_run(rid) or {}
    resp = await sse_events(mkreq(app, {"run_id": rid}))
    chunks = []
    async for ch in resp.body_iterator:
        chunks.append(ch if isinstance(ch, str) else ch.decode("utf-8", "replace"))
        if len(chunks) >= 40:
            break
    return {
        "run_id": rid,
        "stored_status": run.get("status"),
        "stored_summary": run.get("summary"),
        "sse_last_frames": chunks[-3:],
        "close_frame_carries_terminal_facts": ("final_response" in "".join(chunks[-3:])),
    }

try:
    out["sse_close_frame"] = asyncio.run(sse_probe())
except Exception:
    out["sse_close_frame"] = {"probe_error": traceback.format_exc()}

print(json.dumps(out, ensure_ascii=False, indent=2))