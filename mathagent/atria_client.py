"""Atria-Dawn connector with the exact ``UserSuppliedS2Client`` chat signature.

Two transport channels:
- ``AtriaDawnClient``: direct OpenAI-compatible SSE against the InkStone
  discovery gateway, with stage-aware hybrid reasoning (``off`` / ``hybrid`` /
  ``auto_expand``) so the frozen 8192 token budget survives long reasoning
  traces on multi-round voting runs.
- ``InkstoneDesktopBridgeClient``: bridges to the inkstone-re-lab desktop
  protocol stack (``src/desktop/atria-bridge-runner.mjs``) over a JSONL
  subprocess, inheriting ``gateway-events.mjs`` validation,
  ``cancelInferenceDecision`` semantics and 409 conflict recovery.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence
from urllib.parse import urlparse

import requests

ALLOWED_ATRIA_HOSTS = frozenset(
    {
        "discovery-api.intern-ai.org.cn",
        "discovery.intern-ai.org.cn",
        "api.atria-asi.ai",
        "chat.intern-ai.org.cn",
        "127.0.0.1",
        "localhost",
    }
)

ALLOWED_ATRIA_MODELS = frozenset(
    {
        "Atria-Dawn",
        "Atria-Dawn:fast",
        "Atria-Dawn-FP8",
        "Atria-Dawn-Preview",
        "Atria-Dawn-Preview:fast",
        "Atria-Dawn-Preview-FP8",
    }
)

DEFAULT_ATRIA_ENDPOINT = "https://discovery-api.intern-ai.org.cn/v1/chat/completions"
DEFAULT_ATRIA_MODEL = "Atria-Dawn"

# Maps gateway stop_reason values (gateway-events.mjs STOP_REASONS:
# end_turn / tool_use / max_tokens / stop_sequence) plus OpenAI values onto
# the four AgentClient finish reasons.
GATEWAY_STOP_REASON_MAP = {
    "stop": "stop",
    "end_turn": "end_turn",
    "stop_sequence": "stop",
    "tool_use": "stop",
    "length": "length",
    "max_tokens": "length",
    "content_filter": "content_filter",
}


def sanitize_snippet(raw: str, max_len: int = 160) -> str:
    """Align with inkstone-re-lab/src/chat-session.mjs::sanitizeSnippet."""
    cleaned = " ".join((raw or "").split())
    if len(cleaned) > max_len:
        return cleaned[:max_len] + "..."
    return cleaned


@dataclass(frozen=True)
class AtriaTransportResponse:
    content: Optional[str]
    finish_reason: Optional[str]
    usage: Optional[Dict[str, Optional[int]]]
    reasoning_content: Optional[str] = None
    raw_model: Optional[str] = None
    protocol_usage: Optional[Dict[str, Optional[int]]] = None

    def to_openai_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "choices": [
                {
                    "index": 0,
                    "finish_reason": self.finish_reason,
                    "message": {
                        "role": "assistant",
                        "content": self.content,
                    },
                }
            ]
        }
        if self.usage is not None:
            payload["usage"] = dict(self.usage)
        return payload


def _safe_non_negative_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > (2**53 - 1):
        return None
    return value


def _extract_usage(raw_usage: Any) -> Optional[Dict[str, Optional[int]]]:
    """Support OpenAI three-field usage and the inkstone USAGE_KEYS four-field
    shape. Missing values stay None; zero is never fabricated."""
    if not isinstance(raw_usage, Mapping):
        return None
    prompt_tokens = _safe_non_negative_int(
        raw_usage.get("prompt_tokens", raw_usage.get("input_tokens"))
    )
    completion_tokens = _safe_non_negative_int(
        raw_usage.get("completion_tokens", raw_usage.get("output_tokens"))
    )
    total_tokens = _safe_non_negative_int(raw_usage.get("total_tokens"))
    if (
        total_tokens is None
        and prompt_tokens is not None
        and completion_tokens is not None
    ):
        total_tokens = prompt_tokens + completion_tokens
    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        return None
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def _extract_protocol_usage(raw_usage: Any) -> Optional[Dict[str, Optional[int]]]:
    """Four-field USAGE_KEYS view for the /protocol observatory page."""
    if not isinstance(raw_usage, Mapping):
        return None
    return {
        "input_tokens": _safe_non_negative_int(
            raw_usage.get("input_tokens", raw_usage.get("prompt_tokens"))
        ),
        "output_tokens": _safe_non_negative_int(
            raw_usage.get("output_tokens", raw_usage.get("completion_tokens"))
        ),
        "cache_read_tokens": _safe_non_negative_int(raw_usage.get("cache_read_tokens")),
        "cache_write_tokens": _safe_non_negative_int(raw_usage.get("cache_write_tokens")),
    }


def _normalize_finish_reason(raw_reason: Any) -> Optional[str]:
    if not isinstance(raw_reason, str):
        return None
    reason = raw_reason.strip()
    return GATEWAY_STOP_REASON_MAP.get(reason, reason if reason else None)


def _validate_two_text_messages(messages: Sequence[Mapping[str, Any]]) -> List[Dict[str, str]]:
    if not isinstance(messages, Sequence) or len(messages) != 2:
        raise ValueError(
            f"AtriaDawnClient requires exactly 2 messages, got "
            f"{len(messages) if isinstance(messages, Sequence) else type(messages)}"
        )
    out: List[Dict[str, str]] = []
    for idx, msg in enumerate(messages):
        if not isinstance(msg, Mapping):
            raise ValueError(f"Message[{idx}] must be a mapping")
        role = msg.get("role")
        content = msg.get("content")
        if role not in {"system", "user", "assistant"}:
            raise ValueError(f"Invalid role at message[{idx}]: {role!r}")
        if not isinstance(content, str):
            raise ValueError(
                f"Atria-Dawn requires text-only string content; message[{idx}] has {type(content).__name__}"
            )
        out.append({"role": str(role), "content": content})
    return out


def _should_enable_reasoning_in_hybrid_mode(messages: List[Dict[str, str]]) -> bool:
    """Stage-aware hybrid reasoning for the 3ea5819 runtime: ballot/audit turns
    stay fast (reasoning off), solve/repair turns reason with a widened wire
    token budget."""
    combined = (messages[0]["content"] + "\n" + messages[1]["content"]).lower()
    fast_markers = ("ballot", "audit", "vote", "verdict_only", "schema_check")
    return not any(marker in combined for marker in fast_markers)


class AtriaDawnClient:
    """Signature-compatible with ``mathagent.user_client.UserSuppliedS2Client``."""

    def __init__(
        self,
        *,
        api_key: str,
        endpoint: str = DEFAULT_ATRIA_ENDPOINT,
        model: str = DEFAULT_ATRIA_MODEL,
        connect_seconds: float = 10.0,
        read_seconds: float = 60.0,
        reasoning_mode: Optional[str] = None,
        wire_max_tokens: Optional[int] = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("AtriaDawnClient requires a non-empty api_key")
        parsed = urlparse(endpoint)
        allow_local = parsed.hostname in {"127.0.0.1", "localhost"} and parsed.scheme in {
            "http",
            "https",
        }
        if (parsed.scheme != "https" and not allow_local) or parsed.hostname not in ALLOWED_ATRIA_HOSTS:
            raise ValueError(f"Unsupported Atria endpoint host: {endpoint!r}")
        if not parsed.path.endswith("/chat/completions") and not parsed.path.endswith(
            "/local-agent/messages"
        ):
            raise ValueError(f"Unsupported Atria endpoint path: {parsed.path!r}")
        if model not in ALLOWED_ATRIA_MODELS:
            raise ValueError(f"Unsupported Atria model: {model!r}")
        if connect_seconds <= 0 or read_seconds <= 0:
            raise ValueError("connect_seconds and read_seconds must be positive")

        self._api_key = api_key.strip()
        self._endpoint = endpoint
        self._model = model
        self._connect_seconds = float(connect_seconds)
        self._read_seconds = float(read_seconds)

        env_mode = os.environ.get("ASTRA_ATRIA_REASONING_MODE", "off").strip().lower()
        self._reasoning_mode = (reasoning_mode or env_mode or "off").lower()
        if self._reasoning_mode not in {"off", "hybrid", "auto_expand"}:
            raise ValueError(f"Unsupported reasoning_mode: {self._reasoning_mode!r}")

        env_wire = os.environ.get("ASTRA_ATRIA_WIRE_MAX_TOKENS", "").strip()
        if wire_max_tokens is not None:
            self._wire_max_tokens = wire_max_tokens
        elif env_wire.isdigit():
            self._wire_max_tokens = max(8192, min(65536, int(env_wire)))
        else:
            self._wire_max_tokens = 24576 if self._reasoning_mode in {"hybrid", "auto_expand"} else 8192

    @property
    def endpoint(self) -> str:
        return self._endpoint

    @property
    def model(self) -> str:
        return self._model

    @property
    def reasoning_mode(self) -> str:
        return self._reasoning_mode

    @property
    def wire_max_tokens(self) -> int:
        return self._wire_max_tokens

    def chat(
        self,
        *,
        messages: list,
        temperature: float,
        max_tokens: int,
        thinking_mode: bool,
        stream: bool,
        timeout: float,
        cancellation: Any,
    ) -> Dict[str, Any]:
        if max_tokens < 1 or max_tokens > 8192:
            raise ValueError(f"max_tokens must be in [1, 8192], got {max_tokens}")
        if abs(float(temperature) - 0.2) > 1e-6:
            raise ValueError(f"temperature must be 0.2, got {temperature}")
        if thinking_mode is not False:
            raise ValueError("PublicChatPort contract requires thinking_mode=False")
        if stream is not True:
            raise ValueError("PublicChatPort contract requires stream=True")
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError(f"timeout must be positive, got {timeout}")

        clean_messages = _validate_two_text_messages(messages)

        enable_wire_reasoning = False
        if self._reasoning_mode == "auto_expand":
            enable_wire_reasoning = True
        elif self._reasoning_mode == "hybrid":
            enable_wire_reasoning = _should_enable_reasoning_in_hybrid_mode(clean_messages)

        wire_tokens = max(max_tokens, self._wire_max_tokens) if enable_wire_reasoning else max_tokens

        body: Dict[str, Any] = {
            "model": self._model,
            "messages": clean_messages,
            "temperature": 0.2,
            "max_tokens": wire_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if not enable_wire_reasoning and not self._model.endswith(":fast"):
            body["reasoning"] = False

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        deadline = time.monotonic() + float(timeout)
        response = self._dispatch_with_rpm_guard(
            headers=headers,
            body=body,
            deadline=deadline,
            cancellation=cancellation,
        )
        return self._consume_sse_stream(
            response=response,
            deadline=deadline,
            cancellation=cancellation,
        ).to_openai_dict()

    def _dispatch_with_rpm_guard(
        self,
        *,
        headers: Dict[str, str],
        body: Dict[str, Any],
        deadline: float,
        cancellation: Any,
    ) -> requests.Response:
        for attempt in range(2):
            if cancellation is not None and getattr(cancellation, "is_set", lambda: False)():
                raise RuntimeError("Atria request cancelled before dispatch")
            remaining = deadline - time.monotonic()
            if remaining <= 0.05:
                raise TimeoutError("Request budget exhausted before dispatch")

            connect_to = min(self._connect_seconds, remaining)
            read_to = min(self._read_seconds, remaining)
            resp = requests.post(
                self._endpoint,
                headers=headers,
                json=body,
                stream=True,
                timeout=(connect_to, read_to),
            )
            if resp.status_code != 429 or attempt == 1:
                if resp.status_code >= 400:
                    err_snippet = sanitize_snippet(resp.text)
                    resp.close()
                    raise RuntimeError(f"Atria HTTP {resp.status_code}: {err_snippet}")
                return resp

            retry_after_raw = resp.headers.get("Retry-After", "5")
            resp.close()
            try:
                wait_s = float(retry_after_raw)
            except ValueError:
                wait_s = 5.0

            if wait_s <= 0 or (deadline - time.monotonic() - wait_s) < 8.0:
                raise RuntimeError(
                    f"Atria 429 rate limit: Retry-After={wait_s}s exceeds remaining budget"
                )
            if cancellation is not None and hasattr(cancellation, "wait"):
                if cancellation.wait(timeout=wait_s):
                    raise RuntimeError("Cancelled during 429 Retry-After backoff")
            else:
                time.sleep(wait_s)

        raise RuntimeError("Unreachable retry exit")

    def _consume_sse_stream(
        self,
        *,
        response: requests.Response,
        deadline: float,
        cancellation: Any,
    ) -> AtriaTransportResponse:
        """Parse both OpenAI delta frames and inkstone gateway events
        (``thinking_delta.text`` / ``content_delta.text`` / nested ``usage`` /
        ``message_end.stop_reason`` per gateway-events.mjs exact-key checks)."""
        content_chunks: List[str] = []
        reasoning_chunks: List[str] = []
        finish_reason: Optional[str] = None
        usage: Optional[Dict[str, Optional[int]]] = None
        protocol_usage: Optional[Dict[str, Optional[int]]] = None
        raw_model: Optional[str] = None

        try:
            for raw_line in response.iter_lines(decode_unicode=True):
                if cancellation is not None and getattr(cancellation, "is_set", lambda: False)():
                    raise RuntimeError("Atria SSE stream cancelled via cancellation handle")
                if time.monotonic() > deadline:
                    raise TimeoutError("Atria SSE stream exceeded deadline")
                if not raw_line:
                    continue
                line = raw_line.strip()
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break

                event = json.loads(data_str)
                if not isinstance(event, Mapping):
                    continue
                if isinstance(event.get("model"), str):
                    raw_model = event["model"]

                ev_type = event.get("type")
                if ev_type == "thinking_delta" and isinstance(event.get("text"), str):
                    reasoning_chunks.append(event["text"])
                    continue
                if ev_type == "content_delta" and isinstance(event.get("text"), str):
                    content_chunks.append(event["text"])
                    continue
                if ev_type == "usage":
                    raw_u = event.get("usage") if isinstance(event.get("usage"), Mapping) else event
                    extracted = _extract_usage(raw_u)
                    if extracted is not None:
                        usage = extracted
                    protocol_usage = _extract_protocol_usage(raw_u)
                    continue
                if ev_type == "message_end":
                    finish_reason = _normalize_finish_reason(event.get("stop_reason") or "end_turn")
                    continue

                if event.get("usage") is not None:
                    extracted = _extract_usage(event.get("usage"))
                    if extracted is not None:
                        usage = extracted
                    protocol_usage = _extract_protocol_usage(event.get("usage"))

                choices = event.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue
                choice0 = choices[0]
                if not isinstance(choice0, Mapping):
                    continue

                if choice0.get("finish_reason") is not None:
                    finish_reason = _normalize_finish_reason(choice0.get("finish_reason"))

                delta = choice0.get("delta")
                if isinstance(delta, Mapping):
                    c_piece = delta.get("content")
                    if isinstance(c_piece, str) and c_piece:
                        content_chunks.append(c_piece)
                    r_piece = delta.get("reasoning_content")
                    if isinstance(r_piece, str) and r_piece:
                        reasoning_chunks.append(r_piece)
        finally:
            response.close()

        full_content: Optional[str] = "".join(content_chunks) if content_chunks else None
        full_reasoning: Optional[str] = "".join(reasoning_chunks) if reasoning_chunks else None

        return AtriaTransportResponse(
            content=full_content,
            finish_reason=finish_reason,
            usage=usage,
            reasoning_content=full_reasoning,
            raw_model=raw_model,
            protocol_usage=protocol_usage,
        )


class InkstoneDesktopBridgeClient:
    """Drive inkstone-re-lab ``src/desktop/atria-bridge-runner.mjs`` as a JSONL
    subprocess, exposing the same ``chat`` signature to ``PublicChatPort``."""

    def __init__(
        self,
        *,
        inkstone_repo_root: str | pathlib.Path,
        model: str = DEFAULT_ATRIA_MODEL,
        node_executable: str = "node",
    ) -> None:
        self._root = pathlib.Path(inkstone_repo_root).resolve()
        self._driver_script = self._root / "src" / "desktop" / "atria-bridge-runner.mjs"
        if not self._root.exists():
            raise FileNotFoundError(f"inkstone-re-lab repository not found at {self._root}")
        if not self._driver_script.exists():
            raise FileNotFoundError(f"atria-bridge-runner.mjs not found at {self._driver_script}")
        if model not in ALLOWED_ATRIA_MODELS:
            raise ValueError(f"Unsupported Atria model: {model!r}")
        self._model = model
        self._node = node_executable

    @property
    def model(self) -> str:
        return self._model

    def chat(
        self,
        *,
        messages: list,
        temperature: float,
        max_tokens: int,
        thinking_mode: bool,
        stream: bool,
        timeout: float,
        cancellation: Any,
    ) -> Dict[str, Any]:
        clean_messages = _validate_two_text_messages(messages)
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError(f"timeout must be positive, got {timeout}")
        req_payload = {
            "model": self._model,
            "messages": clean_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "timeoutMs": int(float(timeout) * 1000),
        }
        proc = subprocess.Popen(
            [self._node, str(self._driver_script)],
            cwd=str(self._root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def _watch_cancel() -> None:
            if cancellation is not None and hasattr(cancellation, "wait"):
                if cancellation.wait(timeout=float(timeout)) and proc.poll() is None:
                    proc.terminate()

        watcher = threading.Thread(target=_watch_cancel, daemon=True)
        watcher.start()

        try:
            stdout_data, stderr_data = proc.communicate(
                input=json.dumps(req_payload, ensure_ascii=False) + "\n",
                timeout=float(timeout) + 2.0,
            )
        except subprocess.TimeoutExpired:
            proc.kill()
            raise TimeoutError("inkstone-re-lab desktop bridge timed out")

        if proc.returncode != 0:
            raise RuntimeError(
                f"inkstone-re-lab bridge failed (exit={proc.returncode}): {sanitize_snippet(stderr_data)}"
            )
        lines = [ln for ln in stdout_data.strip().splitlines() if ln.strip()]
        if not lines:
            raise RuntimeError("inkstone-re-lab bridge returned no output")
        result = json.loads(lines[-1])
        if not isinstance(result, Mapping) or "choices" not in result:
            raise RuntimeError("inkstone-re-lab bridge returned a malformed payload")
        return dict(result)


__all__ = [
    "ALLOWED_ATRIA_HOSTS",
    "ALLOWED_ATRIA_MODELS",
    "DEFAULT_ATRIA_ENDPOINT",
    "DEFAULT_ATRIA_MODEL",
    "GATEWAY_STOP_REASON_MAP",
    "AtriaDawnClient",
    "AtriaTransportResponse",
    "InkstoneDesktopBridgeClient",
    "sanitize_snippet",
]
