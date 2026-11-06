"""Starlette 应用入口：只读与实时 BFF + 静态资源托管。

路由概览
--------
GET  /api/health                 健康检查（保证不调用任何外部未授权模型）
GET  /api/capabilities           能力声明
GET  /api/runs                   运行索引（L1 摘要）
POST /api/runs                   启动推导会话（参数校验 max_method_loads ∈ {0..4}）
GET  /api/runs/{run_id}          单条运行详情
GET  /api/runs/{run_id}/events   实时 SSE 事件流通道（支持 Last-Event-ID 重连）
GET  /api/replays                具备 L2 详细存档的运行
GET  /api/replays/{run_id}       读取 L2 详细存档内容
GET  /api/assets                 资产清单（可按 run_id 过滤）
GET  /api/assets/{asset_id:path} 下载资产（L3）
GET  /                           apps/web-demo/dist 静态资源（若存在，支持 SPA fallback）
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import time
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from python.astra_bridge import host_checkpoint

# 注册关键 MIME 类型，防御 Windows 注册表错误关联（如 .js 映射为 text/plain 导致浏览器严格 MIME 检查阻断 ES 模块）
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/x-icon", ".ico")

from pydantic import ValidationError

from .config import DEFAULT_BUDGET, WEB_ENGINES, default_budget
from .contracts.dto import CapabilitiesDto, RunRequestDto
from .math_assets_catalog import (
    CatalogUnavailable,
    detail_payload as math_asset_detail,
    runtime_info as math_runtime_info,
    summary_payload as math_asset_summary,
)
from .queue import ExecutionManager, IdempotencyConflict
from .solver_adapter import build_solver_from_env
from .storage import PathTraversalError, Store
from .workspace_projector import find_evidence_detail, project_workspace

class JSONResponseUTF8(JSONResponse):
    """显式声明 ``charset=utf-8`` 的 JSON 响应。

    为什么需要：``application/json`` 按 RFC 8259 本身就应以 UTF-8 编解码，但
    Starlette 默认只发 ``content-type: application/json``（不带 charset），
    部分端侧（例如 Windows PowerShell 5.1 的 Web 客户端）会按系统 ANSI/GBK
    解释响应体，使中文显示成 ``BFF æª...`` 之类的乱码。显式声明 charset 即可
    消除端侧歧义。响应体字节与状态码语义完全不变（json.dumps 仍按 UTF-8 编码）。
    """
    media_type = "application/json; charset=utf-8"


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVICE_NAME = "astra-web-bff"
SERVICE_VERSION = "0.1.0"

logger = logging.getLogger("astra_web.app")


def _env_path(var: str, default: str) -> Path:
    return Path(os.environ.get(var, default)).expanduser()


def _terminal_payload(store: Store, run_id: str) -> dict[str, Any]:
    """从真实运行记录里取出终态事实（供 SSE 关闭帧如实告知，不做任何编造）。"""
    run = store.get_run(run_id)
    if run is None:
        return {}
    summary = run.get("summary") or {}
    return {
        "status": run.get("status"),
        "stopReason": summary.get("stopReason"),
        "terminalKind": summary.get("terminalKind"),
        "final_response": summary.get("final_response"),
        "executed": summary.get("executed"),
        "code": summary.get("code"),
    }


def _derive_detail_level(store: Store, run: dict[str, Any], assets: list[dict[str, Any]]) -> str:
    """按**真实存在的存档文件**推导降级级别（L1/L2/L3）。

    * L3 —— 该 run 有真实存在的附件文件；
    * L2 —— 有真实存在的 L2 详细存档；
    * L1 —— 只有索引里的摘要，不存在任何详细存档。

    绝不默认标 L3：级别只由来源（真实文件）决定。
    """
    for row in assets:
        try:
            if store.safe_join(row["rel_path"]).is_file():
                return "L3"
        except (PathTraversalError, KeyError):
            continue
    l2_path = run.get("l2_path")
    if l2_path:
        try:
            if store.safe_join(l2_path).is_file():
                return "L2"
        except PathTraversalError:
            pass
    return "L1"


def health(request: Request) -> JSONResponse:
    """纯本地健康检查；不解析任何外部未授权模型、不触网、不做未授权 I/O。"""
    store: Store = request.app.state.store
    manager: ExecutionManager = request.app.state.execution_manager
    return JSONResponseUTF8({
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "model_invoked": False,
        "data_root": str(store.root),
        "execution": manager.stats(),
    })


def capabilities(request: Request) -> JSONResponse:
    manager: ExecutionManager = request.app.state.execution_manager
    caps = CapabilitiesDto(
        supported_engines=list(WEB_ENGINES),
        supports_cancellation=False,
        default_budget=default_budget(),
        protocol_version="1.4-unified-math-assets",
    )
    return JSONResponseUTF8({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "read_only": False,
        "execution_queue": True,
        "sse_streaming": True,
        "cancellation_supported": False,
        "model_invoked": False,
        **caps.model_dump(),
        "execution": manager.stats(),
        "routes": [
            "/api/health",
            "/api/capabilities",
            "/api/runtime-info",
            "/api/math-assets",
            "/api/math-assets/{assetId}",
            "/api/runs",
            "/api/runs/{run_id}",
            "/api/runs/{run_id}/workspace",
            "/api/runs/{run_id}/evidence/{evidenceId}",
            "/api/runs/{run_id}/recovery",
            "/api/runs/{run_id}/resume",
            "/api/runs/{run_id}/events",
            "/api/replays",
            "/api/assets",
        ],
        "levels": {
            "L1": "summary inline in SQLite index",
            "L2": "detailed archive (JSON on disk)",
            "L3": "binary/text artifacts on disk",
        },
        "limits": {
            "max_method_loads_allowed": [0, 1, 2, 3, 4],
        },
    })


def list_runs(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    limit = int(request.query_params.get("limit", 50))
    offset = int(request.query_params.get("offset", 0))
    status = request.query_params.get("status")
    scenario = request.query_params.get("scenario")
    items = store.list_runs(
        limit=limit, offset=offset, status=status, scenario=scenario,
    )
    return JSONResponseUTF8({"items": items, "count": len(items), "limit": limit, "offset": offset})


async def create_run(request: Request) -> JSONResponse:
    """POST /api/runs 接收新求解请求并启动执行任务。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    try:
        dto = RunRequestDto.model_validate(body)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(part) for part in first.get("loc", ()))
        raise HTTPException(
            status_code=422,
            detail=(loc + ": " if loc else "") + str(first.get("msg", "invalid request")),
        ) from exc

    header_key = request.headers.get("Idempotency-Key")
    if header_key and dto.idempotency_key and header_key != dto.idempotency_key:
        raise HTTPException(status_code=422, detail="conflicting Idempotency-Key values")
    idempotency_key = header_key or dto.idempotency_key
    normalized = dto.model_dump()
    normalized["idempotency_key"] = idempotency_key

    manager: ExecutionManager = request.app.state.execution_manager
    try:
        result = await manager.enqueue_run(request=normalized)
    except IdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # 幂等重放：同一幂等键不会二次启动执行，返回同一 runId 与既有状态（200）；
    # 首次受理返回 201。绝不因重试而重复派发。
    status_code = 200 if result["idempotent_replay"] else 201
    return JSONResponseUTF8(result, status_code=status_code)


def get_run(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    run_id = request.path_params["run_id"]
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    assets = store.list_assets(run_id=run_id)
    run["assets"] = assets
    run["detail_level"] = _derive_detail_level(store, run, assets)
    return JSONResponseUTF8(run)


async def sse_events(request: Request) -> Response:
    """GET /api/runs/{run_id}/events 提供实时 SSE 事件流，支持 Last-Event-ID 重连。"""
    run_id = request.path_params["run_id"]
    store: Store = request.app.state.store
    manager: ExecutionManager = request.app.state.execution_manager

    # 检查运行是否存在
    if not manager.is_active(run_id) and not store.has_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")

    # 解析起始 seq 游标
    after_seq = 0
    last_event_id_header = request.headers.get("Last-Event-ID")
    if last_event_id_header and last_event_id_header.isdigit():
        after_seq = int(last_event_id_header)
    elif "after" in request.query_params and request.query_params["after"].isdigit():
        after_seq = int(request.query_params["after"])

    async def event_generator() -> AsyncIterator[str]:
        cursor = after_seq

        # 1. 回放历史已存事件
        history = manager.get_history_events(run_id)
        for ev in history:
            seq = ev.get("seq", 0)
            if seq > cursor:
                kind = ev.get("kind") or ev.get("type", "message")
                data_str = json.dumps(ev, ensure_ascii=False)
                yield f"id: {seq}\nevent: {kind}\ndata: {data_str}\n\n"
                cursor = seq

        # 2. 如果任务已不在活跃状态，发送结束包
        if not manager.is_active(run_id):
            # 运行已收口：关闭帧如实携带终态事实（不编造事件、不回落演示数据）
            payload = json.dumps(_terminal_payload(store, run_id), ensure_ascii=False)
            yield f"event: close\ndata: {payload}\n\n"
            return

        # 3. 实时订阅
        queue = manager.subscribe(run_id)
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # 保活心跳 ping
                    yield ": ping\n\n"
                    if not manager.is_active(run_id):
                        break
                    continue

                if ev.get("kind") == "close":
                    payload = ev.get("payload") or _terminal_payload(store, run_id)
                    yield f"event: close\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    break

                seq = ev.get("seq", cursor + 1)
                if seq > cursor:
                    kind = ev.get("kind") or ev.get("type", "message")
                    data_str = json.dumps(ev, ensure_ascii=False)
                    yield f"id: {seq}\nevent: {kind}\ndata: {data_str}\n\n"
                    cursor = seq

                # 如果收到终态 RESULT 事件且 run 不再活跃，结束
                if ev.get("kind") == "RESULT":
                    payload = ev.get("payload") or _terminal_payload(store, run_id)
                    yield f"event: close\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    break
        finally:
            manager.unsubscribe(run_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def list_replays(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    limit = int(request.query_params.get("limit", 50))
    offset = int(request.query_params.get("offset", 0))
    items = store.list_runs(limit=limit, offset=offset, has_l2=True)
    return JSONResponseUTF8({"items": items, "count": len(items), "limit": limit, "offset": offset})


def get_replay(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    run_id = request.path_params["run_id"]
    run = store.get_run(run_id)
    if run is None or not run.get("l2_path"):
        raise HTTPException(status_code=404, detail="replay not found")
    try:
        payload_path = store.safe_join(run["l2_path"])
    except PathTraversalError as exc:
        raise HTTPException(status_code=400, detail="unsafe replay path") from exc
    if not payload_path.is_file():
        raise HTTPException(status_code=410, detail="replay payload missing")
    try:
        details = json.loads(payload_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="replay payload unreadable") from exc
    return JSONResponseUTF8({
        "run_id": run_id,
        "source": run["source"],
        "created_at": run["created_at"],
        "details": details,
    })


def _resolve_run_and_events(request: Request, run_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
    store: Store = request.app.state.store
    manager: ExecutionManager = request.app.state.execution_manager
    is_active = manager.is_active(run_id)

    if is_active:
        active_info = manager.get_active_run(run_id) or {}
        run_dict = {
            "run_id": run_id,
            "status": "running",
            "scenario": active_info.get("problem", ""),
            "summary": active_info,
        }
        events = list(manager.get_history_events(run_id))
        return run_dict, events, True

    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")

    events: list[dict[str, Any]] = []
    checkpoint: Optional[dict[str, Any]] = None
    if isinstance(run.get("summary"), dict) and run["summary"].get("checkpoint"):
        checkpoint = run["summary"]["checkpoint"]

    l2_path = run.get("l2_path")
    if l2_path:
        try:
            payload_path = store.safe_join(l2_path)
            if payload_path.is_file():
                details = json.loads(payload_path.read_text(encoding="utf-8"))
                events = list(details.get("events") or [])
                if not checkpoint and isinstance(details.get("checkpoint"), dict):
                    checkpoint = details["checkpoint"]
        except Exception:
            pass

    # Check dedicated checkpoint file runs/{run_id}/checkpoint.json
    if not checkpoint:
        try:
            cp_path = store.safe_join(f"runs/{run_id}/checkpoint.json")
            if cp_path.is_file():
                checkpoint = json.loads(cp_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    if checkpoint:
        run["checkpoint"] = checkpoint

    return run, events, False


def get_workspace(request: Request) -> JSONResponse:
    run_id = request.path_params["run_id"]
    run, events, is_active = _resolve_run_and_events(request, run_id)
    snapshot = project_workspace(run, events, is_active=is_active)
    return JSONResponseUTF8(snapshot)


def get_evidence(request: Request) -> JSONResponse:
    run_id = request.path_params["run_id"]
    evidence_id = request.path_params["evidence_id"]
    run, events, is_active = _resolve_run_and_events(request, run_id)
    detail = find_evidence_detail(run, events, evidence_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="evidence not found")
    return JSONResponseUTF8(detail)


def get_recovery(request: Request) -> JSONResponse:
    run_id = request.path_params["run_id"]
    run, events, is_active = _resolve_run_and_events(request, run_id)
    snapshot = project_workspace(run, events, is_active=is_active)
    return JSONResponseUTF8(snapshot.get("recovery", {}))


def validate_and_prepare_resume(
    run: dict[str, Any],
    events: list[dict[str, Any]],
    is_active: bool,
    headers: Any = None,
) -> dict[str, Any]:
    """校验恢复准入条件并生成收紧预算的同题恢复请求 (方案 9 节 / AGENTS.md:9)."""
    run_id = run.get("run_id") or ""
    snapshot = project_workspace(run, events, is_active=is_active)
    recovery_info = snapshot.get("recovery") or {}

    if is_active:
        raise HTTPException(status_code=409, detail="run is currently active; cannot resume concurrently")
    if not recovery_info.get("eligible"):
        raise HTTPException(
            status_code=400,
            detail=recovery_info.get("reason", "this run is not eligible for resumption"),
        )

    checkpoint = run.get("checkpoint")
    if not checkpoint or not isinstance(checkpoint, dict):
        raise HTTPException(status_code=400, detail="未检测到可信中间检查点，拒绝恢复")

    problem = snapshot.get("problem") or run.get("scenario") or ""
    problem_hash = hashlib.sha256(problem.encode("utf-8")).hexdigest()
    try:
        verified_cp = host_checkpoint.verify_checkpoint(
            checkpoint,
            problem_hash=problem_hash,
            contract_version=host_checkpoint.body_contract_version(checkpoint),
        )
    except host_checkpoint.CheckpointError as exc:
        raise HTTPException(status_code=400, detail=f"检查点校验失败 ({exc.code})，拒绝恢复") from exc

    # Check unknownRequestIds: strictly blocked per AGENTS.md:9
    if len(verified_cp.get("unknownRequestIds") or []) > 0:
        raise HTTPException(
            status_code=400,
            detail="存在未确认远端请求 (OUTCOME_UNKNOWN)，依据安全准则禁止自动续推",
        )

    # 严格收紧预算，不放宽总预算或重新赠送原时限 (Standards S2, S3 / AGENTS.md:9)
    spent_m = verified_cp.get("spent", {}).get("modelCalls", 0)
    max_m = verified_cp.get("budget", {}).get("maxModelCalls", 0)
    rem_m = max(0, max_m - spent_m)
    if rem_m <= 0:
        raise HTTPException(status_code=400, detail="原模型预算已耗尽，禁止超出原限额续推")

    spent_e = verified_cp.get("spent", {}).get("effectCalls", 0)
    max_e = verified_cp.get("budget", {}).get("maxEffects", 0)
    rem_e = max(0, max_e - spent_e)

    # 继承原执行的截止时间，判断是否已过期；同一个截止边界贯穿两次执行，过期必须拒绝；不能拿历史耗时当绝对时间并赠送 (Standards S1, S2)
    original_seconds = float(run.get("summary", {}).get("problem_seconds") or run.get("problem_seconds") or DEFAULT_BUDGET["problem_seconds"])
    duration_s = float(run.get("duration_s", 0.0))
    created_at = float(run.get("created_at") or run.get("summary", {}).get("created_at") or 0.0)
    now = time.time()

    # 原绝对截止时间：不可变。同一截止边界贯穿整个生命周期 (Standards S1)
    root_deadline_ts = float(
        run.get("root_deadline_ts")
        or run.get("summary", {}).get("root_deadline_ts")
        or (created_at + original_seconds if created_at > 0 else (now + (original_seconds - duration_s)))
    )

    rem_seconds_by_deadline = root_deadline_ts - now
    rem_seconds_by_duration = original_seconds - duration_s

    # 若请求到达时已过期，必须立即拒绝
    if rem_seconds_by_duration <= 0 or rem_seconds_by_deadline <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"原任务时间限额已耗尽或绝对截止时间已过期 (限额 {original_seconds}s，已耗时 {duration_s}s)，依据安全准则禁止恢复",
        )

    # 确定性剩余预算秒数：由不可变的原限额与已耗时决定，保证同一检查点的幂等指纹恒定 (Standards S2)
    stable_rem_seconds = round(max(0.001, rem_seconds_by_duration), 3)

    mode = verified_cp.get("mode") or "local"

    cp_seq = len(verified_cp.get("sessionLog", []))
    resume_key = f"resume-{run_id}-{cp_seq}"
    header_dict = dict(headers or {})
    header_key = header_dict.get("Idempotency-Key") or header_dict.get("idempotency-key") or resume_key

    return {
        "problem": problem,
        "engine": run.get("summary", {}).get("engine", "ts"),
        "metadata": {
            "resumed_from": run_id,
            "root_run_id": run.get("summary", {}).get("root_run_id", run_id),
            "checkpoint_seq": cp_seq,
            "root_max_model_calls": max_m,
            "remaining_model_calls": rem_m,
            "root_deadline_ts": root_deadline_ts,
        },
        "mode": mode,
        "max_model_calls": max_m,
        "max_effects": max_e,
        "max_method_loads": recovery_info.get("remainingBudget", {}).get("maxMethodLoads", 2),
        "problem_seconds": stable_rem_seconds,
        "root_deadline_ts": root_deadline_ts,
        "resume_checkpoint": verified_cp,
        "idempotency_key": header_key,
    }


async def resume_run(request: Request) -> JSONResponse:
    """申请受约束的同题恢复，支持请求幂等 (方案 9.2 节)."""
    run_id = request.path_params["run_id"]
    manager: ExecutionManager = request.app.state.execution_manager

    run, events, is_active = _resolve_run_and_events(request, run_id)
    resume_req = validate_and_prepare_resume(run, events, is_active, headers=request.headers)

    try:
        result = await manager.enqueue_run(request=resume_req)
    except IdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    status_code = 200 if result.get("idempotent_replay") else 201
    return JSONResponseUTF8(result, status_code=status_code)



def list_math_assets(request: Request) -> JSONResponse:
    try:
        return JSONResponseUTF8(math_asset_summary())
    except CatalogUnavailable as exc:
        return JSONResponseUTF8({"error": "CATALOG_UNAVAILABLE", "detail": str(exc)}, status_code=503)


def get_math_asset(request: Request) -> JSONResponse:
    asset_id = request.path_params["asset_id"]
    try:
        detail = math_asset_detail(asset_id)
    except CatalogUnavailable as exc:
        return JSONResponseUTF8({"error": "CATALOG_UNAVAILABLE", "detail": str(exc)}, status_code=503)
    if detail is None:
        raise HTTPException(status_code=404, detail="math asset not found")
    return JSONResponseUTF8(detail)


def get_runtime_info(request: Request) -> JSONResponse:
    manager: ExecutionManager = request.app.state.execution_manager
    return JSONResponseUTF8(math_runtime_info(manager.solver_configured))


def list_assets(request: Request) -> JSONResponse:
    """Run artifacts only; this is not the canonical math-asset catalog."""
    store: Store = request.app.state.store
    run_id = request.query_params.get("run_id")
    limit = int(request.query_params.get("limit", 100))
    items = store.list_assets(run_id=run_id, limit=limit)
    return JSONResponseUTF8({"items": items, "count": len(items)})


def download_asset(request: Request) -> Response:
    store: Store = request.app.state.store
    asset_id = request.path_params["asset_id"]
    row = store.get_asset(asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    try:
        target = store.safe_join(row["rel_path"])
    except PathTraversalError as exc:
        raise HTTPException(status_code=400, detail="unsafe asset path") from exc
    if not target.is_file():
        raise HTTPException(status_code=410, detail="asset file missing")
    return FileResponse(
        path=str(target),
        media_type=row.get("mime") or "application/octet-stream",
        filename=Path(row["rel_path"]).name,
    )


def favicon(request: Request) -> Response:
    """返回网站图标，优先寻找静态目录的 favicon.ico，缺省返回极简 SVG 图标。"""
    web_dist: Path | None = request.app.state.web_dist
    if web_dist:
        ico = web_dist / "favicon.ico"
        if ico.is_file():
            return FileResponse(str(ico), media_type="image/x-icon")
        svg_file = web_dist / "favicon.svg"
        if svg_file.is_file():
            return FileResponse(str(svg_file), media_type="image/svg+xml")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<rect width="32" height="32" rx="8" fill="#0F265C"/>'
        '<circle cx="16" cy="16" r="6" fill="#2E70EA"/>'
        '<circle cx="16" cy="16" r="3" fill="#ffffff"/>'
        '</svg>'
    )
    return Response(content=svg, media_type="image/svg+xml")


class SPAStaticFiles(StaticFiles):
    """单页应用 (SPA) 增强静态文件服务：
    若请求的文件不存在且不以 'assets/' 开头，优雅回退到 'index.html'，
    确保客户端路由（如 /solve、/runs/:id 等）直接访问或刷新时不报 404。
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not path.startswith("assets/"):
                return await super().get_response("index.html", scope)
            raise


def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponseUTF8({"detail": exc.detail}, status_code=exc.status_code)


def create_app(
    *,
    data_root: str | os.PathLike[str] | None = None,
    web_dist: str | os.PathLike[str] | None = None,
    mount_static: bool = True,
    solver: Any = None,
    recover_orphans: bool = True,
) -> Starlette:
    default_data_root = REPO_ROOT / "var" / "astra"
    default_web_dist = REPO_ROOT / "apps" / "web-demo" / "dist"

    store_root = Path(data_root) if data_root else _env_path("ASTRA_DATA_ROOT", str(default_data_root))
    store = Store(store_root)
    execution_manager = ExecutionManager(store, solver=solver)
    if recover_orphans:
        # A previous process may have died mid-run. Those runs keep their real
        # events and are closed honestly instead of showing a phantom "running".
        try:
            execution_manager.recover_orphan_runs()
        except Exception as exc:  # 恢复失败不得阻止服务启动
            logger.warning("restart recovery failed: %s", exc)

    routes = [
        Route("/favicon.ico", favicon, methods=["GET"]),
        Route("/api/health", health, methods=["GET"]),
        Route("/api/capabilities", capabilities, methods=["GET"]),
        Route("/api/runs", list_runs, methods=["GET"]),
        Route("/api/runs", create_run, methods=["POST"]),
        Route("/api/runs/{run_id}", get_run, methods=["GET"]),
        Route("/api/runs/{run_id}/workspace", get_workspace, methods=["GET"]),
        Route("/api/runs/{run_id}/evidence/{evidence_id:path}", get_evidence, methods=["GET"]),
        Route("/api/runs/{run_id}/recovery", get_recovery, methods=["GET"]),
        Route("/api/runs/{run_id}/resume", resume_run, methods=["POST"]),
        Route("/api/runs/{run_id}/events", sse_events, methods=["GET"]),
        Route("/api/runtime-info", get_runtime_info, methods=["GET"]),
        Route("/api/math-assets", list_math_assets, methods=["GET"]),
        Route("/api/math-assets/{asset_id:path}", get_math_asset, methods=["GET"]),
        Route("/api/replays", list_replays, methods=["GET"]),
        Route("/api/replays/{run_id}", get_replay, methods=["GET"]),
        Route("/api/assets", list_assets, methods=["GET"]),
        Route("/api/assets/{asset_id:path}", download_asset, methods=["GET"]),
    ]

    dist_path = Path(web_dist) if web_dist else _env_path("ASTRA_WEB_DIST", str(default_web_dist))
    dist_path = dist_path.expanduser()

    if mount_static and dist_path.is_dir():
        routes.append(Mount("/", SPAStaticFiles(directory=str(dist_path), html=True), name="web"))
        logger.info("mounted static assets with SPA fallback from %s", dist_path)
    else:
        logger.info("static assets not mounted (dist dir: %s)", dist_path)

    app = Starlette(
        debug=False,
        routes=routes,
        exception_handlers={HTTPException: http_exception_handler},
    )
    app.state.store = store
    app.state.execution_manager = execution_manager
    app.state.data_root = store.root
    app.state.web_dist = dist_path if dist_path.is_dir() else None

    return app


try:
    app = create_app(solver=build_solver_from_env())
except Exception:
    app = None
