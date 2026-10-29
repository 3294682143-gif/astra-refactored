"""G7/PR7 Slice 7c — controlled generative-execution gate is fail-closed."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from python.astra_bridge import generated_execution_gate as g  # noqa: E402

SHA = "c" * 64
OTHER = "d" * 64


def _req(**over):
    base = dict(profile_id="wasi-accepted-v1", code_sha256=SHA, max_seconds=5, max_bytes=4096)
    base.update(over)
    return g.ExecutionRequest(**base)


def test_default_gate_is_fail_closed():
    gate = g.GenerativeExecutionGate()
    assert gate.approved is None
    assert gate.decision(_req()) == "REFUSED_NO_PROFILE"
    assert gate.may_execute(_req()) is False


def test_only_an_approved_bounded_profile_is_admitted():
    approved = {"profile_id": "wasi-accepted-v1", "code_sha256": SHA, "max_seconds": 5, "max_bytes": 4096}
    gate = g.GenerativeExecutionGate(approved)
    assert gate.decision(_req()) == "ADMITTED"
    assert gate.decision(_req(profile_id="other")) == "REFUSED_PROFILE_MISMATCH"
    assert gate.decision(_req(code_sha256=OTHER)) == "REFUSED_SHA_MISMATCH"
    assert gate.decision(_req(max_seconds=6)) == "REFUSED_UNBOUNDED"
    assert gate.decision(_req(max_bytes=0)) == "REFUSED_UNBOUNDED"
    # never host-runs: the gate returns a decision only, no side effect/execution
    assert set(g.GATE_REASONS) >= {"ADMITTED", "REFUSED_NO_PROFILE"}
