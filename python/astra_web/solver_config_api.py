"""Model-access (solver) configuration HTTP handlers.

Self-contained module so app.py only imports and registers these routes, keeping
the rest of the BFF untouched. The credential is write-only: it is accepted,
used for a single verification request, stored host-side, and never returned.
"""
from __future__ import annotations

from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse

from .queue import ExecutionManager
from .solver_config import (
    BALANCE_LEDGER_URL,
    KEY_MANAGEMENT_URL,
    SolverConfigError,
    clear_config,
    endpoint_registry,
    endpoint_spec,
    load_config,
    public_view,
    save_config,
)
from .solver_runtime import UsageLedger, build_solver, fetch_models


class JSONResponseUTF8(JSONResponse):
    media_type = "application/json; charset=utf-8"


def _solver_config_path(request: Request) -> Path:
    return request.app.state.solver_config_path


def _solver_usage(request: Request) -> UsageLedger:
    return request.app.state.usage


async def get_solver_config(request: Request) -> JSONResponse:
    """Non-secret view of the model-access configuration (never a credential)."""
    path = _solver_config_path(request)
    manager: ExecutionManager = request.app.state.execution_manager
    view = dict(public_view(load_config(path), path))
    view.update(
        {
            "wired": manager.solver_configured,
            "endpoints": endpoint_registry(),
            "key_management_url": KEY_MANAGEMENT_URL,
            "balance_ledger_url": BALANCE_LEDGER_URL,
        }
    )
    return JSONResponseUTF8(view)


async def put_solver_config(request: Request) -> JSONResponse:
    """Accept a credential without ever returning it."""
    path = _solver_config_path(request)
    manager: ExecutionManager = request.app.state.execution_manager
    try:
        body = await request.json()
    except Exception:
        return JSONResponseUTF8({"detail": "request body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponseUTF8({"detail": "request body must be a JSON object"}, status_code=400)

    endpoint = body.get("endpoint")
    model = body.get("model")
    credential = body.get("credential")
    for name, value in (("endpoint", endpoint), ("model", model), ("credential", credential)):
        if not isinstance(value, str) or not value.strip():
            return JSONResponseUTF8({"detail": "%s is required" % name}, status_code=400)

    model_verified = False
    unverified_note = None
    try:
        live_models = fetch_models(endpoint, credential)
        if live_models and model not in live_models:
            return JSONResponseUTF8(
                {"detail": "端点未提供该模型（其实时列表 %d 个，不含 %s）" % (len(live_models), model)},
                status_code=400,
            )
        model_verified = bool(live_models)
    except Exception as exc:  # noqa: BLE001
        unverified_note = type(exc).__name__

    try:
        config = save_config(path, endpoint=endpoint, model=model, credential=credential)
    except SolverConfigError as exc:
        return JSONResponseUTF8({"detail": str(exc)}, status_code=400)

    try:
        solver = build_solver(config, _solver_usage(request))
    except ValueError as exc:
        clear_config(path)
        manager.set_solver(None)
        return JSONResponseUTF8({"detail": "configuration rejected: %s" % exc}, status_code=400)

    manager.set_solver(solver)
    view = dict(public_view(load_config(path), path))
    view["wired"] = True
    view["model_verified"] = model_verified
    if not model_verified:
        view["model_verified_note"] = "未能向端点核对模型列表（%s）；已按提交值接线" % (unverified_note or "端点返回空列表")
    return JSONResponseUTF8(view, status_code=200)


async def delete_solver_config(request: Request) -> JSONResponse:
    path = _solver_config_path(request)
    manager: ExecutionManager = request.app.state.execution_manager
    removed = clear_config(path)
    manager.set_solver(None)
    view = dict(public_view(load_config(path), path))
    view["wired"] = False
    view["removed"] = removed
    return JSONResponseUTF8(view)


async def get_solver_usage(request: Request) -> JSONResponse:
    """Observed usage only; the balance is linked out, never invented."""
    return JSONResponseUTF8(
        {
            "usage": _solver_usage(request).snapshot(),
            "balance": {
                "available": False,
                "reason": "未发现官方余额接口（该页面为登录态 SPA），请到平台账本页查看",
                "ledger_url": BALANCE_LEDGER_URL,
            },
        }
    )


async def list_solver_models(request: Request) -> JSONResponse:
    """Ask the endpoint which models it serves, using the caller's credential."""
    path = _solver_config_path(request)
    try:
        body = await request.json()
    except Exception:
        return JSONResponseUTF8({"detail": "request body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponseUTF8({"detail": "request body must be a JSON object"}, status_code=400)

    endpoint = body.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint.strip():
        return JSONResponseUTF8({"detail": "endpoint is required"}, status_code=400)

    spec = endpoint_spec(endpoint)
    if spec is None:
        return JSONResponseUTF8({"detail": "endpoint is not one of the sanctioned endpoints"}, status_code=400)

    credential = body.get("credential")
    if not isinstance(credential, str) or not credential.strip():
        stored = load_config(path)
        credential = stored.credential if stored is not None and stored.endpoint == endpoint else ""

    try:
        models = fetch_models(endpoint, credential)
        if not models:
            raise ValueError("endpoint returned an empty model list")
        return JSONResponseUTF8({"endpoint": endpoint, "models": models, "source": "endpoint"})
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "code", None)
        if isinstance(status, int):
            reason = "HTTP %d" % status
            if status in (401, 403):
                reason += "：凭据无效或无权限"
            elif status == 404:
                reason += "：该端点未提供 /models"
        else:
            reason = type(exc).__name__
        return JSONResponseUTF8(
            {
                "endpoint": endpoint,
                "models": list(spec.models),
                "source": "fallback",
                "detail": "未能从端点获取模型列表（%s）；以下为仓库已知列表" % reason,
            }
        )
