"""执行队列与实时事件流管理层（保真版）。

职责
----
1. 请求接收与白名单校验（POST /api/runs，受控的 max_method_loads ∈ {0, 1}）。
2. 异步执行器串行调度（并发上限强制 1，可观测）。
3. 实时 SSE（Server-Sent Events）事件广播，支持 Last-Event-ID 与断线重连。

红线（t1-[1][2][3][4]）
-----------------------
* **不造假**：本模块不内置题库、题号或答案表，也不生成“固定事件/固定答案”。
  结果事件只能来自真实求解链（注入的 ``solver`` 端口）或真实导入存档。
  事件信封的 ``sourceKind`` 一律取自真实来源，绝不把演示数据标为
  ``official_result``。
* **无真实结果 → 显式未执行态**：未接线真实求解入口时，运行立即以
  ``status=error`` / ``stopReason=ERROR`` / ``code=SOLVER_NOT_CONFIGURED`` /
  ``executed=false`` / ``final_response="Unsolved."`` 收口，绝不伪装成 candidate。
* **终态映射**：由 ``contracts.mapping`` 权威推导，区分
  math-unsolved / budget-timeout / system-failure / cancelled；candidate 只可能
  由真实求解链的候选型 stopReason 产生。
* **幂等**：同一幂等键只启动一次执行；重复提交返回同一 runId 与既有状态。
* **终态不可覆盖**：已落盘的终态记录不会被后续写入改写。
* ``candidate_verified`` 严格恒为 False：候选永不被表述为已验证。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from pydantic import ValidationError as PydanticValidationError

from .archive import atomic_write_json
from .config import DEFAULT_BUDGET, default_budget
from .contracts.dto import RunRequestDto
from .contracts.enums import StopReason
from .contracts.mapping import classify_stop_reason, classify_terminal_kind
from .storage import NON_TERMINAL_STATUSES, DuplicateRunError, Store, is_valid_run_id

logger = logging.getLogger("astra_web.queue")

MAX_CONCURRENT_RUNS = 1
UNSOLVED_RESPONSE = "Unsolved."
CODE_SOLVER_NOT_CONFIGURED = "SOLVER_NOT_CONFIGURED"
CODE_SOLVER_FAILED = "SOLVER_FAILED"


class ValidationError(ValueError):
    """请求参数校验错误。"""


def validate_run_request(body: Any) -> Dict[str, Any]:
    """Validate through the same DTO used by the HTTP layer."""
    if not isinstance(body, dict):
        raise ValidationError("request body must be a JSON object")
    try:
        return RunRequestDto.model_validate(body).model_dump()
    except PydanticValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(part) for part in first.get("loc", ()))
        message = first.get("msg", "invalid request")
        raise ValidationError(f"{loc}: {message}") from exc


def request_fingerprint(request: Mapping[str, Any]) -> str:
    """Stable fingerprint of the normalized request, excluding the idempotency key."""
    payload = {k: v for k, v in request.items() if k != "idempotency_key"}
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class IdempotencyConflict(ValueError):
    """Same idempotency key with different request content."""


@dataclass(frozen=True)
class SolveOutcome:
    """真实求解链交回的终态结果，或显式的“未执行”声明。"""
    stop_reason: StopReason
    final_response: str = UNSOLVED_RESPONSE
    reason: str = ""
    code: Optional[str] = None
    executed: bool = True
    events: Tuple[Mapping[str, Any], ...] = field(default_factory=tuple)
    metrics: Optional[Mapping[str, Any]] = None
    child_reaped: Optional[bool] = None
    trace: Tuple[Mapping[str, Any], ...] = field(default_factory=tuple)
    session_id: str = ""
    finish_reason: Optional[str] = None
    elapsed_ms: Optional[int] = None
    result: Optional[Mapping[str, Any]] = None

    @classmethod
    def not_executed(cls, reason: str) -> "SolveOutcome":
        return cls(
            stop_reason=StopReason.ERROR,
            final_response=UNSOLVED_RESPONSE,
            reason=reason,
            code=CODE_SOLVER_NOT_CONFIGURED,
            executed=False,
            child_reaped=None,
        )

    @classmethod
    def system_failure(cls, reason: str, *, code: str = CODE_SOLVER_FAILED) -> "SolveOutcome":
        return cls(
            stop_reason=StopReason.ERROR,
            final_response=UNSOLVED_RESPONSE,
            reason=reason,
            code=code,
            executed=True,
            child_reaped=None,
        )


class ExecutionManager:
    """管理活跃运行任务、串行执行队列与 SSE 订阅者的中心管理器。"""

    def __init__(
        self,
        store: Store,
        *,
        solver: Optional[Callable[[Mapping[str, Any]], Any]] = None,
    ) -> None:
        self.store = store
        self._solver = solver
        self.max_concurrent = MAX_CONCURRENT_RUNS

        self._active_runs: Dict[str, Dict[str, Any]] = {}
        self._subscribers: Dict[str, List[asyncio.Queue]] = {}
        self._history_events: Dict[str, List[Dict[str, Any]]] = {}

        self._pending: List[str] = []
        self._running: set[str] = set()
        self._worker: Optional[asyncio.Task] = None
        self._inflight = 0
        self._max_observed_concurrency = 0
        self._started_total = 0
        self._completed_total = 0

    # ------------------------------------------------------------- 可观测性
    @property
    def solver_configured(self) -> bool:
        """是否接线了真实求解端口；False 表示所有新建运行都会显式报未执行。"""
        return self._solver is not None

    def stats(self) -> Dict[str, Any]:
        """队列与并发状态快照（供 /api/health、/api/capabilities 观测）。"""
        return {
            "max_concurrent_runs": self.max_concurrent,
            "running": len(self._running),
            "queued": len(self._pending),
            "active_run_id": next(iter(self._running), None),
            "started_total": self._started_total,
            "completed_total": self._completed_total,
            "max_observed_concurrency": self._max_observed_concurrency,
            "solver_configured": self.solver_configured,
            "fabricated_events": False,
        }

    # --------------------------------------------------------------- 只读接口
    def get_active_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        return self._active_runs.get(run_id)

    def is_active(self, run_id: str) -> bool:
        return run_id in self._active_runs

    # ----------------------------------------------------------------- 幂等
    @staticmethod
    def derive_run_id(*, run_id: Optional[str], idempotency_key: Optional[str]) -> str:
        """由幂等键确定性地推导 run_id：同键恒得同一 runId（跨进程重启亦成立）。"""
        if run_id and is_valid_run_id(run_id):
            return run_id
        if idempotency_key:
            key = str(idempotency_key)
            if is_valid_run_id(key):
                return key
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
            return f"run-{digest}"
        return f"run-{uuid.uuid4().hex[:12]}"

    # ----------------------------------------------------------------- 写入
    @staticmethod
    def _normalized_request(
        problem: Optional[str],
        request: Optional[Mapping[str, Any]],
        *,
        max_model_calls: int,
        max_method_loads: int,
        engine: str,
        idempotency_key: Optional[str],
    ) -> Dict[str, Any]:
        if request is not None:
            normalized = dict(request)
        else:
            normalized = default_budget()
            normalized.update(
                {
                    "problem": problem or "",
                    "engine": engine,
                    "metadata": {},
                    "idempotency_key": idempotency_key,
                    "max_model_calls": max_model_calls,
                    "max_method_loads": max_method_loads,
                }
            )
        if not isinstance(normalized.get("problem"), str) or not normalized["problem"].strip():
            raise ValidationError("'problem' must be a non-empty string")
        normalized["problem"] = normalized["problem"].strip()
        normalized.setdefault("engine", "ts")
        normalized.setdefault("metadata", {})
        normalized.setdefault("idempotency_key", idempotency_key)
        return normalized

    def prepare_run(
        self,
        problem: Optional[str] = None,
        *,
        request: Optional[Mapping[str, Any]] = None,
        max_model_calls: int = int(DEFAULT_BUDGET["max_model_calls"]),
        max_method_loads: int = int(DEFAULT_BUDGET["max_method_loads"]),
        engine: str = "ts",
        run_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> str:
        """同步注册一次运行（不启动执行；可在纯同步测试环境直接使用）。"""
        normalized = self._normalized_request(
            problem,
            request,
            max_model_calls=max_model_calls,
            max_method_loads=max_method_loads,
            engine=engine,
            idempotency_key=idempotency_key,
        )
        actual = self.derive_run_id(
            run_id=run_id,
            idempotency_key=normalized.get("idempotency_key"),
        )
        if actual in self._active_runs or self.store.has_run(actual):
            return actual
        normalized["requestFingerprint"] = request_fingerprint(normalized)
        created_at = time.time()
        initial_summary = {
            **normalized,
            "status": "running",
            "candidate_verified": False,
            "executed": False,
            "childReaped": None,
        }
        try:
            self.store.save_run(
                {
                    "run_id": actual,
                    "created_at": created_at,
                    "source": "worker",
                    "status": "running",
                    "scenario": normalized["problem"][:40],
                    "model": None,
                    "seed": None,
                    "duration_s": 0.0,
                    "summary_json": json.dumps(initial_summary, ensure_ascii=False),
                    "l2_path": None,
                    "l3_path": None,
                    "tags": f"engine:{normalized['engine']}",
                    "checksum": None,
                },
                overwrite=False,
            )
        except DuplicateRunError:
            return actual
        self._active_runs[actual] = {
            **normalized,
            "run_id": actual,
            "created_at": created_at,
            "status": "running",
        }
        self._history_events.setdefault(actual, [])
        self._subscribers.setdefault(actual, [])
        return actual

    @staticmethod
    def _existing_summary(existing: Mapping[str, Any]) -> Dict[str, Any]:
        summary = existing.get("summary")
        if isinstance(summary, Mapping):
            return dict(summary)
        raw = existing.get("summary_json")
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                return dict(parsed) if isinstance(parsed, Mapping) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    async def enqueue_run(
        self,
        problem: Optional[str] = None,
        *,
        request: Optional[Mapping[str, Any]] = None,
        max_model_calls: int = int(DEFAULT_BUDGET["max_model_calls"]),
        max_method_loads: int = int(DEFAULT_BUDGET["max_method_loads"]),
        engine: str = "ts",
        run_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """注册并异步启动执行任务；同一幂等键只执行一次。"""
        normalized = self._normalized_request(
            problem,
            request,
            max_model_calls=max_model_calls,
            max_method_loads=max_method_loads,
            engine=engine,
            idempotency_key=idempotency_key,
        )
        actual = self.derive_run_id(
            run_id=run_id,
            idempotency_key=normalized.get("idempotency_key"),
        )
        existing = self.store.get_run(actual)
        if existing is not None:
            previous = self._existing_summary(existing)
            previous_fingerprint = previous.get("requestFingerprint")
            current_fingerprint = request_fingerprint(normalized)
            if previous_fingerprint and previous_fingerprint != current_fingerprint:
                raise IdempotencyConflict(
                    "same idempotency key was already used with different request content"
                )
            return {
                "run_id": actual,
                "status": existing["status"],
                "started": False,
                "idempotent_replay": True,
                "terminal": existing["status"] not in NON_TERMINAL_STATUSES,
            }
        actual = self.prepare_run(request=normalized, run_id=actual)
        self._schedule(actual)
        return {
            "run_id": actual,
            "status": "running",
            "started": True,
            "idempotent_replay": False,
            "terminal": False,
        }

    # ------------------------------------------------------------- 串行调度
    def _schedule(self, run_id: str) -> None:
        self._pending.append(run_id)
        self._started_total += 1
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._worker_loop())

    async def _worker_loop(self) -> None:
        """单 worker 逐条消费：并发上限强制为 1。"""
        try:
            while self._pending:
                run_id = self._pending.pop(0)
                await self._run_one(run_id)
        finally:
            self._worker = None

    async def wait_idle(self, timeout: float = 15.0) -> bool:
        """等待队列与在跑任务清空（测试/优雅收口用）。"""
        deadline = time.monotonic() + timeout
        while (self._pending or self._running) and time.monotonic() < deadline:
            await asyncio.sleep(0.002)
        return not self._pending and not self._running

    async def _run_one(self, run_id: str) -> None:
        info = self._active_runs.get(run_id)
        if info is None:
            return

        self._running.add(run_id)
        self._inflight += 1
        self._max_observed_concurrency = max(self._max_observed_concurrency, self._inflight)
        started = time.time()
        loop = asyncio.get_running_loop()

        def event_sink(event: Mapping[str, Any]) -> None:
            loop.call_soon_threadsafe(self.append_event_sync, run_id, dict(event))

        try:
            outcome = await self._invoke_solver(info, event_sink=event_sink)
        except Exception as exc:  # 求解链抛出 → 系统级失败（绝不静默降级）
            logger.error("solver raised for %s: %s", run_id, exc)
            outcome = SolveOutcome.system_failure(
                f"求解链抛出异常：{type(exc).__name__}"
            )

        duration_s = round(time.time() - started, 3)
        try:
            self._finalize(info, outcome, duration_s=duration_s)
        except Exception as exc:
            logger.error("failed to finalize run %s: %s", run_id, exc)
        finally:
            self._inflight -= 1
            self._running.discard(run_id)
            self._completed_total += 1
            self._active_runs.pop(run_id, None)
            self._notify_close(run_id)

    async def _invoke_solver(
        self,
        info: Mapping[str, Any],
        *,
        event_sink: Optional[Callable[[Mapping[str, Any]], None]] = None,
    ) -> SolveOutcome:
        if self._solver is None:
            return SolveOutcome.not_executed(
                "BFF 未接线真实求解入口，本次运行未执行任何求解；"
                "无真实结果，故返回显式未执行态（不提供演示数据冒充）"
            )
        request = {
            key: info[key]
            for key in (
                "run_id", "problem", "engine", "metadata", "idempotency_key",
                "max_model_calls", "max_work_units", "max_effects",
                "max_reviews", "max_method_loads", "max_repairs",
                "max_consensus", "max_r0", "problem_seconds", "policy",
            )
            if key in info
        }
        if event_sink is not None:
            request["_event_sink"] = event_sink
        raw = await asyncio.to_thread(self._solver, request)
        return self._coerce_outcome(raw)

    @staticmethod
    def _coerce_outcome(raw: Any) -> SolveOutcome:
        if isinstance(raw, SolveOutcome):
            return raw
        if not isinstance(raw, Mapping):
            raise TypeError("solver must return SolveOutcome or a mapping")
        reason_raw = raw.get("stopReason") or raw.get("stop_reason") or StopReason.ERROR.value
        try:
            stop_reason = StopReason(str(reason_raw))
        except ValueError:
            stop_reason = StopReason.ERROR
        final_response = raw.get("final_response")
        if not isinstance(final_response, str) or not final_response:
            final_response = UNSOLVED_RESPONSE
        events = raw.get("events") or ()
        if not isinstance(events, (list, tuple)):
            raise TypeError("solver 'events' must be a list of envelopes")
        metrics = raw.get("metrics")
        if metrics is not None and not isinstance(metrics, Mapping):
            metrics = None
        trace = raw.get("trace") or ()
        if not isinstance(trace, (list, tuple)):
            trace = ()
        child_reaped = raw.get("childReaped")
        if child_reaped is not None and not isinstance(child_reaped, bool):
            child_reaped = None
        elapsed_ms = raw.get("elapsedMs")
        if isinstance(elapsed_ms, bool) or not isinstance(elapsed_ms, int):
            elapsed_ms = None
        return SolveOutcome(
            stop_reason=stop_reason,
            final_response=final_response,
            reason=str(raw.get("reason") or ""),
            code=raw.get("code"),
            executed=bool(raw.get("executed", True)),
            events=tuple(events),
            metrics=dict(metrics) if metrics is not None else None,
            child_reaped=child_reaped,
            trace=tuple(dict(row) for row in trace if isinstance(row, Mapping)),
            session_id=str(raw.get("sessionId") or ""),
            finish_reason=str(raw["finishReason"]) if raw.get("finishReason") is not None else None,
            elapsed_ms=elapsed_ms,
            result=dict(raw),
        )

    # ----------------------------------------------------------- 终态与落盘
    def _finalize(self, info: Mapping[str, Any], outcome: SolveOutcome, *, duration_s: float) -> None:
        run_id = info["run_id"]
        status = classify_stop_reason(outcome.stop_reason).value
        terminal_kind = classify_terminal_kind(outcome.stop_reason)

        raw = dict(outcome.result or {})
        summary = {
            "runId": run_id,
            "engine": info["engine"],
            "status": status,
            "final_response": outcome.final_response,
            "candidate_verified": False,  # 红线不可破坏
            "stopReason": outcome.stop_reason.value,
            "terminalKind": terminal_kind.value if terminal_kind is not None else None,
            "reason": outcome.reason,
            "code": outcome.code,
            "executed": outcome.executed,
            "childReaped": outcome.child_reaped,
            "elapsedMs": outcome.elapsed_ms if outcome.elapsed_ms is not None else int(duration_s * 1000),
            "sessionId": outcome.session_id or str(raw.get("sessionId") or ""),
            "finishReason": outcome.finish_reason,
            "strictAcceptance": raw.get("strictAcceptance", "NOT_PERFORMED"),
            "mode": raw.get("mode", "TS_PREVIEW"),
            "targetEnvironment": raw.get("targetEnvironment", "TARGET_UNVERIFIED"),
            "unresolvedObligations": list(raw.get("unresolvedObligations") or []),
            "carrier": raw.get("carrier", ""),
            "trace": [dict(row) for row in outcome.trace],
            "requestFingerprint": info.get("requestFingerprint"),
        }
        for key in (
            "problem", "metadata", "max_model_calls", "max_work_units",
            "max_effects", "max_reviews", "max_method_loads", "max_repairs",
            "max_consensus", "max_r0", "problem_seconds", "policy",
        ):
            if key in info:
                summary[key] = info[key]
        if outcome.metrics is not None:
            summary["metrics"] = dict(outcome.metrics)

        # Real-time observer events are already in the per-run history. Append
        # any final events supplied by the solver, then persist the same ordered
        # history used by SSE; no event is fabricated during finalization.
        for event in outcome.events:
            self.append_event_sync(run_id, dict(event))
        history = list(self._history_events.get(run_id, []))
        l2_rel: Optional[str] = None
        if history:
            l2_rel = f"runs/{run_id}/details.json"
            atomic_write_json(
                self.store.safe_join(l2_rel),
                {"events": history, "summary": summary},
            )

        record = {
            "run_id": run_id,
            "created_at": info["created_at"],
            "source": "worker",
            "status": status,
            "scenario": str(info["problem"])[:40],
            "model": None,
            "seed": None,
            "duration_s": duration_s,
            "summary_json": json.dumps(summary, ensure_ascii=False),
            "l2_path": l2_rel,
            "l3_path": None,
            "tags": f"engine:{info['engine']},terminal:{status}",
            "checksum": None,
        }
        if not self.store.save_run_terminal(record):
            logger.warning("terminal record for %s already exists; kept immutable", run_id)

    # ------------------------------------------------------------- 事件流
    def append_event_sync(self, run_id: str, event: Dict[str, Any]) -> None:
        """同步追加单条真实事件并分发；只补齐传输信封字段。"""
        if run_id not in self._history_events:
            self._history_events[run_id] = []
        history = self._history_events[run_id]
        row = dict(event)
        row.setdefault("runId", run_id)
        row.setdefault("seq", len(history) + 1)
        row.setdefault("at", int(time.time() * 1000))
        row.setdefault("sourceKind", "observed_archive")
        row.setdefault("detailLevel", "partial_observed")
        history.append(row)

        queues = self._subscribers.get(run_id, [])
        for q in list(queues):
            try:
                q.put_nowait(row)
            except Exception:  # 订阅者队列已满/已关闭：不影响主流程
                pass

    async def broadcast_event(self, run_id: str, event: Dict[str, Any]) -> None:
        """向所有 SSE 订阅者广播单个事件，并追加至内存历史。"""
        self.append_event_sync(run_id, event)

    def _notify_close(self, run_id: str) -> None:
        """终态收口：只发送流关闭帧（不带任何伪造的信封）。"""
        payload: Dict[str, Any] = {}
        run = self.store.get_run(run_id)
        if run is not None:
            summary = run.get("summary") or {}
            payload = {
                "status": run.get("status"),
                "stopReason": summary.get("stopReason"),
                "terminalKind": summary.get("terminalKind"),
                "final_response": summary.get("final_response"),
                "executed": summary.get("executed"),
                "code": summary.get("code"),
            }
        for q in list(self._subscribers.get(run_id, [])):
            try:
                q.put_nowait({"kind": "close", "seq": 9999, "payload": payload})
            except Exception:
                pass

    def subscribe(self, run_id: str) -> asyncio.Queue:
        """为特定 run_id 创建一个事件队列。"""
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(run_id, []).append(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        if run_id in self._subscribers and q in self._subscribers[run_id]:
            self._subscribers[run_id].remove(q)

    def get_history_events(self, run_id: str) -> List[Dict[str, Any]]:
        """获取当前会话的历史事件（优先内存，次选 L2 磁盘存档）。"""
        if run_id in self._history_events:
            return list(self._history_events[run_id])

        run = self.store.get_run(run_id)
        if run and run.get("l2_path"):
            try:
                l2_file = self.store.safe_join(run["l2_path"])
                if l2_file.is_file():
                    data = json.loads(l2_file.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and "events" in data:
                        return list(data["events"])
            except Exception as e:
                logger.warning("failed to read l2 events for %s: %s", run_id, e)

        return []