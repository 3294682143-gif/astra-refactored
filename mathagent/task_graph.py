"""Controller-owned incremental DAG. Structural readiness never grants truth."""

from __future__ import annotations

import threading
from dataclasses import asdict, dataclass, replace
from typing import ClassVar

from .domain import Scope, WorkUnit
from .policy import WORKFLOW_DEFAULTS


@dataclass(frozen=True)
class TaskNode:
    unit: WorkUnit
    parents: tuple[str, ...] = ()
    state: str = "READY"
    output: str | None = None
    attempt: int = 0
    conditional: bool = False
    prior_output: str | None = None


class TaskGraph:
    STATES: ClassVar = {
        "READY",
        "RUNNING",
        "DELIVERED",
        "COMPLETE",
        "WAITING_CHALLENGE",
        "WAITING_TOOL",
        "WAITING_ADOPTION",
        "PAUSED",
        "FAILED",
    }

    def __init__(self, lock=None):
        self.lock = lock or threading.RLock()
        self.nodes: dict[str, TaskNode] = {}
        self.max_nodes = 256
        self.external_ids = lambda: ()

    def add(self, unit: WorkUnit, parents=()):
        with self.lock:
            parents = tuple(parents)
            if (
                not unit.id
                or not unit.route
                or not unit.goal.strip()
                or not unit.obligations
            ):
                raise ValueError("task requires identity, route, goal and obligations")
            if len(unit.goal) > 5000 or len(set(parents)) != len(parents):
                raise ValueError("ambiguous task or duplicate parents")
            if unit.id in self.nodes:
                existing = self.nodes[unit.id]
                if existing.unit != unit or existing.parents != parents:
                    raise ValueError("immutable task definition collision")
                return existing
            if any(p not in self.nodes or p == unit.id for p in parents):
                raise ValueError(
                    "parents must precede child; cycles/forward references rejected"
                )
            if (
                len(set(self.nodes) | set(self.external_ids()) | {unit.id})
                > self.max_nodes
            ):
                raise ValueError("problem task graph resource bound")
            node = TaskNode(
                unit,
                parents,
                conditional=any(self.nodes[p].conditional for p in parents),
            )
            self.nodes[unit.id] = node
            return node

    def update(self, task_id, **changes):
        with self.lock:
            if changes.get("state", "READY") not in self.STATES:
                raise ValueError("unknown task state")
            if set(changes) - {
                "state",
                "output",
                "attempt",
                "conditional",
                "prior_output",
            }:
                raise ValueError("task definition is immutable")
            self.nodes[task_id] = replace(self.nodes[task_id], **changes)
            return self.nodes[task_id]

    def descendants(self, task_id):
        with self.lock:
            affected = {task_id}
            while True:
                expanded = affected | {
                    k for k, n in self.nodes.items() if set(n.parents) & affected
                }
                if expanded == affected:
                    return affected - {task_id}
                affected = expanded

    def route_nodes(self, route):
        with self.lock:
            return tuple(n for n in self.nodes.values() if n.unit.route == route)

    def bind(self, task_id, store):
        with self.lock:
            node = self.nodes[task_id]
            dependencies = list(node.unit.dependencies)
            for parent_id in node.parents:
                parent = self.nodes[parent_id]
                if parent.state != "COMPLETE" or parent.output is None:
                    raise ValueError("parent task has no complete delivery")
                dependencies.append(parent.output)
            dependencies = tuple(dict.fromkeys(dependencies))
            store.context(node.unit.route, node.unit.scope, dependencies)
            progress = store.control.get("progress", {})
            key = progress.get("identities", {}).get(
                node.unit.id, node.unit.bottleneck_key
            )
            budget_degraded = node.unit.kind == "DERIVE" and store.control.get(
                "exploration_deprioritized", {}
            ).get(key, False)
            return replace(
                node.unit,
                dependencies=dependencies,
                priority=max(node.unit.priority, WORKFLOW_DEFAULTS.conditional_priority)
                if node.conditional
                or budget_degraded
                or any(self.nodes[p].conditional for p in node.parents)
                else node.unit.priority,
            )

    def ready(self, store, route=None):
        with self.lock:
            ready = []
            for task_id, node in self.nodes.items():
                if node.state != "READY" or (
                    route is not None and node.unit.route != route
                ):
                    continue
                try:
                    bound = self.bind(task_id, store)
                except (ValueError, KeyError):
                    continue
                ready.append(bound)
            return sorted(
                ready,
                key=lambda u: (
                    u.priority,
                    u.kind not in {"CHECK", "COMPUTE", "REPAIR", "CANDIDATE"},
                    u.id,
                ),
            )

    def pause_for_artifact(self, artifact_id, store):
        with self.lock:
            affected = store.affected(artifact_id)
            paused = []
            for task_id, node in tuple(self.nodes.items()):
                parent_outputs = {self.nodes[p].output for p in node.parents}
                if (
                    node.output in affected
                    or affected & (set(node.unit.dependencies) | parent_outputs)
                ) and node.state in {"READY", "DELIVERED"}:
                    self.update(task_id, state="WAITING_CHALLENGE")
                    paused.append(task_id)
            return paused

    def release_challenge(self, task_ids, *, conditional):
        with self.lock:
            for task_id in task_ids:
                node = self.nodes[task_id]
                if node.state == "WAITING_CHALLENGE":
                    self.update(
                        task_id,
                        state="DELIVERED" if node.output else "READY",
                        conditional=conditional,
                    )

    def reopen_invalidated(self, store):
        with self.lock:
            reopened = []
            for task_id, node in tuple(self.nodes.items()):
                if node.output in store.invalid_proofs and node.state in {
                    "COMPLETE",
                    "DELIVERED",
                    "WAITING_CHALLENGE",
                }:
                    self.update(
                        task_id,
                        state="READY",
                        prior_output=node.output,
                        output=None,
                        attempt=node.attempt + 1,
                        conditional=True,
                    )
                    reopened.append(task_id)
            return reopened

    def recover(self, store):
        """Never replay an uncertain or spent generation. Coordinator checks leases first."""
        from .tool_jobs import validate_saved_jobs

        validate_saved_jobs(store)
        with self.lock:
            lost = []
            for task_id, node in tuple(self.nodes.items()):
                if node.output is not None:
                    artifact = store.artifacts.get(node.output)
                    origin = artifact
                    seen = set()
                    while (
                        origin is not None
                        and origin.work_unit != task_id
                        and origin.id not in seen
                    ):
                        consumer = store.control.get("tool_consumers", {}).get(
                            origin.work_unit
                        )
                        job = store.control.get("tool_jobs", {}).get(consumer, {})
                        if (
                            job.get("parent_task_id") == task_id
                            and job.get("state") == "ADOPTED"
                            and job.get("adoption_artifact_id") == origin.id
                        ):
                            origin = store.artifacts.get(job["proposal_artifact_id"])
                            continue
                        seen.add(origin.id)
                        parent = origin.parent_revision
                        if (
                            parent is None
                            and origin.request
                            in {"local_registered_tool", "local_generated_python"}
                            and len(origin.dependencies) == 1
                        ):
                            parent = origin.dependencies[0]
                        origin = store.artifacts.get(parent)
                    if (
                        artifact is None
                        or origin is None
                        or origin.work_unit != task_id
                    ):
                        raise ValueError(
                            "task output does not bind its stored work unit"
                        )
                    if node.state == "COMPLETE" and not artifact.closed:
                        raise ValueError("completed task cannot bind partial output")
                if node.state == "RUNNING":
                    if node.output is not None:
                        self.update(task_id, state="DELIVERED")
                    else:
                        self.update(task_id, state="FAILED")
                        lost.append(task_id)
                elif node.state == "WAITING_CHALLENGE":
                    self.update(
                        task_id,
                        state="DELIVERED" if node.output else "READY",
                        conditional=True,
                    )
            return lost

    def snapshot(self):
        with self.lock:
            return [asdict(n) for n in self.nodes.values()]

    def restore(self, rows):
        for row in rows:
            data = dict(row["unit"])
            scope = data["scope"]
            data["scope"] = Scope(
                tuple(scope["conditions"]), scope["domain"], tuple(scope["quantifiers"])
            )
            data["dependencies"] = tuple(data["dependencies"])
            data["obligations"] = tuple(data["obligations"])
            unit = WorkUnit(**data)
            self.add(unit, row["parents"])
            self.update(
                unit.id,
                **{
                    key: row[key]
                    for key in (
                        "state",
                        "output",
                        "attempt",
                        "conditional",
                        "prior_output",
                    )
                },
            )


def proposed_followups(text):
    """Accept bounded local labels, never model-provided internal IDs or graph edges."""
    from .content_fields import fields

    entries = fields(text, [r"NEXT\s+[1-3]", "NEXT", "JOIN"])
    nexts = [(key, value) for key, value in entries if key.startswith("NEXT")]
    joins = [value for key, value in entries if key == "JOIN"]
    if not nexts or len(joins) > 1:
        return (), None
    labels = [key for key, _ in nexts]
    if labels != ["NEXT"] and labels != [f"NEXT {i + 1}" for i in range(len(labels))]:
        return (), None
    if not all(0 < len(value) <= 2000 for _, value in entries):
        return (), None
    return tuple(value for _, value in nexts), joins[0] if joins else None
