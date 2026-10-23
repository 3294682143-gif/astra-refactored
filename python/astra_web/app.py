"""Starlette 应用入口：只读 BFF + 静态资源托管。

路由概览
--------
GET /api/health                 健康检查（保证不调用任何模型）
GET /api/capabilities           能力声明
GET /api/runs                   运行索引（L1 摘要）
GET /api/runs/{run_id}          单条运行
GET /api/replays                具备 L2 详细存档的运行
GET /api/replays/{run_id}       读取 L2 详细存档内容
GET /api/assets                 资产清单（可按 run_id 过滤）
GET /api/assets/{asset_id:path} 下载资产（L3）
GET /                           apps/web-demo/dist 静态资源（若存在，支持 SPA fallback）

只读约束：本模块不暴露任何写入端点；导入入口在 `replays` 模块。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .storage import PathTraversalError, Store

SERVICE_NAME = "astra-web-bff"
SERVICE_VERSION = "0.1.0"

logger = logging.getLogger("astra_web.app")


def _env_path(var: str, default: str) -> Path:
    return Path(os.environ.get(var, default)).expanduser()


def health(request: Request) -> JSONResponse:
    """纯本地健康检查；不解析任何模型、不触网、不做网络 I/O。"""
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
        "read_only": True,
        "model_invoked": False,
        "schema_version": 1,
        "routes": [
            "/api/health",
            "/api/capabilities",
            "/api/runs",
            "/api/replays",
            "/api/assets",
        ],
        "levels": {
            "L1": "summary inline in SQLite index",
            "L2": "detailed archive (JSON on disk)",
            "L3": "binary/text artifacts on disk",
        },
        "imports": {
            "formats": ["json", "jsonl"],
            "entrypoint": "astra_web.replays",
            "via_http": False,
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


def get_run(request: Request) -> JSONResponse:
    store: Store = request.app.state.store
    run_id = request.path_params["run_id"]
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    run["assets"] = store.list_assets(run_id=run_id)
    return JSONResponse(run)


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


def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


def create_app(
    *,
    data_root: str | os.PathLike[str] | None = None,
    web_dist: str | os.PathLike[str] | None = None,
    mount_static: bool = True,
) -> Starlette:
    store = Store(data_root or _env_path("ASTRA_DATA_ROOT", "./var/astra"))

    routes = [
        Route("/api/health", health, methods=["GET"]),
        Route("/api/capabilities", capabilities, methods=["GET"]),
        Route("/api/runs", list_runs, methods=["GET"]),
        Route("/api/runs/{run_id}", get_run, methods=["GET"]),
        Route("/api/replays", list_replays, methods=["GET"]),
        Route("/api/replays/{run_id}", get_replay, methods=["GET"]),
        Route("/api/assets", list_assets, methods=["GET"]),
        Route("/api/assets/{asset_id:path}", download_asset, methods=["GET"]),
    ]

    dist_path = Path(web_dist) if web_dist else _env_path("ASTRA_WEB_DIST", "apps/web-demo/dist")
    dist_path = dist_path.expanduser()

    if mount_static and dist_path.is_dir():
        routes.append(Mount("/", StaticFiles(directory=str(dist_path), html=True), name="web"))
        logger.info("mounted static assets from %s", dist_path)
    else:
        logger.info("static assets not mounted (dist dir: %s)", dist_path)

    app = Starlette(
        debug=False,
        routes=routes,
        exception_handlers={HTTPException: http_exception_handler},
    )
    app.state.store = store
    app.state.data_root = store.root
    app.state.web_dist = dist_path if dist_path.is_dir() else None

    return app


try:
    app = create_app()
except Exception:
    app = None
