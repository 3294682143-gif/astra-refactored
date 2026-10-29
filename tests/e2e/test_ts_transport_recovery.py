"""The host-side transport classifier stays strict about completeness.

These two cases pin the boundary that the strict client keeps:

* an envelope with **empty** assistant text and no ``finish_reason`` is an
  OUTCOME_UNKNOWN: the run ends unsolved, the adapter is blocked and nothing is
  fabricated;
* an envelope missing ``finish_reason`` but carrying real text is *also*
  UNKNOWN under the audited rule ("a reply without a terminal reason bans
  actions"), so no tool, route, method, final or yield is ever derived from it.

A provider that drops ``finish_reason`` is handled one layer below this
boundary: the injected client seam re-asks the same provider request (bounded,
never the same Host request id twice), exactly like an HTTP 5xx retry, so the
Host still sees one dispatched call per request.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import (  # noqa: E402
    PROBLEM,
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]


def _solve(client, **kwargs):
    kwargs.setdefault("max_model_calls", 8)
    kwargs.setdefault("max_work_units", 4)
    kwargs.setdefault("max_effects", 0)
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


class NoFinishReasonClient(FakeClient):
    """Every reply omits ``finish_reason`` but carries real assistant text."""

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        body = json.loads(messages[1]["content"])
        text = self._review(body) if body.get("stage") == "R2" else self._work(body)
        return {
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": text}}
            ]
        }


class EmptyReplyClient(FakeClient):
    """Every reply is an envelope with no text and no ``finish_reason``."""

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        self.seen.append((messages, temperature, max_tokens))
        self.calls += 1
        return {
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": ""}}
            ]
        }


def test_missing_finish_reason_bans_actions_and_stays_unknown(process_tracker):
    client = NoFinishReasonClient()
    result = _solve(client, problem_seconds=60)
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["remote_outcome_unknown"] is True
    assert result["metrics"]["effect_calls"] == 0
    assert result["metrics"]["review_calls"] == 0
    states = [row["state"] for row in result["trace"] if row["kind"] == "MODEL"]
    assert states == ["DISPATCHED", "OUTCOME_UNKNOWN"]
    assert client.calls == 1
    assert process_tracker


def test_empty_reply_without_finish_reason_stays_unknown(process_tracker):
    client = EmptyReplyClient()
    result = _solve(client, problem_seconds=60)
    assert result["status"] == "unsolved"
    assert result["final_response"] == "Unsolved."
    assert result["metrics"]["remote_outcome_unknown"] is True
    states = [row["state"] for row in result["trace"] if row["kind"] == "MODEL"]
    assert states[-1] == "OUTCOME_UNKNOWN"
    assert process_tracker
