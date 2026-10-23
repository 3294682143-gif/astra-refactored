import json
import pytest
from pydantic import ValidationError

from python.astra_web.contracts.enums import StatusCode, StopReason
from python.astra_web.contracts.dto import (
    RunRequestDto,
    SolveResultDto,
    TraceRowDto,
    MetricsDto,
    RunEventEnvelope,
)
from python.astra_web.contracts.mapping import classify_stop_reason, label_zh


def test_run_request_dto_valid():
    req = RunRequestDto(
        problem="证明质数有无穷多个",
        max_model_calls=24,
        max_method_loads=1,
        policy="BEST_EFFORT",
    )
    assert req.max_model_calls == 24
    assert req.max_method_loads == 1


def test_run_request_dto_rejects_bool_and_invalid_loads():
    # True is forbidden (cannot smuggle bool as int 1)
    with pytest.raises(ValidationError):
        RunRequestDto(problem="test", max_method_loads=True)  # type: ignore

    # 2 is forbidden (only 0 or 1 allowed)
    with pytest.raises(ValidationError):
        RunRequestDto(problem="test", max_method_loads=2)  # type: ignore


def test_solve_result_dto_invariants():
    trace = [
        TraceRowDto(seq=1, kind="MODEL", id="M1", state="COMPLETE", code="OK"),
        TraceRowDto(seq=2, kind="EFFECT", id="T1", state="ACTIVE", code="RUN"),
    ]
    res = SolveResultDto(
        status="candidate",
        final_response="x = 42",
        stopReason="REVISE_REJECTED",
        reason="Revised candidate rejected by gate, original preserved",
        sessionId="sess-123",
        trace=trace,
        childReaped=True,
        elapsedMs=1500,
    )
    assert res.candidate_verified is False
    assert res.status == "candidate"
    assert res.stopReason == "REVISE_REJECTED"
    assert len(res.trace) == 2


def test_stop_reason_mapping():
    assert classify_stop_reason(StopReason.REVIEWS_COMPLETE) == StatusCode.CANDIDATE
    assert classify_stop_reason(StopReason.NO_CANDIDATE) == StatusCode.UNSOLVED
    assert classify_stop_reason(StopReason.BUDGET_EXHAUSTED) == StatusCode.UNSOLVED
    assert "评审结束" in label_zh(StopReason.REVIEWS_COMPLETE)


def test_run_event_envelope():
    env = RunEventEnvelope(
        runId="run-test-01",
        seq=1,
        kind="TRACE",
        at=1792780000000,
        sourceKind="official_result",
        detailLevel="summary_only",
        payload={"msg": "started"},
    )
    assert env.runId == "run-test-01"
    assert env.sourceKind == "official_result"
