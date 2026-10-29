"""Astra Web 契约 - 权威枚举定义.

所有枚举均继承 (str, Enum) 以保证 JSON 序列化时的值稳定性.
禁止在业务层使用裸字符串比较, 一律通过本模块的枚举常量.
"""
from __future__ import annotations

from enum import Enum


class StatusCode(str, Enum):
    """Run 顶层状态码 (权威).

    与 `StopReason` 一一映射, 由 mapping.classify_stop_reason 强制推导,
    DTO 层的 model_validator 会校验一致性; 不允许手工构造不一致的组合.
    """
    SOLVED = "solved"
    UNSOLVED = "unsolved"
    REVISE_REJECTED = "revise_rejected"
    ABORTED = "aborted"
    ERROR = "error"
    CANDIDATE = "candidate"  # 保持与 astra.solve() summary.status 兼容


class StopReason(str, Enum):
    """终止原因 (权威).

    命名采用 SCREAMING_SNAKE_CASE, 与 solve() 内核返回字段保持字节一致.
    """
    SOLVED = "SOLVED"
    WORK_UNITS_COMPLETE = "WORK_UNITS_COMPLETE"
    REVIEWS_COMPLETE = "REVIEWS_COMPLETE"
    REVIEW_STOP = "REVIEW_STOP"
    REVISE_REJECTED = "REVISE_REJECTED"
    NO_CANDIDATE = "NO_CANDIDATE"
    MAX_ITER = "MAX_ITER"
    TIMEOUT = "TIMEOUT"
    DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    CANCELLED = "CANCELLED"
    ERROR = "ERROR"
    SPAWN_FAILED = "SPAWN_FAILED"
    CHILD_FAILED = "CHILD_FAILED"
    FIELD_VALUE = "FIELD_VALUE"
    TRANSPORT_STOP = "TRANSPORT_STOP"


class TerminalKind(str, Enum):
    """终态大类（权威）。

    由 ``StopReason`` 经 mapping.classify_terminal_kind 强制推导，用于把
    异常/未解收口区分为四条可判别路径（每条都有对应 status）：

    * MATH_UNSOLVED   —— 数学上未形成候选（status=unsolved）
    * BUDGET_TIMEOUT  —— 预算/时限耗尽或通信超时（status=unsolved）
    * SYSTEM_FAILURE  —— 启动失败/进程异常/内部错误（status=error）
    * CANCELLED       —— 主动取消/断开（status=aborted）

    候选型 stopReason（SOLVED / REVIEWS_COMPLETE / REVISE_REJECTED）不属于
    上述四类，classify_terminal_kind 对它们返回 ``None``。
    """
    MATH_UNSOLVED = "math_unsolved"
    BUDGET_TIMEOUT = "budget_timeout"
    SYSTEM_FAILURE = "system_failure"
    CANCELLED = "cancelled"


class TraceStage(str, Enum):
    """单条 Trace 所处阶段."""
    PLAN = "plan"
    DRAFT = "draft"
    REVIEW = "review"
    REVISE = "revise"
    FINALIZE = "finalize"
    ERROR = "error"
    MODEL = "MODEL"
    EFFECT = "EFFECT"
    CONTROL = "CONTROL"


class EventType(str, Enum):
    """SSE / WebSocket 事件类型."""
    STARTED = "started"
    TRACE = "trace"
    METRICS = "metrics"
    STATUS = "status"
    COMPLETED = "completed"
    ERROR = "error"
    BUDGET = "budget"
    RUN_TERMINATED = "run_terminated"


class ErrorCategory(str, Enum):
    """错误归类 (供前端 UI 决策重试/降级)."""
    VALIDATION = "validation"
    PROVIDER = "provider"
    TIMEOUT = "timeout"
    BUDGET = "budget"
    INTERNAL = "internal"
