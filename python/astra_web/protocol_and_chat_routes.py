"""Product-chat showcase and InkStone protocol observatory routes.

These routes are physically separate from the ``POST /api/runs`` solving
pipeline: they never produce a solving certificate, they enforce the same
``FORBIDDEN_METADATA_KEYS`` admission red line, and they never let the browser
pick a provider, endpoint, model or credential. All credentials live in the
server process environment.
"""
from __future__ import annotations

import json
import os
import pathlib
import threading
import uuid
from typing import Any, Dict, Iterator, List, Mapping
from urllib.parse import urlparse

import requests
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .config import FORBIDDEN_METADATA_KEYS

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

_ACTIVE_CHAT_STREAMS: Dict[str, threading.Event] = {}
_ACTIVE_LOCK = threading.Lock()

PRODUCT_CHAT_ALLOWED_KEYS = frozenset({"query", "thinking_mode", "chat_id"})


def _default_data_root() -> pathlib.Path:
    return pathlib.Path(os.environ.get("ASTRA_DATA_ROOT", str(_REPO_ROOT / "var" / "astra")))


def get_readonly_provider_capabilities() -> Dict[str, Any]:
    """Redacted provider facts for ``GET /api/capabilities`` (host only, never
    a full path credential, never a key)."""
    provider = os.environ.get("ASTRA_PROVIDER", "").strip().lower() or "atria"
    model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()
    raw_endpoint = os.environ.get(
        "ASTRA_ATRIA_ENDPOINT",
        "https://discovery-api.intern-ai.org.cn/v1/chat/completions",
    ).strip()
    parsed = urlparse(raw_endpoint)
    has_key = bool(
        os.environ.get("ASTRA_ATRIA_API_KEY")
        or os.environ.get("ATRIA_API_KEY")
        or os.environ.get("INTERN_API_KEY")
    )
    reasoning_mode = os.environ.get("ASTRA_ATRIA_REASONING_MODE", "off").strip().lower()
    wire_default = "24576" if reasoning_mode in {"hybrid", "auto_expand"} else "8192"
    wire_max_tokens = int(os.environ.get("ASTRA_ATRIA_WIRE_MAX_TOKENS", wire_default))
    return {
        "provider": provider if has_key or provider == "inkstone-desktop" else "unconfigured",
        "model": model,
        "endpoint_host": parsed.hostname or "unknown",
        "reasoning_mode": reasoning_mode,
        "wire_max_tokens": wire_max_tokens,
        "protocol_source": os.environ.get("ASTRA_PROTOCOL_SOURCE", "live"),
    }


def _check_forbidden_keys(payload: Mapping[str, Any]) -> None:
    violated = set(payload.keys()) & set(FORBIDDEN_METADATA_KEYS)
    if violated:
        raise HTTPException(
            status_code=400,
            detail=f"Forbidden client-side configuration keys rejected: {sorted(violated)}",
        )


async def atria_product_chat(request: Request) -> StreamingResponse:
    """POST /api/atria/chat — product-form chat SSE for the /chat page only.

    Explicitly labelled ``product-chat-showcase``: it produces no run record,
    no audit trail and no solving certificate.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Request body must be valid JSON")
    if not isinstance(body, Mapping):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    _check_forbidden_keys(body)

    extra_keys = set(body.keys()) - PRODUCT_CHAT_ALLOWED_KEYS
    if extra_keys:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported keys in /api/atria/chat: {sorted(extra_keys)}",
        )

    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise HTTPException(status_code=400, detail="Non-empty string 'query' is required")

    thinking_enabled = bool(body.get("thinking_mode", False))
    chat_id = str(body.get("chat_id") or f"chat_{uuid.uuid4().hex[:12]}")
    cancel_event = threading.Event()
    with _ACTIVE_LOCK:
        _ACTIVE_CHAT_STREAMS[chat_id] = cancel_event

    def _event_generator() -> Iterator[str]:
        try:
            yield f"data: {json.dumps({'type': 'workflow_started', 'chat_id': chat_id, 'reasoning_dispatched': thinking_enabled, 'channel': 'product-chat-showcase'}, ensure_ascii=False)}\n\n"
            if os.environ.get("ASTRA_PROTOCOL_SOURCE") == "mock":
                mock_url = os.environ.get("INKSTONE_GATEWAY_URL", "http://127.0.0.1:8787")
                with requests.post(
                    f"{mock_url}/api/orbit/v1/local-agent/messages",
                    json={
                        "messages": [{"role": "user", "content": query}],
                        "thinking_mode": thinking_enabled,
                    },
                    stream=True,
                    timeout=(5, 60),
                ) as resp:
                    for line in resp.iter_lines(decode_unicode=True):
                        if cancel_event.is_set():
                            yield f"data: {json.dumps({'type': 'aborted_locally', 'remote_state': 'unknown'}, ensure_ascii=False)}\n\n"
                            return
                        if line and line.startswith("data:"):
                            yield f"{line}\n\n"
                return

            api_key = (
                os.environ.get("ASTRA_ATRIA_API_KEY")
                or os.environ.get("ATRIA_API_KEY")
                or os.environ.get("INTERN_API_KEY")
                or ""
            ).strip()
            if not api_key:
                yield f"data: {json.dumps({'type': 'error', 'code': 'SOLVER_NOT_CONFIGURED', 'message': 'Server API key not configured'}, ensure_ascii=False)}\n\n"
                return

            endpoint = os.environ.get(
                "ASTRA_ATRIA_ENDPOINT",
                "https://discovery-api.intern-ai.org.cn/v1/chat/completions",
            ).strip()
            model = os.environ.get("ASTRA_ATRIA_MODEL", "Atria-Dawn").strip()
            wire_body: Dict[str, Any] = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "You are a scientific assistant powered by Atria-Dawn."},
                    {"role": "user", "content": query.strip()},
                ],
                "stream": True,
                "max_tokens": 16384 if thinking_enabled else 4096,
                "stream_options": {"include_usage": True},
            }
            if not thinking_enabled and not model.endswith(":fast"):
                wire_body["reasoning"] = False

            with requests.post(
                endpoint,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                },
                json=wire_body,
                stream=True,
                timeout=(10, 120),
            ) as resp:
                if resp.status_code >= 400:
                    snippet = " ".join(resp.text.split())[:160]
                    yield f"data: {json.dumps({'type': 'error', 'code': f'HTTP_{resp.status_code}', 'message': snippet}, ensure_ascii=False)}\n\n"
                    return
                for raw_line in resp.iter_lines(decode_unicode=True):
                    if cancel_event.is_set():
                        # Honest semantics: a local abort is not a server-side stop.
                        yield f"data: {json.dumps({'type': 'aborted_locally', 'remote_state': 'unknown'}, ensure_ascii=False)}\n\n"
                        return
                    if not raw_line or not raw_line.startswith("data:"):
                        continue
                    data_str = raw_line[5:].strip()
                    if data_str == "[DONE]":
                        yield f"data: {json.dumps({'type': 'message_end', 'reasoning_dispatched': thinking_enabled}, ensure_ascii=False)}\n\n"
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("type") == "thinking_delta" and isinstance(chunk.get("text"), str):
                        yield f"data: {json.dumps({'type': 'message.thinking', 'text': chunk['text']}, ensure_ascii=False)}\n\n"
                        continue
                    if chunk.get("type") == "content_delta" and isinstance(chunk.get("text"), str):
                        yield f"data: {json.dumps({'type': 'message.answer', 'text': chunk['text']}, ensure_ascii=False)}\n\n"
                        continue
                    if chunk.get("type") == "usage":
                        yield f"data: {json.dumps({'type': 'usage', 'usage': chunk.get('usage')}, ensure_ascii=False)}\n\n"
                        continue
                    if chunk.get("type") == "message_end":
                        yield f"data: {json.dumps({'type': 'message_end', 'stop_reason': chunk.get('stop_reason'), 'reasoning_dispatched': thinking_enabled}, ensure_ascii=False)}\n\n"
                        continue
                    choice0 = (chunk.get("choices") or [{}])[0]
                    delta = choice0.get("delta") or {}
                    if isinstance(delta.get("reasoning_content"), str) and delta["reasoning_content"]:
                        yield f"data: {json.dumps({'type': 'message.thinking', 'text': delta['reasoning_content']}, ensure_ascii=False)}\n\n"
                    if isinstance(delta.get("content"), str) and delta["content"]:
                        yield f"data: {json.dumps({'type': 'message.answer', 'text': delta['content']}, ensure_ascii=False)}\n\n"
                    if chunk.get("usage"):
                        yield f"data: {json.dumps({'type': 'usage', 'usage': chunk['usage']}, ensure_ascii=False)}\n\n"
        finally:
            with _ACTIVE_LOCK:
                _ACTIVE_CHAT_STREAMS.pop(chat_id, None)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Astra-Channel": "product-chat-showcase",
        },
    )


async def stop_atria_product_chat(request: Request) -> JSONResponse:
    """POST /api/atria/chat/{chat_id}/stop — trigger the server-side cancel
    handle; the response is honest about the unknown remote terminal state."""
    chat_id = request.path_params["chat_id"]
    with _ACTIVE_LOCK:
        ev = _ACTIVE_CHAT_STREAMS.get(chat_id)
    if ev is not None:
        ev.set()
        return JSONResponse(
            {
                "chat_id": chat_id,
                "local_aborted": True,
                "remote_state": "unknown",
                "honest_note": "已触发本地流中止；直连模式下远端生成终止状态未知（不伪造服务端已停止确认）。",
            }
        )
    return JSONResponse(
        {
            "chat_id": chat_id,
            "local_aborted": False,
            "remote_state": "not_found_or_already_ended",
        }
    )


async def list_protocol_sessions(request: Request) -> JSONResponse:
    protocol_dir = _default_data_root() / "protocol"
    if not protocol_dir.exists():
        return JSONResponse({"sessions": []})
    sessions: List[Dict[str, Any]] = []
    for p in sorted(protocol_dir.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True):
        stat = p.stat()
        sessions.append(
            {
                "session_id": p.stem,
                "updated_at": stat.st_mtime,
                "size_bytes": stat.st_size,
            }
        )
    return JSONResponse({"sessions": sessions})


async def get_protocol_session_events(request: Request) -> JSONResponse:
    safe_id = pathlib.Path(request.path_params["session_id"]).name
    log_file = _default_data_root() / "protocol" / f"{safe_id}.jsonl"
    if not log_file.exists():
        raise HTTPException(status_code=404, detail=f"Protocol session {safe_id!r} not found")
    events = [
        json.loads(line)
        for line in log_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return JSONResponse({"session_id": safe_id, "events": events})


async def get_inkstone_desktop_fixture(request: Request) -> JSONResponse:
    safe_name = pathlib.Path(request.path_params["name"]).name
    inkstone_root = pathlib.Path(
        os.environ.get("INKSTONE_RE_LAB_ROOT", str(_REPO_ROOT.parent / "inkstone-re-lab"))
    )
    fixture_path = inkstone_root / "fixtures" / "desktop" / safe_name
    if not fixture_path.exists() or not fixture_path.is_file():
        raise HTTPException(status_code=404, detail=f"Fixture {safe_name!r} not found in inkstone-re-lab")
    return JSONResponse(
        {
            "name": safe_name,
            "source": "inkstone-re-lab/fixtures/desktop",
            "raw_sse": fixture_path.read_text(encoding="utf-8"),
        }
    )


def build_protocol_chat_routes() -> List[Route]:
    return [
        Route("/api/atria/chat", atria_product_chat, methods=["POST"]),
        Route("/api/atria/chat/{chat_id}/stop", stop_atria_product_chat, methods=["POST"]),
        Route("/api/protocol/sessions", list_protocol_sessions, methods=["GET"]),
        Route("/api/protocol/sessions/{session_id}/events", get_protocol_session_events, methods=["GET"]),
        Route("/api/protocol/fixtures/{name}", get_inkstone_desktop_fixture, methods=["GET"]),
    ]


__all__ = [
    "build_protocol_chat_routes",
    "get_readonly_provider_capabilities",
]
