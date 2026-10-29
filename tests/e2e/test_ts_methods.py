"""Real public ``engine="ts"`` entry E2E for the G2A method-read capability.

Only the injected public client is fake; the real ``user_agent`` entry, the real
Python Host, the real Node ``main.js --agent-loop`` profile and the real
read-only ``MethodCatalog`` reader all run. The legacy Python solvers stay
disabled, so a hidden fallback surfaces as a failure.
"""

from __future__ import annotations

import hashlib
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402
from python.astra_bridge import agent_host as host_module  # noqa: E402
from python.astra_bridge.p2_methods import fixture_catalog, fixture_load  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def _method_id():
    """Read the real catalog once, before any spy, to pick a real id/title."""
    catalog = fixture_catalog()
    assert catalog["entries"], "the real method catalog must not be empty"
    return catalog["entries"][0]["id"], catalog["entries"][0]["title"]


class _MethodClient(FakeClient):
    """Reply with a real method action on the first WORK of every session.

    The decision is made from the parsed request body, not from a global call
    counter: each session starts again at ``sourceRequestId == "model-1"``, so
    a second ``solve`` on the same agent still loads the method once. With
    ``repeat`` the second WORK of the same session (``model-2``) also answers
    with the same method action, which must reuse the cached receipt.
    """

    def __init__(self, method_id, repeat=False):
        super().__init__()
        self.method_id = method_id
        self.repeat = repeat

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        source = body.get("sourceRequestId")
        if source == "model-1" or (self.repeat and source == "model-2"):
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant",
                                 "content": json.dumps(
                                     {"action": "method", "id": self.method_id})}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


@pytest.fixture
def spy_catalog(monkeypatch):
    """Count real ``MethodCatalog.load`` calls without changing behaviour.

    The production Host imports ``MethodCatalog`` inside its own function, so
    the spy patches the real class method on ``mathagent.lite.methods`` and
    delegates to the saved original. The expected asset is read from the real
    reader before the patch, so a self-consistent fake body cannot pass.
    """
    from mathagent.lite import methods as methods_module

    method_id, title = _method_id()
    expected = fixture_load(method_id)
    assert expected["status"] == "loaded"
    spy = types.SimpleNamespace(loads=0, expected=expected["asset"],
                                method_id=method_id, title=title)
    original = methods_module.MethodCatalog.load

    def counting(self, requested):
        spy.loads += 1
        return original(self, requested)

    monkeypatch.setattr(methods_module.MethodCatalog, "load", counting)
    return spy


def test_method_load_enters_work_and_is_advisory(process_tracker, spy_catalog):
    method_id, title = spy_catalog.method_id, spy_catalog.title
    expected = spy_catalog.expected
    client = _MethodClient(method_id)
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=2, max_effects=1, max_reviews=1)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert client.calls == 4
    assert result["metrics"]["catalog_calls"] == 1
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["review_calls"] == 1
    assert spy_catalog.loads == 1
    # The second WORK request carries the real asset body and title, byte for
    # byte equal to the real reader's own result.
    second = json.loads(client.seen[1][0][1]["content"])
    assert second["allowMethods"] is True
    assert len(second["methodAssets"]) == 1
    asset = second["methodAssets"][0]
    assert asset == expected
    assert asset["id"] == method_id
    assert asset["title"] == title
    assert asset["bodySha256"] == hashlib.sha256(
        asset["body"].encode("utf-8")).hexdigest()
    assert len(second["toolObservations"]) == 1
    observation = second["toolObservations"][0]
    assert observation["source"] == "METHOD_REFERENCE"
    assert observation["status"] == "COMPLETE"
    assert json.loads(observation["observation"])["asset"] == expected
    # The third request is a different task: no observations, same asset text,
    # and the method action is no longer advertised.
    third = json.loads(client.seen[2][0][1]["content"])
    assert third["task"]["taskId"] != second["task"]["taskId"]
    assert third["toolObservations"] == []
    assert third["methodAssets"] == second["methodAssets"]
    assert third["allowMethods"] is False
    # The R2 review context carries no method assets and no catalog.
    review = json.loads(client.seen[3][0][1]["content"])
    assert review["stage"] == "R2"
    assert "methodAssets" not in review
    assert "methodCatalog" not in review
    assert process_tracker


def test_methods_disabled_by_default(process_tracker, monkeypatch):
    """Default ``max_method_loads=0`` never touches the catalog reader."""
    from mathagent.lite import methods as methods_module

    def boom(self, *args, **kwargs):
        raise AssertionError("the catalog must not be constructed by default")

    monkeypatch.setattr(methods_module.MethodCatalog, "__init__", boom)
    client = FakeClient()
    result = _solve(client)
    assert result["status"] == "candidate"
    assert result["metrics"]["catalog_calls"] == 0
    assert result["metrics"]["method_loads"] == 0
    first = json.loads(client.seen[0][0][1]["content"])
    assert first["allowMethods"] is False
    assert first["methodAssets"] == []
    assert process_tracker


@pytest.mark.parametrize("calls", [0, 1, 2])
def test_low_model_caps_never_read_catalog(calls, process_tracker, spy_catalog):
    client = FakeClient()
    result = _solve(client, max_method_loads=1, max_effects=1,
                    max_model_calls=calls, max_reviews=1)
    assert result["metrics"]["catalog_calls"] == 0
    assert result["metrics"]["method_loads"] == 0
    assert spy_catalog.loads == 0
    assert process_tracker


def test_zero_effect_cap_never_reads_catalog(process_tracker, spy_catalog):
    client = FakeClient()
    result = _solve(client, max_method_loads=1, max_effects=0,
                    max_model_calls=4, max_reviews=1)
    assert result["metrics"]["catalog_calls"] == 0
    assert result["metrics"]["method_loads"] == 0
    assert spy_catalog.loads == 0
    assert process_tracker


def test_repeat_method_reuses_receipt(process_tracker, spy_catalog):
    method_id, _title = spy_catalog.method_id, spy_catalog.title
    client = _MethodClient(method_id, repeat=True)
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=1, max_effects=1, max_reviews=0)
    assert result["status"] == "candidate"
    assert client.calls == 3
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert spy_catalog.loads == 1
    third = json.loads(client.seen[2][0][1]["content"])
    assert len(third["toolObservations"]) == 1
    assert third["toolObservations"][0]["binding"]["sourceRequestId"] == "model-1"
    assert process_tracker


def test_second_different_method_is_refused(process_tracker, spy_catalog):
    catalog = fixture_catalog()
    assert len(catalog["entries"]) >= 2
    first_id = catalog["entries"][0]["id"]
    second_id = catalog["entries"][1]["id"]

    class _TwoMethodClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            if self.calls < 2:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                chosen = first_id if self.calls == 1 else second_id
                return {
                    "choices": [
                        {"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant",
                                     "content": json.dumps(
                                         {"action": "method", "id": chosen})}}
                    ]
                }
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _TwoMethodClient()
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=1, max_effects=2, max_reviews=0)
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "CONTROL_REJECTED"
    assert client.calls == 2
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert spy_catalog.loads == 1
    assert process_tracker


def test_method_and_tool_share_effect_budget(process_tracker, spy_catalog):
    method_id, _title = spy_catalog.method_id, spy_catalog.title
    tool_text = json.dumps({
        "action": "tool",
        "name": "polynomial_expand_coefficients",
        "args": {"expression": "2+2", "variables": ["x"], "parameters": []},
        "scope": "expand the supplied polynomial",
    })

    class _MixedClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            if self.calls == 0:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return {
                    "choices": [
                        {"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant",
                                     "content": json.dumps(
                                         {"action": "method", "id": method_id})}}
                    ]
                }
            if self.calls == 1:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return {
                    "choices": [
                        {"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": tool_text}}
                    ]
                }
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _MixedClient()
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=1, max_effects=2, max_reviews=0)
    assert result["status"] == "candidate"
    assert result["metrics"]["effect_calls"] == 2
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["logical_model_calls"] <= 4
    third = json.loads(client.seen[2][0][1]["content"])
    sources = sorted(row["source"] for row in third["toolObservations"])
    assert sources == ["METHOD_REFERENCE", "PROGRAM_OBSERVATION"]
    assert all(row["status"] == "COMPLETE" for row in third["toolObservations"])
    effect_ids = sorted(row["effectId"] for row in third["toolObservations"])
    assert effect_ids == ["effect-1", "effect-2"]
    assert process_tracker


@pytest.mark.parametrize("mode", ["length", "nofinish"])
def test_incomplete_method_reply_never_loads(mode, process_tracker, spy_catalog):
    method_id, _title = spy_catalog.method_id, spy_catalog.title
    text = json.dumps({"action": "method", "id": method_id})

    class _IncompleteClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            if self.calls == 0:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                if mode == "length":
                    return {"choices": [{"index": 0, "finish_reason": "length",
                                         "message": {"role": "assistant", "content": text}}]}
                return {"choices": [{"index": 0,
                                     "message": {"role": "assistant", "content": text}}]}
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _IncompleteClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts", max_method_loads=1)
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "unsolved"
    assert result["metrics"]["method_loads"] == 0
    assert result["metrics"]["effect_calls"] == 0
    assert spy_catalog.loads == 0
    if mode == "nofinish":
        second = agent.solve(PROBLEM, {"source": "e2e"})
        assert second["status"] == "unsolved"
        assert client.calls == 1
    assert process_tracker


def test_unavailable_catalog_degrades_safely(process_tracker, monkeypatch):
    def empty_catalog(_catalog=None):
        return {"version": "1.1.0", "entries": []}

    monkeypatch.setattr(host_module, "fixture_catalog", empty_catalog)
    client = FakeClient()
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=2, max_effects=1, max_reviews=1)
    assert result["status"] == "candidate"
    assert result["metrics"]["catalog_calls"] == 1
    assert result["metrics"]["method_loads"] == 0
    first = json.loads(client.seen[0][0][1]["content"])
    assert first["allowMethods"] is False
    assert first["methodCatalog"] == []
    assert process_tracker


def test_two_solves_do_not_share_method_cache(process_tracker, spy_catalog):
    """A second solve is a new session: no cross-problem method cache reuse."""
    method_id, _title = spy_catalog.method_id, spy_catalog.title
    client = _MethodClient(method_id)
    agent = user_agent.ReasoningAgent(client=client, engine="ts",
                                      max_method_loads=1, max_model_calls=4,
                                      max_work_units=2, max_effects=1,
                                      max_reviews=1)
    first = agent.solve(PROBLEM, {"source": "e2e"})
    second = agent.solve(PROBLEM, {"source": "e2e"})
    assert first["status"] == "candidate"
    assert second["status"] == "candidate"
    first_body = json.loads(client.seen[0][0][1]["content"])
    second_body = json.loads(client.seen[4][0][1]["content"])
    assert first_body["sessionId"] != second_body["sessionId"]
    assert first_body["sourceRequestId"] == "model-1"
    assert second_body["sourceRequestId"] == "model-1"
    assert second_body["methodAssets"] == []
    assert spy_catalog.loads == 2
    assert process_tracker


def test_strict_policy_does_not_verify_methods(process_tracker, spy_catalog):
    method_id, _title = spy_catalog.method_id, spy_catalog.title
    client = _MethodClient(method_id)
    result = _solve(client, max_method_loads=1, max_model_calls=4,
                    max_work_units=2, max_effects=1, max_reviews=1,
                    policy="STRICT")
    assert result["status"] == "unsolved"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert process_tracker

class _RouteAwareMethodClient(FakeClient):
    """Return a WorkPacket first, then obey the forced method-selection turn."""

    def __init__(self, method_id):
        super().__init__()
        self.method_id = method_id
        self.method_turns = 0
        self.selection = None

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "METHOD SELECTION TURN" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.method_turns += 1
            self.selection = (messages, temperature, max_tokens)
            text = json.dumps({"action": "method", "id": self.method_id})
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


class _SecondMethodClient(FakeClient):
    """Load the first routed card, then optionally offer the second card."""

    def __init__(self, first_id, second_id):
        super().__init__()
        self.first_id = first_id
        self.second_id = second_id
        self.selection_turns = []

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "SECOND METHOD SELECTION TURN" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.selection_turns.append("second")
            text = json.dumps({"action": "method", "id": self.second_id})
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        if "METHOD SELECTION TURN" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.selection_turns.append("first")
            text = json.dumps({"action": "method", "id": self.first_id})
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_second_routed_card_body_reaches_the_answering_turn(
        process_tracker, spy_catalog, monkeypatch):
    # This slice changes the freshly compiled loop; the release bundle is not
    # rebuilt here. The public entry, Host and IPC remain the real ones.
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")
    first_id = "linearization-spectral"
    second_id = "numerical-approximation"
    client = _SecondMethodClient(first_id, second_id)
    problem = "Compute the determinant of the matrix [[1,2],[3,4]] and its rank."
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=10,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=2,
    )
    result = agent.solve(problem, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert client.selection_turns == ["first", "second"]
    assert result["metrics"]["method_effect_calls"] == 2
    assert result["metrics"]["method_loads"] == 2
    assert result["metrics"]["effect_calls"] == 2
    assert set(result["metrics"]["method_ids"]) == {first_id, second_id}
    assert spy_catalog.loads == 2
    bodies = [
        json.loads(messages[1]["content"])
        for messages, _temperature, _max_tokens in client.seen
    ]
    two_asset_bodies = [
        body for body in bodies
        if len(body.get("methodAssets", [])) == 2
    ]
    assert two_asset_bodies
    assert any(
        [asset["id"] for asset in body["methodAssets"]] == [first_id, second_id]
        and all(asset["body"].strip() for asset in body["methodAssets"])
        and all(asset["bodySha256"] == hashlib.sha256(
            asset["body"].encode("utf-8")).hexdigest()
            for asset in body["methodAssets"])
        for body in two_asset_bodies
    )
    assert process_tracker


def test_routed_candidates_appear_in_method_selection_before_the_body(
        process_tracker):
    method_id = "linearization-spectral"
    expected = fixture_load(method_id)
    assert expected["status"] == "loaded"
    body = expected["asset"]["body"]
    client = _RouteAwareMethodClient(method_id)
    problem = "Compute the determinant of the matrix [[1,2],[3,4]] and its rank."
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
    result = agent.solve(problem, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert client.method_turns == 1
    assert result["metrics"]["catalog_calls"] == 1
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert client.selection is not None
    selected_messages, _temperature, _max_tokens = client.selection
    system = selected_messages[0]["content"]
    selected_body = json.loads(selected_messages[1]["content"])
    assert "Routed method candidates (metadata only; bodies are not loaded):" in system
    assert method_id in system
    assert "Other available method ids:" in system
    assert body not in system
    assert body not in json.dumps(selected_messages, ensure_ascii=False)
    assert selected_body["methodAssets"] == []
    catalog_row = next(row for row in selected_body["methodCatalog"]
                       if row["id"] == method_id)
    assert catalog_row["objects"] == ["matrix", "linear_system", "linear_map",
                                      "quadratic_form"]
    assert catalog_row["structures"] == ["rank", "nullspace", "eigenvalue",
                                         "change_of_basis"]
    assert catalog_row["role"] == "method"

    loaded_work = [
        json.loads(messages[1]["content"])
        for messages, _t, _m in client.seen
        if "METHOD SELECTION TURN" not in messages[0]["content"]
    ]
    assert any(row["methodAssets"] and row["methodAssets"][0]["body"] == body
               for row in loaded_work)
    assert process_tracker


def test_method_asset_and_tool_fit_the_three_shared_effect_slots(
    process_tracker, spy_catalog
):
    """Method + math asset + tool share one three-slot effect window.

    Regression for the real 100-item BUDGET stops: the Host's
    ``on_math_asset`` used to compare the total effect count with the public
    tool quota, so after a method card and one asset it refused the second
    asset although the tool quota and effect-id table still had room.
    """
    method_id = spy_catalog.method_id
    asset_text = json.dumps(
        {
            "action": "math_asset",
            "assetId": "math.numerics",
            "target": "interpolation_fit",
            "input": {
                "points": [
                    {"x": "0", "y": "1"},
                    {"x": "1", "y": "4"},
                    {"x": "2", "y": "9"},
                ],
                "expression": "x**2+2*x+1",
                "variable": "x",
            },
        }
    )
    tool_text = json.dumps(
        {
            "action": "tool",
            "name": "polynomial_expand_coefficients",
            "args": {"expression": "2+2", "variables": ["x"], "parameters": []},
            "scope": "expand the supplied polynomial",
        }
    )

    class _MixedAssetClient(FakeClient):
        def chat(self, messages, temperature=0.2, max_tokens=8192):
            if self.calls == 0:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return {
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": json.dumps({"action": "method", "id": method_id}),
                            },
                        }
                    ]
                }
            if self.calls == 1:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return {
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": asset_text},
                        }
                    ]
                }
            if self.calls == 2:
                self.seen.append((messages, temperature, max_tokens))
                self.calls += 1
                return {
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": tool_text},
                        }
                    ]
                }
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    client = _MixedAssetClient()
    result = _solve(
        client,
        max_method_loads=1,
        max_model_calls=6,
        max_work_units=1,
        max_effects=2,
        max_reviews=0,
        max_consensus=0,
    )
    assert result["status"] == "candidate"
    assert result["metrics"]["effect_calls"] == 3
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["tool_effect_calls"] == 2
    last = json.loads(client.seen[-1][0][1]["content"])
    sources = sorted(row["source"] for row in last["toolObservations"])
    assert sources == ["METHOD_REFERENCE", "PROGRAM_OBSERVATION", "PROGRAM_OBSERVATION"]
    assert sorted(row["effectId"] for row in last["toolObservations"]) == [
        "effect-1",
        "effect-2",
        "effect-3",
    ]
    assert process_tracker
