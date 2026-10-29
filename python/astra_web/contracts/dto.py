"""Astra Web 契约 - Pydantic v2 strict DTO 模型.

The Web request is deliberately narrower than the internal Python API: a
browser submits a problem plus a bounded budget, never a provider URL, model
credential, Host binding or executable path. `RunRequestDto` is the single
validation path used by the HTTP layer and the queue.
"""
from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from python.astra_web.config import (
    DEFAULT_BUDGET,
    FORBIDDEN_METADATA_KEYS,
    MAX_METADATA_DEPTH,
    MAX_METADATA_NODES,
    WEB_ENGINES,
)
from .enums import ErrorCategory

_BASE_CFG = ConfigDict(
    extra="ignore",
    frozen=True,
    populate_by_name=True,
    validate_assignment=False,
)
_STRICT_CFG = ConfigDict(
    extra="forbid",
    frozen=True,
    populate_by_name=True,
    validate_assignment=False,
)

RunId = Annotated[str, Field(min_length=1, max_length=128)]
ShortText = Annotated[str, Field(min_length=1, max_length=512)]
LongText = Annotated[str, Field(min_length=1, max_length=65536)]
IdempotencyKey = Annotated[str, Field(min_length=1, max_length=128)]

_INT_FIELDS = (
    "max_model_calls",
    "max_work_units",
    "max_effects",
    "max_reviews",
    "max_method_loads",
    "max_repairs",
    "max_consensus",
    "max_r0",
    "problem_seconds",
)


def _validate_json_value(value: Any, *, depth: int = 0) -> int:
    """Reject NaN/Infinity, non-string keys and non-JSON values; return nodes."""
    if depth > MAX_METADATA_DEPTH:
        raise ValueError("metadata nesting is too deep")
    if value is None or isinstance(value, (str, bool, int)):
        return 1
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("metadata must not contain NaN or Infinity")
        return 1
    if isinstance(value, list):
        nodes = 1
        for item in value:
            nodes += _validate_json_value(item, depth=depth + 1)
            if nodes > MAX_METADATA_NODES:
                raise ValueError("metadata is too large")
        return nodes
    if isinstance(value, dict):
        nodes = 1
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("metadata keys must be strings")
            if key in FORBIDDEN_METADATA_KEYS:
                raise ValueError(f"metadata key '{key}' is control data and is forbidden")
            nodes += _validate_json_value(item, depth=depth + 1)
            if nodes > MAX_METADATA_NODES:
                raise ValueError("metadata is too large")
        return nodes
    raise ValueError("metadata contains a non-JSON value")


class ErrorDto(BaseModel):
    """错误对象."""
    model_config = _BASE_CFG

    code: Annotated[str, Field(min_length=1, max_length=128)]
    message: Annotated[str, Field(min_length=1, max_length=4096)]
    category: ErrorCategory = ErrorCategory.INTERNAL
    retryable: bool = False
    details: dict[str, Any] | None = None


class MetricsDto(BaseModel):
    """运行指标快照；未知指标保留 null，绝不默认写成 0。"""
    model_config = _BASE_CFG

    client_method_calls: int | None = None
    logical_model_calls: int | None = None
    effect_calls: int | None = None
    review_calls: int | None = None
    catalog_calls: int | None = None
    method_loads: int | None = None
    asset_calls: int | None = None
    tool_effect_calls: int | None = None
    method_effect_calls: int | None = None
    work_units: int | None = None
    frames: int | None = None
    remote_outcome_unknown: bool | None = None
    known_http_attempts: int | None = None
    reported_tokens: int | None = None
    exact_tokens: int | None = None
    estimated_tokens: int | None = None
    is_token_estimated: bool | None = None
    unknown_usage_requests: int | None = None
    tool_names: list[str] | None = None
    method_ids: list[str] | None = None
    nodeVersion: str | None = None
    modelEndpoint: str | None = None
    commitHash: str | None = None


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
    """新建 Run 请求体，Web 正式入口只接受 engine='ts'。"""
    model_config = _STRICT_CFG

    problem: LongText
    engine: Literal["ts"] = "ts"
    metadata: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: IdempotencyKey | None = None
    max_model_calls: Annotated[int, Field(ge=0, le=256)] = DEFAULT_BUDGET["max_model_calls"]
    max_work_units: Annotated[int, Field(ge=1, le=64)] = DEFAULT_BUDGET["max_work_units"]
    max_effects: Annotated[int, Field(ge=0, le=2)] = DEFAULT_BUDGET["max_effects"]
    max_reviews: Annotated[int, Field(ge=0, le=3)] = DEFAULT_BUDGET["max_reviews"]
    max_method_loads: Annotated[int, Field(ge=0, le=4)] = DEFAULT_BUDGET["max_method_loads"]
    max_repairs: Annotated[int, Field(ge=0, le=3)] = DEFAULT_BUDGET["max_repairs"]
    max_consensus: Annotated[int, Field(ge=0, le=8)] = DEFAULT_BUDGET["max_consensus"]
    max_r0: Annotated[int, Field(ge=0, le=1)] = DEFAULT_BUDGET["max_r0"]
    problem_seconds: Annotated[int, Field(ge=1, le=3600)] = DEFAULT_BUDGET["problem_seconds"]
    policy: Literal["BEST_EFFORT", "STRICT"] = DEFAULT_BUDGET["policy"]

    @field_validator(*_INT_FIELDS, mode="before")
    @classmethod
    def _reject_bool_and_non_int(cls, value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("must be an integer; boolean and non-integer values are forbidden")
        return value

    @field_validator("problem")
    @classmethod
    def _problem_is_non_blank(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("'problem' must be a non-empty string")
        return text

    @field_validator("metadata")
    @classmethod
    def _metadata_is_json_safe(cls, value: dict[str, Any]) -> dict[str, Any]:
        _validate_json_value(value)
        return value

    @model_validator(mode="after")
    def _engine_is_supported(self) -> "RunRequestDto":
        if self.engine not in WEB_ENGINES:
            raise ValueError("unsupported Web engine")
        return self


class SolveResultDto(BaseModel):
    """solve() 公开返回对象的 Web 契约投影。"""
    model_config = _BASE_CFG

    run_id: str = ""
    engine: str = "ts"
    status: str
    executed: bool = True
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
    metrics: MetricsDto | None = None
    finishReason: str | None = None
    childReaped: bool | None = None
    elapsedMs: int | None = None
    code: str | None = None
    protocolVersion: str | None = None
    catalogVersion: str | None = None
    catalogDigest: str | None = None
    nodeVersion: str | None = None
    modelEndpoint: str | None = None
    commitHash: str | None = None


class RunEventEnvelope(BaseModel):
    """流式事件信封."""
    model_config = _BASE_CFG

    runId: RunId
    seq: Annotated[int, Field(ge=0)]
    kind: str
    at: Annotated[int, Field(ge=0)]
    sourceKind: Literal["demo_fixture", "official_result", "observed_archive"] = "observed_archive"
    detailLevel: Literal["summary_only", "partial_observed", "full_observed"] = "summary_only"
    payload: dict[str, Any] = Field(default_factory=dict)


class CapabilitiesDto(BaseModel):
    model_config = _BASE_CFG

    schema_version: str = "1.1.0"
    server_version: str = "0.1.0"
    supported_engines: list[str] = Field(default_factory=lambda: list(WEB_ENGINES))
    max_concurrent_runs: int = 1
    supports_cancellation: bool = False
    default_budget: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_BUDGET))
    protocol_version: str | None = None
    catalog_version: str | None = None
    catalog_digest: str | None = None


__all__ = [
    "ErrorDto",
    "MetricsDto",
    "TraceRowDto",
    "RunRequestDto",
    "SolveResultDto",
    "RunEventEnvelope",
    "CapabilitiesDto",
]
