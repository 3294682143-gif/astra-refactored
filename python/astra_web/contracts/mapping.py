"""Astra Web 契约 - status / stopReason 权威映射表与归类逻辑.

设计原则:
  1. 本模块是唯一允许 stop_reason -> status 推导的入口.
  2. 所有映射表用 MappingProxyType 冻结, 防止运行时被误改.
  3. 中文标签仅用于展示, 不参与任何业务判断.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping

from .enums import StatusCode, StopReason

STOP_REASON_TO_STATUS: Final[Mapping[StopReason, StatusCode]] = MappingProxyType(
    {
        StopReason.SOLVED: StatusCode.CANDIDATE,
        StopReason.REVIEWS_COMPLETE: StatusCode.CANDIDATE,
        StopReason.REVISE_REJECTED: StatusCode.CANDIDATE,  # 保留原候选交付
        StopReason.NO_CANDIDATE: StatusCode.UNSOLVED,
        StopReason.MAX_ITER: StatusCode.UNSOLVED,
        StopReason.TIMEOUT: StatusCode.UNSOLVED,
        StopReason.DEADLINE_EXCEEDED: StatusCode.UNSOLVED,
        StopReason.BUDGET_EXCEEDED: StatusCode.UNSOLVED,
        StopReason.BUDGET_EXHAUSTED: StatusCode.UNSOLVED,
        StopReason.CANCELLED: StatusCode.ABORTED,
        StopReason.ERROR: StatusCode.ERROR,
        StopReason.SPAWN_FAILED: StatusCode.ERROR,
        StopReason.CHILD_FAILED: StatusCode.ERROR,
        StopReason.FIELD_VALUE: StatusCode.ERROR,
        StopReason.TRANSPORT_STOP: StatusCode.ERROR,
    }
)

STOP_REASON_LABEL_ZH: Final[Mapping[StopReason, str]] = MappingProxyType(
    {
        StopReason.SOLVED: "已形成候选",
        StopReason.REVIEWS_COMPLETE: "评审结束，交付候选",
        StopReason.REVISE_REJECTED: "修复未通过门控（保留原候选）",
        StopReason.NO_CANDIDATE: "未形成有效候选",
        StopReason.MAX_ITER: "已达迭代步数上限",
        StopReason.TIMEOUT: "通信超时",
        StopReason.DEADLINE_EXCEEDED: "超过最大运行总时限",
        StopReason.BUDGET_EXCEEDED: "求解预算耗尽",
        StopReason.BUDGET_EXHAUSTED: "求解预算耗尽",
        StopReason.CANCELLED: "已主动断开/取消",
        StopReason.ERROR: "系统异常",
        StopReason.SPAWN_FAILED: "子进程启动失败",
        StopReason.CHILD_FAILED: "运行时进程异常退出",
        StopReason.FIELD_VALUE: "字段格式校验失败",
        StopReason.TRANSPORT_STOP: "模型通信传输中断",
    }
)

_STATUS_REQUIRES_CANDIDATE: Final[frozenset[StatusCode]] = frozenset(
    {StatusCode.SOLVED, StatusCode.CANDIDATE, StatusCode.REVISE_REJECTED}
)

_STATUS_FORBIDS_ERROR: Final[frozenset[StatusCode]] = frozenset(
    {StatusCode.SOLVED, StatusCode.CANDIDATE, StatusCode.UNSOLVED, StatusCode.REVISE_REJECTED}
)

_STATUS_REQUIRES_ERROR: Final[frozenset[StatusCode]] = frozenset({StatusCode.ERROR})


def classify_stop_reason(reason: StopReason) -> StatusCode:
    """由 stopReason 推导权威 status."""
    return STOP_REASON_TO_STATUS.get(reason, StatusCode.UNSOLVED)


def label_zh(reason: StopReason) -> str:
    """获取 stopReason 的中文展示标签."""
    return STOP_REASON_LABEL_ZH.get(reason, str(reason.value))


def requires_candidate(status: StatusCode) -> bool:
    return status in _STATUS_REQUIRES_CANDIDATE


def forbids_error(status: StatusCode) -> bool:
    return status in _STATUS_FORBIDS_ERROR


def requires_error(status: StatusCode) -> bool:
    return status in _STATUS_REQUIRES_ERROR


__all__ = [
    "STOP_REASON_TO_STATUS",
    "STOP_REASON_LABEL_ZH",
    "classify_stop_reason",
    "label_zh",
    "requires_candidate",
    "forbids_error",
    "requires_error",
]
