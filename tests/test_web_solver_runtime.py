"""Verification of live Web solver_runtime wiring (Option 1).

Covers:
1. ``intern-s2-chat`` defaults to ``engine="ts"``, drives the full multi-stage
   TS pipeline via ``SolverAdapter`` + ``PublicChatPort`` + ``UserSuppliedS2Client``,
   streams real events, persists ``metrics``/``checkpoint``, and preserves
   ``candidate_verified=False``.
2. ``intern-inkstone`` (``openai-compatible``) likewise executes the full ``ts``
   pipeline instead of a single one-shot chat completion, while recording real
   usage counts into ``UsageLedger``.
3. Provider errors such as quota exhaustion (``-20080``) are surfaced honestly
   in ``summary["reason"]`` without inventing answers or exposing credentials.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "tests" / "e2e"))

from python.astra_web.queue import ExecutionManager  # noqa: E402
from python.astra_web.solver_config import SolverConfig  # noqa: E402
from python.astra_web.solver_runtime import UsageLedger, build_solver  # noqa: E402
from python.astra_web.storage import Store  # noqa: E402
from tests.e2e.test_ts_g3_r0 import R0Client  # noqa: E402
from tests.web_provider_helpers import (  # noqa: E402
    API_KEY,
    ENDPOINT,
    FakeStreamingResponse,
    install_fake_provider,
)


class _DummyUrlopenResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> "_DummyUrlopenResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


def _run_to_idle(manager: ExecutionManager, **kwargs: Any) -> dict[str, Any]:
    async def _go() -> dict[str, Any]:
        accepted = await manager.enqueue_run(request=dict(kwargs))
        assert await manager.wait_idle(30.0)
        return accepted

    return asyncio.run(_go())


def test_intern_chat_defaults_to_ts_pipeline_and_streams_metrics(tmp_path, monkeypatch):
    monkeypatch.delenv("ASTRA_SOLVER_ENGINE", raising=False)
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")

    brain = R0Client()
    transport = install_fake_provider(monkeypatch, brain, ENDPOINT)

    usage = UsageLedger()
    config = SolverConfig(
        endpoint=ENDPOINT,
        model="intern-s2",
        credential=API_KEY,
        source=tmp_path / "user_client.conf",
    )
    store = Store(tmp_path)
    manager = ExecutionManager(store, solver=build_solver(config, usage))

    accepted = _run_to_idle(
        manager,
        problem="Compute 2+2",
        max_model_calls=12,
        max_r0=1,
        max_consensus=1,
        max_effects=1,
        max_reviews=1,
        max_repairs=1,
    )
    run_id = accepted["run_id"]
    run = store.get_run(run_id)
    assert run is not None
    summary = run["summary"]

    assert run["status"] == "candidate"
    assert summary["engine"] == "ts"
    assert summary["stopReason"] == "REVIEWS_COMPLETE"
    assert summary["candidate_verified"] is False
    assert summary["executed"] is True
    assert isinstance(summary.get("metrics"), dict)
    assert summary.get("checkpoint") is not None

    details_path = tmp_path / "runs" / run_id / "details.json"
    assert details_path.is_file()
    details = json.loads(details_path.read_text(encoding="utf-8"))
    events = list(details.get("events") or [])
    assert len(events) > 1
    assert any(ev.get("kind") == "RESULT" for ev in events)
    assert any("r0" in str(ev.get("kind") or "").lower() or "r0" in json.dumps(ev).lower() for ev in events)
    assert len(transport.requests) >= 1
    assert brain.r0_seen >= 1

    snap = usage.snapshot()
    assert snap["calls"] >= 1
    assert snap["failures"] == 0


def test_intern_inkstone_runs_full_ts_pipeline_and_records_usage(tmp_path, monkeypatch):
    monkeypatch.delenv("ASTRA_SOLVER_ENGINE", raising=False)
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")

    inkstone_url = "https://discovery-api.intern-ai.org.cn/v1/chat/completions"
    brain = R0Client()
    seen_urls: list[str] = []

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        seen_urls.append(req.full_url)
        body = json.loads(req.data.decode("utf-8"))
        reply = brain.chat(
            messages=body.get("messages") or [],
            temperature=body.get("temperature", 0.2),
            max_tokens=body.get("max_tokens", 8192),
        )
        reply = dict(reply)
        reply["usage"] = {
            "prompt_tokens": 11,
            "completion_tokens": 7,
            "total_tokens": 18,
        }
        return _DummyUrlopenResponse(reply)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    usage = UsageLedger()
    config = SolverConfig(
        endpoint=inkstone_url,
        model="intern-s2",
        credential=API_KEY,
        source=tmp_path / "user_client.conf",
    )
    store = Store(tmp_path)
    manager = ExecutionManager(store, solver=build_solver(config, usage))

    accepted = _run_to_idle(
        manager,
        problem="Compute 2+2",
        max_model_calls=12,
        max_r0=1,
        max_consensus=1,
        max_effects=1,
        problem_seconds=3600,
    )
    run_id = accepted["run_id"]
    run = store.get_run(run_id)
    assert run is not None
    summary = run["summary"]

    assert run["status"] == "candidate"
    assert summary["engine"] == "ts"
    assert summary["stopReason"] == "REVIEWS_COMPLETE"
    assert summary["candidate_verified"] is False
    assert seen_urls and all(url == inkstone_url for url in seen_urls)
    assert brain.r0_seen >= 1

    snap = usage.snapshot()
    assert snap["calls"] >= 1
    assert snap["prompt_tokens"] >= 11
    assert snap["completion_tokens"] >= 7
    assert snap["total_tokens"] >= 18


def test_quota_error_is_surfaced_without_leaking_credential(tmp_path, monkeypatch):
    monkeypatch.delenv("ASTRA_SOLVER_ENGINE", raising=False)
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")

    sse_err = (
        'data: {"error":{"code":"-20080","type":"error","message":"您已超过输入 tokens 配额"}}\n\n'
        "data: [DONE]\n\n"
    ).encode("utf-8")

    def fake_post(url, *, headers=None, json=None, timeout=None, **_kwargs):  # noqa: A002, ARG001
        return FakeStreamingResponse([sse_err])

    monkeypatch.setattr("mathagent.user_client.requests.post", fake_post)

    secret = "sk-supersecretvalue1234567890"  # noqa: S105
    usage = UsageLedger()
    config = SolverConfig(
        endpoint=ENDPOINT,
        model="intern-s2",
        credential=secret,
        source=tmp_path / "user_client.conf",
    )
    store = Store(tmp_path)
    manager = ExecutionManager(store, solver=build_solver(config, usage))

    accepted = _run_to_idle(
        manager,
        problem="Compute 2+2",
        max_model_calls=4,
    )
    run_id = accepted["run_id"]
    run = store.get_run(run_id)
    assert run is not None
    summary = run["summary"]

    assert run["status"] == "unsolved"
    assert summary["final_response"] == "Unsolved."
    assert summary["candidate_verified"] is False
    assert "-20080" in summary["reason"]
    assert "您已超过输入 tokens 配额" in summary["reason"]
    assert secret not in summary["reason"]

    details_path = tmp_path / "runs" / run_id / "details.json"
    if details_path.is_file():
        assert secret not in details_path.read_text(encoding="utf-8")
    assert usage.snapshot()["failures"] >= 1


def test_build_solver_executes_unified_math_asset_tool(tmp_path, monkeypatch):
    from tests.web_math_helpers import MathAssetScriptedClient

    monkeypatch.delenv("ASTRA_SOLVER_ENGINE", raising=False)
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")

    brain = MathAssetScriptedClient("math.linear-algebra", "gf2_rank", {"rows": [1, 2]})
    install_fake_provider(monkeypatch, brain, ENDPOINT)

    usage = UsageLedger()
    config = SolverConfig(
        endpoint=ENDPOINT,
        model="intern-s2",
        credential=API_KEY,
        source=tmp_path / "user_client.conf",
    )
    store = Store(tmp_path)
    manager = ExecutionManager(store, solver=build_solver(config, usage))

    accepted = _run_to_idle(
        manager,
        problem="求 GF(2) 上矩阵的秩",
        max_model_calls=12,
        max_effects=1,
        max_reviews=1,
        max_repairs=1,
        max_consensus=1,
        max_r0=1,
    )
    run_id = accepted["run_id"]
    run = store.get_run(run_id)
    assert run is not None
    summary = run["summary"]

    assert run["status"] == "candidate"
    assert summary["engine"] == "ts"
    assert summary["candidate_verified"] is False
    assert "gf2_rank" in summary["metrics"]["tool_names"]
    kinds = [ev["kind"] for ev in manager.get_history_events(run_id)]
    assert "effect_returned" in kinds


def test_diagnostic_tracker_formats_safe_transport_fields():
    from python.astra_web.solver_runtime import _DiagnosticTracker

    tracker = _DiagnosticTracker()
    exc = RuntimeError("masked message")
    exc.error_type = "RuntimeError"  # type: ignore[attr-defined]
    exc.summary = {  # type: ignore[attr-defined]
        "failure_code": "transport_failure_unconfirmed",
        "stage": "public_content_decode",
        "exception_types": ["ChunkedEncodingError", "ProtocolError"],
        "response_bytes": 1024,
        "read_timeout_seconds": 180,
    }
    tracker.record_exception(exc)
    snap = tracker.snapshot()
    assert snap is not None
    assert snap["failure_code"] == "transport_failure_unconfirmed"
    assert snap["stage"] == "public_content_decode"
    assert snap["exception_types"] == "ChunkedEncodingError,ProtocolError"
    assert snap["response_bytes"] == 1024
    assert snap["read_timeout_seconds"] == 180
    text = tracker.format_summary()
    assert "RuntimeError" in text
    assert "transport_failure_unconfirmed" in text
    assert "stage=public_content_decode" in text
    assert "ChunkedEncodingError,ProtocolError" in text


def test_tracked_connector_recovers_after_rate_limit_and_enables_adaptive_pacing(
    tmp_path, monkeypatch
):
    import threading
    from mathagent.runtime.adapter import RateLimited
    from python.astra_web.solver_config import endpoint_spec
    from python.astra_web.solver_runtime import (
        UsageLedger,
        _DiagnosticTracker,
        _TrackedEndpointConnector,
    )

    spec = endpoint_spec("https://chat.intern-ai.org.cn/api/v1/chat/completions")
    assert spec is not None
    config = SolverConfig(
        endpoint="https://chat.intern-ai.org.cn/api/v1/chat/completions",
        model="intern-s2",
        credential=API_KEY,
        source=tmp_path / "user_client.conf",
    )
    usage = UsageLedger()
    tracker = _DiagnosticTracker()
    connector = _TrackedEndpointConnector(config, spec, usage, tracker)

    attempts = {"count": 0}

    def fake_chat(self, **kwargs):  # noqa: ARG001
        attempts["count"] += 1
        if attempts["count"] <= 2:
            raise RateLimited(0.01)
        return {
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        }

    monkeypatch.setattr("mathagent.user_client.UserSuppliedS2Client.chat", fake_chat)

    payload = connector.chat(
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.2,
        max_tokens=64,
        thinking_mode=False,
        stream=True,
        timeout=300.0,
        cancellation=threading.Event(),
    )
    assert attempts["count"] == 3
    assert payload["choices"][0]["finish_reason"] == "stop"
    assert tracker.snapshot() is None
    snap = usage.snapshot()
    assert snap["calls"] == 1
    assert snap["failures"] == 0
    assert connector._min_gap_seconds > 0.0


def test_tracked_connector_records_rate_limit_when_retries_exhausted(
    tmp_path, monkeypatch
):
    import threading
    from mathagent.runtime.adapter import RateLimited
    from python.astra_web.solver_config import endpoint_spec
    from python.astra_web.solver_runtime import (
        UsageLedger,
        _DiagnosticTracker,
        _TrackedEndpointConnector,
    )

    spec = endpoint_spec("https://chat.intern-ai.org.cn/api/v1/chat/completions")
    assert spec is not None
    config = SolverConfig(
        endpoint="https://chat.intern-ai.org.cn/api/v1/chat/completions",
        model="intern-s2",
        credential=API_KEY,
        source=tmp_path / "user_client.conf",
    )
    usage = UsageLedger()
    tracker = _DiagnosticTracker()
    connector = _TrackedEndpointConnector(config, spec, usage, tracker)

    attempts = {"count": 0}

    def always_limited(self, **kwargs):  # noqa: ARG001
        attempts["count"] += 1
        raise RateLimited(0.01)

    monkeypatch.setattr("mathagent.user_client.UserSuppliedS2Client.chat", always_limited)

    with pytest.raises(RateLimited):
        connector.chat(
            messages=[{"role": "user", "content": "hi"}],
            temperature=0.2,
            max_tokens=64,
            thinking_mode=False,
            stream=True,
            timeout=300.0,
            cancellation=threading.Event(),
        )
    assert attempts["count"] == 4
    snap = usage.snapshot()
    assert snap["failures"] == 1
    diag = tracker.snapshot()
    assert diag is not None
    assert diag["code"] == "PROVIDER_RATE_LIMITED"

