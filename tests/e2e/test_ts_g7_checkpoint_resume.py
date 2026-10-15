"""G7/PR7 Slice 7d — cross-process checkpoint/resume at the real engine="ts" entry.

Four rows of the acceptance surface, all offline (the only fake is the injected
public ``FakeClient``; the real Python Host, real Node ``main.js --agent-loop``
profile and the real registered tools run):

* a normal ``local`` resume continues the run under a *tightened* root budget
  and never replays the already-settled model calls;
* the root budget only ever tightens (a widened recovery is refused);
* a cross-problem or tampered checkpoint is a fixed rejection;
* an in-flight ``OUTCOME_UNKNOWN`` request blocks the resume (no auto-replay).
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from python.astra_bridge import host_carriers, host_checkpoint  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

_PROBLEM = "Compute 2+2"


def _agent(mode="local"):
    client = FakeClient()
    return user_agent.ReasoningAgent(client=client, engine="ts", mode=mode), client


def _first_with_checkpoint(mode="local"):
    agent, client = _agent(mode)
    result = agent.solve(_PROBLEM, {"source": "e2e"})
    assert result["carrier"] == mode
    checkpoint = agent._impl.export_checkpoint(_PROBLEM)
    assert checkpoint is not None
    assert checkpoint["schemaVersion"] == host_checkpoint.CHECKPOINT_SCHEMA_VERSION
    # Defect 3: the checkpoint carries the real, non-empty SessionLog sequence
    # and the real accumulated spend (never an empty log / zero effect count).
    assert isinstance(checkpoint["sessionLog"], list) and len(checkpoint["sessionLog"]) >= 1
    assert checkpoint["sessionLog"][0]["seq"] == 1
    assert any(row["kind"] == "FINAL" for row in checkpoint["sessionLog"])
    assert checkpoint["spent"]["modelCalls"] >= 1
    assert checkpoint["spent"]["effectCalls"] >= 0
    return client, checkpoint


def test_local_resume_continues_without_replaying_settled_calls(process_tracker):
    client, checkpoint = _first_with_checkpoint("local")
    first_calls = client.calls
    assert first_calls >= 1

    resumed, resumed_client = _agent("local")
    result = resumed.solve(_PROBLEM, {"source": "e2e"}, resume_checkpoint=checkpoint)

    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["carrier"] == "local"
    # The root budget only tightens: the resumed run may spend at most what the
    # first run left over, so the settled calls are never replayed.
    remaining = max(
        0,
        checkpoint["budget"]["maxModelCalls"] - checkpoint["spent"]["modelCalls"],
    )
    assert resumed_client.calls <= remaining


def test_completed_resume_rebuilds_without_any_model_call(process_tracker):
    """Defect 3(b): a COMPLETE resumed run rebuilds from the log, no new calls."""
    client, checkpoint = _first_with_checkpoint("local")
    assert client.calls >= 1

    resumed, resumed_client = _agent("local")
    result = resumed.solve(_PROBLEM, {"source": "e2e"}, resume_checkpoint=checkpoint)

    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == "4"
    assert result["metrics"]["logical_model_calls"] == 0
    # The settled WORK is never re-issued from the first WORK.
    assert resumed_client.calls == 0


def test_tampered_final_resume_is_rejected_never_forged(process_tracker):
    """Step 2: a resumed log whose FINAL answer was forged is rejected, not trusted."""
    _, checkpoint = _first_with_checkpoint("local")
    forged = copy.deepcopy(checkpoint)
    for row in forged["sessionLog"]:
        if row["kind"] == "FINAL":
            row["data"] = {**row["data"], "finalResponse": "FORGED"}
    forged.pop("digest", None)
    forged["digest"] = host_checkpoint._digest(forged)

    resumed, resumed_client = _agent("local")
    result = resumed.solve(_PROBLEM, {"source": "e2e"}, resume_checkpoint=forged)
    assert result.get("final_response") != "FORGED"
    assert result["status"] == "unsolved"
    assert resumed_client.calls == 0


def test_resume_budget_only_tightens(process_tracker):
    _, checkpoint = _first_with_checkpoint("shared_public")

    # A widened recovery is a fixed rejection; a same-or-tighter one is fine.
    prior = host_carriers.bind_carrier(
        "shared_public", checkpoint["problemHash"], "prior-session",
        "math-agent-preview-v2", max_model_calls=4, max_work_units=3,
        max_effects=2, root_deadline_ms=5000,
    )
    plan = host_checkpoint.resume_plan(checkpoint, prior=prior, session_id="next")
    assert plan["carrier"].max_model_calls == 4
    with pytest.raises(host_checkpoint.CheckpointError) as widened:
        host_checkpoint.resume_plan(
            checkpoint, prior=prior, session_id="next", max_model_calls=8,
        )
    assert widened.value.code == "BUDGET_WIDENED"


def test_cross_problem_and_tampered_checkpoint_are_refused(process_tracker):
    _, checkpoint = _first_with_checkpoint("local")

    tampered = copy.deepcopy(checkpoint)
    tampered["spent"]["modelCalls"] = tampered["spent"]["modelCalls"] + 1
    with pytest.raises(host_checkpoint.CheckpointError) as bad:
        host_checkpoint.verify_checkpoint(
            tampered,
            problem_hash=checkpoint["problemHash"],
            contract_version=checkpoint["contractVersion"],
            mode="local",
        )
    assert bad.value.code == "CHECKPOINT_DIGEST"

    other, _ = _agent("local")
    result = other.solve("Compute 3+5", {"source": "e2e"}, resume_checkpoint=checkpoint)
    assert result["status"] == "unsolved"
    assert result["code"] == "CHECKPOINT_PROBLEM"


def test_outcome_unknown_blocks_resume_instead_of_replaying(process_tracker):
    _, checkpoint = _first_with_checkpoint("local")

    blocked = copy.deepcopy(checkpoint)
    blocked["unknownRequestIds"] = ["model-1"]
    blocked.pop("digest", None)
    blocked["digest"] = host_checkpoint._digest(blocked)

    other, other_client = _agent("local")
    result = other.solve(_PROBLEM, {"source": "e2e"}, resume_checkpoint=blocked)
    assert result["status"] == "unsolved"
    assert result["code"] == "OUTCOME_UNKNOWN"
    # the unknown request is never re-dispatched to the public client
    assert other_client.calls == 0
