"""Final-delivery anchoring: the Node-chosen source must stay ACTIVE.

Regression for agent_host.py:1824 (idx28/29/40/62/86/93 in test0 v12/v13): the
Host's independent crowning superseded the source the Node delivered, so the
final provenance check found no row. The final check now anchors the projection
to the delivered candidate; forgery checks are unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path

from python.astra_bridge.agent_context import candidate_packet
from python.astra_bridge.agent_history import project_artifacts

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "final_anchor_history.json"


def _data():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_unanchored_crowning_supersedes_the_node_source():
    data = _data()
    proj = project_artifacts(data["history"], data["sessionId"], data["problemHash"])
    assert "model-14" not in proj["bySourceRef"]
    assert "model-15" in proj["bySourceRef"]


def test_anchored_delivery_row_is_active_and_latest():
    data = _data()
    proj = project_artifacts(data["history"], data["sessionId"], data["problemHash"], "model-14")
    row = proj["bySourceRef"].get("model-14")
    assert isinstance(row, dict)
    assert row["availability"] == "ACTIVE"
    latest = None
    for other in proj["rows"]:
        if other["artifactId"] != row["artifactId"]:
            continue
        if latest is None or other["envelope"]["artifactVersion"] > latest["envelope"]["artifactVersion"]:
            latest = other
    assert latest is row


def test_candidate_packet_forgery_boundary_is_unchanged():
    data = _data()
    packet = candidate_packet(data["history"], "model-14", data["problem"], data["sessionId"], data["problemHash"])
    assert packet is not None
    assert isinstance(packet["candidateProposal"], str) and packet["candidateProposal"]
    assert candidate_packet(data["history"], "model-99", data["problem"], data["sessionId"], data["problemHash"]) is None
