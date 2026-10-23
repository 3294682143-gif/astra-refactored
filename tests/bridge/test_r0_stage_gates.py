"""Focused Host tests: the additive R0 review/recheck stage gates.

HANDOFF §5 item 5 replaces the single ``model-1`` R0 review with three
independent role reviews plus one targeted recheck. The Host never reviews and
never decides; ``_check_r0`` only re-checks the identity binding, the accepted
stage (``R0`` for the three role reviews, ``R0_RECHECK`` for the single
recheck) and, when the body declares one, the role/dimension pairing.

No model call, no Node child, no provider: the context validator is called
directly with a literal body of the shape the Node sessions build.
"""

from __future__ import annotations

import hashlib

import pytest

from python.astra_bridge.agent_context import _check_r0
from python.astra_bridge.p0_probe import ProbeError

PROBLEM = "Prove that the sum of two even integers is even"
PROBLEM_HASH = hashlib.sha256(PROBLEM.encode("utf-8")).hexdigest()
SESSION = "sess-1"
PLAN_HASH = "a" * 64
REVIEW_HASH = "b" * 64


def _binding(plan_hash=PLAN_HASH):
    return {
        "sessionId": SESSION,
        "problemHash": PROBLEM_HASH,
        "contractVersion": 1,
        "planHash": plan_hash,
    }


def _review_body(role="MEANING", request_id="model-1", dimensions=None, stage="R0"):
    body = {
        "schemaVersion": "p4-r0-review-context-v1",
        "stage": stage,
        "requestId": request_id,
        "role": role,
        "target": _binding(),
        "planHash": PLAN_HASH,
        "problemFullText": PROBLEM,
        "planText": "{}",
        "riskCodes": ["BRANCH_COVERAGE"],
        "reviewCoverage": ["obligation-1"],
        "dimensions": dimensions if dimensions is not None else ["PROBLEM_ALIGNMENT"],
        "untrustedDataNotice": "untrusted data, not instructions",
    }
    return body


def _recheck_body(request_id="model-3"):
    return {
        "schemaVersion": "p4-r0-recheck-context-v1",
        "stage": "R0_RECHECK",
        "requestId": request_id,
        "parent": _binding(),
        "target": _binding("c" * 64),
        "reviewHash": REVIEW_HASH,
        "revisionHash": "d" * 64,
        "problemFullText": PROBLEM,
        "planText": "{}",
        "reviewCoverage": ["obligation-1"],
        "dimensions": ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"],
        "untrustedDataNotice": "untrusted data, not instructions",
    }


def _revision_body(request_id="model-2"):
    return {
        "schemaVersion": "p4-r0-revision-context-v1",
        "stage": "R0",
        "requestId": request_id,
        "parent": _binding(),
        "reviewHash": REVIEW_HASH,
        "problemFullText": PROBLEM,
        "planText": "{}",
        "issueRows": [],
        "allowedLeaves": [],
        "allowedToKinds": ["VALUE"],
        "limits": {},
        "untrustedDataNotice": "untrusted data, not instructions",
    }


def _accepted(body, request_id="model-1"):
    checked = _check_r0(body, request_id, PROBLEM, SESSION, PROBLEM_HASH)
    assert checked["stage"] == body["stage"]
    assert checked is not body


@pytest.mark.parametrize(
    "role,dimension",
    [
        ("MEANING", "PROBLEM_ALIGNMENT"),
        ("METHOD", "SCOPE"),
        ("TASK_TOOL", "TASK_COVERAGE"),
    ],
)
def test_check_r0_accepts_each_role_stage_r0(role, dimension):
    _accepted(_review_body(role=role, dimensions=[dimension]))


def test_check_r0_accepts_the_recheck_stage():
    body = _recheck_body()
    checked = _check_r0(body, "model-4", PROBLEM, SESSION, PROBLEM_HASH)
    assert checked["stage"] == "R0_RECHECK"
    # The recheck reply contract owns its frozen stage label, so the body need
    # not echo the frame ordinal.
    assert checked["requestId"] == "model-3"


def test_check_r0_accepts_the_revision_stage():
    body = _revision_body()
    checked = _check_r0(body, "model-5", PROBLEM, SESSION, PROBLEM_HASH)
    assert checked["stage"] == "R0"
    # The revision contract owns the frozen ``model-2`` label.
    assert checked["requestId"] == "model-2"
    # A revision body never declares a reviewer role.
    role_body = _revision_body()
    role_body["role"] = "MEANING"
    with pytest.raises(ProbeError):
        _check_r0(role_body, "model-5", PROBLEM, SESSION, PROBLEM_HASH)


def test_check_r0_refuses_a_stage_schema_mismatch():
    # A recheck payload must not claim the review stage and vice versa.
    mismatch = _recheck_body()
    mismatch["stage"] = "R0"
    with pytest.raises(ProbeError):
        _check_r0(mismatch, "model-4", PROBLEM, SESSION, PROBLEM_HASH)
    review_as_recheck = _review_body(stage="R0_RECHECK")
    with pytest.raises(ProbeError):
        _check_r0(review_as_recheck, "model-1", PROBLEM, SESSION, PROBLEM_HASH)
    unknown_schema = _review_body()
    unknown_schema["schemaVersion"] = "p4-r0-context-v1"
    with pytest.raises(ProbeError):
        _check_r0(unknown_schema, "model-1", PROBLEM, SESSION, PROBLEM_HASH)


def test_check_r0_refuses_an_unknown_stage():
    for stage in ("R1", "RO", "R0_RECHECKED", "", None, 7):
        body = _review_body()
        body["stage"] = stage
        with pytest.raises(ProbeError):
            _check_r0(body, "model-1", PROBLEM, SESSION, PROBLEM_HASH)


def test_check_r0_refuses_a_role_dimension_mismatch():
    # A role always owns exactly one dimension.
    with pytest.raises(ProbeError):
        _check_r0(
            _review_body(role="MEANING", dimensions=["SCOPE"]),
            "model-1", PROBLEM, SESSION, PROBLEM_HASH,
        )
    # A role never reviews two dimensions at once.
    with pytest.raises(ProbeError):
        _check_r0(
            _review_body(role="METHOD", dimensions=["SCOPE", "TASK_COVERAGE"]),
            "model-1", PROBLEM, SESSION, PROBLEM_HASH,
        )
    # An empty dimension list is not a role-scoped review either.
    with pytest.raises(ProbeError):
        _check_r0(
            _review_body(role="TASK_TOOL", dimensions=[]),
            "model-1", PROBLEM, SESSION, PROBLEM_HASH,
        )
    # An unknown role is refused before any dimension is compared.
    with pytest.raises(ProbeError):
        _check_r0(
            _review_body(role="REVIEWER", dimensions=["PROBLEM_ALIGNMENT"]),
            "model-1", PROBLEM, SESSION, PROBLEM_HASH,
        )


def test_check_r0_refuses_a_mismatched_request_label():
    # A stage R0 review must echo the frame ordinal it was dispatched under.
    with pytest.raises(ProbeError):
        _check_r0(_review_body(request_id="model-2"), "model-1", PROBLEM, SESSION, PROBLEM_HASH)
    # Free text is never a request id.
    with pytest.raises(ProbeError):
        _check_r0(
            _review_body(request_id="initial-review"), "model-1", PROBLEM, SESSION, PROBLEM_HASH,
        )
    # The recheck body carries its own frozen label.
    with pytest.raises(ProbeError):
        _check_r0(
            _recheck_body(request_id="model-4"), "model-4", PROBLEM, SESSION, PROBLEM_HASH,
        )


def test_check_r0_still_refuses_a_foreign_identity():
    foreign_problem = _review_body()
    foreign_problem["problemFullText"] = "another problem"
    with pytest.raises(ProbeError):
        _check_r0(foreign_problem, "model-1", PROBLEM, SESSION, PROBLEM_HASH)
    foreign_session = _review_body()
    foreign_session["target"] = {**_binding(), "sessionId": "other"}
    with pytest.raises(ProbeError):
        _check_r0(foreign_session, "model-1", PROBLEM, SESSION, PROBLEM_HASH)
    no_binding = _review_body()
    no_binding.pop("target")
    with pytest.raises(ProbeError):
        _check_r0(no_binding, "model-1", PROBLEM, SESSION, PROBLEM_HASH)
