"""Real public ``engine="ts"`` entry E2E for the MULTIPART goal class.

Only the injected public client is fake. The real ``user_agent.ReasoningAgent``
path, the real Python Host, the real Node ``main.js --agent-loop`` profile and
the real registered tool executor all run; the legacy Python solvers are
replaced by raising stubs.

A real multi-part problem compiles to ``MULTIPART`` with one leaf sub-goal per
declared sub-question: independent child ``goalId``\\s, one ``SUBGOAL_COVERAGE``
task per child and a root ``OUTPUT_COVERAGE`` task that depends on every cover.
The fixed 4-call/3-unit profile cannot reach the root cover, so this public
entry proves the structural facts it *can* observe (independent child task ids;
no whole-problem candidate from a child) while the full graph shape is asserted
in the TS unit test ``p2-multipart.test.ts``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    FakeClient,
    no_legacy_solver,
    process_tracker,
)

__all__ = ["no_legacy_solver", "process_tracker"]

# Two independently labelled sub-questions: the conservative compiler must
# classify MULTIPART and give each part its own child goal.
MULTIPART_PROBLEM = "Solve both parts: (a) compute 2+2 and (b) compute 3+3"

_BUDGET = {"max_model_calls": 4, "max_work_units": 3, "max_effects": 0}


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


def _work_bodies(client):
    bodies = []
    for messages, _temperature, _max_tokens in client.seen:
        body = json.loads(messages[1]["content"])
        if body.get("stage") != "R2":
            bodies.append(body)
    return bodies


def test_real_multipart_has_independent_child_tasks(process_tracker):
    """A real multi-part problem runs independent child tasks, not one goal."""
    client = FakeClient()
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["engine"] == "ts"
    assert result["childReaped"] is True
    assert process_tracker
    assert process_tracker[0].args[1].endswith("main.js")
    assert process_tracker[0].args[2] == "--agent-loop"
    bodies = _work_bodies(client)
    assert bodies
    task_ids = [body["task"]["taskId"] for body in bodies]
    # Two distinct child identities really appear, so the problem is not run as
    # a single goal-1 chain.
    assert len({task_id.split(":", 1)[0] for task_id in task_ids}) >= 2
    assert any(task_id.startswith("goal-1-a:") for task_id in task_ids)
    assert any(task_id.startswith("goal-1-b:") for task_id in task_ids)


def test_child_answer_is_not_the_whole_problem_candidate(process_tracker):
    """A COMPLETE candidate on a child task never becomes the whole answer.

    ``FakeClient`` answers every WORK turn with a COMPLETE candidate packet, so
    each child task does carry a candidate. Because a child is a local step of
    the MULTIPART root, no whole-problem candidate may be released.
    """
    client = FakeClient()
    result = _solve(client, MULTIPART_PROBLEM, **_BUDGET)
    assert result["status"] != "candidate"
    assert result["final_response"] == "Unsolved."
    assert result["candidate_verified"] is False
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    # No child turn ever protects a whole-problem candidate.
    for body in bodies:
        assert body["protectedCandidate"] is None


def test_single_part_problem_is_not_multipart(process_tracker):
    """A single labelled part is not multi-part and is not split into children."""
    client = FakeClient()
    result = _solve(client, "Compute (a) 2+2", **_BUDGET)
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert not body["task"]["taskId"].startswith("goal-1-a:")


def test_reordered_labels_are_not_multipart(process_tracker):
    """``(b) ... (a) ...`` is not an ordered multi-part statement."""
    client = FakeClient()
    result = _solve(
        client, "Solve both parts: (b) compute 3+3 and (a) compute 2+2", **_BUDGET
    )
    assert result["childReaped"] is True
    assert process_tracker
    bodies = _work_bodies(client)
    assert bodies
    for body in bodies:
        assert not body["task"]["taskId"].startswith("goal-1-a:")
