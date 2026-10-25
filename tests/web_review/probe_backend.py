"""Independent verification probe (backend) for defects #1, #2, #5.

Usage:  C:\\Python314\\python.exe tests/web_review/probe_backend.py <treeRoot> [label]

Read-only wrt the tree: it only imports the tree's python package and exercises the
public ExecutionManager / Store / app functions against private temp data roots.
It never writes to implementation files and never touches the running BFF.

Defect #1: BFF fabricated fixed events marked sourceKind=official_result and returned the
           same fabricated candidate for different problems.
Defect #2: run records were labelled L3 unconditionally; unknown run must be a real 404.
Defect #5: same idempotency key started a second execution; terminal record could be overwritten.
"""
from __future__ import annotations
import asyncio, json, sys, tempfile, traceback
from pathlib import Path

tree = Path(sys.argv[1]).resolve()
label = sys.argv[2] if len(sys.argv) > 2 else str(tree)
sys.path.insert(0, str(tree))

from python.astra_web.storage import Store, DuplicateRunError  # noqa: E402
from python.astra_web.queue import ExecutionManager             # noqa: E402
from python.astra_web.app import create_app, get_run            # noqa: E402
from starlette.exceptions import HTTPException                  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="astra_probe_"))
out = {"tree": str(tree), "label": label, "tmp": str(TMP)}


def rid_of(res):
    return res["run_id"] if isinstance(res, dict) else res


async def settle(mgr, seconds=3.0):
    if hasattr(mgr, "wait_idle"):
        await mgr.wait_idle(timeout=seconds)
    else:
        await asyncio.sleep(seconds)


def mkreq(app, path_params):
    from starlette.requests import Request
    scope = {"type": "http", "app": app, "method": "GET", "path": "/",
             "query_string": b"", "headers": [], "path_params": path_params}
    return Request(scope)


# ------------------------------------------------------------------ defect #1
async def probe_fabrication():
    store = Store(TMP / "fab")
    mgr = ExecutionManager(store)
    rA = rid_of(await mgr.enqueue_run(problem="证明质数有无穷多个"))
    rB = rid_of(await mgr.enqueue_run(problem="构造任意阶幻方"))
    await settle(mgr)
    histA = mgr.get_history_events(rA)
    official = [e for e in histA if e.get("sourceKind") == "official_result"]
    runA = store.get_run(rA) or {}
    runB = store.get_run(rB) or {}
    sumA, sumB = runA.get("summary", {}), runB.get("summary", {})
    ansA = sumA.get("final_response") or sumA.get("answer")
    ansB = sumB.get("final_response") or sumB.get("answer")
    fabricated = (len(official) > 0) or (sumA.get("status") == "candidate")
    return {
        "events_emitted_by_bff": len(histA),
        "events_stamped_official_result": len(official),
        "runA_status": sumA.get("status"),
        "runB_status": sumB.get("status"),
        "runA_final_response": ansA,
        "runB_final_response": ansB,
        "different_problems_get_byte_identical_answer": (ansA == ansB and ansA is not None),
        "fabricated_event_or_candidate_status": fabricated,
    }


# ------------------------------------------------------------------ defect #5a
async def probe_idempotency():
    ctl_store = Store(TMP / "ctl")
    ctl = ExecutionManager(ctl_store)
    crid = rid_of(await ctl.enqueue_run(problem="same-problem"))
    await settle(ctl)
    ctl_hist = len(ctl.get_history_events(crid))

    d_store = Store(TMP / "dup")
    d = ExecutionManager(d_store)
    r1 = await d.enqueue_run(problem="same-problem", idempotency_key="IDEMKEY1")
    await asyncio.sleep(0)
    r2 = await d.enqueue_run(problem="same-problem", idempotency_key="IDEMKEY1")
    await settle(d)
    drid = rid_of(r1)
    d_hist = len(d.get_history_events(drid))
    started_total = d.stats().get("started_total") if hasattr(d, "stats") else None
    second_started = (d_hist > ctl_hist) or (isinstance(r2, dict) and r2.get("started") is True)
    return {
        "single_submission_history_events": ctl_hist,
        "duplicate_submission_history_events": d_hist,
        "same_run_id_returned": rid_of(r1) == rid_of(r2),
        "second_call_result": r2 if isinstance(r2, dict) else "(str run_id in this version)",
        "started_total": started_total,
        "second_execution_started": second_started,
    }


# ------------------------------------------------------------------ defect #5b
def probe_terminal_overwrite():
    store = Store(TMP / "ovr")
    base = dict(run_id="run-ovr", created_at=1.0, source="worker", status="running",
                scenario="s", model=None, seed=None, duration_s=0.0,
                summary_json=json.dumps({"status": "running"}), l2_path=None,
                l3_path=None, tags="", checksum=None)
    store.save_run(base, overwrite=True)
    terminal = dict(base, status="candidate", summary_json=json.dumps({"status": "candidate", "final_response": "A"}))
    store.save_run(terminal, overwrite=True)
    raised = False
    err = None
    try:
        store.save_run(dict(terminal, summary_json=json.dumps({"status": "candidate", "final_response": "OVERWRITTEN"})), overwrite=True)
    except DuplicateRunError as exc:
        raised = True
        err = type(exc).__name__
    final = store.get_run("run-ovr")
    return {
        "terminal_overwrite_refused": raised,
        "exception": err,
        "stored_final_response_after_attempt": final["summary"].get("final_response"),
    }


# ------------------------------------------------------------------ defect #2
def probe_detail_level_and_404():
    app = create_app(data_root=TMP / "app", mount_static=False)
    unknown_404 = False
    try:
        get_run(mkreq(app, {"run_id": "definitely-missing"}))
    except HTTPException as exc:
        unknown_404 = (exc.status_code == 404)
    mgr = app.state.execution_manager
    store = app.state.store
    run = dict(run_id="run-l1", created_at=1.0, source="worker", status="error",
               scenario="s", model=None, seed=None, duration_s=0.0,
               summary_json=json.dumps({"status": "error", "final_response": "Unsolved.", "executed": False}),
               l2_path=None, l3_path=None, tags="", checksum=None)
    store.save_run(run, overwrite=True)
    resp = get_run(mkreq(app, {"run_id": "run-l1"}))
    body = json.loads(resp.body.decode("utf-8"))
    return {
        "unknown_run_is_404": unknown_404,
        "detail_level_field_present": "detail_level" in body,
        "detail_level_value": body.get("detail_level"),
        "l3_path": body.get("l3_path"),
        "l2_path": body.get("l2_path"),
    }


def main():
    results = {}
    for name, fn in (("defect1_fabrication", probe_fabrication),
                     ("defect5_idempotency", probe_idempotency)):
        try:
            results[name] = asyncio.run(fn())
        except Exception:
            results[name] = {"probe_error": traceback.format_exc()}
    for name, fn in (("defect5_terminal_overwrite", probe_terminal_overwrite),
                     ("defect2_detail_level_404", probe_detail_level_and_404)):
        try:
            results[name] = fn()
        except Exception:
            results[name] = {"probe_error": traceback.format_exc()}
    out["results"] = results
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()