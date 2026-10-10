"""Subprocess timeout guard for calls that may hang at C level (e.g. SymPy).

Fork-based so a wedged child can be killed and its process reclaimed.
"""
from __future__ import annotations

import multiprocessing
from typing import Any, Callable


def _worker(queue, func, args, kwargs):
    try:
        queue.put(("ok", func(*args, **kwargs)))
    except Exception as e:  # noqa: BLE001 - child must report, not crash silently
        queue.put(("error", repr(e)))


def run_with_timeout(
    func: Callable[..., Any], timeout_ms: int, *args, **kwargs
) -> tuple[str, Any]:
    """Run func in a forked child with a hard timeout.

    Returns (status, payload) with status in {"ok", "error", "timeout"}.
    """
    ctx = multiprocessing.get_context("fork")
    queue = ctx.Queue()
    proc = ctx.Process(target=_worker, args=(queue, func, args, kwargs))
    proc.start()
    try:
        tag, payload = queue.get(timeout=timeout_ms / 1000.0)
    except Exception:  # queue.Empty and friends
        proc.kill()
        proc.join(timeout=2)
        return "timeout", None
    proc.join(timeout=2)
    if proc.is_alive():
        proc.kill()
        proc.join(timeout=2)
    return ("ok", payload) if tag == "ok" else ("error", payload)
