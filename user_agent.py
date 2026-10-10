"""Official file-path loading seam; no editable install/PYTHONPATH prerequisite."""

import sys
import time
from pathlib import Path

_LOAD_STARTED = time.monotonic()
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import mathagent as _package

if Path(_package.__file__).resolve().parent != (_ROOT / "mathagent").resolve():
    raise ImportError(
        "foreign mathagent module cached; load the submission in its own process"
    )

from mathagent.entrypoint import ReasoningAgent as _LegacyReasoningAgent
from mathagent.lite.runtime import LiteRuntime

_ENGINES = {"lite", "legacy"}


class ReasoningAgent:
    """Public entry point with an explicit engine switch.

    The default experimental engine is the lightweight typed-action path. The
    original Controller remains reachable with engine='legacy' and is otherwise
    untouched. Unknown engines and unsupported parameters are rejected rather
    than silently ignored.
    """

    def __init__(self, client, *args, **kwargs):
        engine = kwargs.pop("engine", "lite")
        if engine not in _ENGINES:
            raise ValueError("unknown engine")
        self.engine = engine
        if engine == "legacy":
            kwargs.setdefault("_entry_load_started", _LOAD_STARTED)
            self._impl = _LegacyReasoningAgent(client, *args, **kwargs)
            return
        if args:
            raise TypeError("lite engine accepts keyword arguments only")
        allowed = {
            "policy",
            "load_started",
            "executor",
            "max_steps",
            "problem_seconds",
            "max_methods",
            "max_method_chars",
            "method_catalog",
        }
        unknown = set(kwargs) - allowed
        if unknown:
            raise TypeError("unsupported lite parameter")
        # The lite path deliberately does not inherit the module import time. A
        # fresh instance must not be charged an old global load timestamp; only an
        # explicit caller-supplied load_started constrains the first solve.
        self._impl = LiteRuntime(client, **kwargs)

    def solve(self, problem, metadata=None):
        return self._impl.solve(problem, metadata)


__all__ = ["ReasoningAgent"]
