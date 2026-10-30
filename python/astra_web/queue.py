"""执行队列与实时事件流管理层（保真版）。

职责
----
1. 请求接收与白名单校验（POST /api/runs，受控的 max_method_loads ∈ {0..4}）。
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
import os
import time
from pathlib import Path
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from pydantic import ValidationError as PydanticValidationError

from .archive import atomic_write_json
from .config import DEFAULT_BUDGET, default_budget
from .contracts.dto import RunRequestDto
from .contracts.enums import StopReason
from .contracts.mapping import classify_stop_reason, classify_terminal_kind
from .storage import (
    NON_TERMINAL_STATUSES,
    DuplicateRunError,
    Store,
    is_terminal_status,
    is_valid_run_id,
)

logger = logging.getLogger("astra_web.queue")

def _read_process_identity(pid: int) -> Optional[Dict[str, Any]]:
    """Identity of one process *instance* (pids are reused, so pid alone lies).

    ``boot_id`` changes on reboot and ``starttime`` (``/proc/<pid>/stat`` field 22)
    changes on every fork, so the pair identifies one concrete process instance
    even after the kernel recycles its pid.
    """
    if type(pid) is not int or pid <= 0:
        return None
    boot_id: Optional[str] = None
    start_ticks: Optional[int] = None
    proc = Path("/proc")
    if proc.is_dir():
        try:
            boot_id = (proc / "sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        except OSError:
            boot_id = None
        try:
            raw = (proc / str(pid) / "stat").read_text(encoding="utf-8")
            # ``comm`` may contain spaces/parentheses, so split after the last ')'.
            fields = raw.rsplit(")", 1)[1].split()
            start_ticks = int(fields[19])
        except (OSError, IndexError, ValueError):
            return None if boot_id is None else {
                "pid": pid,
                "bootId": boot_id,
                "startTicks": None,
            }
    if boot_id is None and start_ticks is None:
        return None
    return {"pid": pid, "bootId": boot_id, "startTicks": start_ticks}


def _own_process_identity() -> Dict[str, Any]:
    identity = _read_process_identity(os.getpid()) or {"pid": os.getpid()}
    return {
        "ownerPid": identity.get("pid"),
        "ownerBootId": identity.get("bootId"),
        "ownerStartTicks": identity.get("startTicks"),
    }


# Import time ≈ BFF process start. A legacy record (no owner identity) may only be
# recovered when it predates this process, so a concurrent sibling can never be
# closed by mistake.
_PROCESS_STARTED_AT = time.time()

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
        self._recovered_runs: List[str] = []
        # Per-manager token: two managers can share one process, so the pid alone
        # cannot tell "my run" from "another manager's run".
        self._owner_token = uuid.uuid4().hex

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
            "recovered_runs": len(self._recovered_runs),
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
            # Ownership is recorded so restart recovery can tell a真 orphan from a
            # run that another live process (or a spawned helper that re-imports
            # this module) is still working on.
            "ownerToken": self._owner_token,
            **_own_process_identity(),
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
            "provider": raw.get("provider") or info.get("provider") or os.environ.get("ASTRA_PROVIDER", "s2"),
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
        # The authoritative terminal record is a real event, not an inference:
        # replay and detail views must be able to close the run without a second,
        # separately-shaped summary document.
        self.append_terminal_event(run_id, summary)
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

    # --------------------------------------------------------- 重启恢复
    def recover_orphan_runs(self) -> List[str]:
        """收口上一个进程遗留的非终态运行。

        运行中途退出时，worker 线程、调用线程与责任记录都会消失，但已观测事件
        已经增量落盘。这里把这些运行如实收口为 **系统级失败 + 远端结果未知**：

        * 绝不改写为 candidate / solved，也不推测数学结论；
        * 若历史里出现过真实模型派发，则明确记录 ``remote_outcome_unknown=True``，
          保留未决请求责任，而不是把它当作“从未发生”；
        * 终态与事件都以真实记录落盘，回放与详情页因此可以完整收口。
        """
        recovered: List[str] = []
        try:
            records = self.store.list_runs(limit=500)
        except Exception as exc:
            logger.warning("failed to scan runs for restart recovery: %s", exc)
            return recovered

        for record in records:
            run_id = record.get("run_id")
            if not isinstance(run_id, str) or not is_valid_run_id(run_id):
                continue
            if record.get("status") not in NON_TERMINAL_STATUSES:
                continue
            if run_id in self._active_runs:
                continue
            if not self._owner_is_gone(record):
                # Another live process still owns this run (a spawned helper that
                # re-imports this module, or a second BFF sharing the data root).
                # Closing it here would fabricate an outcome for a live run.
                continue
            try:
                if self._recover_one(record):
                    recovered.append(run_id)
            except Exception as exc:
                logger.error("failed to recover orphan run %s: %s", run_id, exc)
        self._recovered_runs = list(recovered)
        if recovered:
            logger.warning(
                "recovered %d run(s) left non-terminal by a previous process "
                "(pid=%s, root=%s): %s",
                len(recovered),
                os.getpid(),
                self.store.root,
                ", ".join(recovered),
            )
        return recovered

    @staticmethod
    def _pid_alive(pid: Any) -> bool:
        if type(pid) is not int or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:  # exists, owned by another user
            return True
        except OSError:
            return False
        return True

    def _owner_is_gone(self, record: Mapping[str, Any]) -> bool:
        """A run may only be recovered when its owner can no longer finish it.

        A live *pid* is not proof: the kernel recycles pids, so a brand-new
        process can wear the dead owner's number. The recorded boot id and
        kernel start time identify one process *instance*, and only that instance
        keeps a run alive.
        """
        summary = self._existing_summary(record)
        owner = summary.get("ownerPid")
        if type(owner) is int and owner > 0:
            if owner == os.getpid():
                # This pid is mine *now*, but it may have belonged to the dead
                # owner before the kernel recycled it. Instance identity decides.
                me = _own_process_identity()
                recorded_boot = summary.get("ownerBootId")
                recorded_start = summary.get("ownerStartTicks")
                if (
                    isinstance(recorded_boot, str)
                    and me.get("ownerBootId")
                    and recorded_boot != me["ownerBootId"]
                ):
                    return True
                if type(recorded_start) is int and type(me.get("ownerStartTicks")) is int:
                    if recorded_start != me["ownerStartTicks"]:
                        return True
                # Genuinely this process: only this very manager may reclaim its
                # own run. A sibling manager (or a spawned helper that re-imports
                # this module) must never close a run it does not own.
                return summary.get("ownerToken") == self._owner_token
            if not self._pid_alive(owner):
                return True
            recorded_boot = summary.get("ownerBootId")
            recorded_start = summary.get("ownerStartTicks")
            live = _read_process_identity(owner)
            if live is None:
                # The pid exists but its identity cannot be read: assume it is
                # still the owner and never close a live run.
                return False
            if isinstance(recorded_boot, str) and live.get("bootId"):
                if recorded_boot != live["bootId"]:
                    return True  # different boot: the owner is certainly gone
            if type(recorded_start) is int and type(live.get("startTicks")) is int:
                return live["startTicks"] != recorded_start  # pid was recycled
            # No usable identity on record: stay conservative.
            return False
        # Legacy record without ownership: only trust records older than this
        # process, so a concurrent sibling can never be closed by mistake.
        created_at = record.get("created_at")
        if isinstance(created_at, (int, float)):
            return float(created_at) < _PROCESS_STARTED_AT
        return False

    @staticmethod
    def remote_outcome_unknown(events: Sequence[Mapping[str, Any]]) -> bool:
        """Pair every dispatch with its return; only truly unresolved calls count.

        A request whose ``model_returned`` says COMPLETE/TRUNCATED/ERROR has a
        known remote outcome, so a later crash must not relabel it as unknown.
        """
        pending: Dict[str, bool] = {}
        anonymous_pending = 0
        for row in events:
            kind = str(row.get("kind"))
            payload = row.get("payload")
            body = payload if isinstance(payload, Mapping) else {}
            request_id = body.get("requestId")
            if kind in {"model_dispatched", "MODEL_REQUEST"}:
                if isinstance(request_id, str):
                    pending[request_id] = True
                else:
                    anonymous_pending += 1
            elif kind == "model_returned":
                status = body.get("transportStatus")
                # The Host records whether the request actually left the process:
                # a NOT_DISPATCHED return proves nothing was sent, so it settles
                # the entry instead of keeping it as an unknown remote outcome.
                dispatch_state = body.get("dispatchState")
                settled = status in {"COMPLETE", "TRUNCATED", "ERROR"} or (
                    dispatch_state == "NOT_DISPATCHED"
                )
                if isinstance(request_id, str):
                    if settled:
                        pending.pop(request_id, None)
                    else:
                        pending[request_id] = True
        return bool(pending) or anonymous_pending > 0

    def _persisted_terminal(self, record: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        """Authoritative terminal record already on disk, if the crash left one.

        ``_finalize`` appends the RESULT event and the ``details.json`` archive
        *before* committing the database row. A crash in between must be finished
        forward (commit the archived terminal), never rewritten as a system
        failure that contradicts the archive.
        """
        run_id = str(record["run_id"])
        candidates: List[Dict[str, Any]] = []
        l2_path = record.get("l2_path") or f"runs/{run_id}/details.json"
        for rel in {str(l2_path), f"runs/{run_id}/details.json"}:
            try:
                path = self.store.safe_join(rel)
            except Exception:
                continue
            if not path.is_file():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            summary = payload.get("summary") if isinstance(payload, Mapping) else None
            if isinstance(summary, Mapping):
                candidates.append(dict(summary))
        for row in self.get_history_events(run_id):
            if str(row.get("kind")) != "RESULT":
                continue
            body = row.get("payload")
            if isinstance(body, Mapping):
                candidates.append(dict(body))
        for candidate in candidates:
            status = candidate.get("status")
            stop_reason = candidate.get("stopReason") or candidate.get("stop_reason")
            if isinstance(status, str) and is_terminal_status(status) and isinstance(stop_reason, str):
                return candidate
        return None

    def _recover_one(self, record: Mapping[str, Any]) -> bool:
        run_id = str(record["run_id"])
        summary = self._existing_summary(record)
        events = self.get_history_events(run_id)
        persisted = self._persisted_terminal(record)
        if persisted is not None:
            return self._commit_persisted_terminal(record, persisted, events)

        unknown = self.remote_outcome_unknown(events)
        kind = classify_terminal_kind(StopReason.TRANSPORT_STOP)
        metrics = summary.get("metrics")
        metrics = dict(metrics) if isinstance(metrics, Mapping) else {}
        metrics["remote_outcome_unknown"] = unknown
        created_at = record.get("created_at")
        elapsed_ms = None
        if isinstance(created_at, (int, float)):
            elapsed_ms = int(max(0.0, time.time() - float(created_at)) * 1000)

        recovered_summary = {
            **summary,
            "runId": run_id,
            "status": classify_stop_reason(StopReason.TRANSPORT_STOP).value,
            "stopReason": StopReason.TRANSPORT_STOP.value,
            "terminalKind": kind.value if kind is not None else None,
            "reason": (
                "BFF 进程在运行中途重启：本次运行的 worker 已不存在，"
                "未取得终态事实，按系统级失败收口并保留未决请求责任"
            ),
            "code": "HOST_RESTARTED",
            "final_response": summary.get("final_response") or UNSOLVED_RESPONSE,
            "executed": False,
            "candidate_verified": False,  # 红线不可破坏
            "childReaped": None,
            "elapsedMs": elapsed_ms,
            "metrics": metrics,
        }

        # 先写一条真实的系统级事件，再写权威终态 RESULT 事件：两者都来自本次
        # 恢复动作本身，且都在事件流里可见，不是对结果的推测。
        self.append_event_sync(
            run_id,
            {
                "kind": "error",
                "sourceKind": "observed_archive",
                "detailLevel": "partial_observed",
                "payload": {
                    "code": "HOST_RESTARTED",
                    "message": recovered_summary["reason"],
                    "remoteOutcomeUnknown": metrics["remote_outcome_unknown"],
                    "eventsBeforeRestart": len(events),
                },
            },
        )
        self.append_terminal_event(run_id, recovered_summary)

        history = list(self._history_events.get(run_id, []))
        l2_rel = f"runs/{run_id}/details.json"
        try:
            atomic_write_json(
                self.store.safe_join(l2_rel),
                {"events": history, "summary": recovered_summary},
            )
        except Exception as exc:
            logger.warning("failed to persist recovered archive for %s: %s", run_id, exc)
            l2_rel = record.get("l2_path")

        saved = self.store.save_run_terminal(
            {
                "run_id": run_id,
                "created_at": record.get("created_at") or time.time(),
                "source": record.get("source") or "worker",
                "status": recovered_summary["status"],
                "scenario": record.get("scenario"),
                "model": record.get("model"),
                "seed": record.get("seed"),
                "duration_s": record.get("duration_s") or 0.0,
                "summary_json": json.dumps(recovered_summary, ensure_ascii=False),
                "l2_path": l2_rel,
                "l3_path": record.get("l3_path"),
                "tags": f"engine:{summary.get('engine', 'ts')},terminal:{recovered_summary['status']},recovered:restart",
                "checksum": record.get("checksum"),
            }
        )
        return bool(saved)

    def _commit_persisted_terminal(
        self,
        record: Mapping[str, Any],
        persisted: Mapping[str, Any],
        events: Sequence[Mapping[str, Any]],
    ) -> bool:
        """Finish a crash that happened after the terminal evidence was written.

        The archived terminal record wins: the database row is simply completed
        from it, the archive is completed from the events, and no outcome is
        invented or downgraded.
        """
        run_id = str(record["run_id"])
        base = self._existing_summary(record)
        finished = {
            **base,
            **{key: value for key, value in dict(persisted).items() if value is not None},
            "runId": run_id,
            "candidate_verified": False,  # 红线：候选永不被表述为已验证
            "committedFromArchive": True,
        }
        kind = classify_terminal_kind(
            StopReason(finished["stopReason"]) if finished.get("stopReason") in {r.value for r in StopReason} else StopReason.ERROR
        )
        finished.setdefault("terminalKind", kind.value if kind is not None else None)
        finished.setdefault("executed", True)
        finished.setdefault("childReaped", None)

        self.append_terminal_event(run_id, finished)
        history = list(self._history_events.get(run_id, []))
        l2_rel = f"runs/{run_id}/details.json"
        try:
            atomic_write_json(
                self.store.safe_join(l2_rel),
                {"events": history, "summary": finished},
            )
        except Exception as exc:
            logger.warning("failed to rewrite archive for %s: %s", run_id, exc)
            l2_rel = record.get("l2_path") or l2_rel

        saved = self.store.save_run_terminal(
            {
                "run_id": run_id,
                "created_at": record.get("created_at") or time.time(),
                "source": record.get("source") or "worker",
                "status": finished["status"],
                "scenario": record.get("scenario"),
                "model": record.get("model"),
                "seed": record.get("seed"),
                "duration_s": record.get("duration_s") or 0.0,
                "summary_json": json.dumps(finished, ensure_ascii=False),
                "l2_path": l2_rel,
                "l3_path": record.get("l3_path"),
                "tags": (
                    f"engine:{base.get('engine', 'ts')},"
                    f"terminal:{finished['status']},recovered:terminal-from-archive"
                ),
                "checksum": record.get("checksum"),
            }
        )
        if saved:
            logger.warning(
                "completed terminal row for %s from its persisted archive (%s)",
                run_id,
                finished["status"],
            )
        return bool(saved)

    # ------------------------------------------------------------- 事件流
    def append_terminal_event(
        self, run_id: str, summary: Mapping[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """把权威终态记录写成一条真实 RESULT 事件（同一 run 只写一次）。"""
        if any(
            str(row.get("kind")) == "RESULT"
            for row in self._history_events.get(run_id, [])
        ):
            return None
        event = {
            "kind": "RESULT",
            "sourceKind": "official_result",
            "detailLevel": "partial_observed",
            "payload": {
                "status": summary.get("status"),
                "stopReason": summary.get("stopReason"),
                "terminalKind": summary.get("terminalKind"),
                "final_response": summary.get("final_response"),
                "reason": summary.get("reason"),
                "code": summary.get("code"),
                "executed": summary.get("executed"),
                "childReaped": summary.get("childReaped"),
                "candidate_verified": False,
                "elapsedMs": summary.get("elapsedMs"),
                "sessionId": summary.get("sessionId"),
            },
        }
        self.append_event_sync(run_id, event)
        return event

    @staticmethod
    def events_relpath(run_id: str) -> str:
        """运行事件的增量落盘路径（append-only JSON Lines）。"""
        return f"runs/{run_id}/events.jsonl"

    def _append_event_line(self, run_id: str, row: Mapping[str, Any]) -> None:
        """把单条事件立即追加到磁盘；失败只记日志，绝不改写数学结果。"""
        try:
            path = self.store.safe_join(self.events_relpath(run_id))
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(dict(row), ensure_ascii=False) + "\n")
        except Exception as exc:  # 落盘故障不能改变运行语义
            logger.warning("failed to append event for %s: %s", run_id, exc)

    def _read_persisted_events(self, run_id: str) -> List[Dict[str, Any]]:
        """读取增量落盘的事件（进程重启后内存历史为空时的唯一真实来源）。"""
        try:
            path = self.store.safe_join(self.events_relpath(run_id))
        except Exception:
            return []
        if not path.is_file():
            return []
        rows: List[Dict[str, Any]] = []
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, Mapping):
                    rows.append(dict(parsed))
        except Exception as exc:
            logger.warning("failed to read persisted events for %s: %s", run_id, exc)
            return []
        rows.sort(key=lambda row: row.get("seq", 0) if type(row.get("seq")) is int else 0)
        return rows

    def append_event_sync(self, run_id: str, event: Dict[str, Any]) -> None:
        """同步追加单条真实事件并分发；只补齐传输信封字段。

        事件在产生的**当下**就追加到 ``runs/{run_id}/events.jsonl``：进程在运行
        中途退出时，已观测到的事件不会随内存一起消失。
        """
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
        self._append_event_line(run_id, row)

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

        # 最后回落到增量落盘的 JSONL：即使进程在运行中途退出、终态收口从未发生，
        # 已观测事件仍然可读（并被继续下发），不会被当作“零事件”。
        persisted = self._read_persisted_events(run_id)
        if persisted:
            self._history_events[run_id] = list(persisted)
            return list(persisted)
        return []