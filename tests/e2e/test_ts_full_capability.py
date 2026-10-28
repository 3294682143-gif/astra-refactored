"""Full-capability profile: every architecture stage is actually dispatched.

The only fake is the injected public client. The real ``user_agent.ReasoningAgent``
entry, real Python Host, real Node ``main.js --agent-loop`` profile and real
process lifecycle run. This test is a wiring/observability proof, not a claim
that any mathematical answer is verified.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import no_legacy_solver, process_tracker  # noqa: E402
from test_ts_g3_r0 import R0Client  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]


@pytest.fixture(autouse=True)
def workspace_entry(monkeypatch):
    """Run the freshly compiled workspace loop, which contains this slice."""
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")


PROBLEM = "Compute 2+2"
ANSWER_OBLIGATION = "goal-1:CANDIDATE_VALIDITY"


class ChallengeClient(R0Client):
    """R0 + G2 + consensus + R2 ISSUES; REPAIR is dispatched but ungrounded.

    The point is to exercise the bounded REPAIR -> R4 branch without a prior
    program observation: the revision must be refused fail-closed, and both
    calls must still be visible in the run ledger.
    """

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") in ("R2", "R4"):
            assert temperature == 0.2
            assert max_tokens == 8192
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            text = self._review(body)
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": text},
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    def _review(self, body):
        if body.get("schemaVersion") == "p4-r2-context-v1":
            # R4 has the same context shape; it must report the recheck stage.
            conclusion = "ISSUES" if body.get("stage") == "R2" else "NO_ISSUE"
            issues = []
            if conclusion == "ISSUES":
                derivation = body["derivation"]
                issues = [
                    {
                        "stepLocator": {
                            "start": 0,
                            "end": 1,
                            "quote": derivation[:1],
                        },
                        "suspectedIssue": "MISSING_CASE",
                        "rationale": "the answer does not state the missing case",
                        "requestedCheck": "state the missing case explicitly",
                        "obligationIds": [ANSWER_OBLIGATION],
                    }
                ]
            return json.dumps(
                {
                    "schemaVersion": "p4-review-v1",
                    "requestId": body["requestId"],
                    "target": body["target"],
                    "targetHash": body["targetHash"],
                    "stage": body["stage"],
                    "conclusion": conclusion,
                    "reviewCoverage": [row["obligationId"] for row in body["obligations"]],
                    "issues": issues,
                }
            )
        return super()._review(body)

    def _work(self, body):
        if body.get("stage") == "REPAIR":
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
                    "claim": "2+2=4",
                    "derivation": "2+2=4",
                    "assumptions": [],
                    "dependencies": task["inputArtifactRefs"],
                    "pendingObligations": [],
                    "suggestedChecks": [],
                    "deliveryStatus": "COMPLETE",
                    "candidateProposal": "4",
                }
            )
        return super()._work(body)


class MalformedRepairClient(ChallengeClient):
    """R2 challenges, but the REPAIR turn returns an unusable packet."""

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            return "{not-a-work-packet"
        return super()._work(body)


def test_full_profile_dispatches_r0_g2_consensus_r2(process_tracker):
    client = R0Client()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=30,
        max_work_units=8,
        max_effects=0,
        max_reviews=2,
        max_repairs=1,
        max_consensus=8,
        max_r0=1,
        problem_seconds=10,
        mode="local",
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert result["childReaped"] is True

    metrics = result["metrics"]
    assert metrics["capability_profile"] == "FULL"
    # R0: three independent role reviews + the pure aggregate.
    assert metrics["r0_model_calls"] == 3
    assert metrics["r0_role_reviews"] == 3
    assert metrics["r0_aggregates"] == 1
    assert client.r0_seen == 3
    # G2: one real second route, one real work unit on it, and one candidate
    # comparison. The route starts from empty dependency refs by construction.
    assert metrics["g2_route_attempts"] == 1
    assert metrics["g2_routes_admitted"] == 1
    assert metrics["g2_routes_rejected"] == 0
    assert metrics["g2_route_workunits"] == 1
    assert metrics["g2_route_candidates"] == 1
    assert metrics["g2_route_agreements"] == 1
    # Consensus: 5 independent + 2 anchored audits + 1 certificate.
    assert metrics["consensus_independent_calls"] == 5
    assert metrics["consensus_audit_calls"] == 2
    assert metrics["consensus_certificate_calls"] == 1
    assert metrics["consensus_independent_ballots"] == 5
    assert metrics["consensus_audit_ballots"] == 2
    assert metrics["consensus_certificate_ballots"] == 1
    assert metrics["r2_review_calls"] == 1
    # R0+G2+consensus+R2 are real; the R2 review here is NO_ISSUE, so the
    # mandatory capability probe supplies the one REPAIR and one R4 exercise.
    assert metrics["capability_probe_calls"] == 1
    assert metrics["repair_model_calls"] == 1
    assert metrics["r4_review_calls"] == 1
    assert len(process_tracker) == 1


def test_malformed_repair_packet_keeps_the_parent_candidate(process_tracker):
    client = MalformedRepairClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=30,
        max_work_units=8,
        max_effects=0,
        max_reviews=2,
        max_repairs=1,
        max_consensus=2,
        max_r0=1,
        problem_seconds=10,
        mode="local",
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["stopReason"] == "REVISE_REJECTED"
    assert result["final_response"] == "4"
    metrics = result["metrics"]
    assert metrics["repair_model_calls"] == 1
    assert metrics["repair_packet_rejected"] == 1
    assert metrics["repair_accepted"] == 0
    assert metrics["r4_review_calls"] == 0
    assert metrics["capability_probe_calls"] == 0


def test_full_profile_dispatches_r2_repair_r4_fail_closed(process_tracker):
    client = ChallengeClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=30,
        max_work_units=8,
        max_effects=0,
        max_reviews=2,
        max_repairs=1,
        max_consensus=2,
        max_r0=1,
        problem_seconds=10,
        mode="local",
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["stopReason"] == "REVISE_REJECTED"
    # The ungrounded repair is never substituted: the parent candidate wins.
    assert result["final_response"] == "4"
    metrics = result["metrics"]
    assert metrics["capability_profile"] == "FULL"
    assert metrics["r2_review_calls"] == 1
    assert metrics["repair_model_calls"] == 1
    assert metrics["repair_decisions"] == 1
    assert metrics["repair_accepted"] == 0
    assert metrics["repair_rejected"] == 1
    assert metrics["r4_review_calls"] == 1
    assert metrics["capability_probe_calls"] == 0
    assert len(process_tracker) == 1
