"""Forced method/tool turns are protocol gates, not one-shot advice."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from python.astra_bridge.p2_methods import fixture_catalog  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

ALEXANDER_MATRIX = [
    ["-t**2+2*t-1", "-t", "t", "t**2-2*t+1"],
    ["t**2-2*t+1", "-t**2+2*t-1", "-t", "t"],
    ["t", "t**2-2*t+1", "-t**2+2*t-1", "-t"],
    ["-t", "t", "t**2-2*t+1", "-t**2+2*t-1"],
]
ALEXANDER_POLYNOMIAL = (
    "t^6 - 5*t^5 + 10*t^4 - 13*t^3 + 10*t^2 - 5*t + 1"
)
EXACT_PROBLEM = "给定矩阵 M，计算亚历山大多项式 P(t) 使用其子式的行列式。"


def _envelope(text):
    return {
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ]
    }


def _packet(body, candidate, checks=None):
    task = body["task"]
    return json.dumps(
        {
            "schemaVersion": "p2a-work-v1",
            "sessionId": body["sessionId"],
            "problemHash": body["problemHash"],
            "contractVersion": body["contractVersion"],
            "taskId": task["taskId"],
            "goalId": task["goalId"],
            "scopeId": task["scopeId"],
            "routeId": body["route"]["routeId"],
            "sourceRequestId": body["sourceRequestId"],
            "claim": "forced-turn fixture",
            "derivation": "forced-turn fixture derivation",
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": list(checks or []),
            "deliveryStatus": "COMPLETE",
            "candidateProposal": candidate,
        }
    )


class ExactRetryClient(FakeClient):
    def __init__(self, persistent=False):
        super().__init__()
        self.persistent = persistent
        self.exact_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "ANSWER CLOSURE" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            body = json.loads(messages[1]["content"])
            return _envelope(
                _packet(
                    body,
                    ALEXANDER_POLYNOMIAL,
                    [
                        "CERT1|CHECK|C1|MAXIMAL_MINORS|all maximal minors agree => PASS",
                        "CERT1|FINAL|" + ALEXANDER_POLYNOMIAL,
                    ],
                )
            )
        if "EXACT CHECK TURN" in system:
            assert temperature == 0.2
            assert max_tokens == 8192
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.exact_turns += 1
            body = json.loads(messages[1]["content"])
            if self.persistent or self.exact_turns == 1:
                return _envelope(_packet(body, "t^2 - t + 1"))
            return _envelope(
                json.dumps(
                    {
                        "action": "tool",
                        "name": "exact_check_expr",
                        "args": {
                            "operation": "MAXIMAL_MINORS",
                            "matrix": ALEXANDER_MATRIX,
                            "variable": "t",
                        },
                        "scope": "all maximal minors of the supplied matrix",
                    }
                )
            )
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


class MethodRetryClient(FakeClient):
    def __init__(self, method_id, persistent=False):
        super().__init__()
        self.method_id = method_id
        self.persistent = persistent
        self.method_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "METHOD SELECTION TURN" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.method_turns += 1
            if self.persistent or self.method_turns == 1:
                body = json.loads(messages[1]["content"])
                return _envelope(super()._work(body))
            return _envelope(json.dumps({"action": "method", "id": self.method_id}))
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_exact_check_refusal_is_retried_once_then_obeys(process_tracker):
    client = ExactRetryClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=16,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(EXACT_PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == ALEXANDER_POLYNOMIAL
    assert client.exact_turns == 2
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["routed"] >= 1
    assert result["metrics"]["forced"] >= 1
    assert result["metrics"]["obeyed"] >= 1
    assert "exact_check_expr" in result["metrics"]["tool_names"]
    assert result["metrics"]["tool_effect_calls"] == 1
    assert process_tracker


def test_persistent_exact_check_refusal_stops_after_one_retry(process_tracker):
    client = ExactRetryClient(persistent=True)
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        # The current unified route may offer both a math asset and the
        # exact-check tool on every work unit. A persistent refusal must still
        # fail open and deliver the ordinary packet, so leave enough front-stage
        # calls for four work units plus the bounded retries.
        max_model_calls=24,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(EXACT_PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    # A problem-level route is attempted once per run, not once per work unit.
    assert result["metrics"]["routed"] == 1
    assert client.exact_turns == 2
    assert result["metrics"]["effect_calls"] == 0
    assert process_tracker


def test_method_refusal_is_retried_once_then_loads_the_real_card(process_tracker):
    catalog = fixture_catalog()
    method_id = catalog["entries"][0]["id"]
    client = MethodRetryClient(method_id)
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=10,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=1,
    )
    result = agent.solve("Compute 2+2", {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert client.method_turns == 2
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["method_effect_calls"] == 1
    assert result["metrics"]["tool_effect_calls"] == 0
    assert result["metrics"]["method_ids"]
    assert process_tracker


def test_persistent_method_refusal_stops_after_one_retry(process_tracker):
    catalog = fixture_catalog()
    method_id = catalog["entries"][0]["id"]
    client = MethodRetryClient(method_id, persistent=True)
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=10,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=1,
    )
    result = agent.solve("Compute 2+2", {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert client.method_turns == 2
    assert result["metrics"]["method_loads"] == 0
    assert result["metrics"]["effect_calls"] == 0
    assert process_tracker


def test_forced_math_asset_turn_is_cleared_after_one_execution(process_tracker):
    """The loop must not re-render MATH ASSET TURN from a stale forced flag.

    Before this regression, an obeying client was asked for the same asset on
    every iteration; the second/third loop-forced call hit the shared effect
    quota and became CONTROL_REJECTED.
    """

    class _ObeyingClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.asset_turns = []

        def chat(self, messages, temperature=0.2, max_tokens=8192):
            system = messages[0]["content"]
            body = json.loads(messages[1]["content"])
            if "MATH ASSET TURN" in system:
                self.asset_turns.append(body.get("sourceRequestId"))
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return _envelope(
                    json.dumps(
                        {
                            "action": "math_asset",
                            "assetId": "math.linear-algebra",
                            "target": "maximal_minors",
                            "input": {
                                "matrix": ALEXANDER_MATRIX,
                                "variable": "t",
                            },
                        }
                    )
                )
            return _envelope(_packet(body, ALEXANDER_POLYNOMIAL))

    client = _ObeyingClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=4,
        max_effects=2,
        max_reviews=0,
        max_repairs=0,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(EXACT_PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == ALEXANDER_POLYNOMIAL
    # The evidence turn is intentionally taken before the first answer turn, so
    # it now owns model-1. The regression this test protects is that the same
    # forced asset turn is not rendered again on model-2/model-3.
    assert client.asset_turns == ["model-1"]
    assert result["metrics"]["tool_effect_calls"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert process_tracker


def test_unknown_forced_method_id_fails_open_to_a_candidate(process_tracker):
    """An unknown method id is not obedience; the bounded fallback must answer.

    Previously the forced-turn check accepted any ``action == "method"``, then
    the ordinary catalog guard turned the unknown id into a fatal
    CONTROL_REJECTED. The retry plus one final-answer turn must instead produce
    the ordinary packet.
    """

    class _UnknownMethodClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.forced_turns = []

        def chat(self, messages, temperature=0.2, max_tokens=8192):
            system = messages[0]["content"]
            body = json.loads(messages[1]["content"])
            if "METHOD SELECTION TURN" in system:
                self.forced_turns.append(body.get("sourceRequestId"))
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return _envelope(
                    json.dumps({"action": "method", "id": "no-such-method-id"})
                )
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _UnknownMethodClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=4,
        max_effects=1,
        max_reviews=0,
        max_repairs=0,
        max_consensus=1,
        max_method_loads=1,
    )
    result = agent.solve("Compute 2+2", {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["stopReason"] != "CONTROL_REJECTED"
    assert len(client.forced_turns) == 2
    assert result["metrics"]["method_loads"] == 0
    assert process_tracker
