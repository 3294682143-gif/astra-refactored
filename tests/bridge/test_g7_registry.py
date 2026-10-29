"""G7/PR7 Slice 7b — Host math-asset registry + integrity tests."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import host_assets_registry as reg  # noqa: E402


def test_registry_enumerates_the_rc2_math_assets():
    snap = reg.registry_snapshot(ROOT)
    assert snap["counts"]["outputCheckers"] == 10  # the 10 exact output checkers
    assert snap["counts"]["mathFamilies"] >= 21  # RC2 math families (>=21)
    assert snap["counts"]["skills"] >= 1
    assert snap["counts"]["prompts"] >= 1
    # The known exact checkers are all present.
    for name in ("algebraic.py", "diophantine.py", "geometry.py", "symbolic.py"):
        assert name in snap["outputCheckers"]["entries"]


def test_registry_integrity_verifies():
    result = reg.verify_integrity(ROOT)
    assert result["ok"] is True
    assert result["errors"] == []
