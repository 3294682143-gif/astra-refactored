"""E2E: a failed math asset must feed its real input contract back to the model."""

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


class _InvalidAssetClient(FakeClient):
    """Ask for one asset with an invalid parameter, then answer normally."""

    def __init__(self):
        super().__init__()
        self.asset_turn = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if self.asset_turn == 0:
            self.asset_turn += 1
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "action": "math_asset",
                                    "assetId": "math.linear-algebra",
                                    "target": "gf2_rank",
                                    "input": {"rows": "not-a-row-list"},
                                }
                            ),
                        },
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_failed_asset_observation_carries_the_canonical_input_contract(
    process_tracker,
):
    client = _InvalidAssetClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=2,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(
        "Compute the GF(2) rank of the supplied rows.",
        {"source": "e2e"},
    )

    assert result["status"] == "candidate"
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["tool_effect_calls"] == 1
    failures = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        for row in body.get("toolObservations", []):
            observation = json.loads(row["observation"])
            if "effectFailure" in observation:
                failures.append(observation["effectFailure"])
    assert failures, "the failed asset must produce an ERROR observation"
    failure = failures[0]
    assert failure["status"] == "NEEDS_INPUT"
    assert failure["receivedInputKeys"] == ["rows"]
    contract = failure["inputContract"]
    assert contract["assetId"] == "math.linear-algebra"
    assert any(
        behavior["target"] == "gf2_rank"
        and "rows" in behavior["requiredParams"]
        for behavior in contract["behaviors"]
    )
    assert process_tracker
