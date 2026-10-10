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

from mathagent.entrypoint import ReasoningAgent as _ReasoningAgent


class ReasoningAgent(_ReasoningAgent):
    def __init__(self, client, *args, **kwargs):
        kwargs.setdefault("_entry_load_started", _LOAD_STARTED)
        super().__init__(client, *args, **kwargs)


__all__ = ["ReasoningAgent"]
