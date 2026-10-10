"""Offline test client; never constructs a provider or opens a network connection."""

from __future__ import annotations

import os
import threading

from .runtime.adapter import ConfirmedCancellation
from .runtime.config import ClientCapabilities

OFFLINE_CAPABILITIES = ClientCapabilities(
    evidence="controlled offline fake client",
    offline_simulation=True,
    cancellation_confirms_end=True,
)


class ScriptedClient:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []
        self.lock = threading.Lock()

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
        with self.lock:
            self.calls.append(
                {
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "thinking_mode": thinking_mode,
                    "stream": stream,
                }
            )
            try:
                response = next(self.responses)
            except StopIteration:
                raise ConfirmedCancellation("offline script exhausted")
        if cancellation.is_set():
            raise ConfirmedCancellation()
        if callable(response):
            response = response(cancellation)
        if isinstance(response, dict):
            return response
        return {
            "choices": [{"message": {"content": response}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }


def l3(result, status="COMPLETED", gap="NONE"):
    return f"STATUS: {status}\nRESULT: {result}\nGAP: {gap}"


class EmulatorWorkflowClient:
    """Answer-free workflow fixture for the supplied local judge, never a provider."""

    model = "OFFLINE_WORKFLOW_FIXTURE_NOT_S2"
    connect_seconds, read_seconds = 10, 60

    def chat(self, messages, **kwargs):
        if os.environ.get("ASTRA_EMULATOR_MODE") != "offline":
            raise ValueError("offline judge fixture requires explicit mode")
        if kwargs.get("max_tokens") != 8192 or kwargs.get("thinking_mode") is not False:
            raise ValueError("mock must exercise the actual target request settings")
        if kwargs["cancellation"].is_set():
            raise ConfirmedCancellation()
        goal = messages[1]["content"].split("ACTIVE_WORK_UNIT:\n", 1)[1]
        if "Deeply read and plan" in goal:
            text = l3(
                "CARD: offline workflow only, mathematical content unresolved; FIELDS: symbolic_algebra; ROUTE 1: direct local check; TASK: derive one mock intermediate"
            )
        elif "Only review" in goal:
            text = l3("COVERAGE: offline workflow fixture; NO_ISSUE")
        elif "ANSWER:" in goal:
            text = l3(
                "ANSWER: MOCK_WORKFLOW_ONLY; BASIS: offline protocol fixture, not a solution; GAPS: all mathematical obligations"
            )
        else:
            text = l3("Mock intermediate: no mathematical assertion verified")
        return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}


def create_emulator_client():
    if os.environ.get("ASTRA_EMULATOR_MODE") != "offline":
        raise ValueError("offline factory disabled outside explicit mock runs")
    return EmulatorWorkflowClient()
