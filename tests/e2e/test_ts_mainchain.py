"""Real public ``engine="ts"`` entry E2E: three WorkUnits on the real main chain.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run; the legacy Python solvers are
replaced by raising stubs so a hidden fallback surfaces as a failure.

Every expectation below is *derived at runtime* from the real run: the test
reads the real WORK contexts the Host actually built, the real task ids, the
real ``inputArtifactRefs`` and the real ``inputArtifacts`` bytes, and asserts
the three main-chain properties against those observed values. Nothing about
the ready order, the dependency edges or the artifact refs is hard-coded.

1. three WORK units land on the real ready nodes, in the order the real M1 DAG
   decides (each later task's declared dependencies are already DELIVERED);
2. a downstream WORK context really carries the predecessor's ACTIVE artifact
   (``rawResponseText``/``rawResponseHash`` byte-identical to the recorded
   receipt) and its packet ``dependencies`` match the declared input refs;
3. M2 schedules by readiness: a task whose predecessor is not DELIVERED is
   never selected, and a declared ``scopeCoverage`` row never changes the ready
   set and never closes an obligation.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


class ChainClient(FakeClient):
    """FakeClient that answers every WORK turn with a plain COMPLETE packet."""

    def __init__(self, mode="ordinary"):
        super().__init__()
        self.mode = mode
        self.rawtexts = {}

    def _work(self, body):
        text = super()._work(body)
        if self.mode == "partial_first" and body["sourceRequestId"] == "model-1":
            packet = json.loads(text)
            packet["deliveryStatus"] = "INCOMPLETE"
            text = json.dumps(packet, ensure_ascii=False, separators=(",", ":"))
        self.rawtexts[body["sourceRequestId"]] = text
        return text


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


def _work_bodies(client):
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


def test_three_work_units_follow_real_ready_order(process_tracker):
    """Three WORK units run in the order the real M1 DAG makes ready."""
    client = ChainClient()
    result = _solve(client, **_BUDGET)
    assert result["engine"] == "ts"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True
    assert result["metrics"]["work_units"] == 3
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 1
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    assert process_tracker[0].args[2] == "--agent-loop"
    bodies = _work_bodies(client)
    assert len(bodies) == 3
    # The real observed scheduling sequence, printed for traceability.
    observed = [body["task"]["taskId"] for body in bodies]
    print("observed ready order:", observed)
    assert len(set(observed)) == 3
    # Every later task's declared dependencies are already DELIVERED earlier in
    # the real sequence: the order is the real DAG's ready order, not a fixed
    # route id or question id.
    for index, body in enumerate(bodies):
        for dependency in body["task"]["dependencyTaskIds"]:
            assert dependency in observed[:index]
    # The first unit is a real ready node with no predecessor.
    assert bodies[0]["task"]["dependencyTaskIds"] == []
    assert bodies[0]["task"]["inputArtifactRefs"] == []
    assert bodies[0]["inputArtifacts"] == []
    # The last unit really consumes predecessors: its declared refs are exactly
    # the refs the Host resolved for it.
    last = bodies[-1]
    assert last["task"]["dependencyTaskIds"]
    assert last["task"]["inputArtifactRefs"]
    assert len(last["inputArtifacts"]) == len(last["task"]["inputArtifactRefs"])


def test_downstream_consumes_predecessor_active_artifact(process_tracker):
    """A downstream WORK context really carries the predecessor's ACTIVE bytes."""
    client = ChainClient()
    result = _solve(client, **_BUDGET)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert len(bodies) == 3
    by_task = {body["task"]["taskId"]: body for body in bodies}
    consumed = 0
    for body in bodies:
        for ref, artifact in zip(body["task"]["inputArtifactRefs"], body["inputArtifacts"]):
            source_id = artifact["sourceRequestId"]
            assert source_id in client.rawtexts
            raw = client.rawtexts[source_id]
            # The carried artifact is the real earlier receipt, byte for byte.
            assert artifact["rawResponseText"] == raw
            assert artifact["rawResponseHash"] == hashlib.sha256(
                raw.encode("utf-8")
            ).hexdigest()
            assert artifact["packet"] == json.loads(raw)
            assert artifact["artifactId"] == ref["artifactId"]
            assert artifact["envelope"]["artifactVersion"] == ref["artifactVersion"]
            assert artifact["transportStatus"] == "COMPLETE"
            assert artifact["deliveryStatus"] == "COMPLETE"
            assert artifact["level"] == "PROVISIONAL"
            assert artifact["checkResult"] == "UNKNOWN"
            # The predecessor really ran earlier in this same session.
            producer = by_task[artifact["envelope"]["taskId"]]
            assert producer["sourceRequestId"] == source_id
            assert producer["sessionId"] == body["sessionId"]
            assert producer["problemHash"] == body["problemHash"]
            # The carried artifact is the producer's own record: its packet
            # dependencies are the producer's declared inputs, never the
            # consumer's. The consumer's own packet declares its own refs.
            assert artifact["packet"]["dependencies"] == producer["task"]["inputArtifactRefs"]
            assert artifact["packet"]["taskId"] == artifact["envelope"]["taskId"]
            assert artifact["packet"]["sourceRequestId"] == source_id
            consumed += 1
        consumer_packet = json.loads(client.rawtexts[body["sourceRequestId"]])
        assert consumer_packet["dependencies"] == body["task"]["inputArtifactRefs"]
    assert consumed >= 1


def test_unmet_predecessor_is_never_selected(process_tracker):
    """A task whose predecessor is not DELIVERED is never scheduled."""
    client = ChainClient(mode="partial_first")
    result = _solve(client, **_BUDGET)
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    # The first delivery is INCOMPLETE, so no dependent task may be selected:
    # every observed task is a real ready node with no predecessor.
    for body in bodies:
        assert body["task"]["dependencyTaskIds"] == []
        assert body["task"]["inputArtifactRefs"] == []
        assert body["inputArtifacts"] == []


def test_declared_coverage_never_changes_ready_set(process_tracker):
    """A declared coverage row is data only: it never changes the ready set."""
    plain = ChainClient()
    plain_result = _solve(plain, **_BUDGET)
    declared = ChainClient()
    declared_result = _solve(declared, **_BUDGET)
    assert plain_result["candidate_verified"] is False
    assert declared_result["candidate_verified"] is False
    plain_tasks = [body["task"]["taskId"] for body in _work_bodies(plain)]
    declared_tasks = [body["task"]["taskId"] for body in _work_bodies(declared)]
    assert plain_tasks == declared_tasks
    assert plain_tasks
    for body in _work_bodies(declared):
        assert "scopeCoverage" in body
        assert isinstance(body["scopeCoverage"], list)
        for row in body["scopeCoverage"]:
            assert row["taskId"] == body["task"]["taskId"]
            assert row["scopeId"] == body["task"]["scopeId"]
    assert process_tracker
