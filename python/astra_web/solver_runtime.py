"""Turn a stored host-side configuration into a real solver callable.

Two sanctioned endpoints are supported and both drive the repository's full
bounded reasoning pipeline (TS by default: R0 + M1-M5 + DAG + unified math
assets + live SSE events, or explicit ``ASTRA_SOLVER_ENGINE=lite``):

* ``intern-s2-chat`` — routed through the repository's official pinned client
  (``mathagent.user_client.UserSuppliedS2Client``) via ``PublicChatPort``.
* ``intern-inkstone`` — the discovery endpoint, routed through an OpenAI-
  compatible connector bound to ``PublicChatPort``.

Honesty rules applied here:

* No fabricated events are ever produced. The adapter returns only the real
  events and terminal facts it observed.
* ``usage`` is recorded only when the provider actually returned it; an absent or
  malformed block stays ``UNKNOWN`` and is **never** counted as ``0``.
* Failures (quota exhaustion, HTTP rejection, transport failure) are recorded
  using non-secret diagnostics without altering ``candidate_verified=False`` or
  manufacturing answers.
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .queue import ExecutionManager, SolveOutcome
from .solver_config import EndpointSpec, SolverConfig, endpoint_spec, models_url

DEFAULT_TIMEOUT_SECONDS = 60.0
DEFAULT_MAX_TOKENS = 2048


def _model_ids(payload: Any) -> list[str]:
    """Accept the shapes an OpenAI-compatible model list actually comes in."""
    rows: Any = payload
    if isinstance(payload, Mapping):
        for key in ("data", "models", "result"):
            if isinstance(payload.get(key), list):
                rows = payload[key]
                break
        else:
            rows = []
    found: list[str] = []
    if isinstance(rows, list):
        for row in rows:
            if isinstance(row, str) and row.strip():
                found.append(row.strip())
            elif isinstance(row, Mapping):
                for key in ("id", "model", "name"):
                    value = row.get(key)
                    if isinstance(value, str) and value.strip():
                        found.append(value.strip())
                        break
    # Order preserved, duplicates dropped — the console shows exactly what the
    # endpoint reported, never a list we invented.
    seen: set[str] = set()
    unique: list[str] = []
    for name in found:
        if name not in seen:
            seen.add(name)
            unique.append(name)
    return unique


def fetch_models(
    endpoint: str, credential: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> list[str]:
    """Ask the endpoint itself which models it serves, using the supplied credential.

    Raises on any real failure; the caller decides how to present that honestly.
    """
    spec = endpoint_spec(endpoint)
    if spec is None:
        raise ValueError("endpoint is not one of the sanctioned endpoints")
    if not credential:
        raise ValueError("a credential is required to enumerate models")

    request = urllib.request.Request(
        models_url(endpoint),
        method="GET",
        headers={
            "Authorization": "Bearer " + credential,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return _model_ids(json.loads(raw.decode("utf-8")))


@dataclass
class UsageLedger:
    """Observed provider usage. Numbers only from real responses; else UNKNOWN."""

    calls: int = 0
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None
    unknown_usage_responses: int = 0
    failures: int = 0
    last_endpoint: Optional[str] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @staticmethod
    def _as_count(value: Any) -> Optional[int]:
        if type(value) is int and value >= 0:
            return value
        return None

    def record_success(self, usage: Any, endpoint: str) -> None:
        with self._lock:
            self.calls += 1
            self.last_endpoint = endpoint
            block = usage if isinstance(usage, Mapping) else None
            prompt = self._as_count(block.get("prompt_tokens")) if block else None
            completion = self._as_count(block.get("completion_tokens")) if block else None
            total = self._as_count(block.get("total_tokens")) if block else None
            details = block.get("prompt_tokens_details") if block else None
            cached = None
            if isinstance(details, Mapping):
                cached = self._as_count(details.get("cached_tokens"))
            if prompt is None and completion is None and total is None:
                # Missing/malformed usage stays unknown; it is never coerced to 0.
                self.unknown_usage_responses += 1
                return
            self.prompt_tokens = (self.prompt_tokens or 0) + (prompt or 0)
            self.completion_tokens = (self.completion_tokens or 0) + (completion or 0)
            self.total_tokens = (self.total_tokens or 0) + (total or (prompt or 0) + (completion or 0))
            if cached is not None:
                self.cached_tokens = (self.cached_tokens or 0) + cached

    def record_failure(self) -> None:
        with self._lock:
            self.calls += 1
            self.failures += 1

    def snapshot(self) -> Mapping[str, Any]:
        with self._lock:
            return {
                "calls": self.calls,
                "failures": self.failures,
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "total_tokens": self.total_tokens,
                "cached_tokens": self.cached_tokens,
                "unknown_usage_responses": self.unknown_usage_responses,
                "last_endpoint": self.last_endpoint,
            }


def problem_text(payload: Mapping[str, Any]) -> str:
    """The operator-supplied problem text, taken from the real request payload."""
    for key in ("problem", "problemText", "question", "prompt"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    raise ValueError("run payload carries no problem text")


def _extract(content_payload: Mapping[str, Any]) -> tuple[Optional[str], Optional[str], Any]:
    choices = content_payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None, None, content_payload.get("usage")
    first = choices[0] if isinstance(choices[0], Mapping) else {}
    message = first.get("message") if isinstance(first.get("message"), Mapping) else {}
    content = message.get("content")
    return (
        content if isinstance(content, str) else None,
        first.get("finish_reason"),
        content_payload.get("usage"),
    )


def _unwrap(response: Any) -> Mapping[str, Any]:
    """The official client returns a TransportResponse; accept mapping or attribute."""
    if isinstance(response, Mapping):
        return response
    body = getattr(response, "body", None)
    if isinstance(body, Mapping):
        return body
    if isinstance(response, tuple) and response and isinstance(response[0], Mapping):
        return response[0]
    raise ValueError("unrecognised response shape from the official client")


_SAFE_DIAG_KEYS = (
    "http_status",
    "provider_error_code",
    "provider_error_type",
    "provider_error_message",
    "error_type",
    "failure_reason",
    "failure_type",
    "failure_code",
    "stage",
    "observed_finish_reason",
    "bytes_received",
    "response_bytes",
    "sse_events",
    "read_timeout_seconds",
    "response_headers_seconds",
    "first_body_chunk_seconds",
)


def _record_safe_diag_fields(
    diag: dict[str, Any],
    source: Mapping[str, Any],
    *,
    overwrite: bool,
) -> None:
    """Copy non-secret numeric/string/exception diagnostic fields from source."""
    for key in _SAFE_DIAG_KEYS:
        val = source.get(key)
        if val is None:
            continue
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            val_out: Any = round(val, 2) if isinstance(val, float) else val
            if overwrite:
                diag[key] = val_out
            else:
                diag.setdefault(key, val_out)
        elif isinstance(val, str) and val.strip():
            cleaned = _clean_text(val)
            if overwrite:
                diag[key] = cleaned
            else:
                diag.setdefault(key, cleaned)
    exc_types = source.get("exception_types")
    if isinstance(exc_types, (list, tuple)) and exc_types:
        cleaned_types = _clean_text(
            ",".join(str(item) for item in exc_types[:4] if item),
            limit=120,
        )
        if cleaned_types:
            if overwrite:
                diag["exception_types"] = cleaned_types
            else:
                diag.setdefault("exception_types", cleaned_types)


def _clean_text(value: Any, *, limit: int = 240) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit]


def _classify_failure(exc: BaseException) -> str:
    """Map a real failure to a stable, non-invented code."""
    name = type(exc).__name__
    if isinstance(exc, urllib.error.HTTPError):
        return "PROVIDER_HTTP_%d" % exc.code
    if name in {"RateLimited"}:
        return "PROVIDER_RATE_LIMITED"
    if name in {"ProviderRejected"}:
        return "PROVIDER_REJECTED"
    if name in {"RequestNotDispatched"}:
        return "REQUEST_NOT_DISPATCHED"
    if name in {"TerminalDeliveryError", "UnconfirmedTransportFailure"}:
        return "TRANSPORT_UNCONFIRMED"
    if isinstance(exc, (TimeoutError, urllib.error.URLError)):
        return "TRANSPORT_FAILED"
    return "SOLVER_CALL_FAILED"


@dataclass
class _DiagnosticTracker:
    """Thread-safe holder for non-secret provider diagnostics during one run."""

    last_failure: Optional[dict[str, Any]] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _store(self, diag: dict[str, Any]) -> None:
        if not diag:
            return
        with self._lock:
            self.last_failure = diag

    def record_payload_error(self, err: Mapping[str, Any]) -> None:
        diag: dict[str, Any] = {"code": "PROVIDER_REJECTED"}
        if err.get("code") is not None:
            diag["provider_error_code"] = _clean_text(err.get("code"), limit=64)
        if err.get("type") is not None:
            diag["provider_error_type"] = _clean_text(err.get("type"), limit=64)
        if err.get("message") is not None:
            diag["provider_error_message"] = _clean_text(err.get("message"))
        self._store(diag)

    def record_exception(
        self, exc: BaseException, transport_summary: Optional[Mapping[str, Any]] = None
    ) -> None:
        diag: dict[str, Any] = {
            "code": _classify_failure(exc),
            "exception": type(exc).__name__,
        }
        if isinstance(exc, urllib.error.HTTPError):
            diag["http_status"] = int(exc.code)
            try:
                raw_body = exc.read(1024)
            except Exception:
                raw_body = b""
            if raw_body:
                try:
                    parsed = json.loads(raw_body.decode("utf-8", errors="ignore"))
                except ValueError:
                    parsed = None
                if isinstance(parsed, Mapping) and isinstance(parsed.get("error"), Mapping):
                    err = parsed["error"]
                    if err.get("code") is not None:
                        diag["provider_error_code"] = _clean_text(err.get("code"), limit=64)
                    if err.get("message") is not None:
                        diag["provider_error_message"] = _clean_text(err.get("message"))
        if isinstance(transport_summary, Mapping):
            _record_safe_diag_fields(diag, transport_summary, overwrite=True)
        err_type = getattr(exc, "error_type", None)
        if isinstance(err_type, str) and err_type.strip():
            diag.setdefault("error_type", _clean_text(err_type, limit=80))
        exc_summary = getattr(exc, "summary", None)
        if isinstance(exc_summary, Mapping):
            _record_safe_diag_fields(diag, exc_summary, overwrite=False)
        self._store(diag)

    def snapshot(self) -> Optional[dict[str, Any]]:
        with self._lock:
            return dict(self.last_failure) if self.last_failure is not None else None

    def format_summary(self) -> str:
        diag = self.snapshot()
        if not diag:
            return ""
        parts: list[str] = []
        pcode = diag.get("provider_error_code")
        pmsg = diag.get("provider_error_message")
        http_status = diag.get("http_status")
        err_type = diag.get("error_type") or diag.get("failure_reason")
        fcode = diag.get("failure_code")
        stage = diag.get("stage")
        exc_types = diag.get("exception_types")
        if pcode and pmsg:
            parts.append(f"端点返回 {pcode}: {pmsg}")
        elif pmsg:
            parts.append(f"端点返回: {pmsg}")
        elif pcode:
            parts.append(f"端点错误码 {pcode}")
        elif err_type:
            detail_bits = [
                bit
                for bit in (
                    fcode if isinstance(fcode, str) else None,
                    f"stage={stage}" if isinstance(stage, str) else None,
                    exc_types if isinstance(exc_types, str) else None,
                )
                if bit
            ]
            suffix = f" ({', '.join(detail_bits)})" if detail_bits else ""
            parts.append(f"传输错误 {err_type}{suffix}")
        elif diag.get("code"):
            parts.append(str(diag["code"]))
        if isinstance(http_status, int):
            parts.append(f"HTTP {http_status}")
        return "，".join(parts)


class _TrackedEndpointConnector:
    """Bind ``intern-chat`` or ``openai-compatible`` calls to ``PublicChatPort``.

    Exposes ``chat(messages, temperature, max_tokens, thinking_mode, stream,
    timeout, cancellation)`` as expected by ``PublicChatPort``, records observed
    usage into ``UsageLedger``, and captures non-secret failure diagnostics.
    """

    def __init__(
        self,
        config: SolverConfig,
        spec: EndpointSpec,
        usage: UsageLedger,
        tracker: _DiagnosticTracker,
    ) -> None:
        self._config = config
        self._spec = spec
        self._usage = usage
        self._tracker = tracker
        self._pace_lock = threading.Lock()
        self._last_call_finished_at: Optional[float] = None
        self._min_gap_seconds: float = 0.0
        self._rate_limit_backoffs: tuple[float, ...] = (15.0, 28.0, 45.0)
        self._adaptive_gap_seconds: float = 2.5

    def _wait_inter_call_gap(
        self, *, deadline: float, cancellation: threading.Event
    ) -> None:
        from mathagent.runtime.adapter import RequestNotDispatched

        with self._pace_lock:
            min_gap = self._min_gap_seconds
            last_finished = self._last_call_finished_at
        if min_gap <= 0.0 or last_finished is None:
            return
        elapsed = time.monotonic() - last_finished
        wait_s = min_gap - elapsed
        if wait_s <= 0.0:
            return
        if deadline - time.monotonic() - wait_s < 25.0:
            return
        cancellation.wait(wait_s)
        if cancellation.is_set():
            raise RequestNotDispatched()

    def _call_intern_chat(
        self,
        *,
        message_list: list[Any],
        temperature: float,
        bounded_tokens: int,
        thinking_mode: bool,
        stream: bool,
        deadline: float,
        cancellation: threading.Event,
    ) -> dict[str, Any]:
        from mathagent.runtime.adapter import RateLimited, RequestNotDispatched
        from mathagent.user_client import UserSuppliedS2Client

        self._wait_inter_call_gap(deadline=deadline, cancellation=cancellation)
        max_retries = len(self._rate_limit_backoffs)
        for attempt in range(max_retries + 1):
            remaining_timeout = max(0.1, deadline - time.monotonic())
            client = UserSuppliedS2Client(
                api_key=self._config.credential,
                endpoint=self._config.endpoint,
                model=self._config.model,
                connect_seconds=15,
                read_seconds=180,
            )
            try:
                response = client.chat(
                    messages=message_list,
                    temperature=temperature,
                    max_tokens=bounded_tokens,
                    thinking_mode=thinking_mode,
                    stream=stream,
                    timeout=remaining_timeout,
                    cancellation=cancellation,
                )
            except RateLimited as exc:
                if cancellation.is_set():
                    raise RequestNotDispatched() from exc
                if attempt < max_retries:
                    cap = self._rate_limit_backoffs[attempt]
                    hint = getattr(exc, "retry_after", cap)
                    wait_s = min(float(hint), cap) if (
                        isinstance(hint, (int, float))
                        and math.isfinite(float(hint))
                        and float(hint) > 0
                    ) else cap
                    if deadline - time.monotonic() - wait_s >= 25.0:
                        with self._pace_lock:
                            self._min_gap_seconds = max(
                                self._min_gap_seconds, self._adaptive_gap_seconds
                            )
                        cancellation.wait(wait_s)
                        if cancellation.is_set():
                            raise RequestNotDispatched() from exc
                        continue
                self._usage.record_failure()
                self._tracker.record_exception(
                    exc, getattr(client, "last_transport_summary", None)
                )
                raise
            except Exception as exc:
                self._usage.record_failure()
                self._tracker.record_exception(
                    exc, getattr(client, "last_transport_summary", None)
                )
                raise
            with self._pace_lock:
                self._last_call_finished_at = time.monotonic()
            return dict(_unwrap(response))
        raise RuntimeError("unreachable")  # pragma: no cover

    def chat(
        self,
        *,
        messages: Any,
        temperature: float,
        max_tokens: int,
        thinking_mode: bool,
        stream: bool,
        timeout: float,
        cancellation: threading.Event,
    ) -> dict[str, Any]:
        message_list = list(messages or ())
        bounded_tokens = max(1, min(int(max_tokens), 8192))

        if self._spec.client == "intern-chat":
            deadline = time.monotonic() + max(0.1, float(timeout))
            payload = self._call_intern_chat(
                message_list=message_list,
                temperature=temperature,
                bounded_tokens=bounded_tokens,
                thinking_mode=thinking_mode,
                stream=stream,
                deadline=deadline,
                cancellation=cancellation,
            )
        else:
            body = json.dumps(
                {
                    "model": self._config.model,
                    "messages": message_list,
                    "temperature": temperature,
                    "max_tokens": bounded_tokens,
                    "stream": False,
                }
            ).encode("utf-8")
            request = urllib.request.Request(
                self._config.endpoint,
                data=body,
                method="POST",
                headers={
                    "Authorization": "Bearer " + self._config.credential,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    raw = response.read()
                decoded = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                self._usage.record_failure()
                self._tracker.record_exception(exc)
                raise
            if not isinstance(decoded, Mapping):
                raise ValueError("unrecognised JSON payload from endpoint")
            payload = dict(decoded)

        err = payload.get("error")
        if isinstance(err, Mapping) and err:
            self._usage.record_failure()
            self._tracker.record_payload_error(err)
            return payload

        _, _, usage_block = _extract(payload)
        self._usage.record_success(usage_block, self._config.endpoint)
        return payload


def _resolve_engine(payload: Mapping[str, Any]) -> str:
    env_engine = (os.environ.get("ASTRA_SOLVER_ENGINE") or "").strip().lower()
    if env_engine in {"lite", "ts"}:
        return env_engine
    req_engine = payload.get("engine")
    if isinstance(req_engine, str):
        normalized = req_engine.strip().lower()
        if normalized in {"lite", "ts"}:
            return normalized
    return "ts"


def build_solver(
    config: SolverConfig, usage: UsageLedger, *, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> Callable[[Mapping[str, Any]], SolveOutcome]:
    """Build the solver callable for a validated configuration."""
    spec = endpoint_spec(config.endpoint)
    if spec is None:
        raise ValueError("endpoint is not one of the sanctioned endpoints")

    def solve(payload: Mapping[str, Any]) -> SolveOutcome:
        try:
            problem = problem_text(payload)
        except ValueError as exc:
            return SolveOutcome.system_failure(str(exc), code="REQUEST_INVALID")
        return _solve_via_pipeline(config, spec, payload, problem, usage, timeout=timeout)

    return solve


def _solve_via_pipeline(
    config: SolverConfig,
    spec: EndpointSpec,
    payload: Mapping[str, Any],
    problem: str,
    usage: UsageLedger,
    *,
    timeout: float,
) -> SolveOutcome:
    """Run one bounded solve through ``SolverAdapter`` + ``PublicChatPort``."""
    from python.astra_bridge.public_chat_port import PublicChatPort

    from .config import DEFAULT_BUDGET
    from .solver_adapter import SolverAdapter

    engine = _resolve_engine(payload)
    if engine == "ts":
        os.environ.setdefault("ASTRA_STDIO_RUNTIME", "dev")

    caller_sink = payload.get("_event_sink") if callable(payload.get("_event_sink")) else None
    local_events: list[Mapping[str, Any]] = []
    observed_count = 0

    def _observer(event: Mapping[str, Any]) -> None:
        nonlocal observed_count
        observed_count += 1
        if caller_sink is not None:
            caller_sink(event)
        else:
            local_events.append(dict(event))

    adapter_request = dict(payload)
    adapter_request["problem"] = problem
    adapter_request["engine"] = engine
    adapter_request["_event_sink"] = _observer
    raw_seconds = adapter_request.get("problem_seconds")
    if (
        type(raw_seconds) not in {int, float}
        or not math.isfinite(float(raw_seconds))
        or float(raw_seconds) <= 0
        or float(raw_seconds) > 1200.0
    ):
        fallback_sec = float(timeout) if math.isfinite(float(timeout)) else 600.0
        adapter_request["problem_seconds"] = min(max(fallback_sec, 0.1), 1200.0)

    tracker = _DiagnosticTracker()
    connector = _TrackedEndpointConnector(config, spec, usage, tracker)

    def _client_factory(budgets: Mapping[str, Any]) -> PublicChatPort:
        req_seconds = budgets.get(
            "problem_seconds",
            adapter_request.get("problem_seconds", DEFAULT_BUDGET["problem_seconds"]),
        )
        bounded = min(max(float(req_seconds), 0.1), 1200.0)
        return PublicChatPort(connector, request_seconds=bounded)

    adapter = SolverAdapter(client_factory=_client_factory)
    try:
        raw_result = dict(adapter(adapter_request))
    except Exception as exc:  # noqa: BLE001 - reported honestly, never smoothed over
        diag = tracker.snapshot()
        if diag is None:
            usage.record_failure()
        diag_text = tracker.format_summary()
        detail = f"官方流水线（engine={engine}）执行失败：{type(exc).__name__}"
        if diag_text:
            detail = f"{detail}（{diag_text}）"
        return SolveOutcome.system_failure(
            detail,
            code=(diag or {}).get("code") or "PIPELINE_LAUNCH_FAILED",
        )

    if (
        not raw_result.get("stopReason")
        and not raw_result.get("stop_reason")
        and raw_result.get("status") == "candidate"
    ):
        raw_result["stopReason"] = "SOLVED"

    if local_events:
        raw_result["events"] = local_events
    elif (
        observed_count == 0
        and engine == "lite"
        and isinstance(raw_result.get("trace"), (list, tuple))
    ):
        raw_result["events"] = [
            dict(row) for row in raw_result["trace"] if isinstance(row, Mapping)
        ]

    diag = tracker.snapshot()
    if diag is not None and raw_result.get("stopReason") != "SOLVED":
        raw_result["providerDiagnostic"] = diag
        diag_text = tracker.format_summary()
        if diag_text:
            base_reason = str(raw_result.get("reason") or "").strip()
            if diag_text not in base_reason:
                raw_result["reason"] = (
                    f"{base_reason}（{diag_text}）" if base_reason else diag_text
                )
        if not raw_result.get("code") and isinstance(diag.get("code"), str):
            raw_result["code"] = diag["code"]

    return ExecutionManager._coerce_outcome(raw_result)


def build_solver_from_path(path: Any, usage: UsageLedger) -> Optional[Callable[[Mapping[str, Any]], SolveOutcome]]:
    """Convenience used by the app factory: None when unconfigured or unusable."""
    from .solver_config import load_config

    config = load_config(path)
    if config is None:
        return None
    try:
        return build_solver(config, usage)
    except ValueError:
        return None
