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

from .archive import atomic_write_json
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
    """校验求解请求体字段合规性。"""
    if not isinstance(body, dict):
        raise ValidationError("request body must be a JSON object")

    problem = body.get("problem")
    if not isinstance(problem, str) or not problem.strip():
        raise ValidationError("'problem' must be a non-empty string")

    # 严格校验 max_method_loads ∈ {0, 1}（且禁止用 bool 冒充）
    max_method_loads = body.get("max_method_loads", 1)
    if isinstance(max_method_loads, bool) or max_method_loads not in (0, 1):
        raise ValidationError("'max_method_loads' must be exactly 0 or 1 (boolean is forbidden)")

    max_model_calls = body.get("max_model_calls", 24)
    if isinstance(max_model_calls, bool) or not isinstance(max_model_calls, int) or max_model_calls <= 0:
        raise ValidationError("'max_model_calls' must be a positive integer")

    engine = body.get("engine", "ts")
    idempotency_key = body.get("idempotency_key")

    return {
        "problem": problem.strip(),
        "max_method_loads": max_method_loads,
        "max_model_calls": max_model_calls,
        "engine": engine,
        "idempotency_key": idempotency_key,
    }


@dataclass(frozen=True)
class SolveOutcome:
    """真实求解链交回的终态结果，或显式的“未执行”声明。

    ``executed=False`` 表示本次运行**没有**执行任何求解链，因此**没有真实结果**；
    此时 ``final_response`` 按官方契约取 ``"Unsolved."`` 并保留 ``stopReason``。
    ``events`` 只允许装载真实观测到的事件信封（含真实 ``sourceKind``）。
    """
    stop_reason: StopReason
    final_response: str = UNSOLVED_RESPONSE
    reason: str = ""
    code: Optional[str] = None
    executed: bool = True
    events: Tuple[Mapping[str, Any], ...] = field(default_factory=tuple)
    metrics: Optional[Mapping[str, Any]] = None

    @classmethod
    def not_executed(cls, reason: str) -> "SolveOutcome":
        """未接线真实求解入口时的显式未执行态（不返回任何演示数据）。"""
        return cls(
            stop_reason=StopReason.ERROR,
            final_response=UNSOLVED_RESPONSE,
            reason=reason,
            code=CODE_SOLVER_NOT_CONFIGURED,
            executed=False,
        )

    @classmethod
    def system_failure(cls, reason: str, *, code: str = CODE_SOLVER_FAILED) -> "SolveOutcome":
        """系统级失败（启动失败/进程异常/内部错误），映射为 system-failure。"""
        return cls(
            stop_reason=StopReason.ERROR,
            final_response=UNSOLVED_RESPONSE,
            reason=reason,
            code=code,
            executed=True,
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
    def prepare_run(
        self,
        problem: str,
        *,
        max_model_calls: int = 24,
        max_method_loads: int = 1,
        engine: str = "ts",
        run_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> str:
        """同步注册一次运行（不启动执行；可在纯同步测试环境直接使用）。

        幂等且不覆盖：若目标 run_id 已存在（运行中或终态），直接返回该 id，
        **绝不改写**既有记录。
        """
        actual = self.derive_run_id(run_id=run_id, idempotency_key=idempotency_key)

        if actual in self._active_runs or self.store.has_run(actual):
            return actual

        created_at = time.time()
        initial_summary = {
            "problem": problem,
            "engine": engine,
            "status": "running",
            "candidate_verified": False,
            "max_model_calls": max_model_calls,
            "max_method_loads": max_method_loads,
        }

        try:
            self.store.save_run(
                {
                    "run_id": actual,
                    "created_at": created_at,
                    "source": "worker",
                    "status": "running",
                    "scenario": problem[:40],
                    "model": None,
                    "seed": None,
                    "duration_s": 0.0,
                    "summary_json": json.dumps(initial_summary, ensure_ascii=False),
                    "l2_path": None,
                    "l3_path": None,
                    "tags": f"engine:{engine}",
                    "checksum": None,
                },
                overwrite=False,
            )
        except DuplicateRunError:
            # 竞态：已被并发写入，保持既有记录不变
            return actual

        self._active_runs[actual] = {
            "run_id": actual,
            "problem": problem,
            "engine": engine,
            "created_at": created_at,
            "status": "running",
            "max_model_calls": max_model_calls,
            "max_method_loads": max_method_loads,
        }
        self._history_events.setdefault(actual, [])
        self._subscribers.setdefault(actual, [])
        return actual

    async def enqueue_run(
        self,
        problem: str,
        *,
        max_model_calls: int = 24,
        max_method_loads: int = 1,
        engine: str = "ts",
        run_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """注册并异步启动执行任务。

        返回 ``{run_id, status, started, idempotent_replay, terminal}``。
        同一幂等键重复提交：**不再次启动执行**，返回同一 runId 与既有状态。
        """
        actual = self.derive_run_id(run_id=run_id, idempotency_key=idempotency_key)

        existing = self.store.get_run(actual)
        if existing is not None:
            logger.info("idempotent replay for %s (existing status=%s)", actual, existing["status"])
            return {
                "run_id": actual,
                "status": existing["status"],
                "started": False,
                "idempotent_replay": True,
                "terminal": existing["status"] not in NON_TERMINAL_STATUSES,
            }

        actual = self.prepare_run(
            problem,
            max_model_calls=max_model_calls,
            max_method_loads=max_method_loads,
            engine=engine,
            run_id=actual,
        )
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
        try:
            outcome = await self._invoke_solver(info)
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

    async def _invoke_solver(self, info: Mapping[str, Any]) -> SolveOutcome:
        if self._solver is None:
            return SolveOutcome.not_executed(
                "BFF 未接线真实求解入口，本次运行未执行任何求解；"
                "无真实结果，故返回显式未执行态（不提供演示数据冒充）"
            )
        request = {
            "run_id": info["run_id"],
            "problem": info["problem"],
            "engine": info["engine"],
            "max_model_calls": info["max_model_calls"],
            "max_method_loads": info["max_method_loads"],
        }
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
        return SolveOutcome(
            stop_reason=stop_reason,
            final_response=final_response,
            reason=str(raw.get("reason") or ""),
            code=raw.get("code"),
            executed=bool(raw.get("executed", True)),
            events=tuple(events),
        )

    # ----------------------------------------------------------- 终态与落盘
    def _finalize(self, info: Mapping[str, Any], outcome: SolveOutcome, *, duration_s: float) -> None:
        run_id = info["run_id"]
        status = classify_stop_reason(outcome.stop_reason).value
        terminal_kind = classify_terminal_kind(outcome.stop_reason)

        summary = {
            "engine": info["engine"],
            "status": status,
            "final_response": outcome.final_response,
            "candidate_verified": False,  # 红线不可破坏
            "stopReason": outcome.stop_reason.value,
            "terminalKind": terminal_kind.value if terminal_kind is not None else None,
            "reason": outcome.reason,
            "code": outcome.code,
            "executed": outcome.executed,
            "childReaped": True,
            "elapsedMs": int(duration_s * 1000),
        }
        if outcome.metrics is not None:
            summary["metrics"] = dict(outcome.metrics)

        l2_rel: Optional[str] = None
        if outcome.events:
            l2_rel = f"runs/{run_id}/details.json"
            atomic_write_json(
                self.store.safe_join(l2_rel),
                {"events": [dict(ev) for ev in outcome.events], "summary": summary},
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

        # 只有真实观测到的事件才进入历史并广播（不做任何补齐/合成）
        for event in outcome.events:
            self.append_event_sync(run_id, dict(event))

    # ------------------------------------------------------------- 事件流
    def append_event_sync(self, run_id: str, event: Dict[str, Any]) -> None:
        """同步追加单条事件至内存历史并分发。"""
        if run_id not in self._history_events:
            self._history_events[run_id] = []
        self._history_events[run_id].append(event)

        queues = self._subscribers.get(run_id, [])
        for q in list(queues):
            try:
                q.put_nowait(event)
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