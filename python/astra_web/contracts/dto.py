"""Astra Web 契约 - Pydantic v2 strict DTO 模型.

适配 astra.solve() 公开返回对象的序列化契约.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from .enums import (
    ErrorCategory,
    EventType,
    StatusCode,
    StopReason,
    TraceStage,
)
from .mapping import (
    classify_stop_reason,
    forbids_error,
    requires_candidate,
    requires_error,
)

_BASE_CFG = ConfigDict(
    extra="ignore",  # 宽松接纳扩展字段
    frozen=True,
    populate_by_name=True,
    validate_assignment=False,
)

RunId = Annotated[str, Field(min_length=1, max_length=128)]
ShortText = Annotated[str, Field(min_length=1, max_length=512)]
LongText = Annotated[str, Field(min_length=1, max_length=65536)]


class ErrorDto(BaseModel):
    """错误对象."""
    model_config = _BASE_CFG

    code: Annotated[str, Field(min_length=1, max_length=128)]
    message: Annotated[str, Field(min_length=1, max_length=4096)]
    category: ErrorCategory = ErrorCategory.INTERNAL
    retryable: bool = False
    details: dict[str, Any] | None = None


class MetricsDto(BaseModel):
    """运行指标快照."""
    model_config = _BASE_CFG

    client_method_calls: int = 0
    logical_model_calls: int | None = None
    effect_calls: int = 0
    review_calls: int = 0
    catalog_calls: int = 0
    method_loads: int = 0
    asset_calls: int = 0
    work_units: int | None = None
    frames: int = 0
    remote_outcome_unknown: bool = False
    known_http_attempts: int | None = None
    reported_tokens: int | None = None
    unknown_usage_requests: int = 0


class TraceRowDto(BaseModel):
    """单条 trace 记录."""
    model_config = _BASE_CFG

    seq: Annotated[int, Field(ge=0)]
    kind: str
    id: str
    state: str
    code: str
    ts_ms: int | None = None


class RunRequestDto(BaseModel):
    """新建 Run 请求体."""
    model_config = _BASE_CFG

    problem: LongText
    engine: Literal["ts", "lite", "legacy"] = "ts"
    metadata: dict[str, Any] = Field(default_factory=dict)
    max_model_calls: Annotated[int, Field(ge=0, le=256)] = 24
    max_work_units: Annotated[int, Field(ge=1, le=64)] = 8
    max_effects: Annotated[int, Field(ge=0, le=2)] = 2
    max_reviews: Annotated[int, Field(ge=0, le=3)] = 1
    max_method_loads: Literal[0, 1] = 0
    max_repairs: Annotated[int, Field(ge=0, le=3)] = 1
    max_consensus: Annotated[int, Field(ge=0, le=8)] = 2
    max_r0: Literal[0, 1] = 0
    problem_seconds: Annotated[int, Field(ge=1, le=3600)] = 600
    policy: Literal["BEST_EFFORT", "STRICT"] = "BEST_EFFORT"

    @field_validator("max_method_loads", "max_r0", mode="before")
    @classmethod
    def _reject_bool(cls, v: Any) -> Any:
        if isinstance(v, bool):
            raise ValueError("Must be integer 0 or 1, boolean disallowed")
        return v


class SolveResultDto(BaseModel):
    """solve() 公开返回对象的 Web 契约投影."""
    model_config = _BASE_CFG

    engine: str = "ts"
    status: str
    final_response: str = ""
    candidate_verified: Literal[False] = False  # 恒为 False
    strictAcceptance: str = "NOT_PERFORMED"
    mode: str = "TS_PREVIEW"
    targetEnvironment: str = "TARGET_UNVERIFIED"
    stopReason: str
    reason: str = ""
    unresolvedObligations: list[str] = Field(default_factory=list)
    carrier: str = ""
    sessionId: str = ""
    trace: list[TraceRowDto] = Field(default_factory=list)
    metrics: MetricsDto = Field(default_factory=MetricsDto)
    finishReason: str | None = None
    childReaped: bool = True
    elapsedMs: int = 0
    code: str | None = None


class RunEventEnvelope(BaseModel):
    """流式事件信封."""
    model_config = _BASE_CFG

    runId: RunId
    seq: Annotated[int, Field(ge=0)]
    kind: str
    at: Annotated[int, Field(ge=0)]
    sourceKind: Literal["demo_fixture", "official_result", "observed_archive"] = "official_result"
    detailLevel: Literal["summary_only", "partial_observed", "full_observed"] = "summary_only"
    payload: dict[str, Any] = Field(default_factory=dict)


class CapabilitiesDto(BaseModel):
    model_config = _BASE_CFG

    schema_version: str = "1.0.0"
    server_version: str = "0.1.0"
    supported_engines: list[str] = Field(default_factory=lambda: ["ts", "lite", "legacy"])
    max_concurrent_runs: int = 1
    supports_cancellation: bool = True
    default_budget: dict[str, Any] = Field(default_factory=dict)


__all__ = [
    "ErrorDto",
    "MetricsDto",
    "TraceRowDto",
    "RunRequestDto",
    "SolveResultDto",
    "RunEventEnvelope",
    "CapabilitiesDto",
]
