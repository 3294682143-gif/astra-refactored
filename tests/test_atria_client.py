"""Offline unit tests for mathagent.atria_client (no network access)."""
from __future__ import annotations

import json
import threading
from typing import Any, Dict, List

import pytest

from mathagent import atria_client
from mathagent.atria_client import (
    AtriaDawnClient,
    InkstoneDesktopBridgeClient,
    _extract_protocol_usage,
    _extract_usage,
    _normalize_finish_reason,
    _should_enable_reasoning_in_hybrid_mode,
    _validate_two_text_messages,
    sanitize_snippet,
)

TWO_MESSAGES = [
    {"role": "system", "content": "sys"},
    {"role": "user", "content": "hello"},
]


def _make_client(**overrides: Any) -> AtriaDawnClient:
    kwargs: Dict[str, Any] = {"api_key": "sk-test-key"}
    kwargs.update(overrides)
    return AtriaDawnClient(**kwargs)


class _FakeResponse:
    def __init__(self, lines: List[str], status_code: int = 200, headers: Dict[str, str] | None = None, text: str = ""):
        self._lines = lines
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text
        self.closed = False

    def iter_lines(self, decode_unicode: bool = True):
        return iter(self._lines)

    def close(self) -> None:
        self.closed = True


def _openai_sse(text: str, finish: str = "stop", usage: Dict[str, int] | None = None) -> List[str]:
    frames = [f"data: {json.dumps({'choices': [{'index': 0, 'delta': {'content': ch}}]})}" for ch in text]
    if usage:
        frames.append(f"data: {json.dumps({'choices': [], 'usage': usage})}")
    frames.append(f"data: {json.dumps({'choices': [{'index': 0, 'finish_reason': finish, 'delta': {}}]})}")
    frames.append("data: [DONE]")
    return frames


def _gateway_sse() -> List[str]:
    events = [
        {"type": "message_start", "response_id": "r1", "model": "Atria-Dawn"},
        {"type": "thinking_delta", "text": "思考"},
        {"type": "content_delta", "text": "答"},
        {"type": "content_delta", "text": "案"},
        {"type": "usage", "usage": {"input_tokens": 7, "output_tokens": 2, "cache_read_tokens": 0, "cache_write_tokens": 0}},
        {"type": "message_end", "stop_reason": "end_turn"},
    ]
    return [f"data: {json.dumps(e, ensure_ascii=False)}" for e in events] + ["data: [DONE]"]


def _chat_kwargs(**overrides: Any) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {
        "messages": TWO_MESSAGES,
        "temperature": 0.2,
        "max_tokens": 8192,
        "thinking_mode": False,
        "stream": True,
        "timeout": 30.0,
        "cancellation": threading.Event(),
    }
    kwargs.update(overrides)
    return kwargs


class TestConstruction:
    def test_rejects_empty_key(self) -> None:
        with pytest.raises(ValueError):
            AtriaDawnClient(api_key="  ")

    def test_rejects_unknown_host(self) -> None:
        with pytest.raises(ValueError):
            _make_client(endpoint="https://evil.example.com/v1/chat/completions")

    def test_rejects_unknown_model(self) -> None:
        with pytest.raises(ValueError):
            _make_client(model="GPT-7")

    def test_rejects_bad_path(self) -> None:
        with pytest.raises(ValueError):
            _make_client(endpoint="https://discovery-api.intern-ai.org.cn/v1/other")

    def test_defaults(self) -> None:
        client = _make_client()
        assert client.model == "Atria-Dawn"
        assert client.reasoning_mode == "off"
        assert client.wire_max_tokens == 8192

    def test_reasoning_mode_expands_wire_tokens(self) -> None:
        assert _make_client(reasoning_mode="hybrid").wire_max_tokens == 24576
        assert _make_client(reasoning_mode="auto_expand").wire_max_tokens == 24576

    def test_rejects_bad_reasoning_mode(self) -> None:
        with pytest.raises(ValueError):
            _make_client(reasoning_mode="always")


class TestContractValidation:
    def test_frozen_contract_enforced(self) -> None:
        client = _make_client()
        with pytest.raises(ValueError):
            client.chat(**_chat_kwargs(max_tokens=8193))
        with pytest.raises(ValueError):
            client.chat(**_chat_kwargs(temperature=0.7))
        with pytest.raises(ValueError):
            client.chat(**_chat_kwargs(thinking_mode=True))
        with pytest.raises(ValueError):
            client.chat(**_chat_kwargs(stream=False))
        with pytest.raises(ValueError):
            client.chat(**_chat_kwargs(timeout=0))

    def test_exactly_two_text_messages(self) -> None:
        with pytest.raises(ValueError):
            _validate_two_text_messages([{"role": "user", "content": "x"}])
        with pytest.raises(ValueError):
            _validate_two_text_messages(
                [{"role": "user", "content": "x"}, {"role": "user", "content": ["not-text"]}]
            )
        out = _validate_two_text_messages(TWO_MESSAGES)
        assert out[1]["content"] == "hello"


class TestHybridReasoning:
    def test_ballot_turns_disable_reasoning(self) -> None:
        msgs = [
            {"role": "system", "content": "run the ballot audit"},
            {"role": "user", "content": "vote now"},
        ]
        assert _should_enable_reasoning_in_hybrid_mode(msgs) is False

    def test_solve_turns_enable_reasoning(self) -> None:
        msgs = [
            {"role": "system", "content": "solve the equation"},
            {"role": "user", "content": "find all roots"},
        ]
        assert _should_enable_reasoning_in_hybrid_mode(msgs) is True


class TestHelpers:
    def test_sanitize_snippet_truncates(self) -> None:
        assert sanitize_snippet("a" * 200, max_len=10) == "aaaaaaaaaa..."
        assert sanitize_snippet("  x  y  ") == "x y"

    def test_extract_usage_openai_shape(self) -> None:
        usage = _extract_usage({"prompt_tokens": 3, "completion_tokens": 5})
        assert usage == {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}

    def test_extract_usage_gateway_shape(self) -> None:
        usage = _extract_usage({"input_tokens": 4, "output_tokens": 6, "cache_read_tokens": 1})
        assert usage == {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10}

    def test_extract_usage_never_fakes_zero(self) -> None:
        assert _extract_usage({}) is None
        assert _extract_usage(None) is None

    def test_protocol_usage_four_fields(self) -> None:
        pu = _extract_protocol_usage({"input_tokens": 1, "output_tokens": 2})
        assert pu == {
            "input_tokens": 1,
            "output_tokens": 2,
            "cache_read_tokens": None,
            "cache_write_tokens": None,
        }

    def test_stop_reason_mapping(self) -> None:
        assert _normalize_finish_reason("end_turn") == "end_turn"
        assert _normalize_finish_reason("max_tokens") == "length"
        assert _normalize_finish_reason("tool_use") == "stop"
        assert _normalize_finish_reason(None) is None


class TestChatStream:
    def test_openai_stream_consumed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: Dict[str, Any] = {}

        def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
            captured["url"] = url
            captured["body"] = kwargs["json"]
            return _FakeResponse(_openai_sse("你好", usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}))

        monkeypatch.setattr(atria_client.requests, "post", fake_post)
        result = _make_client().chat(**_chat_kwargs())
        assert result["choices"][0]["message"]["content"] == "你好"
        assert result["choices"][0]["finish_reason"] == "stop"
        assert result["usage"]["total_tokens"] == 2
        # reasoning off mode must explicitly disable wire reasoning
        assert captured["body"]["reasoning"] is False
        assert captured["body"]["max_tokens"] == 8192

    def test_gateway_stream_consumed_with_text_field(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            atria_client.requests, "post", lambda *a, **k: _FakeResponse(_gateway_sse())
        )
        result = _make_client().chat(**_chat_kwargs())
        assert result["choices"][0]["message"]["content"] == "答案"
        assert result["choices"][0]["finish_reason"] == "end_turn"
        assert result["usage"] == {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}

    def test_hybrid_ballot_keeps_wire_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: Dict[str, Any] = {}

        def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
            captured["body"] = kwargs["json"]
            return _FakeResponse(_openai_sse("ok"))

        monkeypatch.setattr(atria_client.requests, "post", fake_post)
        ballot_msgs = [
            {"role": "system", "content": "ballot round"},
            {"role": "user", "content": "vote"},
        ]
        _make_client(reasoning_mode="hybrid").chat(**_chat_kwargs(messages=ballot_msgs))
        assert captured["body"]["max_tokens"] == 8192
        assert captured["body"]["reasoning"] is False

    def test_hybrid_solve_expands_wire_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: Dict[str, Any] = {}

        def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
            captured["body"] = kwargs["json"]
            return _FakeResponse(_openai_sse("ok"))

        monkeypatch.setattr(atria_client.requests, "post", fake_post)
        _make_client(reasoning_mode="hybrid").chat(**_chat_kwargs())
        assert captured["body"]["max_tokens"] == 24576
        assert "reasoning" not in captured["body"]

    def test_429_retry_then_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
            calls["n"] += 1
            if calls["n"] == 1:
                return _FakeResponse([], status_code=429, headers={"Retry-After": "0.01"}, text="slow down")
            return _FakeResponse(_openai_sse("ok"))

        monkeypatch.setattr(atria_client.requests, "post", fake_post)
        result = _make_client().chat(**_chat_kwargs(timeout=60.0))
        assert calls["n"] == 2
        assert result["choices"][0]["message"]["content"] == "ok"

    def test_http_error_raises_sanitized(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            atria_client.requests,
            "post",
            lambda *a, **k: _FakeResponse([], status_code=500, text="boom " * 100),
        )
        with pytest.raises(RuntimeError, match="Atria HTTP 500"):
            _make_client().chat(**_chat_kwargs())

    def test_cancelled_before_dispatch(self) -> None:
        ev = threading.Event()
        ev.set()
        with pytest.raises(RuntimeError, match="cancelled"):
            _make_client().chat(**_chat_kwargs(cancellation=ev))


class TestBridgeClient:
    def test_missing_repo_rejected(self, tmp_path) -> None:
        with pytest.raises(FileNotFoundError):
            InkstoneDesktopBridgeClient(inkstone_repo_root=tmp_path / "nope")

    def test_missing_runner_rejected(self, tmp_path) -> None:
        (tmp_path / "src" / "desktop").mkdir(parents=True)
        with pytest.raises(FileNotFoundError):
            InkstoneDesktopBridgeClient(inkstone_repo_root=tmp_path)
