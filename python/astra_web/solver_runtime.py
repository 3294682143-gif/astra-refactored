"""Turn a stored host-side configuration into a real solver callable.

Two sanctioned endpoints are supported:

* ``intern-s2-chat`` — routed through the repository's official pinned client
  (``mathagent.user_client.UserSuppliedS2Client``), unchanged.
* ``intern-inkstone`` — the discovery endpoint, which is OpenAI-compatible and is
  called directly with a single non-streaming request.

Honesty rules applied here:

* No fabricated events are ever produced. The adapter returns only the real
  terminal facts it observed.
* ``usage`` is recorded only when the provider actually returned it; an absent or
  malformed block stays ``UNKNOWN`` and is **never** counted as ``0``.
* Failures are mapped to explicit outcomes (rate limit / provider rejection /
  transport failure) instead of being smoothed over.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .queue import SolveOutcome, StopReason, UNSOLVED_RESPONSE, CODE_SOLVER_FAILED
from .solver_config import SolverConfig, endpoint_spec

DEFAULT_TIMEOUT_SECONDS = 60.0
DEFAULT_MAX_TOKENS = 2048


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


def _call_official(config: SolverConfig, problem: str, timeout: float) -> Mapping[str, Any]:
    from mathagent.user_client import UserSuppliedS2Client

    client = UserSuppliedS2Client(
        api_key=config.credential, endpoint=config.endpoint, model=config.model
    )
    response = client.chat(
        messages=[{"role": "user", "content": problem}],
        temperature=0.2,
        max_tokens=DEFAULT_MAX_TOKENS,
        thinking_mode=False,
        stream=True,
        timeout=timeout,
        cancellation=threading.Event(),
    )
    return _unwrap(response)


def _call_openai_compatible(config: SolverConfig, problem: str, timeout: float) -> Mapping[str, Any]:
    body = json.dumps(
        {
            "model": config.model,
            "messages": [{"role": "user", "content": problem}],
            "temperature": 0.2,
            "max_tokens": DEFAULT_MAX_TOKENS,
            "stream": False,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        config.endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + config.credential,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw.decode("utf-8"))


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


def build_solver(
    config: SolverConfig, usage: UsageLedger, *, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> Callable[[Mapping[str, Any]], SolveOutcome]:
    """Build the solver callable for a validated configuration."""
    spec = endpoint_spec(config.endpoint)
    if spec is None:
        raise ValueError("endpoint is not one of the sanctioned endpoints")
    if config.model not in spec.models:
        raise ValueError("model is not served by the selected endpoint")

    def solve(payload: Mapping[str, Any]) -> SolveOutcome:
        try:
            problem = problem_text(payload)
        except ValueError as exc:
            return SolveOutcome.system_failure(str(exc), code="REQUEST_INVALID")

        try:
            if spec.client == "intern-chat":
                content_payload = _call_official(config, problem, timeout)
            else:
                content_payload = _call_openai_compatible(config, problem, timeout)
        except Exception as exc:  # noqa: BLE001 - every real failure is reported as such
            usage.record_failure()
            return SolveOutcome.system_failure(
                "模型调用失败：%s" % type(exc).__name__, code=_classify_failure(exc)
            )

        content, finish_reason, usage_block = _extract(content_payload)
        usage.record_success(usage_block, config.endpoint)

        if finish_reason == "length" and not content:
            return SolveOutcome.system_failure(
                "模型仅产出推理内容并因长度上限截断，未给出完整回答",
                code="TRUNCATED_THINKING_ONLY",
            )
        if content is None:
            return SolveOutcome.system_failure(
                "响应未包含可用的回答内容（不伪造结果）", code="EMPTY_CONTENT"
            )
        return SolveOutcome(
            stop_reason=StopReason.CANDIDATE,
            final_response=content,
            reason="模型已返回回答（未经形式化验证）",
            executed=True,
        )

    return solve


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
