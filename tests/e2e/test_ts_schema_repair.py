"""Bounded WorkPacket schema repair at the real public entry.

The first WORK response intentionally uses the two shapes the real Intern-S2
model produced in the acceptance run: ``deliveryStatus="RUNNING"`` and a
``candidateProposal`` object.  With ``max_repairs=1`` the loop must make exactly
one correction turn for the same task and then continue; with the default
``max_repairs=0`` it must still fail closed after the first packet.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

PROBLEM = "Compute 2+2"


class SchemaRepairClient(FakeClient):
    """First reply is the real-model shape; a repair reply is schema-valid."""

    def __init__(self):
        super().__init__()
        self.rejected = False

    def _packet(self, body, *, source_id=None, complete: bool):
        task = body["task"]
        return {
            "schemaVersion": "p2a-work-v1",
            "sessionId": body["sessionId"],
            "problemHash": body["problemHash"],
            "contractVersion": body["contractVersion"],
            "taskId": task["taskId"],
            "goalId": task["goalId"],
            "scopeId": task["scopeId"],
            "routeId": body["route"]["routeId"],
            "sourceRequestId": source_id,
            "claim": "2+2=4",
            "derivation": "2+2=4",
            "assumptions": [],
            "dependencies": body["task"]["inputArtifactRefs"],
            "pendingObligations": [] if complete else ["goal-1:OUTPUT_COVERAGE"],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE" if complete else "RUNNING",
            "candidateProposal": "4" if complete else {"answer": "4", "complete": True},
        }

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        raw_system = messages[0]["content"]
        raw_user = messages[1]["content"]
        body = json.loads(raw_user)
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        if body.get("stage") == "R2":
            return super().chat(messages, temperature=temperature, max_tokens=max_tokens)
        source = re.search(
            r"(?:^|\n)currentSourceRequestId=(model-\d+)(?:\n|$)",
            raw_system,
        )
        source_id = source.group(1) if source is not None else body.get("sourceRequestId")
        if not self.rejected:
            self.rejected = True
            packet = self._packet(body, source_id=source_id, complete=False)
        else:
            packet = self._packet(body, source_id=source_id, complete=True)
        return {
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": json.dumps(packet, ensure_ascii=False)},
                }
            ]
        }


def _agent(client, **kwargs):
    return user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)


def test_one_bounded_schema_repair_recovers_the_complete_packet(process_tracker):
    client = SchemaRepairClient()
    result = _agent(
        client,
        max_model_calls=4,
        max_work_units=2,
        max_effects=0,
        max_reviews=1,
        max_repairs=1,
    ).solve(PROBLEM, {"source": "schema-repair"})
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["candidate_verified"] is False
    assert result["metrics"]["logical_model_calls"] >= 2
    assert client.calls >= 2
    assert process_tracker


def test_schema_repair_is_off_with_the_default_zero_budget(process_tracker):
    client = SchemaRepairClient()
    result = _agent(
        client,
        max_model_calls=4,
        max_work_units=2,
        max_effects=0,
        max_reviews=1,
    ).solve(PROBLEM, {"source": "schema-repair-off"})
    assert result["status"] == "unsolved"
    assert result["stopReason"] == "PACKET_REJECTED"
    assert result["final_response"] == "Unsolved."
    assert client.calls == 1
    assert process_tracker
