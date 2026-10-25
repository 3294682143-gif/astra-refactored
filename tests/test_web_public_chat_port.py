"""The production client assembly must satisfy the formal ``chat`` contract.

Regression cover for the reviewed P0 defect: ``build_solver_from_env`` used to
hand the raw user-supplied S2 connector to ``AgentClient``, whose only call form
is ``chat(messages=..., temperature=..., max_tokens=...)``. The connector also
requires ``thinking_mode``/``stream``/``timeout``/``cancellation``, so the very
first dispatch raised ``TypeError``, the Host recorded an unknown outcome and
then blocked the client for the rest of the process — with real credentials and
a reachable endpoint.

Only ``requests.post`` is faked here; the connector, the port, ``AgentClient``,
the Python Host, the Node bundle and the unified math executor are real.
"""
from __future__ import annotations

import pytest

from mathagent.user_client import UserSuppliedS2Client
from python.astra_bridge.public_chat_port import PublicChatPort
from python.astra_web.config import default_budget
from python.astra_web.solver_adapter import SolverAdapter, build_solver_from_env
from tests.web_math_helpers import MathAssetScriptedClient
from tests.web_provider_helpers import (
    API_KEY,
    ENDPOINT,
    MODEL,
    configure_env,
    install_fake_provider,
)

ASSET_ID = "math.linear-algebra"
TARGET = "gf2_rank"
INPUT = {"rows": [1, 2]}


def _connector() -> UserSuppliedS2Client:
    return UserSuppliedS2Client(api_key=API_KEY, endpoint=ENDPOINT, model=MODEL)


def _problem() -> str:
    return "求 GF(2) 上由 rows 表示的矩阵的秩"


def test_raw_connector_rejects_the_formal_three_keyword_call():
    """The mismatch is real, so the port is required rather than cosmetic."""
    with pytest.raises(TypeError):
        _connector().chat(
            messages=[{"role": "user", "content": "hi"}],
            temperature=0.2,
            max_tokens=64,
        )


def test_port_dispatches_one_real_streamed_generation(monkeypatch):
    brain = MathAssetScriptedClient(ASSET_ID, TARGET, INPUT)
    transport = install_fake_provider(monkeypatch, brain, ENDPOINT)
    port = PublicChatPort(_connector(), request_seconds=120.0)

    response = port.chat(
        messages=[
            {"role": "system", "content": "host"},
            {"role": "user", "content": '{"schemaVersion": "R1", "stage": "R1"}'},
        ],
        temperature=0.2,
        max_tokens=8192,
    )

    assert port.calls == 1
    # The connector decoded a real SSE stream into the OpenAI-shaped result.
    assert response["choices"][0]["finish_reason"] == "stop"
    assert response["usage"]["total_tokens"] == 18
    assert response.transport["stage"] == "terminal_response"
    # The frozen S2 settings the connector requires were supplied by the port,
    # not by the formal caller.
    payload = transport.requests[0]["payload"]
    assert payload["thinking_mode"] is False
    assert payload["stream"] is True
    assert payload["temperature"] == 0.2
    assert payload["max_tokens"] == 8192
    assert payload["model"] == MODEL
    assert transport.requests[0]["headers"]["Authorization"] == "Bearer " + API_KEY
    assert 0 < port.last_timeout_seconds <= 120.0


def test_port_refuses_to_dispatch_without_remaining_budget(monkeypatch):
    # A fake transport is installed so this test can never reach the network.
    install_fake_provider(
        monkeypatch, MathAssetScriptedClient(ASSET_ID, TARGET, INPUT), ENDPOINT
    )
    now = {"t": 0.0}
    port = PublicChatPort(
        _connector(), request_seconds=0.5, clock=lambda: now["t"]
    )
    now["t"] = 1.0  # the run budget is already gone
    with pytest.raises(Exception) as excinfo:
        port.chat(
            messages=[{"role": "user", "content": "hi"}],
            temperature=0.2,
            max_tokens=64,
        )
    assert type(excinfo.value).__name__ == "RequestNotDispatched"
    assert port.calls == 0


def test_port_rejects_a_loosened_formal_contract():
    port = PublicChatPort(_connector(), request_seconds=60.0)
    with pytest.raises(ValueError):
        port.chat(messages=[{"role": "user", "content": "x"}], temperature=0.7, max_tokens=64)
    with pytest.raises(ValueError):
        port.chat(messages=[], temperature=0.2, max_tokens=64)
    with pytest.raises(ValueError):
        PublicChatPort(_connector(), request_seconds=0)


def test_production_assembly_runs_a_whole_solve_over_the_real_connector(monkeypatch):
    """End-to-end: env config -> real connector -> port -> Host -> Node -> asset."""
    configure_env(monkeypatch)
    brain = MathAssetScriptedClient(ASSET_ID, TARGET, INPUT)
    transport = install_fake_provider(monkeypatch, brain, ENDPOINT)

    solver = build_solver_from_env()
    assert solver is not None, "production credentials are configured in this test"
    assert solver._factory_takes_budget is True

    result = solver(
        {
            "run_id": "run-production-port-1",
            "problem": _problem(),
            "engine": "ts",
            "metadata": {},
            **default_budget(),
        }
    )

    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    metrics = result["metrics"]
    # Every dispatched Host call reached the provider exactly once; no call was
    # lost to a signature error and none ended in an unknown remote outcome.
    assert metrics["client_method_calls"] == len(transport.requests)
    assert metrics["client_method_calls"] >= 1
    assert metrics["remote_outcome_unknown"] is False
    assert metrics["unknown_usage_requests"] == 0
    assert metrics["tool_effect_calls"] == 1
    assert TARGET in metrics["tool_names"]
    assert brain.observation_seen is True
    # The frozen settings were supplied by the port on every single generation.
    assert all(row["payload"]["stream"] is True for row in transport.requests)
    assert all(row["payload"]["thinking_mode"] is False for row in transport.requests)
    assert all(row["timeout"][0] <= row["timeout"][1] for row in transport.requests)
    assert all(response.closed is True for response in transport.responses)


def test_budget_mapping_reaches_the_transport_deadline(monkeypatch):
    """``problem_seconds`` is the transport bound, not an unused DTO field."""
    configure_env(monkeypatch)
    installed: list[float] = []

    def _factory(budgets):
        port = SolverAdapter.__mro__  # noqa: F841 - keeps the import honest
        installed.append(float(budgets["problem_seconds"]))
        return PublicChatPort(_connector(), request_seconds=budgets["problem_seconds"])

    solver = SolverAdapter(client_factory=_factory)
    assert solver._factory_takes_budget is True
    client = solver._build_client({"problem_seconds": 42})
    assert isinstance(client, PublicChatPort)
    assert client.request_seconds == 42.0
    assert installed == [42.0]
