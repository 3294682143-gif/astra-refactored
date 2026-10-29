"""Only the HTTP transport is simulated for production-client tests.

The real ``mathagent.user_client.UserSuppliedS2Client`` (frozen settings,
streaming SSE decode, transport summary), the real ``PublicChatPort``, the real
``AgentClient``, the real Python Host, the real Node bundle and the real unified
math-asset executor all stay in place. Nothing but ``requests.post`` is faked, so
a signature or wiring mismatch between the production assembly and the formal
client contract can no longer hide behind a ``**kwargs`` test double.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Iterable


class FakeStreamingResponse:
    """Minimal ``requests`` response surface used by the S2 connector."""

    def __init__(
        self,
        chunks: Iterable[bytes] = (),
        *,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._chunks = list(chunks)
        self.status_code = status_code
        self.headers = dict(headers or {})
        self.closed = False

    def iter_content(self, chunk_size: int = 4096) -> Iterable[bytes]:
        for chunk in self._chunks:
            yield chunk

    def close(self) -> None:
        self.closed = True


def sse_body(content: str, *, finish_reason: str = "stop") -> list[bytes]:
    """Encode one assistant message as an OpenAI-style SSE stream."""
    delta = {
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": content},
                "finish_reason": None,
            }
        ]
    }
    terminal = {
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
    }
    lines = [
        f"data: {json.dumps(delta, ensure_ascii=False)}\n\n".encode("utf-8"),
        f"data: {json.dumps(terminal, ensure_ascii=False)}\n\n".encode("utf-8"),
        b"data: [DONE]\n\n",
    ]
    # Split the terminal line to exercise the streaming decoder's tail handling.
    body = b"".join(lines)
    return [body[:17], body[17:53], body[53:]]


class FakeProviderTransport:
    """Replacement for ``requests.post`` that answers from a scripted brain.

    ``brain.chat(messages=..., temperature=..., max_tokens=...)`` returns the
    OpenAI-shaped dict a real provider would return; the transport renders it as
    SSE bytes so the real connector still decodes a real stream.
    """

    def __init__(self, brain: Any, *, endpoint: str) -> None:
        self.brain = brain
        self.endpoint = endpoint
        self.requests: list[dict[str, Any]] = []
        self.responses: list[FakeStreamingResponse] = []
        self.fail_with: BaseException | None = None

    def __call__(self, url, *, headers=None, json=None, timeout=None, **_kwargs):  # noqa: A002
        self.requests.append(
            {
                "url": url,
                "headers": dict(headers or {}),
                "payload": dict(json or {}),
                "timeout": timeout,
            }
        )
        if self.fail_with is not None:
            raise self.fail_with
        payload = dict(json or {})
        answer = self.brain.chat(
            messages=payload.get("messages") or [],
            temperature=payload.get("temperature"),
            max_tokens=payload.get("max_tokens"),
        )
        choice = answer["choices"][0]
        chunks = sse_body(
            choice["message"]["content"],
            finish_reason=choice.get("finish_reason") or "stop",
        )
        response = FakeStreamingResponse(chunks)
        self.responses.append(response)
        return response


def install_fake_provider(monkeypatch, brain: Any, endpoint: str) -> FakeProviderTransport:
    """Route every production connector POST to ``brain`` for this test."""
    transport = FakeProviderTransport(brain, endpoint=endpoint)
    monkeypatch.setattr("mathagent.user_client.requests.post", transport)
    return transport


ENDPOINT = "https://chat.intern-ai.org.cn/api/v1/chat/completions"
MODEL = "Intern-S2-Preview-397B"
API_KEY = "sk-" + "test" * 8  # noqa: S105 - syntactically valid, never dispatched


def production_env() -> dict[str, str]:
    return {
        "ASTRA_S2_API_KEY": API_KEY,
        "ASTRA_S2_ENDPOINT": ENDPOINT,
        "ASTRA_S2_MODEL": MODEL,
    }


def configure_env(monkeypatch) -> None:
    for key, value in production_env().items():
        monkeypatch.setenv(key, value)


__all__: list[Callable[..., Any] | str] = [
    "FakeStreamingResponse",
    "FakeProviderTransport",
    "install_fake_provider",
    "sse_body",
    "configure_env",
    "production_env",
    "ENDPOINT",
    "MODEL",
    "API_KEY",
]
