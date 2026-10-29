"""Scripted remote-model client for Web integration tests.

Only the remote model answer is scripted. Node, the Python Host, the unified
math-asset executor and the BFF all remain the production implementations.
"""
from __future__ import annotations

import json
from typing import Any


class MathAssetScriptedClient:
    def __init__(self, asset_id: str, target: str, input_data: dict[str, Any]) -> None:
        self.asset_id = asset_id
        self.target = target
        self.input_data = input_data
        self.turn = 0
        self.observation_seen = False

    def chat(self, messages, **kwargs):
        self.turn += 1
        body = json.loads(messages[1]["content"])
        schema = body.get("stage") or body.get("schemaVersion")
        if schema in ("R0", "R2", "R4"):
            target = body.get("target") or {}
            target_hash = body.get("targetHash") or body.get("planHash") or ""
            role = body.get("role")
            resp_dict = {
                "schemaVersion": "p4-review-v1",
                "requestId": body.get("requestId", f"model-{self.turn}"),
                "target": target,
                "targetHash": target_hash,
                "stage": schema,
                "conclusion": "NO_ISSUE",
                "reviewCoverage": body.get("reviewCoverage") or [row["obligationId"] for row in body.get("obligations", [])],
                "issues": [],
            }
            if role:
                resp_dict["role"] = role
            return {
                "choices": [{
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps(resp_dict),
                    },
                }]
            }
        observations = body.get("toolObservations", [])
        if observations and any(self.target in str(row) for row in observations):
            self.observation_seen = True

        if not self.observation_seen:
            content = {
                "action": "math_asset",
                "assetId": self.asset_id,
                "target": self.target,
                "input": self.input_data,
            }
        else:
            content = {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": body["task"]["taskId"],
                "goalId": body["task"]["goalId"],
                "scopeId": body["task"]["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": f"Solved {self.target}",
                "derivation": "Verified by math asset observation",
                "assumptions": [],
                "dependencies": [
                    {"artifactId": ref["artifactId"], "artifactVersion": ref["artifactVersion"]}
                    for ref in body["task"].get("inputArtifactRefs", [])
                ],
                "pendingObligations": [],
                "suggestedChecks": [],
                "deliveryStatus": "COMPLETE",
                "candidateProposal": f"Verified result for {self.target}",
            }
        return {
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": json.dumps(content)},
            }]
        }


__all__ = ["MathAssetScriptedClient"]
