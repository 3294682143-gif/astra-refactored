"""G4/PR5 Slice 4b — Pi truncated-tool-barrier E08/E09 at the public entry.

Only the injected public client is fake. A WORK reply that is not COMPLETE must
never yield a tool/method action, an artifact or a candidate:
- E08: an explicit ``finish_reason="length"`` (transport TRUNCATED) rejects every
  action in that reply;
- E09: a reply with no ``finish_reason`` (transport UNKNOWN) is conservatively
  banned (COMPLETENESS_UNKNOWN).
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

TOOL_ACTION = json.dumps(
    {
        "action": "tool",
        "name": "polynomial_expand_coefficients",
        "args": {"expression": "2+2", "variables": ["x"], "parameters": []},
        "scope": "expand the supplied polynomial",
    }
)


class BarrierClient(FakeClient):
    """Returns a tool action with a chosen finish_reason (or none)."""

    def __init__(self, finish):
        super().__init__()
        self.finish = finish

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        choice = {"index": 0, "message": {"role": "assistant", "content": TOOL_ACTION}}
        if self.finish is not None:
            choice["finish_reason"] = self.finish
        return {"choices": [choice]}


def _solve(client):
    agent = user_agent.ReasoningAgent(client=client, engine="ts")
    return agent.solve("Compute 2+2", {"source": "e2e"})


def test_e08_length_truncation_rejects_the_tool_action(process_tracker):
    result = _solve(BarrierClient("length"))
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["effect_calls"] == 0
    assert result["candidate_verified"] is False
    assert process_tracker


def test_e09_missing_finish_reason_is_conservatively_banned(process_tracker):
    result = _solve(BarrierClient(None))
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["effect_calls"] == 0
    assert result["candidate_verified"] is False
    assert process_tracker
