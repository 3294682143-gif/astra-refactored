"""G3/PR4 B1b + HANDOFF §5 item 5 — the R0 three-review stage at the real entry.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the legacy-solver-disabled negative control all run.

DECISION-0150 ruling B1 + HANDOFF §5 item 5: with ``max_r0=1`` three
*independent* role reviews (题意 / 方法 / 任务·工具) run before any WORK (phase
``R0``, no work task, shared root budget), each under its own root request id
and each with only its own dimension. A pure controller aggregates them; an
aggregate ``ISSUES`` records exactly one revision proposal and spends exactly
one targeted recheck (phase ``R0_RECHECK``), and the single version bump is
applied only when that recheck is a usable ``NO_ISSUE``. With ``max_r0=0`` the
whole stage is inert. The Python Host accepts the additive ``R0``/``R0_RECHECK``
phases (``validate_context`` + ``_check_r0``) and the frozen legacy solver stays
disabled.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]


@pytest.fixture(autouse=True)
def workspace_entry(monkeypatch):
    """Run the freshly compiled workspace entry for this file.

    The published release bundle is deliberately not rebuilt inside this slice
    (HANDOFF §6), so the R0 stage is proved against the compiled
    ``apps/stdio-runtime/dist`` entry the Node test suite also runs. The real
    Python Host, the real IPC and the real loop are unchanged by the choice of
    artifact.
    """
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")

PROBLEM = "Prove that the sum of two even integers is even"
ROLE_DIMENSION = {
    "MEANING": "PROBLEM_ALIGNMENT",
    "METHOD": "SCOPE",
    "TASK_TOOL": "TASK_COVERAGE",
}
REVIEW_ROLES = ("MEANING", "METHOD", "TASK_TOOL")


def _span(source):
    return {"start": 0, "end": 1, "quote": list(source)[0]}


class R0Client(FakeClient):
    """FakeClient that answers the whole R0 stage deterministically.

    Every reply is literal data derived from the real request it receives; the
    client records the order in which the R0 sub-stages were actually asked for.
    """

    def __init__(self, verdicts=None, recheck="NO_ISSUE", certified=True):
        super().__init__()
        self.verdicts = verdicts or {role: "NO_ISSUE" for role in REVIEW_ROLES}
        self.recheck = recheck
        self.certified = certified
        self.r0_seen = 0
        self.review_roles = []
        self.revision_calls = 0
        self.recheck_calls = 0

    # -- R0 sub-stages --------------------------------------------------

    def _review(self, body):
        # The same method name serves P4 R2/R4 reports in FakeClient. Keep the
        # R0 helper scoped to its own context shape and delegate the review
        # stages to the base fake.
        if body.get("schemaVersion") == "p4-r2-context-v1" or "role" not in body:
            return super()._review(body)
        role = body["role"]
        verdict = self.verdicts[role]
        dimension = body["dimensions"][0]
        assert dimension == ROLE_DIMENSION[role]
        self.r0_seen += 1
        self.review_roles.append(role)
        return json.dumps(
            {
                "schemaVersion": "p4-r0-review-v1",
                "requestId": body["requestId"],
                "stage": "R0",
                "role": role,
                "target": body["target"],
                "planHash": body["planHash"],
                "conclusion": verdict,
                "reviewCoverage": body["reviewCoverage"],
                "checks": [
                    {
                        "dimension": dimension,
                        "verdict": verdict,
                        "rationale": "reviewed the initial template against the problem",
                        "problemSpan": _span(body["problemFullText"]),
                        "planSpan": _span(body["planText"]),
                    }
                ],
            }
        )

    def _revision(self, body):
        self.revision_calls += 1
        if not self.certified:
            return "{ not a revision report"
        leaf = body["allowedLeaves"][0]
        plan = body["planText"]
        start = plan.index(leaf["goalJson"])
        to_kind = "PROOF" if leaf["kind"] == "VALUE" else "VALUE"
        return json.dumps(
            {
                "schemaVersion": "p4-r0-plan-revision-v1",
                "requestId": "model-2",
                "parent": body["parent"],
                "reviewHash": body["reviewHash"],
                "changes": [
                    {
                        "goalId": leaf["goalId"],
                        "fromKind": leaf["kind"],
                        "toKind": to_kind,
                        "issueDimension": body["issueRows"][0]["dimension"],
                        "rationale": "the initial template class is too narrow",
                        "problemSpan": _span(body["problemFullText"]),
                        "planSpan": {
                            "start": start,
                            "end": start + len(leaf["goalJson"]),
                            "quote": leaf["goalJson"],
                        },
                    }
                ],
            }
        )

    def _recheck_reply(self, body):
        self.recheck_calls += 1
        checks = [
            {
                "dimension": dimension,
                "verdict": self.recheck,
                "rationale": "rechecked the revised plan",
                "problemSpan": _span(body["problemFullText"]),
                "planSpan": _span(body["planText"]),
            }
            for dimension in ("PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE")
        ]
        return json.dumps(
            {
                "schemaVersion": "p4-r0-recheck-v1",
                "requestId": "model-3",
                "stage": "R0_RECHECK",
                "parent": body["parent"],
                "target": body["target"],
                "reviewHash": body["reviewHash"],
                "revisionHash": body["revisionHash"],
                "conclusion": self.recheck,
                "reviewCoverage": body["reviewCoverage"],
                "checks": checks,
            }
        )

    # -- dispatch -------------------------------------------------------

    def _work(self, body):
        schema = body.get("schemaVersion")
        if schema == "p4-r0-review-context-v1":
            return self._review(body)
        if schema == "p4-r0-revision-context-v1":
            return self._revision(body)
        if schema == "p4-r0-recheck-context-v1":
            return self._recheck_reply(body)
        return super()._work(body)


def _agent(client, **kwargs):
    # ``mode="local"`` selects the resumable carrier used by the checkpoint
    # export below; it changes no model, tool or budget behaviour.
    kwargs.setdefault("mode", "local")
    return user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)


def _solve(client, **kwargs):
    agent = _agent(client, **kwargs)
    result = agent.solve(PROBLEM, {"source": "e2e"})
    return agent, result


def _r0_rows(checkpoint):
    return [
        row for row in checkpoint["sessionLog"] if row["kind"] == "R0_REVIEW"
    ]


def test_public_entry_bounded_r0_three_role_reviews(process_tracker):
    client = R0Client()
    agent, result = _solve(
        client,
        max_r0=1,
        # A five-call front stage stays inside the Host's quarter-of-budget
        # front share only when the soft budget is at least twenty calls.
        max_model_calls=20,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
        problem_seconds=5,
    )
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    # Three independent reviews ran at the public entry, in the fixed order.
    assert client.r0_seen == 3
    assert client.review_roles == list(REVIEW_ROLES)
    # No revision and no recheck on an all-NO_ISSUE aggregate.
    assert client.revision_calls == 0
    assert client.recheck_calls == 0

    checkpoint = agent._impl.export_checkpoint(PROBLEM)
    assert checkpoint is not None
    rows = _r0_rows(checkpoint)
    assert len(rows) == 4
    role_rows = rows[:3]
    assert [row["data"]["role"] for row in role_rows] == list(REVIEW_ROLES)
    assert [row["data"]["requestId"] for row in role_rows] == ["model-1", "model-2", "model-3"]
    assert [row["data"]["dimension"] for row in role_rows] == [
        ROLE_DIMENSION[role] for role in REVIEW_ROLES
    ]
    assert [row["data"]["verdict"] for row in role_rows] == ["NO_ISSUE"] * 3
    assert [row["data"]["issueCount"] for row in role_rows] == [0, 0, 0]
    aggregate = rows[3]["data"]
    assert aggregate["role"] == "AGGREGATE"
    assert aggregate["conclusion"] == "NO_ISSUE"
    assert aggregate["issueDimensions"] == []
    assert aggregate["dissents"] == []
    # No raw model text is ever copied into the audit rows.
    assert "rationale" not in json.dumps([row["data"] for row in rows])
    assert process_tracker


def test_public_entry_bounded_r0_issues_then_one_recheck(process_tracker):
    client = R0Client(
        verdicts={"MEANING": "ISSUES", "METHOD": "NO_ISSUE", "TASK_TOOL": "NO_ISSUE"},
        recheck="NO_ISSUE",
        certified=True,
    )
    agent, result = _solve(
        client,
        max_r0=1,
        max_model_calls=20,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
        problem_seconds=5,
    )
    assert result["engine"] == "ts"
    assert result["status"] in ("candidate", "unsolved")
    assert result["candidate_verified"] is False
    # Three reviews, then exactly one revision proposal and one targeted recheck.
    assert client.r0_seen == 3
    assert client.review_roles == list(REVIEW_ROLES)
    assert client.revision_calls == 1
    assert client.recheck_calls == 1

    checkpoint = agent._impl.export_checkpoint(PROBLEM)
    assert checkpoint is not None
    rows = _r0_rows(checkpoint)
    aggregate = rows[3]["data"]
    assert aggregate["role"] == "AGGREGATE"
    assert aggregate["conclusion"] == "ISSUES"
    assert aggregate["issueDimensions"] == ["PROBLEM_ALIGNMENT"]
    assert aggregate["dissents"] == [
        {"role": "METHOD", "dimension": "SCOPE", "verdict": "NO_ISSUE"},
        {"role": "TASK_TOOL", "dimension": "TASK_COVERAGE", "verdict": "NO_ISSUE"},
    ]
    kinds = [row["kind"] for row in checkpoint["sessionLog"]]
    # The revision is applied only after the recheck certified it.
    assert "CONTRACT_REVISED" in kinds
    # The recheck itself is auditable through its own phase on the request row.
    recheck_rows = [
        row
        for row in checkpoint["sessionLog"]
        if row["kind"] == "MODEL_REQUEST" and row["data"].get("phase") == "R0_RECHECK"
    ]
    assert len(recheck_rows) == 1
    assert process_tracker


def test_public_entry_r0_is_inert_by_default(process_tracker):
    client = R0Client()
    result = _solve(
        client,
        max_model_calls=20,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
    )[1]
    assert result["engine"] == "ts"
    assert client.r0_seen == 0
    assert client.revision_calls == 0
    assert client.recheck_calls == 0
    assert process_tracker


def test_public_entry_r0_stage_is_inert_with_max_r0_zero(process_tracker):
    client = R0Client()
    agent, result = _solve(
        client,
        max_r0=0,
        max_model_calls=20,
        max_work_units=3,
        max_effects=0,
        max_reviews=0,
    )
    assert result["engine"] == "ts"
    assert client.r0_seen == 0
    checkpoint = agent._impl.export_checkpoint(PROBLEM)
    assert checkpoint is not None
    assert _r0_rows(checkpoint) == []
    assert process_tracker


def test_public_entry_r0_force_runs_on_a_value_template_with_long_deadline(process_tracker):
    """maxR0=1 is an explicit opt-in even when M1 has no intrinsic risk code.

    The evaluation profile gives a real 1800s deadline; the old 5000ms input
    ceiling made every such preparation fall back silently to WORK. A VALUE
    problem is exactly the case that used to produce R0=0 in a full 100-item run.
    """
    client = R0Client()
    agent, result = _solve(
        client,
        max_r0=1,
        max_model_calls=20,
        max_work_units=4,
        max_effects=0,
        max_reviews=0,
        max_repairs=0,
        max_consensus=0,
        problem_seconds=10,
    )
    assert result["status"] == "candidate"
    assert client.r0_seen == 3
    assert client.review_roles == list(REVIEW_ROLES)
    checkpoint = agent._impl.export_checkpoint(PROBLEM)
    assert checkpoint is not None
    rows = _r0_rows(checkpoint)
    assert [row["data"]["role"] for row in rows] == ["MEANING", "METHOD", "TASK_TOOL", "AGGREGATE"]
    assert process_tracker
