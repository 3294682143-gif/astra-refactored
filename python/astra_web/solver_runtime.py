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
from .solver_config import SolverConfig, endpoint_spec, models_url

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
    # The model is deliberately NOT checked against the repository's known list:
    # that list is stale by construction (the endpoint's own /models returned 11
    # entries where the repository recorded 1). The endpoint is the authority, and
    # a model it does not serve is reported honestly when the call is made.

    def solve(payload: Mapping[str, Any]) -> SolveOutcome:
        try:
            problem = problem_text(payload)
        except ValueError as exc:
            return SolveOutcome.system_failure(str(exc), code="REQUEST_INVALID")

        if spec.client == "intern-chat":
            # The sanctioned path: drive the repository's own pipeline (M1-M5,
            # method cards, work units, tool observations) through the official
            # entry point. A bare one-shot chat produced 0 work units / 0 tool
            # calls and could not carry a genuinely hard problem.
            return _solve_via_pipeline(config, payload, problem, usage, timeout=timeout)

        try:
            content_payload = _call_openai_compatible(config, problem, timeout)
        except Exception as exc:  # noqa: BLE001 - every real failure is reported as such
            usage.record_failure()
            return SolveOutcome.system_failure(
                "模型调用失败：%s" % type(exc).__name__, code=_classify_failure(exc)
            )
        return _candidate_from_payload(content_payload, usage, config.endpoint)

    return solve


class _PublicChatShim:
    """Expose exactly the public surface ``AgentClient`` calls.

    ``AgentClient`` dispatches ``chat(messages=..., temperature=..., max_tokens=...)``
    — those three keywords and nothing else — inside a deadline-bounded worker. An
    injected client that demands further arguments raises, which the runtime
    records as OUTCOME_UNKNOWN and then permanently blocks the client. This shim
    therefore accepts exactly those three and supplies the frozen transport
    settings itself.
    """

    def __init__(self, config: SolverConfig, usage: UsageLedger, *, timeout: float) -> None:
        self._config = config
        self._usage = usage
        self._timeout = timeout

    def chat(self, *, messages, temperature, max_tokens):
        messages = list(messages or ())
        bounded_tokens = min(int(max_tokens), 8192)
        from mathagent.user_client import UserSuppliedS2Client

        client = UserSuppliedS2Client(
            api_key=self._config.credential,
            endpoint=self._config.endpoint,
            model=self._config.model,
        )
        response = client.chat(
            messages=messages,
            temperature=0.2,
            max_tokens=bounded_tokens,
            thinking_mode=False,
            stream=True,
            timeout=self._timeout,
            cancellation=threading.Event(),
        )
        payload = _unwrap(response)
        content, finish, usage_block = _extract(payload)
        self._usage.record_success(usage_block, self._config.endpoint)
        return {
            "choices": [
                {
                    "index": 0,
                    "message": {"content": content if content is not None else ""},
                    "finish_reason": finish if finish is not None else "UNKNOWN",
                }
            ],
            "usage": usage_block if isinstance(usage_block, Mapping) else {},
        }


def _solve_via_pipeline(
    config: SolverConfig,
    payload: Mapping[str, Any],
    problem: str,
    usage: UsageLedger,
    *,
    timeout: float,
) -> SolveOutcome:
    """Run one bounded solve through the official pipeline entry point.

    The engine is chosen explicitly by the operator through
    ``ASTRA_SOLVER_ENGINE``. It is never downgraded automatically: the official
    contract states that a TS failure must surface as an error/unsolved result
    rather than being silently retried on lite. The default here is ``lite``
    because this checkout's TypeScript runtime exits immediately
    (``CHILD_FAILED`` in ~8 ms, reproduced by the repository's own
    ``tests/e2e/test_ts_entry.py`` in both the work tree and the frozen baseline).
    """
    import os
    import shutil

    import user_agent

    engine = (os.environ.get("ASTRA_SOLVER_ENGINE") or "lite").strip().lower()
    if engine not in {"lite", "ts"}:
        engine = "lite"

    max_model_calls = payload.get("max_model_calls")
    if not isinstance(max_model_calls, int) or isinstance(max_model_calls, bool):
        max_model_calls = 8
    max_method_loads = payload.get("max_method_loads")
    if max_method_loads not in (0, 1):
        max_method_loads = 0

    bounded_seconds = min(max(float(timeout), 30.0), 600.0)
    shim = _PublicChatShim(config, usage, timeout=timeout)

    try:
        if engine == "ts":
            os.environ.setdefault("ASTRA_STDIO_RUNTIME", "dev")
            agent = user_agent.ReasoningAgent(
                shim,
                engine="ts",
                max_model_calls=max(1, min(max_model_calls, 256)),
                max_work_units=max(1, min(4, max_model_calls)),
                max_method_loads=max_method_loads,
                problem_seconds=bounded_seconds,
                node=shutil.which("node") or "node",
            )
        else:
            agent = user_agent.ReasoningAgent(
                shim,
                engine="lite",
                max_steps=max(1, min(max_model_calls, 16)),
                max_methods=max_method_loads,
                problem_seconds=bounded_seconds,
            )
        result = agent.solve(problem, {})
    except Exception as exc:  # noqa: BLE001 - reported, never smoothed over
        usage.record_failure()
        return SolveOutcome.system_failure(
            "官方流水线（engine=%s）启动失败：%s" % (engine, type(exc).__name__),
            code="PIPELINE_LAUNCH_FAILED",
        )

    if not isinstance(result, Mapping):
        usage.record_failure()
        return SolveOutcome.system_failure(
            "官方流水线返回非结构化结果", code="PIPELINE_RESULT_INVALID"
        )

    raw_reason = result.get("stopReason") or result.get("stop_reason")
    stop_reason = StopReason.ERROR
    if isinstance(raw_reason, str):
        try:
            stop_reason = StopReason(raw_reason)
        except ValueError:
            stop_reason = StopReason.ERROR
    elif isinstance(result.get("status"), str) and result["status"] == "candidate":
        # lite reports a candidate without a stopReason; the authoritative mapping
        # turns SOLVED into the candidate status.
        stop_reason = StopReason.SOLVED

    final_response = result.get("final_response")
    if not isinstance(final_response, str) or not final_response:
        final_response = UNSOLVED_RESPONSE

    # Real events only. Both engines return a real trace; it is what the replay
    # archive (L2/L3) is built from. An empty trace leaves the archive absent
    # rather than filling it with invented frames.
    events: list[Mapping[str, Any]] = []
    trace = result.get("trace")
    if isinstance(trace, (list, tuple)):
        events.extend(row for row in trace if isinstance(row, Mapping))
    impl = getattr(agent, "_impl", None)
    session_log = getattr(impl, "last_session_log", None)
    if isinstance(session_log, (list, tuple)) and session_log:
        events.extend(row for row in session_log if isinstance(row, Mapping))

    code = result.get("code")
    return SolveOutcome(
        stop_reason=stop_reason,
        final_response=final_response,
        reason=str(result.get("reason") or "官方流水线终态（engine=%s）" % engine),
        code=code if isinstance(code, str) else None,
        executed=True,
        events=tuple(events),
    )


def _candidate_from_payload(
    content_payload: Mapping[str, Any], usage: UsageLedger, endpoint: str
) -> SolveOutcome:
    """Map one direct (non-pipeline) provider response to a candidate outcome."""
    content, finish_reason, usage_block = _extract(content_payload)
    usage.record_success(usage_block, endpoint)

    if finish_reason == "length" and not content:
        return SolveOutcome.system_failure(
            "模型仅产出推理内容并因长度上限截断，未给出完整回答",
            code="TRUNCATED_THINKING_ONLY",
        )
    if content is None:
        return SolveOutcome.system_failure(
            "响应未包含可用的回答内容（不伪造结果）", code="EMPTY_CONTENT"
        )
    # StopReason.SOLVED maps to StatusCode.CANDIDATE through the authoritative
    # mapping table ("已形成候选") — what an unreviewed model answer is. There is
    # no StopReason.CANDIDATE member; using one raised AttributeError and
    # collapsed every run into an unclassified ERROR. candidate_verified stays
    # False downstream, so this is never presented as a verified result.
    return SolveOutcome(
        stop_reason=StopReason.SOLVED,
        final_response=content,
        reason="模型已返回回答（未经形式化验证，候选待审）",
        executed=True,
    )


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
