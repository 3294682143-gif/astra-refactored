"""Inner delivery classification; neither protocol closure nor mathematical truth."""

from dataclasses import dataclass
from enum import Enum

from .tools import parse_tool_proposal

SCHEMA = "math-delivery-v1"


class DeliveryType(str, Enum):
    MATHEMATICAL_ARTIFACT = "MATHEMATICAL_ARTIFACT"
    TOOL_PROPOSAL = "TOOL_PROPOSAL"
    COMPUTATION_NEEDED = "COMPUTATION_NEEDED"
    CONTRACT_OR_BINDING_REPAIR = "CONTRACT_OR_BINDING_REPAIR"
    PARTIAL_OR_BLOCKED = "PARTIAL_OR_BLOCKED"


def classify(unit, text, *, closed=True):
    if not closed:
        return DeliveryType.PARTIAL_OR_BLOCKED
    if unit.kind == "CONTRACT_CLARIFY":
        return DeliveryType.CONTRACT_OR_BINDING_REPAIR
    if text.startswith("COMPUTATION_NEEDED:"):
        return DeliveryType.COMPUTATION_NEEDED
    if text.startswith("TOOL:"):
        if unit.kind in {
            "DERIVE",
            "CHECK",
            "COMPUTE",
            "REPAIR",
        } and parse_tool_proposal(text):
            return DeliveryType.TOOL_PROPOSAL
        return DeliveryType.PARTIAL_OR_BLOCKED
    if unit.kind == "COMPUTE":
        return DeliveryType.PARTIAL_OR_BLOCKED
    return DeliveryType.MATHEMATICAL_ARTIFACT


@dataclass(frozen=True)
class ToolExecutionOutcome:
    parent_task_id: str
    proposal_artifact_id: str
    source_hash: str
    contract_revision: str | None
    target_id: str
    backend: str
    operation: str
    proposal_hash: str
    disposition: str
    effective_deadline: float
    runtime_hash: str = ""
    review_receipt_id: str | None = None
    execution_receipt_id: str | None = None
    observation_id: str | None = None
    output_hash: str | None = None
    evidence_ids: tuple[str, ...] = ()
    evidence_scope: tuple[str, ...] = ()
    remaining_gap: str = ""
    schema: str = "tool-execution-outcome-v1"


def count_fact(store, name, identity, *, task=None, **details):
    """Versioned, replay-idempotent facts; old request counters stay separate."""
    with store.lock:
        node = store.tasks.nodes.get(task)
        goal_key = store.control.get("goal_tasks", {}).get(task)
        goal_job = (
            store.control.get("goal_closure", {})
            .get("scheduler", {})
            .get("jobs", {})
            .get(goal_key, {})
        )
        role = (
            node.unit.kind
            if node
            else store.control.get("artifact_units", {})
            .get(identity, {})
            .get("kind", "LOCAL_CHECK")
        )
        details = {"role": role, "purpose": goal_job.get("purpose"), **details}
        counters = store.control.setdefault(
            "math_delivery_counters", {"schema": "math-delivery-counts-v1", "facts": {}}
        )
        facts = counters["facts"].setdefault(name, {})
        if identity in facts:
            return
        facts[identity] = {"task": task, **details}
        store.event(name, identity=identity, task=task, **details)
