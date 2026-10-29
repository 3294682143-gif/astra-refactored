"""Bounded multi-round review -> repair -> R4 re-review at the public entry.

The only fake is the injected public client. The real Python Host, real Node
``main.js --agent-loop`` profile and the real registered tool executor all run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

PROBLEM = "Classify the number of solutions of x^2=p in terms of the parameter p"
ANSWER_TASK = "goal-1:OUTPUT_COVERAGE"
TOOL_ARGS = {"expression": "x^2-p", "variables": ["x"], "parameters": ["p"]}
FIRST_ANSWER = "p=0: zero solutions"
FIRST_REPAIR = "p!=0: two solutions; p=0: one solution"
SECOND_REPAIR = "p!=0: two solutions; p=0: one solution (round 2)"


class MultiRoundClient(FakeClient):
    """Initial partial candidate, then one complete answer per repair round."""

    def __init__(self):
        super().__init__()
        self.tool_done = False
        self.repairs = 0
        self.review_stages = []

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        assert temperature == 0.2
        assert max_tokens == 8192
        self.seen.append((messages, temperature, max_tokens))
        body = json.loads(messages[1]["content"])
        self.calls += 1
        if body.get("stage") in ("R2", "R4"):
            self.review_stages.append(body["stage"])
            text = self._review(body)
        else:
            text = self._work(body)
        return {
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": text},
                }
            ]
        }

    def _work(self, body):
        if body.get("stage") == "REPAIR":
            self.repairs += 1
            return self._packet(
                body,
                "classification of x^2=p",
                "split on the parameter p",
                FIRST_REPAIR if self.repairs == 1 else SECOND_REPAIR,
            )
        task = body["task"]
        on_answer = task["taskId"] == ANSWER_TASK
        if not self.tool_done and on_answer:
            self.tool_done = True
            return json.dumps(
                {
                    "action": "tool",
                    "name": "polynomial_expand_coefficients",
                    "args": TOOL_ARGS,
                    "scope": "check the supplied polynomial against the original problem",
                }
            )
        if on_answer:
            return self._packet(body, "classification", "branch analysis", FIRST_ANSWER)
        return self._packet(body, "prerequisite", "prerequisite", None)

    def _packet(self, body, claim, derivation, candidate):
        return json.dumps(
            {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": body["task"]["taskId"],
                "goalId": body["task"]["goalId"],
                "scopeId": body["task"]["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": claim,
                "derivation": derivation,
                "assumptions": [],
                "dependencies": body["task"]["inputArtifactRefs"],
                "pendingObligations": [],
                "suggestedChecks": [],
                "deliveryStatus": "COMPLETE",
                "candidateProposal": candidate,
            }
        )

    def _review(self, body):
        return json.dumps(
            {
                "schemaVersion": "p4-review-v1",
                "requestId": body["requestId"],
                "target": body["target"],
                "targetHash": body["targetHash"],
                "stage": body["stage"],
                "conclusion": "ISSUES",
                "reviewCoverage": [ANSWER_TASK],
                "issues": [
                    {
                        "stepLocator": {"start": 0, "end": 4, "quote": body["derivation"][:4]},
                        "suspectedIssue": "MISSING_CASE",
                        "rationale": "a trusted parameter branch remains unclassified",
                        "requestedCheck": "restate both parameter branches",
                        "obligationIds": [ANSWER_TASK],
                    }
                ],
            }
        )


def test_public_entry_two_review_repair_rounds(process_tracker):
    client = MultiRoundClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_reviews=2,
        max_repairs=2,
        max_effects=1,
        max_model_calls=12,
        max_work_units=5,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == SECOND_REPAIR
    assert result["reason"] == "REVISED_CANDIDATE"
    assert result["metrics"]["review_calls"] == 2
    assert client.repairs == 2
    assert client.review_stages == ["R2", "R4"]
    assert process_tracker


def test_re_review_after_repair_budget_is_spent_keeps_the_revision(process_tracker):
    """A post-repair R4 may run even when no second repair is authorized."""
    client = MultiRoundClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_reviews=2,
        max_repairs=1,
        max_effects=1,
        max_model_calls=10,
        max_work_units=5,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == FIRST_REPAIR
    assert result["reason"] == "REVISED_CANDIDATE"
    assert result["metrics"]["review_calls"] == 2
    assert client.repairs == 1
    assert client.review_stages == ["R2", "R4"]
    assert process_tracker
