"""Helper runner for P1-F1: Executes real production stdio-runtime bundle via ReasoningAgent(engine="ts").

Called by packages/agent-kernel/tests/math-parity.test.mjs to perform genuine
production-entry level parity verification without in-test mocks.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import user_agent
from tests.e2e.test_ts_entry import FakeClient


class ParityMathSolverClient(FakeClient):
    """Client for solving the reference quadratic equation problem."""

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
            "claim": "x=2 or x=3",
            "derivation": "Factorization: (x-2)(x-3)=0 => x=2 or x=3",
            "assumptions": [],
            "dependencies": task["inputArtifactRefs"],
            "pendingObligations": [],
            "suggestedChecks": [],
            "deliveryStatus": "COMPLETE",
            "candidateProposal": "x=2, x=3",
        })

    def _review(self, body):
        return json.dumps({
            "schemaVersion": "p4-review-v1",
            "requestId": body["requestId"],
            "target": body["target"],
            "targetHash": body["targetHash"],
            "stage": body.get("stage", "R2"),
            "conclusion": "NO_ISSUE",
            "reviewCoverage": [row["obligationId"] for row in body.get("obligations", [])],
            "issues": [],
        })


def main():
    problem = sys.argv[1] if len(sys.argv) > 1 else "求二次代数方程 x^2 - 5x + 6 = 0 的所有实数解"

    client = ParityMathSolverClient()
    agent = user_agent.ReasoningAgent(client=client, engine="ts", max_model_calls=6, max_work_units=4)
    result = agent.solve(problem, {"source": "production_parity_f1"})

    output = {
        "engine": result.get("engine"),
        "status": result.get("status"),
        "finalResponse": result.get("final_response"),
        "candidateVerified": result.get("candidate_verified"),
        "strictAcceptance": result.get("strictAcceptance"),
        "metrics": result.get("metrics", {}),
        "traceKinds": [row.get("kind") for row in result.get("trace", [])],
        "traceStates": [row.get("state") for row in result.get("trace", [])],
    }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
