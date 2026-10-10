"""R3 mapping review and typed tool observation; never promotes a mapping."""

import copy
import json
import time
from dataclasses import asdict, replace

from ..domain import Artifact, FailureRecord, Scope
from ..input_contracts import validate_inputs
from ..review_context import ReviewContext
from ..runtime.config import fingerprint
from ..tool_contracts import (
    CONTRACTS,
    InvalidToolInput,
    OutsideAuditScope,
    normalize_inputs,
)
from ..tool_feedback import rejection_key
from ..tool_input_evidence import record_input_evidence
from ..tool_mapping import mapped_value, register_mapping
from ..tools import parse_tool_proposal
from .ports import ArtifactProcessor


class ToolWorkflow:
    def __init__(
        self,
        *,
        store,
        budget,
        review,
        executor,
        process_challenge: ArtifactProcessor,
        generated_python=None,
        checkpoint=None,
        clock=None,
    ):
        self.store, self.budget, self.review = store, budget, review
        self.executor, self.process_challenge = executor, process_challenge
        self.generated_python = generated_python
        self.checkpoint = checkpoint or (lambda: None)
        self.clock = clock or getattr(review, "clock", time.monotonic)
        from ..tool_jobs import ToolJobs

        self.jobs = ToolJobs(self)

    def preflight(self, artifact, unit):
        proposal = parse_tool_proposal(artifact.text)
        if proposal is None or unit.kind not in {
            "DERIVE",
            "CHECK",
            "COMPUTE",
            "REPAIR",
        }:
            return "not an executable proposal for this task"
        rejected = self.store.control.get("rejected_tool_proposals", {}).get(
            rejection_key(self.store, unit, proposal)
        )
        if rejected is not None:
            prior = self.store.control["tool_failure_details"][rejected]
            self.reject_input(
                artifact, unit, proposal, "RepeatedRejectedProposal", prior["message"]
            )
            return "RepeatedRejectedProposal: " + prior["message"]
        if proposal.name == "generated_python":
            if not self.generated_python:
                return "generated_python_unavailable"
            return self.generated_python.preflight(proposal)
        if proposal.name not in self.executor.registry:
            return "tool_unavailable"
        operation = self.store.control.get("task_operations", {}).get(unit.id, {})
        if proposal.name == "solve_system_guarded_expr" and operation.get(
            "expected_artifact", ""
        ).lower() in {"solution_set", "candidates", "parameter_conditions"}:
            self.reject_input(
                artifact,
                unit,
                proposal,
                "OutputContractMismatch",
                "this registered interface returns isolated-real-solution counts, not the required solution set or parameter conditions",
            )
            return "OutputContractMismatch"
        try:
            validate_inputs(proposal.name, proposal.args)
            if proposal.name in CONTRACTS:
                normalize_inputs(proposal.name, proposal.args)
        except (InvalidToolInput, OutsideAuditScope, ValueError, TypeError) as exc:
            self.reject_input(artifact, unit, proposal, type(exc).__name__, str(exc))
            return type(exc).__name__ + ": " + str(exc)
        if proposal.name in {
            "polynomial_expand_coefficients",
            "linear_system_solution_set",
        }:
            from ..computation_policy import choose_backend

            selection = choose_backend(
                {
                    "operation": proposal.name,
                    "inputs": proposal.args,
                    "domain": proposal.domain,
                    "expected_artifact": "coefficient_table"
                    if proposal.name == "polynomial_expand_coefficients"
                    else "solution_set",
                    "bounds": self.executor.registry[proposal.name].get("limits"),
                    "check_scope": "exact_for_input",
                    "mapping": proposal.mapping,
                }
            )
            self.store.event(
                "computation_backend_selected",
                task=unit.id,
                **selection,
                basis="actual input/output/check contract",
            )
        return ""

    def process_outcome(
        self, artifact, unit, *, closing=False, deadline=None, step=False
    ):
        from ..delivery_types import ToolExecutionOutcome

        stage = self.budget.finish_end if closing else self.budget.solving_end
        deadline = min(stage, deadline) if deadline is not None else stage
        if not artifact.closed or not parse_tool_proposal(artifact.text):
            return ToolExecutionOutcome(
                unit.id,
                artifact.id,
                self.store.problem.digest,
                None,
                "",
                "",
                "",
                "",
                "NO_PROPOSAL",
                deadline,
            )
        if unit.kind not in {"DERIVE", "CHECK", "COMPUTE", "REPAIR"}:
            return ToolExecutionOutcome(
                unit.id,
                artifact.id,
                self.store.problem.digest,
                None,
                "",
                "",
                "",
                "",
                "REJECTED",
                deadline,
                remaining_gap="task cannot execute tools",
            )
        row = self.jobs.submit(artifact, unit, deadline=deadline, closing=closing)
        if fingerprint(row["unit"]) != fingerprint(asdict(unit)):
            return replace(
                self.jobs.outcome(row),
                disposition="REJECTED",
                remaining_gap="a spent proposal cannot be rebound to another task/dependency identity",
            )
        if step:
            return self.jobs.outcome(row)
        while True:
            result = self.jobs.advance(row, artifact, unit)
            if result.disposition != "PENDING":
                return result
            self.jobs.wait_for_local()

    def process(self, artifact, unit, *, closing=False, deadline=None):
        """Compatibility entry; omitted deadline retains the previous synchronous API.

        Controller routes, challenges and closeout use process_artifact/outcome.
        Real executors enforce their stage deadline even in this legacy adapter.
        """
        if deadline is None:
            return self._process(artifact, unit, closing=closing)
        return self.process_artifact(artifact, unit, closing=closing, deadline=deadline)

    def process_artifact(self, artifact, unit, *, closing=False, deadline=None):
        """Artifact-facing adapter around the common typed production dispatcher."""
        result = self.process_outcome(
            artifact, unit, closing=closing, deadline=deadline
        )
        if (
            result.disposition == "REJECTED"
            and unit.kind != "COMPUTE"
            and any(
                f.target == artifact.id and f.reason == "tool_mapping_unresolved"
                for f in self.store.failures
            )
        ):
            return self.process_challenge(artifact, unit)
        return self.store.artifacts.get(result.observation_id, artifact)

    def reject_input(self, artifact, unit, proposal, kind, message):
        feedback = {
            "tool": proposal.name,
            "args": copy.deepcopy(proposal.args),
            "original_task": unit.goal,
            "failure_kind": kind,
            "message": message[:500],
            "supported_scope": CONTRACTS.get(
                proposal.name, ("", "see registered input schema")
            )[1],
            "route": unit.route,
            "problem": self.store.problem.digest,
        }
        with self.store.lock:
            self.store.failures.append(
                FailureRecord(artifact.id, "tool_input_contract")
            )
            self.store.control.setdefault("tool_failure_details", {})[artifact.id] = (
                feedback
            )
            self.store.control.setdefault("rejected_tool_proposals", {})[
                rejection_key(self.store, unit, proposal)
            ] = artifact.id
            self.store.event(
                "tool_preflight_failed",
                target=artifact.id,
                reason=kind,
                no_model_review=True,
            )
            self.store.event("tool_failure_feedback", target=artifact.id, **feedback)
            self.checkpoint()
        return artifact

    def _process(
        self,
        artifact,
        unit,
        *,
        closing=False,
        deadline=None,
        _review_only=False,
        _reviewed=None,
    ):
        enforce_deadline = deadline is not None
        stage = self.budget.finish_end if closing else self.budget.solving_end
        deadline = min(stage, deadline) if deadline is not None else stage
        proposal = parse_tool_proposal(artifact.text) if artifact.closed else None
        if proposal is None:
            return artifact
        with self.store.lock:
            seen = self.store.control.setdefault("tool_proposals_seen", [])
            if artifact.id not in seen:
                seen.append(artifact.id)
                self.store.event(
                    "tool_proposed", target=artifact.id, proposal=asdict(proposal)
                )
        if proposal.name == "generated_python" and self.generated_python is not None:
            return self.generated_python.process(
                artifact,
                unit,
                proposal,
                closing=closing,
                deadline=deadline,
                _review_only=_review_only,
                _reviewed=_reviewed,
                _enforce_deadline=enforce_deadline,
            )
        if proposal.name not in self.executor.registry:
            self.store.failures.append(FailureRecord(artifact.id, "tool_unavailable"))
            self.store.event(
                "tool_unavailable",
                proposed_tool=proposal.name,
                action="general_work_unit",
            )
            return artifact
        rejected = self.store.control.get("rejected_tool_proposals", {}).get(
            rejection_key(self.store, unit, proposal)
        )
        if rejected is not None:
            prior = self.store.control["tool_failure_details"][rejected]
            return self.reject_input(
                artifact, unit, proposal, "RepeatedRejectedProposal", prior["message"]
            )
        key = fingerprint((artifact.digest, asdict(proposal), asdict(unit)))
        receipts = self.store.control.setdefault("registered_tool_receipts", {})
        previous = receipts.get(key)
        if previous:
            observation = self.store.artifacts.get(previous.get("observation"))
            if observation is not None:
                return observation
            self.store.event(
                "registered_tool_not_replayed",
                target=artifact.id,
                state=previous["state"],
            )
            self.store.failures.append(
                FailureRecord(
                    artifact.id, "tool_previous_execution_without_observation"
                )
            )
            return artifact
        try:
            input_contract = validate_inputs(proposal.name, proposal.args)
            if proposal.name in CONTRACTS:
                normalize_inputs(proposal.name, proposal.args)
        except (InvalidToolInput, OutsideAuditScope) as exc:
            return self.reject_input(
                artifact, unit, proposal, type(exc).__name__, str(exc)
            )
        spec = self.executor.registry[proposal.name]
        self.store.event(
            "tool_preflight",
            target=artifact.id,
            tool=proposal.name,
            status="INPUT_CONTRACT_ACCEPTED",
        )
        checked_property, checked_scope = CONTRACTS.get(
            proposal.name, ("unknown", "unknown")
        )
        contract = {
            "name": proposal.name,
            "declared_scope": spec.get("declared_scope", "UNKNOWN"),
            "required_params": spec.get("required_params", []),
            "optional_params": spec.get("optional_params", []),
            "limits": spec.get("limits", []),
            "checked_property": checked_property,
            "checked_scope": checked_scope,
            "execution_input_schema": input_contract.get(
                "schema", "delegated independent input checks"
            ),
            "cannot_establish": "No original-problem mapping or universal claim outside this input/scope is certified; numerical/conjecture/witness checks are not exact proofs.",
        }
        context = ReviewContext(
            task=unit.goal,
            contract=json.dumps(contract, ensure_ascii=False, default=str),
            mapping=json.dumps(
                {
                    "purpose": proposal.purpose,
                    "args": proposal.args,
                    "domain": proposal.domain,
                    "mapping": proposal.mapping,
                    "target_obligations": unit.obligations,
                },
                ensure_ascii=False,
            ),
            conditions=f"{unit.scope}; provisional dependencies: {bool(artifact.unverified_dependencies)}",
            bindings=(artifact.digest, json.dumps(proposal.args, sort_keys=True)),
        )
        report = _reviewed or self.review.review(
            "task_tool",
            "R3",
            artifact,
            deadline=deadline,
            context=context,
            **({"closing": True} if closing else {}),
        )
        self.store.event(
            "tool_review_reused" if _reviewed else "tool_review",
            target=artifact.id,
            interpretation=getattr(report, "interpretation", "UNKNOWN"),
        )
        if report and report.finding:
            self.store.failures.append(
                FailureRecord(artifact.id, "tool_mapping_unresolved")
            )
            self.store.event(
                "tool_mapping_paused", target=artifact.id, challenge=report.finding.id
            )
            if unit.kind == "COMPUTE" or _review_only:
                return artifact  # Graph schedules a bounded remapping; no recursive R3 loop.
            return self.process_challenge(artifact, unit)
        if (
            not report
            or not report.complete
            or report.interpretation != "NO_SPECIFIC_ISSUE"
        ):
            self.store.failures.append(
                FailureRecord(artifact.id, "tool_mapping_review_missing")
            )
            self.store.event(
                "tool_mapping_paused", target=artifact.id, interpretation="UNKNOWN"
            )
            return artifact
        if _review_only:
            return report
        if enforce_deadline and self.clock() >= deadline:
            self.store.failures.append(FailureRecord(artifact.id, "tool_deadline"))
            return artifact
        # Review and metadata do not certify mapping. Output remains provisional.
        with self.store.lock:
            if key in receipts:
                return self.store.artifacts.get(
                    receipts[key].get("observation"), artifact
                )
            receipts[key] = {"state": "STARTED", "target": artifact.id}
            self.checkpoint()
        options = {"deadline": deadline, "scope": proposal.domain}
        if callable(getattr(self.executor, "execute_bound", None)):
            result = self.executor.execute_bound(
                proposal.name,
                proposal.args,
                **options,
                binding={
                    "unit": asdict(unit),
                    "proposal": asdict(proposal),
                    "artifact_digest": artifact.digest,
                    "unverified_dependencies": artifact.unverified_dependencies,
                },
            )
        else:
            result = self.executor.execute(proposal.name, proposal.args, **options)
        self.store.event(
            "tool_result",
            target=artifact.id,
            proposal=asdict(proposal),
            result=asdict(result),
            mapping_status="UNVERIFIED",
            position="R3",
        )
        self.store.event(
            "tool_executed",
            target=artifact.id,
            tool=proposal.name,
            status=result.status,
        )
        self.store.event(
            "tool_verified_scope",
            target=artifact.id,
            evidence_kind=result.evidence_kind,
            coverage=result.declared_scope,
            original_problem_mapping_verified=False,
        )
        if result.status not in {"ok", "partial"}:
            receipts[key] = {
                "state": "FINISHED_WITHOUT_OBSERVATION",
                "target": artifact.id,
                "status": result.status,
            }
            self.store.failures.append(
                FailureRecord(artifact.id, "tool_" + result.status)
            )
            self.checkpoint()
            return artifact
        mapped = mapped_value(self.store, unit, proposal, result)
        observation = Artifact(
            "tool-" + artifact.id,
            self.store.problem.digest,
            unit.route,
            unit.id + "-tool",
            json.dumps(asdict(result), ensure_ascii=False, default=str),
            "local_registered_tool",
            Scope(domain="positive_integer") if mapped else unit.scope,
            () if mapped else (artifact.id,),
            ()
            if mapped
            else tuple(sorted(set(artifact.unverified_dependencies) | {artifact.id})),
            True,
            artifact.id if mapped else None,
        )
        self.store.append(observation)
        if mapped:
            register_mapping(self.store, observation, artifact, mapped)
        else:
            record_input_evidence(self.store, observation, proposal, result)
        receipts[key] = {
            "state": "FINISHED",
            "target": artifact.id,
            "observation": observation.id,
        }
        self.checkpoint()
        return observation
