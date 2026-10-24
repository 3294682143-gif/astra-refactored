"""Starlette 应用入口：只读与实时 BFF + 静态资源托管。

路由概览
--------
GET  /api/health                 健康检查（保证不调用任何外部未授权模型）
GET  /api/capabilities           能力声明
GET  /api/runs                   运行索引（L1 摘要）
POST /api/runs                   启动推导会话（参数校验 max_method_loads ∈ {0, 1}）
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
import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# 注册关键 MIME 类型，防御 Windows 注册表错误关联（如 .js 映射为 text/plain 导致浏览器严格 MIME 检查阻断 ES 模块）
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/x-icon", ".ico")

from .queue import ExecutionManager
from .storage import PathTraversalError, Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVICE_NAME = "astra-web-bff"
SERVICE_VERSION = "0.1.0"

logger = logging.getLogger("astra_web.app")


def _env_path(var: str, default: str) -> Path:
    return Path(os.environ.get(var, default)).expanduser()


def health(request: Request) -> JSONResponse:
    """纯本地健康检查；不解析任何外部未授权模型、不触网、不做未授权 I/O。"""
    store: Store = request.app.state.store
    return JSONResponse({
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "model_invoked": False,
        "data_root": str(store.root),
    })


def capabilities(request: Request) -> JSONResponse:
    return JSONResponse({
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "read_only": False,
        "execution_queue": True,
        "sse_streaming": True,
        "model_invoked": False,
        "schema_version": 1,
        "routes": [
            "/api/health",
            "/api/capabilities",
            "/api/runs",
            "/api/runs/{run_id}",
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
            "max_method_loads_allowed": [0, 1],
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
    return JSONResponse({"items": items, "count": len(items), "limit": limit, "offset": offset})


async def create_run(request: Request) -> JSONResponse:
    """POST /api/runs 接收新求解请求并启动执行任务。"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    problem = body.get("problem")
    if not isinstance(problem, str) or not problem.strip():
        raise HTTPException(status_code=422, detail="'problem' must be a non-empty string")

    # 校验 max_method_loads ∈ {0, 1}（且禁止用 bool 冒充）
    max_method_loads = body.get("max_method_loads", 1)
    if isinstance(max_method_loads, bool) or max_method_loads not in (0, 1):
        raise HTTPException(status_code=422, detail="'max_method_loads' must be exactly 0 or 1")

    max_model_calls = body.get("max_model_calls", 24)
    if isinstance(max_model_calls, bool) or not isinstance(max_model_calls, int) or max_model_calls <= 0:
        raise HTTPException(status_code=422, detail="'max_model_calls' must be a positive integer")

    engine = body.get("engine", "ts")
    idempotency_key = request.headers.get("Idempotency-Key") or body.get("idempotency_key")

    manager: ExecutionManager = request.app.state.execution_manager
    run_id = await manager.enqueue_run(
        problem=problem.strip(),
        max_model_calls=max_model_calls,
        max_method_loads=max_method_loads,
        engine=engine,
        idempotency_key=idempotency_key,
    )

    return JSONResponse({"run_id": run_id, "status": "running"}, status_code=201)


def get_run(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    run_id = request.path_params["run_id"]
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    run["assets"] = store.list_assets(run_id=run_id)
    return JSONResponse(run)


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
            yield "event: close\ndata: {}\n\n"
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
                    yield "event: close\ndata: {}\n\n"
                    break

                seq = ev.get("seq", cursor + 1)
                if seq > cursor:
                    kind = ev.get("kind") or ev.get("type", "message")
                    data_str = json.dumps(ev, ensure_ascii=False)
                    yield f"id: {seq}\nevent: {kind}\ndata: {data_str}\n\n"
                    cursor = seq

                # 如果收到终态 RESULT 事件且 run 不再活跃，结束
                if ev.get("kind") == "RESULT":
                    yield "event: close\ndata: {}\n\n"
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
    return JSONResponse({"items": items, "count": len(items), "limit": limit, "offset": offset})


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
    return JSONResponse({
        "run_id": run_id,
        "source": run["source"],
        "created_at": run["created_at"],
        "details": details,
    })


def list_assets(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    run_id = request.query_params.get("run_id")
    limit = int(request.query_params.get("limit", 100))
    items = store.list_assets(run_id=run_id, limit=limit)
    return JSONResponse({"items": items, "count": len(items)})


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
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


def create_app(
    *,
    data_root: str | os.PathLike[str] | None = None,
    web_dist: str | os.PathLike[str] | None = None,
    mount_static: bool = True,
) -> Starlette:
    default_data_root = REPO_ROOT / "var" / "astra"
    default_web_dist = REPO_ROOT / "apps" / "web-demo" / "dist"

    store_root = Path(data_root) if data_root else _env_path("ASTRA_DATA_ROOT", str(default_data_root))
    store = Store(store_root)
    execution_manager = ExecutionManager(store)

    routes = [
        Route("/favicon.ico", favicon, methods=["GET"]),
        Route("/api/health", health, methods=["GET"]),
        Route("/api/capabilities", capabilities, methods=["GET"]),
        Route("/api/runs", list_runs, methods=["GET"]),
        Route("/api/runs", create_run, methods=["POST"]),
        Route("/api/runs/{run_id}", get_run, methods=["GET"]),
        Route("/api/runs/{run_id}/events", sse_events, methods=["GET"]),
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
    app = create_app()
except Exception:
    app = None
