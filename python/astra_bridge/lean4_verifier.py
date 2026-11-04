"""
Bridge re-export for the Lean 4 controlled formal verifier.
Maintains strict unidirectional dependency: astra_bridge -> mathagent.core.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from mathagent.core.lean4_verifier import (  # noqa: E402
    Lean4Verifier,
    _DEFAULT_VERIFIER,
    _safe_sympify,
    verify_obligation,
)

__all__ = [
    "Lean4Verifier",
    "verify_obligation",
    "_DEFAULT_VERIFIER",
    "_safe_sympify",
]
