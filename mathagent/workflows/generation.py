"""WorkUnit calls and atomic artifact/delivery persistence, not scheduling."""

from __future__ import annotations

import re
import threading
from contextlib import nullcontext
from dataclasses import asdict, replace

from ..check_templates import result_instruction
from ..domain import Artifact, Scope, WorkUnit
from ..goal_contracts import current, render_contract
from ..goal_ledger import ingest_material
from ..observability import note_admission_wait
from ..prompts import workflows as prompt_text
from ..prompts.protocol import messages
from ..runtime.config import fingerprint
from ..runtime.coordinator import AdmissionError
from ..skills import SkillCatalog
from ..tool_feedback import failure_feedback, recovery_instruction, render_feedback
from ..verification import arithmetic_goal
from ..work_delivery import assess_delivery
from ..delivery_types import DeliveryType, classify, count_fact
from .ports import Checkpoint


class WorkUnitExecution:
    def __init__(
        self,
        *,
        adapter,
        item,
        store,
        experiment,
        checkpoint: Checkpoint,
        python_available=False,
        skills=None,
    ):
        self.adapter, self.item, self.store = adapter, item, store
        self.experiment, self.checkpoint = experiment, checkpoint
        self.sequence = len(store.artifacts)
        self.sequence_lock = threading.Lock()
        self.python_available = python_available
        self.skills = skills if skills is not None else SkillCatalog()

    def artifact(self, generated, unit, parent=None, contract_revision=None):
        assessment = assess_delivery(unit, generated.parsed.result)
        deps = tuple(unit.dependencies)
        unverified = set()
        for dep in deps:
            a = self.store.artifacts[dep]
            if not self.store.applicable_evidence(dep, unit.scope):
                unverified.add(dep)
                unverified.update(a.unverified_dependencies)
        with self.sequence_lock:
            artifact_id = f"artifact-{self.sequence:06d}"
            self.sequence += 1
        a = Artifact(
            artifact_id,
            self.store.problem.digest,
            unit.route,
            unit.id,
            generated.parsed.result if generated.parsed.valid else generated.parsed.raw,
            generated.request_id,
            unit.scope,
            deps,
            tuple(sorted(unverified)),
            generated.parsed.closed and assessment.status != "MISMATCH",
            parent,
        )
        with self.store.lock:
            contract = current(self.store)
            stale = bool(
                contract_revision
                and (not contract or contract["id"] != contract_revision)
            )
            if stale or generated.late or self.store.control.get("goal_closure_closed"):
                a = replace(a, closed=False)
            self.store.append(a)
            if contract_revision:
                self.store.control.setdefault("artifact_contracts", {})[a.id] = (
                    contract_revision
                )
            self.store.control.setdefault("artifact_units", {})[a.id] = asdict(unit)
            self.store.control.setdefault("delivery_assessments", {})[a.id] = {
                "status": assessment.status,
                "gap": assessment.gap,
                "protocol_closed": generated.parsed.closed,
                "schema": "math-delivery-assessment-v1",
                "type": classify(unit, a.text, closed=a.closed).value,
            }
            if generated.parsed.closed:
                count_fact(
                    self.store,
                    "protocol_complete",
                    a.id,
                    task=unit.id,
                    request=a.request,
                )
            self.store.event("work_unit", artifact=a.id, unit=asdict(unit))
            self.store.event(
                "delivery",
                request=generated.request_id,
                status=generated.parsed.status,
                violations=generated.parsed.violations,
                late=generated.late,
                error=generated.error,
                finish_reason=generated.finish_reason,
                raw=generated.parsed.raw,
                gap=generated.parsed.gap,
                normalizations=generated.parsed.normalizations,
                task_delivery_status=assessment.status,
                task_gap=assessment.gap,
                **({"transport": generated.transport} if generated.transport else {}),
            )
            ingest_material(self.store, a)
            if unit.id in self.store.tasks.nodes and not stale:
                self.store.tasks.update(unit.id, state="DELIVERED", output=a.id)
            self.checkpoint()
            return a

    def request_context(self, unit, *, review_input="", skill=""):
        """Shared by preflight and dispatch; preflight never spends an once flag."""
        verified, provisional = self.store.context(
            unit.route, unit.scope, unit.dependencies
        )
        related = set(unit.dependencies)
        for dep in unit.dependencies:
            related.update(self.store.artifacts[dep].unverified_dependencies)
        for row in self.store.control.get("tool_jobs", {}).values():
            if (
                row.get("state") == "ADOPTED"
                and row.get("adoption_artifact_id") in related
            ):
                observation = self.store.artifacts[row["observation_id"]]
                provisional += (
                    "UNVERIFIED original mapping; actual computation underlying the supplied dependency:\n"
                    + self.store.public_text(observation),
                )
        if (
            not skill
            and unit.kind not in {"PLAN", "CONTRACT_CLARIFY"}
            and self.experiment.enabled("skills")
        ):
            plan = self.store.control.get("planning", {}).get("plan", {})
            skill = self.skills.load_for(
                unit.goal,
                plan.get("fields", ()),
                context=(
                    self.store.problem.raw,
                    plan.get("card", ""),
                    review_input,
                ),
            )
        result_hint = result_instruction(unit.goal)
        if arithmetic_goal(unit.goal) is not None:
            result_hint = prompt_text.ARITHMETIC_RESULT_HINT
        tool_hint = (
            prompt_text.TOOL_PROPOSAL_HINT
            if unit.kind in {"DERIVE", "CHECK", "COMPUTE", "REPAIR"} and not result_hint
            else ""
        )
        if tool_hint:
            from ..computation_policy import capability_metadata

            tool_hint += "\n" + capability_metadata()
        operation = self.store.control.get("task_operations", {}).get(unit.id)
        if operation:
            import json

            review_input += (
                "\nController-parsed operation suggestion (requires sound original mapping): "
                + json.dumps(operation)
            )
        if self.python_available and tool_hint:
            tool_hint += prompt_text.GENERATED_PYTHON_HINT
            from ..computation_results import OUTPUT_HINT

            tool_hint += OUTPUT_HINT
        follow_hint = (
            prompt_text.FOLLOWUP_HINT + prompt_text.EXACT_CHECK_HINT
            if unit.kind == "DERIVE" and not result_hint
            else ""
        )
        feedback_id = self.store.control.get("task_tool_feedback", {}).get(unit.id)
        feedback = failure_feedback(self.store, feedback_id)
        recovery = ""
        if feedback:
            if (
                feedback["route"] != unit.route
                or feedback["problem"] != self.store.problem.digest
            ):
                raise ValueError("tool feedback cannot cross problem or route")
            review_input += "\n" + render_feedback(feedback)
            recovery = recovery_instruction(
                feedback, python_available=self.python_available
            )
        if unit.kind != "PLAN":
            review_input += render_contract(self.store)
            consumer_key = self.store.control.get("tool_consumers", {}).get(unit.id)
            if consumer_key:
                from ..computation_results import consumer_context

                job = self.store.control["tool_jobs"][consumer_key]
                if (
                    job["state"] != "OBSERVED"
                    or job["observation_id"] not in unit.dependencies
                ):
                    raise ValueError("consumer has no current observed tool dependency")
                review_input += consumer_context(self.store, job["observation_id"])
                review_input += "\nThis is the mathematical result-consumption step, not another code proposal. Interpret/check the actual output under the original mapping, deliver the requested object or relationship and state gaps. A receipt alone does not prove completeness."
                # The full observation is in the dedicated packet, no duplicate code.
                provisional = tuple(
                    x
                    for x in provisional
                    if x
                    != self.store.public_text(
                        self.store.artifacts[job["observation_id"]]
                    )
                )
            key = self.store.control.get("goal_tasks", {}).get(unit.id)
            if key:
                job = self.store.control["goal_closure"]["scheduler"]["jobs"][key]
                if job["contract"] != current(self.store)["id"]:
                    raise ValueError("task bound to a superseded target contract")
                review_input += (
                    "\nTask-specific material (not a verified parent):\n"
                    + job["material"]
                )
                if job["purpose"] == "MERGE":
                    from ..solution_branches import checked_branch

                    for branch_id in job["refs"]:
                        branch = self.store.control["goal_closure"]["branches"][
                            branch_id
                        ]
                        evidence = checked_branch(self.store, branch)
                        if not evidence or evidence.outcome != "SUPPORTS":
                            raise ValueError(
                                "merge member evidence is no longer applicable"
                            )
                        verified += (
                            evidence.verified_statement
                            + "\nObject: "
                            + branch["object"]
                            + "\nDomain: "
                            + branch["domain"]
                            + "\nExhaustive coverage remains unproved.",
                        )
            if (
                unit.kind not in {"CONTRACT_CLARIFY", "ROUTE_EXTENSION"}
                and current(self.store)
                and self.store.problem.answer_shape
                in {
                    "ALL_SOLUTIONS",
                    "MULTI_SELECT",
                    "MULTIPART",
                }
            ):
                from ..solution_branches import BRANCH_HINT

                follow_hint += BRANCH_HINT
        if unit.kind in {"CANDIDATE", "ASSEMBLE", "FALLBACK", "REPAIR"}:
            from ..verification import VerificationEngine

            failures, seen = [], set()
            with self.store.lock:
                for evidence in reversed(list(self.store.evidence.values())):
                    prior = self.store.artifacts.get(evidence.artifact_id)
                    if (
                        not prior
                        or prior.problem != self.store.problem.digest
                        or evidence.artifact_hash != prior.digest
                        or evidence.outcome != "REFUTES"
                        or evidence.kind != "EXACT_COUNTEREXAMPLE"
                        or evidence.checker != "registered_exact_checker"
                        or evidence.checker_version != VerificationEngine.version
                        or not evidence.property.startswith("source_")
                        or not evidence.verified_statement
                        or evidence.input_hash in seen
                    ):
                        continue
                    seen.add(evidence.input_hash)
                    rejected = next(
                        (
                            c.answer
                            for c in self.store.candidates.values()
                            if c.artifact == prior.id
                        ),
                        prior.text,
                    )
                    failures.append(
                        "Rejected candidate under the original source conditions: "
                        + rejected
                        + "\nIndependent check: "
                        + evidence.verified_statement
                    )
                    if len(failures) == 3:
                        break
            if failures:
                review_input += (
                    "\nIndependent source-bound counterexamples (not reviewer opinions):\n"
                    + "\n".join(failures)
                    + "\nANSWER and BASIS must agree. Do not resubmit a rejected object while admitting its failure in BASIS. "
                    "A repaired version must independently satisfy the original conditions; membership still does not prove all solutions."
                )
        return {
            "goal": unit.goal + recovery + tool_hint + follow_hint + result_hint,
            "kind": "local_repair"
            if unit.kind == "REPAIR"
            and "original_goal_coverage" not in unit.obligations
            else unit.kind.lower(),
            "problem": self.store.problem.raw,
            "verified": verified,
            "provisional": provisional,
            "review_input": review_input,
            "skill": skill if self.experiment.enabled("skills") else "",
        }

    def check_context(self, unit):
        policy = getattr(self.adapter.coordinator, "policy", None)
        caps = getattr(self.adapter, "capabilities", None)
        maximum = getattr(
            caps, "max_input_chars", getattr(policy, "max_input_chars", 64000)
        )
        context = self.request_context(unit)
        try:
            messages(**context, max_chars=maximum)
        except ValueError:
            if not context["skill"]:
                raise
            # Match both adapters: optional retrieval cannot force truncation or
            # rejection of an otherwise fitting complete mathematical parent.
            messages(**(context | {"skill": ""}), max_chars=maximum)

    def call(
        self,
        unit,
        *,
        deadline,
        once=None,
        review_input="",
        skill="",
        parent=None,
        final=False,
    ):
        consumer_key = self.store.control.get("tool_consumers", {}).get(unit.id)
        if consumer_key:
            deadline = min(
                deadline,
                self.store.control["tool_jobs"][consumer_key]["effective_deadline"],
            )
        contract = current(self.store)
        revision = contract["id"] if contract else None
        from ..task_resources import admit_task

        admit_task(self.store, unit.id)
        context = self.request_context(unit, review_input=review_input, skill=skill)
        try:
            options = {}
            job_key = self.store.control.get("goal_tasks", {}).get(unit.id)
            if hasattr(self.adapter, "request_profile") and job_key:
                options["purpose"] = self.store.control["goal_closure"]["scheduler"][
                    "jobs"
                ][job_key]["purpose"]
            if getattr(self.adapter, "request_profile", "fixed_8192") != "fixed_8192":
                from ..request_policy import task_class

                options["output_class"] = task_class(
                    kind=unit.kind,
                    material=context["review_input"],
                    goal=unit.goal,
                    purpose=options.get("purpose"),
                    profile=self.adapter.request_profile,
                )
            metadata = {'unit_id': unit.id, 'task_kind': unit.kind,
                        'is_retry': unit.id in self.store.control.get('task_tool_feedback', {}),
                        'consumption': bool(consumer_key),
                        'computation_pending': any(n.unit.kind == 'COMPUTE' and n.state in
                            {'READY', 'RUNNING', 'WAITING_TOOL', 'WAITING_ADOPTION'}
                            for n in self.store.tasks.nodes.values())}
            scope = getattr(self.adapter, 'work_context', lambda value: nullcontext())(metadata)
            with scope:
                generated = self.adapter.generate(
                    self.item,
                    **context,
                    deadline=deadline,
                    once=once,
                    final=final,
                    priority=unit.priority,
                    **options,
                )
        except AdmissionError as exc:
            self.store.event(
                "admission_refused",
                task=unit.id,
                task_kind=unit.kind,
                reason=exc.code,
                deadline=deadline,
                once=once,
            )
            raise
        body = context["skill"]
        note_admission_wait(self.store, generated)
        family = re.match(r"#\s+([a-z_]+)\b", body)
        if family and generated.transport.get("skill_included", True):
            self.store.event(
                "skill_used",
                task=unit.id,
                request=generated.request_id,
                family=family[1],
                content_hash=fingerprint(body),
                confirmed_packet=generated.transport.get("skill_included") is True,
                scope="effective adapter packet when confirmed; otherwise passed to adapter; never proof of model adherence",
            )
        artifact = self.artifact(generated, unit, parent, revision)
        if '[general-v1.1 method=' in body:
            self.store.event(
                'general_method_used', task=unit.id, request=generated.request_id,
                method_ids=re.findall(r'\[general-v1\.1 method=([^;]+);', body),
                packet_included=generated.transport.get('skill_included') is True,
                mathematical_benefit_established=False,
            )
        if (
            consumer_key
            and not generated.error
            and generated.parsed.valid
            and "request_started_monotonic" in generated.transport
        ):
            count_fact(
                self.store,
                "packet_included",
                generated.request_id,
                task=unit.id,
                observation=self.store.control["tool_jobs"][consumer_key][
                    "observation_id"
                ],
                meaning="confirmed adapter delivery contained observation; conservative lower bound, not proof of adherence",
            )
        coordinator = getattr(self.adapter, "coordinator", None)
        if (
            artifact.closed
            and classify(unit, artifact.text) == DeliveryType.MATHEMATICAL_ARTIFACT
            and unit.kind != "CONTRACT_CLARIFY"
            and callable(getattr(coordinator, "record_request_fact", None))
        ):
            from ..runtime.coordinator import Lease

            coordinator.record_request_fact(
                Lease(generated.request_id, self.item.id, deadline, unit.kind),
                "task_delivered",
            )
        return artifact, generated

    def unit_for_artifact(self, artifact, fallback):
        data = self.store.control.get("artifact_units", {}).get(artifact.id)
        if not data:
            return replace(
                fallback,
                id=artifact.work_unit,
                dependencies=artifact.dependencies,
                scope=artifact.scope,
            )
        data = dict(data)
        scope = data["scope"]
        data["scope"] = Scope(
            tuple(scope["conditions"]), scope["domain"], tuple(scope["quantifiers"])
        )
        data["dependencies"] = tuple(data["dependencies"])
        data["obligations"] = tuple(data["obligations"])
        unit = WorkUnit(**data)
        if (unit.id, unit.route, unit.dependencies, unit.scope) != (
            artifact.work_unit,
            artifact.route,
            artifact.dependencies,
            artifact.scope,
        ):
            raise ValueError("stored work unit does not bind the committed artifact")
        return unit
