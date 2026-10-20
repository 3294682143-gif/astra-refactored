"""Public-entry forced method consultation before candidate delivery."""

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

PROBLEM = "Compute 2+2"


class ForcedMethodClient(FakeClient):
    def __init__(self, method_id):
        super().__init__()
        self.method_id = method_id
        self.method_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "METHOD SELECTION TURN" in system:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.method_turns += 1
            text = json.dumps({"action": "method", "id": self.method_id})
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


def test_forced_method_turn_loads_a_real_card_before_the_answer(process_tracker):
    catalog = fixture_catalog()
    assert catalog["entries"]
    method_id = catalog["entries"][0]["id"]
    client = ForcedMethodClient(method_id)
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
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["metrics"]["method_loads"] == 1
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["logical_model_calls"] == 8
    assert client.method_turns == 1
    # The final answer turn carries the real loaded method asset.
    final_work = [body for (msgs, _t, _m) in client.seen
                  if "METHOD SELECTION TURN" not in msgs[0]["content"]
                  for body in [json.loads(msgs[1]["content"])]
                  if body.get("task", {}).get("taskId") == "goal-1:CANDIDATE_VALIDITY"]
    assert final_work
    assert final_work[-1]["methodAssets"]
    assert process_tracker
