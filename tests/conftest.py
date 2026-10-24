"""Global conftest for pytest runs, ensuring Windows compatibility."""

from __future__ import annotations

import sys
import threading

if sys.platform == "win32":
    try:
        from math_families.core import guard

        def _win_run_with_timeout(func, timeout_ms, *args, **kwargs):
            res_box = [None]
            err_box = [None]

            def target():
                try:
                    res_box[0] = func(*args, **kwargs)
                except Exception as exc:
                    err_box[0] = exc

            th = threading.Thread(target=target, daemon=True)
            th.start()
            th.join(timeout=max(timeout_ms / 1000.0, 0.05))
            if th.is_alive():
                return ("timeout", None)
            if err_box[0] is not None:
                raise err_box[0]
            return ("ok", res_box[0])

        guard.run_with_timeout = _win_run_with_timeout
    except Exception:
        pass

    try:
        from math_families.families import diophantine

        def _win_run_isolated(func, *args, timeout_s=5):
            res_box = [None]
            err_box = [None]

            def target():
                try:
                    res_box[0] = func(*args)
                except Exception as exc:
                    err_box[0] = exc

            th = threading.Thread(target=target, daemon=True)
            th.start()
            th.join(timeout=timeout_s)
            if th.is_alive():
                return ("timeout", None)
            if err_box[0] is not None:
                return ("error", str(err_box[0]))
            return ("ok", res_box[0])

        diophantine._run_isolated = _win_run_isolated
    except Exception:
        pass
