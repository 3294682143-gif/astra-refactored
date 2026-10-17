"""Real public ``engine="ts"`` entry E2E: FakeClient through the real Node loop.

The only fake is the injected public client. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and the
real registered tool executor all run. The legacy Python solvers are replaced by
raising stubs so a hidden fallback surfaces as a failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

PROBLEM = "Compute 2+2"
SENTINEL = "SENTINEL-PRIVATE-7c1d"
TOOL_ARGS = {"expression": "2+2", "variables": ["x"], "parameters": []}


class FakeClient:
    """Public ``chat`` client returning explicit ``finish_reason: stop`` envelopes."""

    def __init__(self, tool_first=False):
        self.tool_first = tool_first
        self.calls = 0
        self.seen = []

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        assert temperature == 0.2
        assert max_tokens == 8192
        assert isinstance(messages, list) and len(messages) == 2
        self.seen.append((messages, temperature, max_tokens))
        body = json.loads(messages[1]["content"])
        self.calls += 1
        if body.get("stage") == "R2":
            text = self._review(body)
        elif self.tool_first and self.calls == 1:
            text = json.dumps(
                {"action": "tool", "name": "polynomial_expand_coefficients",
                 "args": TOOL_ARGS, "scope": "expand the supplied polynomial"}
            )
        else:
            text = self._work(body)
        return {
            "choices": [
                {"index": 0, "finish_reason": "stop",
                 "message": {"role": "assistant", "content": text}}
            ]
        }

    def _work(self, body):
        task = body["task"]
        return json.dumps({
            "schemaVersion": "p2a-work-v1",
            "sessionId": body["sessionId"],
            "problemHash": body["problemHash"],
            "contractVersion": body["contractVersion"],
            "taskId": task["taskId"],
            "goalId": task["goalId"],
            "scopeId": task["scopeId"],
            "routeId": body["route"]["routeId"],
            "sourceRequestId": body["sourceRequestId"],
            "claim": "2+2=4",
            "derivation": "2+2=4",
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": "4",
        })

    def _review(self, body):
        return json.dumps({
            "schemaVersion": "p4-review-v1",
            "requestId": body["requestId"],
            "target": body["target"],
            "targetHash": body["targetHash"],
            "stage": "R2",
            "conclusion": "NO_ISSUE",
            "reviewCoverage": [row["obligationId"] for row in body["obligations"]],
            "issues": [],
        })


@pytest.fixture(autouse=True)
def no_legacy_solver(monkeypatch):
    """Any hidden fallback to a frozen Python solver must fail loudly."""
    import mathagent.controller as controller
    import mathagent.entrypoint as entrypoint
    import mathagent.lite.runtime as lite_runtime

    def boom(*args, **kwargs):
        raise AssertionError("legacy solver must not run in the TS engine")

    monkeypatch.setattr(entrypoint.ReasoningAgent, "__init__", boom, raising=False)
    monkeypatch.setattr(entrypoint.ReasoningAgent, "solve", boom, raising=False)
    monkeypatch.setattr(lite_runtime.LiteRuntime, "__init__", boom, raising=False)
    monkeypatch.setattr(lite_runtime.LiteRuntime, "solve", boom, raising=False)
    monkeypatch.setattr(controller.Controller, "solve", boom, raising=False)


@pytest.fixture(autouse=True)
def process_tracker(monkeypatch):
    """Track every real child process; every test must leave none behind."""
    procs = []
    real_popen = subprocess.Popen

    def tracking(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        procs.append(proc)
        return proc

    monkeypatch.setattr(subprocess, "Popen", tracking)
    yield procs
    for proc in procs:
        assert proc.poll() is not None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            assert stream is None or stream.closed


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def test_ts_entry_fake_two_turns_and_controller_disabled(process_tracker):
    client = FakeClient()
    result = _solve(client)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert client.calls >= 2
    assert result["metrics"]["logical_model_calls"] >= 3
    blob = json.dumps(result["trace"])
    assert PROBLEM not in blob
    assert SENTINEL not in blob
    # Every MODEL call records two rows (DISPATCHED then RETURNED); the
    # dispatched rows are the ordered model-1..model-N ledger.
    dispatched = [
        row["id"]
        for row in result["trace"]
        if row["kind"] == "MODEL" and row["state"] == "DISPATCHED"
    ]
    assert dispatched == [f"model-{index}" for index in range(1, len(dispatched) + 1)]
    assert len(dispatched) >= 3
    assert process_tracker


def test_nested_bidirectional_rpc_tool_roundtrip(process_tracker):
    client = FakeClient(tool_first=True)
    result = _solve(client, max_model_calls=4, max_work_units=2, max_effects=1)
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["work_units"] == 2
    assert result["metrics"]["review_calls"] == 1
    assert client.calls == 4
    assert any(row["kind"] == "EFFECT" for row in result["trace"])
    # The second model request must carry exactly the one real tool
    # observation produced by the registered polynomial executor.
    second = json.loads(client.seen[1][0][1]["content"])
    observations = second["toolObservations"]
    assert len(observations) == 1
    observation = json.loads(observations[0]["observation"])
    assert observation["tool"] == "polynomial_expand_coefficients"
    assert "4" in json.dumps(observation["result"])
    # The third request is a different task and must not inherit the
    # observation; the R2 review context carries no tool observations at all.
    third = json.loads(client.seen[2][0][1]["content"])
    assert third["task"]["taskId"] != second["task"]["taskId"]
    assert third["toolObservations"] == []
    review = json.loads(client.seen[3][0][1]["content"])
    assert review["stage"] == "R2"
    assert "toolObservations" not in review
    assert process_tracker
    assert process_tracker[0].args[1].endswith(("main.js", "stdio-runtime.bundle.mjs"))
    assert process_tracker[0].args[2] == "--agent-loop"


def test_ts_entry_three_units_dependencies(process_tracker):
    client = FakeClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["status"] == "candidate"
    assert result["metrics"]["work_units"] == 3
    assert result["metrics"]["effect_calls"] == 0
    assert client.calls == 4
    third = json.loads(client.seen[2][0][1]["content"])
    assert len(third["task"]["inputArtifactRefs"]) == 2
    assert len(third["inputArtifacts"]) == 2
    assert process_tracker


def test_two_solves_distinct_sessions(process_tracker):
    client = FakeClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts", max_model_calls=4, max_work_units=2, problem_seconds=5)
    first = agent.solve(PROBLEM, {"source": "e2e"})
    second = agent.solve(PROBLEM, {"source": "e2e"})
    assert first["status"] == "candidate"
    assert second["status"] == "candidate"
    assert first["final_response"] == "4"
    assert second["final_response"] == "4"
    assert first["metrics"]["logical_model_calls"] == second["metrics"]["logical_model_calls"]
    assert first["metrics"]["client_method_calls"] == second["metrics"]["client_method_calls"]
    # The two runs must be separate sessions, not one reused session.
    first_session = json.loads(client.seen[0][0][1]["content"])["sessionId"]
    second_session = json.loads(client.seen[3][0][1]["content"])["sessionId"]
    assert first_session != second_session
    assert process_tracker
    assert len(process_tracker) == 2
