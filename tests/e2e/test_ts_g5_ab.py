"""G5/PR6 (local) — offline A/B/C/D harness over the real engine="ts" entry."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402
from python.astra_bridge import math_ab_harness as ab  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

CORPUS = [
    {"id": "v1", "problem": "Compute 2+2", "expected_answer": "4"},
    {"id": "v2", "problem": "Compute 3+5", "expected_answer": "8"},
]


def _make_agent(arm_id, problem):
    profile = dict(ab.ARM_PROFILES[arm_id])
    return user_agent.ReasoningAgent(client=FakeClient(), engine="ts", **profile)


def test_offline_ab_comparison_runs_cd_and_marks_ab_not_run(process_tracker):
    report = ab.run_comparison(CORPUS, _make_agent)
    assert set(report["offline"]) == {"C", "D"}
    # C and D really ran offline through engine="ts".
    for arm in ("C", "D"):
        assert report["arms"][arm]["status"] == "RUN"
        stats = report["arms"][arm]["stats"]
        assert stats["total"] == len(CORPUS)
        assert stats["correct"] == 1  # only v1 matches the fake "4" answer
        assert stats["unsolved"] == 0  # v2 is a (wrong) candidate, not unsolved
    # A and B require the authorized real API run: never faked.
    for arm in ("A", "B"):
        assert report["arms"][arm]["status"] == "NOT_RUN"
        assert report["arms"][arm]["blocker"] == "BLOCKED_EXTERNAL"
        assert report["arms"][arm]["stats"] is None
    assert process_tracker


def test_judge_reports_per_cell(process_tracker):
    records = ab.run_arm("D", CORPUS, _make_agent)
    stats = ab.judge(CORPUS, records, "D")
    for cell in (
        "correct", "right_to_wrong", "wrong_to_right", "unsolved", "missing_branch",
        "repair_retained", "truncated_length", "outcome_unknown", "known_tokens",
        "unknown_tokens", "latency_ms",
    ):
        assert cell in stats
    assert process_tracker
