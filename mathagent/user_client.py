"""Explicit judge-side client factory for the user-supplied S2 endpoint.

Transport conventions are selectively reimplemented from the supplied S2
preset_engine/chat_client.py. No experiment runner or reasoning channel is read.
The solving agent never constructs this client or discovers credentials.
Post-dispatch cancellation is unconfirmed: this connector cannot certify it.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests

from .runtime.adapter import ProviderRejected, RateLimited, RequestNotDispatched
from .runtime.config import fingerprint
from .runtime.http_observer import exception_types
from .runtime.provider_error import describe_error, rejection_kind
from .runtime.request_observer import observe
from .runtime.response import TerminalDeliveryError, public_choice, terminal_reason
from .runtime.transport import (
    TransportResponse,
    UnconfirmedTransportFailure,
    safe_transport,
)


class UserSuppliedS2Client:
    # This connector is for explicit self-managed runs, never a substitute for
    # an injected platform client or a way around historical unknown leases.
    astra_local_coordination_required = True

    def __init__(
        self, *, api_key, endpoint, model, connect_seconds=10, read_seconds=60
    ):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "chat.intern-ai.org.cn"
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path != "/api/v1/chat/completions"
            or parsed.port not in {None, 443}
        ):
            raise ValueError(
                "endpoint must match the explicitly supplied HTTPS destination"
            )
        if not api_key or len(api_key) > 4096 or model != "Intern-S2-Preview-397B":
            raise ValueError("explicit supplied client configuration invalid")
        self._api_key = api_key
        self.endpoint, self.model = endpoint, model
        if any(
            type(v) not in {int, float} or not math.isfinite(v) or not 0 < v <= 1200
            for v in (connect_seconds, read_seconds)
        ):
            raise ValueError("positive bounded transport timeouts required")
        self.connect_seconds, self.read_seconds = connect_seconds, read_seconds
        self.last_transport_summary = {}

    def chat(
        self,
        *,
        messages,
        temperature,
        max_tokens,
        thinking_mode,
        stream,
        timeout,
        cancellation,
    ):
        summary = {
            "stage": "request_validation",
            "attempts": 0,
            "post_dispatch_cancellation_confirmed": False,
        }
        self.last_transport_summary = summary
        if (
            type(max_tokens) is not int
            or not 1 <= max_tokens <= 8192
            or thinking_mode is not False
            or stream is not True
            or temperature != 0.2
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("request violates the frozen S2 settings")
        if cancellation.is_set():
            raise RequestNotDispatched()
        # Exactly one HTTP attempt; caller owns logical accounting and retries.
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "thinking_mode": False,
            "stream": True,
        }
        response = None
        started = time.monotonic()
        deadline = started + timeout
        summary.update(
            connect_timeout_seconds=min(self.connect_seconds, timeout),
            read_timeout_seconds=min(self.read_seconds, timeout),
            response_headers_seconds=None,
            first_body_chunk_seconds=None,
            response_bytes=0,
        )
        content, usage, finish_reason, done_seen = [], {}, None, False
        total, pending, stream_seen = 0, b"", False

        def consume(chunk):
            nonlocal finish_reason
            if isinstance(chunk, dict) and chunk.get("error"):
                details = describe_error(chunk["error"], self._api_key)
                summary.update(details)
                category = rejection_kind(details, content_seen=any(content))
                observe(
                    "provider_error",
                    **details,
                    category=category or "unknown",
                    content_seen=any(content),
                    at=time.monotonic(),
                )
                if category == "rate_limit":
                    try:
                        retry = float(response.headers.get("Retry-After", "60"))
                    except (TypeError, ValueError):
                        retry = 60
                    retry = max(60, min(21600, retry)) if math.isfinite(retry) else 60
                    summary["retry_after_seconds"] = retry
                    raise RateLimited(retry)
                if category == "invalid_request":
                    code = details.get("provider_error_code", "400")
                    raise ProviderRejected(
                        int(code)
                        if code in {"400", "401", "403", "404", "422"}
                        else 400
                    )
                raise RuntimeError("provider_stream_error_unconfirmed")
            # Check original identity before any normalization or terminal receipt.
            choice = public_choice(chunk)
            if choice is not None:
                reason = terminal_reason(choice)
                if choice.get("finish_reason") == "":
                    summary["empty_finish_reason_chunks"] = (
                        summary.get("empty_finish_reason_chunks", 0) + 1
                    )
                if reason is not None:
                    summary["finish_reason_type"] = type(reason).__name__
                    if isinstance(reason, str) and re.fullmatch(
                        r"[A-Za-z_]{1,32}", reason
                    ):
                        summary["observed_finish_reason"] = reason
                    finish_reason = reason
                    # Persist the validated receipt immediately, even if content
                    # decoding or local cleanup subsequently fails.
                    terminal_usage = chunk.get("usage")
                    receipt_usage = dict(usage)
                    if isinstance(terminal_usage, dict):
                        receipt_usage.update(
                            {
                                key: terminal_usage[key]
                                for key in (
                                    "prompt_tokens",
                                    "completion_tokens",
                                    "total_tokens",
                                )
                                if type(terminal_usage.get(key)) is int
                                and terminal_usage[key] >= 0
                            }
                        )
                    observe(
                        "terminal_receipt",
                        finish_reason=reason,
                        usage=receipt_usage,
                        at=time.monotonic(),
                    )
                text = (choice.get("delta") or choice.get("message") or {}).get(
                    "content"
                )
                if text is not None:
                    if not isinstance(text, str):
                        raise ValueError("invalid public content type")
                    content.append(text)
                    observe("visible_content", content=text, at=time.monotonic())
            raw_usage = chunk.get("usage") or {}
            usage.update(
                {
                    k: raw_usage[k]
                    for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                    if type(raw_usage.get(k)) is int and raw_usage[k] >= 0
                }
            )

        def consume_line(line):
            nonlocal done_seen, stream_seen
            line = line.strip()
            if not line or line.startswith((b":", b"event:", b"id:", b"retry:")):
                return
            if line.startswith(b"data:"):
                stream_seen = True
                body = line[5:].strip()
                if body == b"[DONE]":
                    done_seen = True
                else:
                    consume(json.loads(body.decode("utf-8")))
            else:
                consume(json.loads(line.decode("utf-8")))

        try:
            observe(
                "http_dispatch",
                payload=payload,
                payload_sha256=fingerprint(payload),
                absolute_deadline=deadline,
                at=started,
                connect_seconds=min(self.connect_seconds, timeout),
                stream_idle_read_seconds=min(self.read_seconds, timeout),
            )
            summary.update(stage="http_dispatch", attempts=1)
            observe("transport_snapshot", transport=safe_transport(summary), at=started)
            response = requests.post(
                self.endpoint,
                headers={
                    "Authorization": "Bearer " + self._api_key,
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=(
                    min(self.connect_seconds, timeout),
                    min(self.read_seconds, timeout),
                ),
                allow_redirects=False,
                stream=True,
            )
            status = response.status_code
            summary["response_headers_seconds"] = max(0, time.monotonic() - started)
            observe("http_headers", http_status=status, at=time.monotonic())
            summary.update(
                {
                    "stage": "http_response",
                    "http_status": status,
                    "attempts": 1,
                    "post_dispatch_cancellation_confirmed": False,
                }
            )
            observe(
                "transport_snapshot",
                transport=safe_transport(summary),
                at=time.monotonic(),
            )
            if status == 429:
                try:
                    delay = float(response.headers.get("Retry-After", "60"))
                except ValueError:
                    delay = 60
                raise RateLimited(
                    max(0, min(21600, delay)) if math.isfinite(delay) else 60
                )
            if 400 <= status < 500 and status != 408:
                raise ProviderRejected(status)
            if status != 200:
                raise RuntimeError("nonterminal_http_failure_unconfirmed")
            summary["stage"] = "public_content_decode"
            for block in response.iter_content(chunk_size=4096):
                if block and summary["first_body_chunk_seconds"] is None:
                    summary["first_body_chunk_seconds"] = max(
                        0, time.monotonic() - started
                    )
                total += len(block)
                summary["response_bytes"] = total
                if total > 2 * 1024 * 1024:
                    raise RuntimeError("response_resource_limit_unconfirmed")
                pending += block
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if len(line) > 65536:
                        raise RuntimeError("response_line_limit_unconfirmed")
                    consume_line(line)
                    if finish_reason is not None:
                        pending = (
                            b""  # Only transport tail can follow the terminal choice.
                        )
                        break
                if len(pending) > 65536:
                    raise RuntimeError("response_line_limit_unconfirmed")
                if finish_reason is not None:
                    # A recognized public terminal reason ends this generation.
                    # Do not require socket EOF / [DONE] / a read of the next block;
                    # those are transport observations, not cancellation receipts.
                    break
                # Inspect bytes already received for a real end receipt before
                # discarding them at the hard observation boundary. Late content
                # remains unusable by the adapter's separate phase deadline.
                if cancellation.is_set() or time.monotonic() >= deadline:
                    raise RuntimeError("post_dispatch_cancellation_unconfirmed")
            if pending.strip():
                consume_line(pending)
            if finish_reason is None:
                raise RuntimeError("missing_terminal_reason_unconfirmed")
            result = "".join(content)
            if len(result.encode("utf-8")) > 65536:
                raise RuntimeError("content_limit_unconfirmed")
            summary.update(
                stage="terminal_response",
                transport="SSE" if stream_seen else "JSON",
                done_seen=done_seen,
                finish_reason=finish_reason,
            )
            return TransportResponse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "message": {"content": result},
                            "finish_reason": finish_reason,
                        }
                    ],
                    "usage": usage,
                },
                summary,
            )
        except Exception as exc:
            summary["exception_types"] = exception_types(exc)
            summary["failure_type"] = type(exc).__name__
            if finish_reason is not None:
                observe(
                    "transport_failure",
                    transport=safe_transport(summary),
                    at=time.monotonic(),
                )
                raise TerminalDeliveryError(finish_reason, summary) from None
            if isinstance(exc, (ProviderRejected, RateLimited, RequestNotDispatched)):
                # Keep an explicit provider rejection as the final public error
                # event. Its request-local details also reach the worker journal.
                exc.transport = summary
                raise
            safe_codes = {
                "missing_terminal_reason_unconfirmed",
                "post_dispatch_cancellation_unconfirmed",
                "response_resource_limit_unconfirmed",
                "response_line_limit_unconfirmed",
                "nonterminal_http_failure_unconfirmed",
                "provider_stream_error_unconfirmed",
            }
            code = (
                str(exc) if str(exc) in safe_codes else "transport_failure_unconfirmed"
            )
            summary["failure_code"] = code
            observe(
                "transport_failure",
                transport=safe_transport(summary),
                at=time.monotonic(),
            )
            error_type = (
                "RuntimeError"
                if isinstance(exc, requests.RequestException)
                else type(exc).__name__
            )
            raise UnconfirmedTransportFailure(error_type, summary, code) from None
        finally:
            if response is not None:
                try:
                    response.close()  # Local disposal is never a remote end receipt.
                except Exception as exc:  # noqa: BLE001 - cleanup must not replace return or primary error
                    summary["cleanup_error_type"] = type(exc).__name__


def create_client():
    """Explicit invocation by a user-authorized factory/runner, not by the agent."""
    path = os.environ.get("ASTRA_USER_CLIENT_CONFIG")
    if not path:
        raise ValueError("explicit user configuration file required")
    text = Path(path).read_text(encoding="utf-8")
    keys = [
        line.strip()
        for line in text.splitlines()
        if re.fullmatch(r"sk-[A-Za-z0-9_-]{20,4090}", line.strip())
    ]
    endpoints = set(
        re.findall(r"https://chat\.intern-ai\.org\.cn/api/v1/chat/completions", text)
    )
    models = set(re.findall(r"Intern-S2-Preview-397B", text))
    if len(keys) != 1 or len(endpoints) != 1 or len(models) != 1:
        raise ValueError(
            "user file must explicitly identify one credential, endpoint and model"
        )
    return UserSuppliedS2Client(
        api_key=keys[0], endpoint=endpoints.pop(), model=models.pop()
    )
