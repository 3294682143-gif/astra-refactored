"""Checkpointed tool ownership, staged R3, bounded local execution and receipts.

The process-wide executor is a local resource valve, never an API quota authority.
Only Controller-created tasks may submit; no model-provided edges are installed.
"""

from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import asdict
from itertools import pairwise
from types import SimpleNamespace

from .delivery_types import ToolExecutionOutcome, count_fact
from .domain import Artifact, Scope, WorkUnit
from .goal_contracts import current
from .runtime.config import fingerprint
from .tools import parse_tool_proposal

LOCAL_EXECUTIONS_MAX = 2
_POOL = ThreadPoolExecutor(
    max_workers=LOCAL_EXECUTIONS_MAX, thread_name_prefix="math-local-tool"
)
TRANSITIONS = {
    "PROPOSED": {"INPUT_ACCEPTED", "REJECTED", "DEADLINE"},
    "INPUT_ACCEPTED": {"REVIEWING", "REJECTED", "DEADLINE"},
    "REVIEWING": {
        "READY_TO_EXECUTE",
        "REJECTED",
        "DEADLINE",
        "INTERRUPTED_WITHOUT_RECEIPT",
    },
    "READY_TO_EXECUTE": {"RUNNING", "DEADLINE", "REJECTED"},
    "RUNNING": {"OBSERVED", "FAILED", "DEADLINE", "INTERRUPTED_WITHOUT_RECEIPT"},
    "OBSERVED": {"ADOPTED", "REJECTED", "DEADLINE"},
    "ADOPTED": set(),
    "REJECTED": set(),
    "FAILED": set(),
    "DEADLINE": set(),
    "INTERRUPTED_WITHOUT_RECEIPT": set(),
}


class ToolJobs:
    def __init__(self, workflow):
        self.workflow = workflow
        self.futures = {}

    @property
    def store(self):
        return self.workflow.store

    def clock(self):
        return self.workflow.clock()

    @property
    def rows(self):
        return self.store.control.setdefault("tool_jobs", {})

    def transition(self, row, state, **data):
        with self.store.lock:
            if state != row["state"] and state not in TRANSITIONS[row["state"]]:
                raise ValueError("illegal tool-job transition")
            row.update(state=state, **data)
            row.setdefault("history", []).append({"state": state, "time": self.clock()})
            self.store.event("tool_job_state", job=row["id"], state=state)
            self.workflow.checkpoint()

    def submit(self, artifact, unit, *, deadline, closing=False):
        from .entrypoint import code_version

        runtime_hash = code_version()
        frozen_runtime = self.store.control.setdefault(
            "tool_flow_runtime_hash", runtime_hash
        )
        if frozen_runtime != runtime_hash:
            raise ValueError("runtime source changed within the tool flow")
        proposal = parse_tool_proposal(artifact.text) if artifact.closed else None
        if proposal is None:
            raise ValueError("tool job requires a closed, explicit proposal")
        contract = current(self.store)
        revision = contract["id"] if contract else None
        backend = "WASI" if proposal.name == "generated_python" else "REGISTERED"
        sandbox = self.workflow.generated_python
        environment = (
            getattr(getattr(sandbox, "sandbox", None), "identity", None)
            if backend == "WASI"
            else fingerprint(self.workflow.executor.registry)
        )
        # Do not give the same mathematical proposal a new identity by changing an ID.
        key = fingerprint(
            (
                self.store.problem.digest,
                revision,
                unit.bottleneck_key,
                asdict(proposal),
                environment,
            )
        )
        with self.store.lock:
            if key not in self.rows:
                row = {
                    "schema": "tool-job-v1",
                    "id": key,
                    "state": "PROPOSED",
                    "parent_task_id": unit.id,
                    "proposal_artifact_id": artifact.id,
                    "proposal_artifact_hash": artifact.digest,
                    "source_hash": self.store.problem.digest,
                    "contract_revision": revision,
                    "target_id": fingerprint(
                        (unit.goal, unit.obligations, asdict(unit.scope))
                    ),
                    "unit": asdict(unit),
                    "backend": backend,
                    "operation": proposal.name,
                    "proposal_hash": fingerprint(asdict(proposal)),
                    "environment_hash": environment,
                    "runtime_hash": runtime_hash,
                    "effective_deadline": deadline,
                    "closing": closing,
                    "consumer_task_id": None,
                    "once_identity": key,
                    "history": [{"state": "PROPOSED", "time": self.clock()}],
                }
                self.rows[key] = row
                self.workflow.checkpoint()
            return self.rows[key]

    def bound_unit(self, row):
        data = dict(row["unit"])
        scope = data["scope"]
        data["scope"] = Scope(
            tuple(scope["conditions"]), scope["domain"], tuple(scope["quantifiers"])
        )
        data["dependencies"] = tuple(data["dependencies"])
        data["obligations"] = tuple(data["obligations"])
        return WorkUnit(**data)

    def valid_binding(self, row):
        from .entrypoint import code_version

        contract = current(self.store)
        sandbox = self.workflow.generated_python
        environment = (
            getattr(getattr(sandbox, "sandbox", None), "identity", None)
            if row["backend"] == "WASI"
            else fingerprint(self.workflow.executor.registry)
        )
        return (
            row["source_hash"] == self.store.problem.digest
            and row["runtime_hash"] == code_version()
            and self.store.artifacts[row["proposal_artifact_id"]].digest
            == row["proposal_artifact_hash"]
            and row["environment_hash"] == environment
            and row["contract_revision"] == (contract["id"] if contract else None)
            and self.store.control.get("artifact_contracts", {}).get(
                row["proposal_artifact_id"], row["contract_revision"]
            )
            == row["contract_revision"]
            and not self.store.control.get("goal_closure_closed")
            and not set(row["unit"]["dependencies"])
            & (self.store.refuted | self.store.invalid_proofs)
        )

    def outcome(self, row):
        observation = self.store.artifacts.get(row.get("observation_id"))
        evidence = tuple(
            e
            for e in self.store.evidence.values()
            if observation and e.artifact_id == observation.id
        )
        return ToolExecutionOutcome(
            **{
                k: row[k]
                for k in (
                    "parent_task_id",
                    "proposal_artifact_id",
                    "source_hash",
                    "contract_revision",
                    "target_id",
                    "backend",
                    "operation",
                    "proposal_hash",
                    "effective_deadline",
                    "runtime_hash",
                )
            },
            disposition="EXECUTED"
            if row["state"] in {"OBSERVED", "ADOPTED"}
            else "PENDING"
            if row["state"]
            in {
                "PROPOSED",
                "INPUT_ACCEPTED",
                "REVIEWING",
                "READY_TO_EXECUTE",
                "RUNNING",
            }
            else row["state"],
            review_receipt_id=row.get("review_receipt_id"),
            execution_receipt_id=row.get("execution_receipt_id"),
            observation_id=observation.id if observation else None,
            output_hash=observation.digest if observation else None,
            evidence_ids=tuple(e.id for e in evidence),
            evidence_scope=tuple(e.property for e in evidence),
            remaining_gap=row.get(
                "remaining_gap",
                "interpret output under original mapping; completeness not established",
            ),
        )

    def advance(self, row, artifact, unit):
        state = row["state"]
        if not TRANSITIONS[state] or state == "OBSERVED":
            return self.outcome(row)
        if state == "RUNNING":
            future = self.futures.get(row["id"])
            if future is None:
                self.transition(
                    row,
                    "INTERRUPTED_WITHOUT_RECEIPT",
                    remaining_gap="started execution has no committed completion; not replayed",
                )
            elif future.done():
                try:
                    observation = future.result()
                except Exception as exc:  # noqa: BLE001 - durable interrupted receipt, never replay or promote
                    self.transition(
                        row,
                        "INTERRUPTED_WITHOUT_RECEIPT",
                        remaining_gap="worker exception without committed completion: "
                        + type(exc).__name__,
                    )
                else:
                    receipt = next(
                        (
                            e["details"]["result"]
                            for e in reversed(self.store.events)
                            if e["kind"] == "tool_result"
                            and e["details"].get("target") == artifact.id
                        ),
                        None,
                    )
                    if receipt is not None:
                        row["execution_receipt_id"] = fingerprint(
                            (row["id"], receipt, row["effective_deadline"])
                        )
                        row["execution_status"] = receipt["status"]
                        count_fact(
                            self.store,
                            "execution_completed",
                            row["id"],
                            task=unit.id,
                            receipt=row["execution_receipt_id"],
                            backend=row["backend"],
                            status=receipt["status"],
                        )
                    if observation.id == artifact.id:
                        self.transition(
                            row,
                            "FAILED",
                            remaining_gap="execution did not produce a usable output; see tool failure receipt",
                        )
                    elif self.clock() >= row["effective_deadline"]:
                        self.transition(
                            row,
                            "DEADLINE",
                            remaining_gap="late output retained but not adopted",
                        )
                    elif not self.valid_binding(row):
                        self.transition(
                            row,
                            "FAILED",
                            remaining_gap="source/contract/dependency binding changed during execution",
                        )
                    else:
                        self.transition(row, "OBSERVED", observation_id=observation.id)
                        from .computation_results import ingest_execution

                        ingest_execution(self.store, row, observation)
                self.futures.pop(row["id"], None)
            return self.outcome(row)
        if self.clock() >= row["effective_deadline"]:
            self.transition(
                row, "DEADLINE", remaining_gap="original tool group deadline exhausted"
            )
        elif not self.valid_binding(row):
            self.transition(
                row,
                "REJECTED",
                remaining_gap="source/contract/dependency binding changed",
            )
        elif state == "REVIEWING":
            self.transition(
                row,
                "INTERRUPTED_WITHOUT_RECEIPT",
                remaining_gap="R3 started without a committed receipt; not replayed",
            )
        elif state in {"PROPOSED", "INPUT_ACCEPTED"}:
            if state == "PROPOSED":
                # Backend preflight must actually succeed before input acceptance.
                problem = self.workflow.preflight(artifact, unit)
                if problem:
                    from .domain import FailureRecord

                    self.store.failures.append(
                        FailureRecord(artifact.id, "tool_preflight_rejected")
                    )
                    self.store.event(
                        "tool_preflight_failed",
                        target=artifact.id,
                        reason=problem,
                        no_model_review=True,
                    )
                    self.transition(row, "REJECTED", remaining_gap=problem)
                    return self.outcome(row)
                self.transition(row, "INPUT_ACCEPTED")
                count_fact(
                    self.store,
                    "proposal_valid",
                    row["id"],
                    task=unit.id,
                    backend=row["backend"],
                )
            self.transition(row, "REVIEWING")
            report = self.workflow._process(
                artifact,
                unit,
                deadline=row["effective_deadline"],
                closing=row["closing"],
                _review_only=True,
            )
            if isinstance(report, Artifact):
                self.transition(
                    row,
                    "REJECTED",
                    remaining_gap="R3 or input rejected; execution not started",
                )
            elif self.clock() >= row["effective_deadline"]:
                self.transition(
                    row, "DEADLINE", remaining_gap="R3 exceeded original group window"
                )
            else:
                reviewed_request = next(
                    (
                        e["details"].get("request")
                        for e in reversed(self.store.events)
                        if e["kind"] == "review"
                        and e["details"].get("position") == "R3"
                        and e["details"].get("target") == artifact.id
                        and e["details"].get("complete")
                    ),
                    None,
                )
                receipt = {
                    "complete": report.complete,
                    "interpretation": report.interpretation,
                    "finding": None,
                    "request_id": reviewed_request,
                }
                self.transition(
                    row,
                    "READY_TO_EXECUTE",
                    review=receipt,
                    review_request_id=reviewed_request,
                    review_receipt_id=fingerprint((row["id"], receipt)),
                )
        elif state == "READY_TO_EXECUTE":
            self.transition(row, "RUNNING")
            self.futures[row["id"]] = _POOL.submit(
                self.workflow._process,
                artifact,
                unit,
                deadline=row["effective_deadline"],
                closing=row["closing"],
                _reviewed=SimpleNamespace(**row["review"]),
            )
        return self.outcome(row)

    def wait_for_local(self, timeout=0.1):
        if self.futures:
            wait(tuple(self.futures.values()), timeout=timeout)


def validate_saved_jobs(store):
    """Read-only recovery gate; a saved state bit is not an execution receipt."""
    for key, row in store.control.get("tool_jobs", {}).items():
        if (
            row.get("schema") != "tool-job-v1"
            or row.get("id") != key
            or row.get("state") not in TRANSITIONS
            or row.get("source_hash") != store.problem.digest
            or row.get("runtime_hash") != store.control.get("tool_flow_runtime_hash")
        ):
            raise ValueError("tool job schema/source identity mismatch")
        artifact = store.artifacts.get(row.get("proposal_artifact_id"))
        proposal = parse_tool_proposal(artifact.text) if artifact else None
        if (
            not artifact
            or not proposal
            or artifact.digest != row.get("proposal_artifact_hash")
            or fingerprint(asdict(proposal)) != row.get("proposal_hash")
        ):
            raise ValueError("saved tool proposal changed")
        history = row.get("history", [])
        if (
            not history
            or history[0]["state"] != "PROPOSED"
            or history[-1]["state"] != row["state"]
        ):
            raise ValueError("saved tool state has no transition history")
        for before, after in pairwise(history):
            if after["state"] != before["state"] and after[
                "state"
            ] not in TRANSITIONS.get(before["state"], ()):
                raise ValueError("illegal saved tool transition")
        if row["state"] in {"OBSERVED", "ADOPTED"}:
            result = store.control.get("computation_results", {}).get(
                row.get("observation_id"), {}
            )
            observation = store.artifacts.get(row.get("observation_id"))
            if (
                not observation
                or result.get("artifact_hash") != observation.digest
                or not row.get("review_receipt_id")
                or not row.get("execution_receipt_id")
                or result.get("execution_receipt_id") != row["execution_receipt_id"]
            ):
                raise ValueError("saved observed execution lacks bound receipts")
        if row["state"] == "ADOPTED":
            consumer = store.artifacts.get(row.get("adoption_artifact_id"))
            if (
                not consumer
                or consumer.work_unit != row.get("consumer_task_id")
                or row["observation_id"] not in consumer.dependencies
            ):
                raise ValueError("saved adoption has no actual consumer dependency")
