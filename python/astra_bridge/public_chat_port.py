"""Bind an explicit provider connector to the formal public chat contract.

``AgentClient.generate`` owns the root budget and dispatches exactly one bounded
call per Host request, always as::

    client.chat(messages=..., temperature=0.2, max_tokens=8192)

The explicit user-supplied S2 connector
(``mathagent.user_client.UserSuppliedS2Client``) instead requires the frozen S2
settings plus a bounded transport timeout and a cancellation event, because it
is the piece that actually talks to the remote provider. Wiring that connector
straight into ``AgentClient`` raises ``TypeError`` on the very first dispatch;
the Host then (correctly) records an unknown outcome and blocks the client for
the rest of the process, so no configuration change could ever make it work.

``PublicChatPort`` is that missing adapter, and it stays deliberately thin:

* it never retries, never reorders, never invents text and never touches maths;
* it forwards only the three contract keywords it receives, and supplies the
  frozen S2 transport settings on the caller's behalf;
* the transport timeout is the *remaining* run budget anchored when the port is
  created for one run, so a single generation cannot outlive the site budget;
* a run that has no remaining budget raises ``RequestNotDispatched`` before any
  byte is sent, which is the only honest "no request happened" signal.
"""
from __future__ import annotations

import math
import threading
import time
from typing import Any

from mathagent.runtime.adapter import RequestNotDispatched

FROZEN_TEMPERATURE = 0.2
FROZEN_MAX_TOKENS = 8192
FROZEN_THINKING_MODE = False
FROZEN_STREAM = True
MAX_REQUEST_SECONDS = 1200.0
_MIN_REQUEST_SECONDS = 0.05


def _bounded_seconds(value: Any, *, name: str) -> float:
    if type(value) not in {int, float} or not math.isfinite(float(value)):
        raise ValueError(f"{name} must be a finite number")
    seconds = float(value)
    if not 0 < seconds <= MAX_REQUEST_SECONDS:
        raise ValueError(f"{name} must be within (0, {MAX_REQUEST_SECONDS}]")
    return seconds


class PublicChatPort:
    """Adapt one explicit provider connector to the formal ``chat`` contract."""

    def __init__(
        self,
        client: Any,
        *,
        request_seconds: float = 600.0,
        clock: Any = None,
    ) -> None:
        chat = getattr(client, "chat", None)
        if not callable(chat):
            raise TypeError("public chat port requires a callable client.chat")
        self._chat = chat
        self.request_seconds = _bounded_seconds(request_seconds, name="request_seconds")
        self._clock = clock if callable(clock) else time.monotonic
        self._anchor = self._clock()
        self.calls = 0
        self.last_timeout_seconds: float | None = None

    # -- budget ----------------------------------------------------------
    def remaining_seconds(self) -> float:
        """Remaining share of the run budget owned by this port."""
        return self.request_seconds - max(0.0, self._clock() - self._anchor)

    def may_dispatch(self) -> bool:
        """Pre-dispatch admission for the formal layer; no side effects.

        ``AgentClient`` calls this *before* it records a dispatch, so a budget
        that is already gone is reported as "nothing was sent" instead of being
        mistaken for an unknown remote outcome. Budget accounting stays with the
        caller: this port never refunds or discounts a logical call.
        """
        return self.remaining_seconds() >= _MIN_REQUEST_SECONDS

    # -- formal contract -------------------------------------------------
    def chat(self, *, messages, temperature, max_tokens):
        """One bounded generation for ``AgentClient``; never retried here."""
        if temperature != FROZEN_TEMPERATURE:
            raise ValueError("the formal contract fixes temperature at 0.2")
        if type(max_tokens) is not int or not 1 <= max_tokens <= FROZEN_MAX_TOKENS:
            raise ValueError("the formal contract fixes 1..8192 max_tokens")
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list")
        timeout = self.remaining_seconds()
        if timeout < _MIN_REQUEST_SECONDS:
            # Provably nothing was sent: the caller must record "not dispatched"
            # rather than an unknown remote outcome (and owns any budget policy).
            raise RequestNotDispatched()
        cancellation = threading.Event()
        self.calls += 1
        self.last_timeout_seconds = timeout
        return self._chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking_mode=FROZEN_THINKING_MODE,
            stream=FROZEN_STREAM,
            timeout=timeout,
            cancellation=cancellation,
        )


__all__ = [
    "PublicChatPort",
    "FROZEN_TEMPERATURE",
    "FROZEN_MAX_TOKENS",
    "FROZEN_THINKING_MODE",
    "FROZEN_STREAM",
    "MAX_REQUEST_SECONDS",
]
