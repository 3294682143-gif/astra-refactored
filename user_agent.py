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

_ENGINES = {"lite", "legacy", "ts"}


class ReasoningAgent:
    """Public entry point with an explicit engine switch.

    The formal default engine is the unified TypeScript AgentLoop (``engine="ts"``):
    the Host starts the Node runtime and drives M1-M5 under one root session. The
    lightweight typed-action path remains available only as an explicit
    ``engine="lite"`` choice, and the original Controller as ``engine="legacy"``.
    Unknown engines and unsupported parameters are rejected rather than silently
    ignored, and a failure on the TS path surfaces as an error/unsolved result —
    it is never silently downgraded to lite/legacy.
    """

    def __init__(self, client, *args, **kwargs):
        engine = kwargs.pop("engine", "ts")
        if engine not in _ENGINES:
            raise ValueError("unknown engine")
        self.engine = engine
        if engine == "ts":
            if args:
                raise TypeError("ts engine accepts keyword arguments only")
            from python.astra_bridge.agent_runtime import AgentRuntime

            self._impl = AgentRuntime(client, **kwargs)
            return
        if engine == "legacy":
            from mathagent.entrypoint import ReasoningAgent as _LegacyReasoningAgent

            kwargs.setdefault("_entry_load_started", _LOAD_STARTED)
            self._impl = _LegacyReasoningAgent(client, *args, **kwargs)
            return
        if args:
            raise TypeError("lite engine accepts keyword arguments only")
        from mathagent.lite.runtime import LiteRuntime

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

    def solve(self, problem, metadata=None, resume_checkpoint=None):
        if resume_checkpoint is None:
            return self._impl.solve(problem, metadata)
        if self.engine != "ts":
            raise TypeError("resume_checkpoint requires engine='ts'")
        return self._impl.solve(problem, metadata, resume_checkpoint=resume_checkpoint)


__all__ = ["ReasoningAgent"]
