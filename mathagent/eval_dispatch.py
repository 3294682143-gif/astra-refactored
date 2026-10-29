"""Incremental local evaluation admission and operational, non-scoring metrics."""

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from .finalization import UNSOLVED


def not_attempted(item):
    return {
        "idx": item["idx"],
        "final_response": UNSOLVED,
        "status": "not_attempted",
        "execution": {
            "attempted": False,
            "provider_success": False,
            "run_can_continue": False,
            "bootstrap_succeeded": False,
            "not_attempted_due_to_guard": True,
            "remote_usage_unknown": False,
        },
    }


def bounded_evaluate(items, solve, *, can_start, on_result, parallelism=3):
    """Serial until communication is established, then at most three pending.

    can_start must share the transport guard, so an error observed in one worker
    prevents additional dispatch even before that worker's solve returns.
    """
    if type(parallelism) is not int or not 1 <= parallelism <= 3:
        raise ValueError("evaluation has at most three active items")
    results, next_index, gate_open = [], 0, False

    def accept(row):
        results.append(row)
        on_result(row)
        return row.get("execution", {}).get("run_can_continue") is True

    while next_index < len(items) and can_start():
        row = solve(items[next_index])
        permitted = accept(row)
        next_index += 1
        if not permitted:
            break
        if row.get("execution", {}).get("bootstrap_succeeded") is True:
            gate_open = can_start()
            break
    if gate_open:
        with ThreadPoolExecutor(max_workers=parallelism) as pool:
            pending = set()
            while pending or next_index < len(items):
                while (
                    gate_open
                    and next_index < len(items)
                    and len(pending) < parallelism
                    and can_start()
                ):
                    pending.add(pool.submit(solve, items[next_index]))
                    next_index += 1
                if not pending:
                    break
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    gate_open = accept(future.result()) and gate_open
    for item in items[next_index:]:
        accept(not_attempted(item))
    return results


def execution_summary(rows):
    entries = [r.get("execution", {}) for r in rows]
    return {
        "total_items": len(rows),
        "attempted_items": sum(bool(e.get("attempted")) for e in entries),
        "provider_success_items": sum(bool(e.get("provider_success")) for e in entries),
        "items_with_truncation": sum(bool(e.get("had_truncation")) for e in entries),
        "incomplete_delivery_calls": sum(
            e.get("incomplete_delivery_calls", 0) for e in entries
        ),
        "run_stop_reasons": sorted(
            {e["run_stop_reason"] for e in entries if e.get("run_stop_reason")}
        ),
        "not_attempted_due_to_guard": sum(
            bool(e.get("not_attempted_due_to_guard")) for e in entries
        ),
        "remote_usage_unknown_items": sum(
            bool(e.get("remote_usage_unknown")) for e in entries
        ),
        "unsolved_items": sum(r.get("final_response") == UNSOLVED for r in rows),
        "mathematical_quality_evaluated": False,
        "scoring": "separate frozen judge; operational status never rewrites the original grade",
    }
