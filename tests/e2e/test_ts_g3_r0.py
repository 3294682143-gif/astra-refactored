"""G3/PR4 B1b — bounded R0 planning review at the real public ``engine="ts"`` entry.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the legacy-solver-disabled negative control all run.

DECISION-0150 ruling B1: with ``max_r0=1`` a single R0 review runs before any
WORK (phase ``R0``, no work task, shared root budget). A recorded ``NO_ISSUE``
conclusion leaves the contract at version 1 and the run proceeds unchanged; an
``ISSUES`` conclusion attempts exactly one ``reviseGoals`` revision and, when
that revision is not certified, falls back to the fixed deterministic template
under the same root budget. The Python Host accepts the additive ``R0`` phase
(``validate_context`` + ``_check_r0``); the frozen legacy solver stays disabled.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

PROBLEM = "Prove that the sum of two even integers is even"


def _span(source):
    return {"start": 0, "end": 1, "quote": list(source)[0]}


class R0Client(FakeClient):
    """FakeClient that answers the R0 review phase deterministically."""

    def __init__(self, conclusion="NO_ISSUE"):
        super().__init__()
        self.conclusion = conclusion
        self.r0_seen = 0

    def _work(self, body):
        if body.get("stage") == "R0":
            self.r0_seen += 1
            problem = body["problemFullText"]
            plan = body["planText"]
            checks = [
                {
                    "dimension": dimension,
                    "verdict": self.conclusion,
                    "rationale": "reviewed the initial template against the problem",
                    "problemSpan": _span(problem),
                    "planSpan": _span(plan),
                }
                for dimension in ("PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE")
            ]
            return json.dumps(
                {
                    "schemaVersion": "p4-r0-review-v1",
                    "requestId": "model-1",
                    "stage": "R0",
                    "target": body["target"],
                    "planHash": body["planHash"],
                    "conclusion": self.conclusion,
                    "reviewCoverage": body["reviewCoverage"],
                    "checks": checks,
                }
            )
        return super()._work(body)


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def test_public_entry_bounded_r0_no_issue_keeps_version_one(process_tracker):
    client = R0Client("NO_ISSUE")
    result = _solve(
        client,
        max_r0=1,
        max_model_calls=6,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
        problem_seconds=5,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    # The R0 review really ran at the public entry before any WORK.
    assert client.r0_seen == 1
    assert process_tracker


def test_public_entry_bounded_r0_issues_falls_back_without_crashing(process_tracker):
    client = R0Client("ISSUES")
    result = _solve(
        client,
        max_r0=1,
        max_model_calls=6,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
        problem_seconds=5,
    )
    assert result["engine"] == "ts"
    # The uncertified single revision did not crash the run; it continued under
    # the same root budget on the fixed deterministic template.
    assert result["status"] in ("candidate", "unsolved")
    assert result["candidate_verified"] is False
    # The R0 review (model-1) and the single bounded revision attempt (model-2)
    # both ran; the uncertified revision fell back without a second bump.
    assert client.r0_seen == 2
    assert process_tracker


def test_public_entry_r0_is_inert_by_default(process_tracker):
    client = R0Client("NO_ISSUE")
    result = _solve(
        client,
        max_model_calls=6,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
    )
    assert result["engine"] == "ts"
    assert client.r0_seen == 0
    assert process_tracker
