"""Astra Web 契约包."""
from __future__ import annotations

from .enums import (
    ErrorCategory,
    EventType,
    StatusCode,
    StopReason,
    TraceStage,
)
from .mapping import (
    STOP_REASON_LABEL_ZH,
    STOP_REASON_TO_STATUS,
    classify_stop_reason,
    label_zh,
)
from .dto import (
    CapabilitiesDto,
    ErrorDto,
    MetricsDto,
    RunEventEnvelope,
    RunRequestDto,
    SolveResultDto,
    TraceRowDto,
)

__all__ = [
    "ErrorCategory",
    "EventType",
    "StatusCode",
    "StopReason",
    "TraceStage",
    "STOP_REASON_LABEL_ZH",
    "STOP_REASON_TO_STATUS",
    "classify_stop_reason",
    "label_zh",
    "CapabilitiesDto",
    "ErrorDto",
    "MetricsDto",
    "RunEventEnvelope",
    "RunRequestDto",
    "SolveResultDto",
    "TraceRowDto",
]
