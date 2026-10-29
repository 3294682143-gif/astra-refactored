"""Astra Web 契约 - status / stopReason 权威映射表与归类逻辑.

设计原则:
  1. 本模块是唯一允许 stop_reason -> status 推导的入口.
  2. 所有映射表用 MappingProxyType 冻结, 防止运行时被误改.
  3. 中文标签仅用于展示, 不参与任何业务判断.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Final, Mapping

from .enums import StatusCode, StopReason, TerminalKind

STOP_REASON_TO_STATUS: Final[Mapping[StopReason, StatusCode]] = MappingProxyType(
    {
        StopReason.SOLVED: StatusCode.CANDIDATE,
        StopReason.WORK_UNITS_COMPLETE: StatusCode.CANDIDATE,
        StopReason.REVIEWS_COMPLETE: StatusCode.CANDIDATE,
        # A malformed/UNKNOWN review report stops the review loop but the
        # protected parent candidate is still delivered; it is not a system
        # failure. Before this mapping it fell through to ERROR in the BFF.
        StopReason.REVIEW_STOP: StatusCode.CANDIDATE,
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
        StopReason.WORK_UNITS_COMPLETE: "工作单元链全部完成，交付候选",
        StopReason.REVIEWS_COMPLETE: "评审结束，交付候选",
        StopReason.REVIEW_STOP: "评审中止，保留受保护候选",
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

STOP_REASON_TO_TERMINAL: Final[Mapping[StopReason, TerminalKind]] = MappingProxyType(
    {
        # 数学上未形成候选
        StopReason.NO_CANDIDATE: TerminalKind.MATH_UNSOLVED,
        StopReason.MAX_ITER: TerminalKind.MATH_UNSOLVED,
        # 预算 / 时限 / 通信超时
        StopReason.TIMEOUT: TerminalKind.BUDGET_TIMEOUT,
        StopReason.DEADLINE_EXCEEDED: TerminalKind.BUDGET_TIMEOUT,
        StopReason.BUDGET_EXCEEDED: TerminalKind.BUDGET_TIMEOUT,
        StopReason.BUDGET_EXHAUSTED: TerminalKind.BUDGET_TIMEOUT,
        # 系统级失败（含启动失败/进程异常/内部错误/传输中断）
        StopReason.ERROR: TerminalKind.SYSTEM_FAILURE,
        StopReason.SPAWN_FAILED: TerminalKind.SYSTEM_FAILURE,
        StopReason.CHILD_FAILED: TerminalKind.SYSTEM_FAILURE,
        StopReason.FIELD_VALUE: TerminalKind.SYSTEM_FAILURE,
        StopReason.TRANSPORT_STOP: TerminalKind.SYSTEM_FAILURE,
        # 主动取消
        StopReason.CANCELLED: TerminalKind.CANCELLED,
    }
)

TERMINAL_KIND_LABEL_ZH: Final[Mapping[TerminalKind, str]] = MappingProxyType(
    {
        TerminalKind.MATH_UNSOLVED: "数学未解（未形成有效候选）",
        TerminalKind.BUDGET_TIMEOUT: "预算/时限耗尽",
        TerminalKind.SYSTEM_FAILURE: "系统级失败",
        TerminalKind.CANCELLED: "已取消/断开",
    }
)


def classify_terminal_kind(reason: StopReason) -> TerminalKind | None:
    """由 stopReason 推导终态大类；候选型 stopReason 返回 None（不属四类异常收口）。"""
    return STOP_REASON_TO_TERMINAL.get(reason)


def terminal_kind_label_zh(kind: TerminalKind) -> str:
    return TERMINAL_KIND_LABEL_ZH.get(kind, str(kind.value))


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
    "STOP_REASON_TO_TERMINAL",
    "TERMINAL_KIND_LABEL_ZH",
    "classify_terminal_kind",
    "terminal_kind_label_zh",
    "classify_stop_reason",
    "label_zh",
    "requires_candidate",
    "forbids_error",
    "requires_error",
]
