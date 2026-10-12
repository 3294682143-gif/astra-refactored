"""Cross-runtime ECMAScript whitespace parity: real TS entry + real Node parser.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real ``@astra/math-gateway`` ``parseP3Action`` all run. The legacy Python
solvers stay disabled so a hidden fallback surfaces as a failure.

The parity corpus is the ECMAScript ``String.prototype.trim`` boundary: a
``unsolved`` reason of ``U+FEFF`` is empty for Node and must be rejected, while
``U+0085``, ``U+001C`` and ``U+200B`` are not ECMAScript whitespace and must be
accepted. Raw strings are never rewritten: the accepted value keeps its exact
code points.
"""

from __future__ import annotations

import json
import subprocess
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

# (label, reason, legal) — legal means Node's trim leaves a non-empty string.
REASONS = [
    ("feff", "\ufeff", False),
    ("nel", "\u0085", True),
    ("space", " ", False),
    ("fs", "\u001c", True),
    ("zwsp", "\u200b", True),
    ("text", "no route", True),
]


def _solve(client, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(PROBLEM, {"source": "e2e"})


class _ReasonClient(FakeClient):
    """First WORK of the session answers ``unsolved`` with one exact reason."""

    def __init__(self, reason):
        super().__init__()
        self.reason = reason
        self.sent_text = None

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and body.get("sourceRequestId") == "model-1":
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            text = json.dumps(
                {"action": "unsolved", "reason": self.reason},
                ensure_ascii=False, separators=(",", ":"),
            )
            self.sent_text = text
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def _capture_progress(monkeypatch):
    """Capture the Host's own progress projection at solve-result time."""
    from python.astra_bridge import agent_host as host_module
    from python.astra_bridge import agent_progress as progress_module

    seen = []
    base = host_module.AgentHost.on_solve_result

    def wrapper(self, message):
        seen.append(progress_module.progress_events(self.history, self.effects))
        return base(self, message)

    monkeypatch.setattr(host_module.AgentHost, "on_solve_result", wrapper)
    return seen


def _work_bodies(client):
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


@pytest.mark.parametrize("label,reason,legal", REASONS, ids=[row[0] for row in REASONS])
def test_unsolved_reason_whitespace_boundary(label, reason, legal, monkeypatch, process_tracker):
    seen = _capture_progress(monkeypatch)
    client = _ReasonClient(reason)
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=0)
    assert result["childReaped"] is True
    assert result["candidate_verified"] is False
    assert client.sent_text is not None
    # The raw reply is never trimmed or rewritten on the wire.
    assert json.loads(client.sent_text)["reason"] == reason
    assert seen
    events = seen[0]
    if legal:
        assert client.calls == 2
        bodies = _work_bodies(client)
        assert len(bodies) == 2
        assert bodies[0]["task"]["taskId"] != bodies[1]["task"]["taskId"]
        assert len(events) == 1
        assert events[0]["reason"] == "UNSOLVED"
        assert events[0]["sourceRequestId"] == "model-1"
        assert events[0]["taskId"] == bodies[0]["task"]["taskId"]
    else:
        assert client.calls == 1
        assert result["stopReason"] == "PACKET_REJECTED"
        assert result["metrics"]["work_units"] == 0
        assert events == []
    assert process_tracker


_NODE_SCRIPT = """
import { parseP3Action } from "./packages/math-gateway/dist/src/index.js";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out = rows.map((row) => {
  try {
    const value = parseP3Action(row.text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false };
  }
});
process.stdout.write(JSON.stringify(out));
"""


def _node_parse(texts):
    """Run the real Node ``parseP3Action`` over one batch of raw texts."""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", _NODE_SCRIPT],
        input=json.dumps([{"text": text} for text in texts], ensure_ascii=False),
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=10,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


_BINDING = {
    "sessionId": "s",
    "problemHash": "0" * 64,
    "contractVersion": 1,
    "taskId": "t",
    "scopeId": "0" * 64,
    "sourceRequestId": "model-1",
}


def _python_parse(text):
    from python.astra_bridge.p3_host_context import parse_action
    from python.astra_bridge.p0_probe import ProbeError
    from python.astra_bridge.p0_protocol import ProtocolError

    try:
        return True, parse_action(text, dict(_BINDING))
    except (ProbeError, ProtocolError):
        return False, None


def _corpus():
    rows = []
    for label, reason, _legal in REASONS:
        rows.append((
            "unsolved-" + label,
            json.dumps({"action": "unsolved", "reason": reason},
                       ensure_ascii=False, separators=(",", ":")),
        ))
    for label, answer, _legal in REASONS:
        rows.append((
            "final-" + label,
            json.dumps({"action": "final", "answer": answer, "complete": False,
                        "unresolved": []},
                       ensure_ascii=False, separators=(",", ":")),
        ))
    for label, scope, _legal in REASONS:
        rows.append((
            "tool-" + label,
            json.dumps({"action": "tool", "name": "polynomial_expand_coefficients",
                        "args": {"expression": "2+2", "variables": ["x"],
                                 "parameters": []},
                        "scope": scope},
                       ensure_ascii=False, separators=(",", ":")),
        ))
    return rows


def test_python_and_node_parse_action_agree(process_tracker):
    rows = _corpus()
    node = _node_parse([text for _label, text in rows])
    assert len(node) == len(rows)
    for (label, text), row in zip(rows, node):
        accepted, value = _python_parse(text)
        assert accepted is row["ok"], label
        if not accepted:
            continue
        # The accepted value keeps the exact raw string, including U+0085.
        raw = json.loads(text)
        if raw["action"] == "unsolved":
            assert value["reason"] == raw["reason"], label
            assert row["value"]["reason"] == raw["reason"], label
        elif raw["action"] == "final":
            assert value["answer"] == raw["answer"], label
            assert row["value"]["answer"] == raw["answer"], label
        else:
            assert value["scope"] == raw["scope"], label
            assert row["value"]["scope"] == raw["scope"], label
    assert process_tracker


class _BadToolScopeClient(FakeClient):
    """First WORK is a real candidate; the second returns an invalid tool scope."""

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2" and body.get("sourceRequestId") == "model-2":
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            text = json.dumps(
                {"action": "tool", "name": "polynomial_expand_coefficients",
                 "args": {"expression": "2+2", "variables": ["x"],
                          "parameters": []},
                 "scope": "\ufeff"},
                ensure_ascii=False, separators=(",", ":"),
            )
            return {
                "choices": [
                    {"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": text}}
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_invalid_tool_scope_never_yields_and_keeps_candidate(monkeypatch, process_tracker):
    seen = _capture_progress(monkeypatch)
    client = _BadToolScopeClient()
    result = _solve(client, max_model_calls=4, max_work_units=3, max_effects=1,
                    max_reviews=1)
    assert result["childReaped"] is True
    assert result["candidate_verified"] is False
    assert result["metrics"]["effect_calls"] == 0
    assert seen
    assert seen[0] == []
    assert process_tracker
