"""Initial plan, bounded repair and R0 review/conflict workflow."""

from dataclasses import asdict, replace

from ..domain import Artifact, Route, Scope, WorkUnit
from ..goal_contracts import (
    adopt_contract,
    current,
    proposal_issues,
    restore_proposal,
    source_grammar_fallback,
)
from ..observability import admission_wait_estimate
from ..planning import PLAN_GOAL, Plan, generic_plan, parse_plan
from ..policy import WORKFLOW_DEFAULTS
from ..prompts import workflows as prompt_text
from ..review import ROLES, material_conflict, parse_report
from ..runtime.coordinator import AdmissionError
from ..runtime.protocol import parse_response
from .ports import Checkpoint, WorkUnitCall


class PlanningWorkflow:
    def __init__(
        self,
        *,
        store,
        budget,
        call: WorkUnitCall,
        review,
        skills,
        checkpoint: Checkpoint,
    ):
        self.store, self.budget, self.call = store, budget, call
        self.review, self.skills, self.checkpoint = review, skills, checkpoint

    def can_start(self, once, *, previous_seconds=0):
        remaining = self.budget.planning_end - self.review.clock()
        coord = getattr(getattr(self.review, "adapter", None), "coordinator", None)
        estimate = max(
            previous_seconds,
            getattr(coord, "estimated_call_seconds", lambda: 0)(),
        ) + admission_wait_estimate(self.store)
        if remaining <= 0 or estimate > remaining:
            self.store.event(
                "planning_not_started",
                once=once,
                reason="phase_time_insufficient",
                remaining=max(0, remaining),
                estimated_call_seconds=estimate,
            )
            return False
        return True

    def run(self):
        unit = WorkUnit("planning", "planning", PLAN_GOAL, "PLAN")
        artifact = None
        plan = generic_plan()
        saved = self.store.control.get("planning")
        if saved:
            data = saved["plan"]
            plan = Plan(
                data["raw"],
                data["card"],
                tuple(data["fields"]),
                tuple(Route(**r) for r in data["routes"]),
                data["complete"],
                data["suggested_width"],
                restore_proposal(data.get("contract")),
                data.get("operations", {}),
            )
            artifact = self.store.artifacts[saved["artifact"]]
            if self.store.control.get("planning_reviewed"):
                return plan, [
                    c
                    for c in self.store.challenges.values()
                    if c.target == artifact.id
                    and c.status not in {"RESOLVED", "REPAIRED"}
                ]
        previous_seconds = 0
        for attempt in range(0 if saved else WORKFLOW_DEFAULTS.planning_attempts):
            once = "planning" if not attempt else "planning_repair"
            if not self.can_start(once, previous_seconds=previous_seconds):
                break
            began = self.review.clock()
            try:
                artifact, generated = self.call(
                    unit,
                    deadline=self.budget.planning_end,
                    once=once,
                    skill=self.skills.metadata(),
                    review_input=artifact.text if artifact else "",
                )
            except AdmissionError:
                break
            previous_seconds = max(0, self.review.clock() - began)
            plan = (
                parse_plan(generated.parsed.result)
                if generated.parsed.closed
                else generic_plan(generated.parsed.raw)
            )
            if not generated.parsed.closed:
                # Partial text is review input only; it does not change delivery
                # validity or become a completed mathematical parent.
                partial = parse_plan(generated.parsed.raw)
                plan = replace(plan, contract=partial.contract)
            plan = replace(
                plan,
                contract=source_grammar_fallback(plan.contract, self.store.problem.raw),
            )
            contract_gaps = proposal_issues(plan.contract, self.store.problem.raw)
            self.store.event(
                "planning_structure",
                skeleton_ready=plan.complete,
                contract_structure_ready=not contract_gaps,
                field_gaps=contract_gaps,
                normalizations=plan.contract.normalizations,
            )
            if plan.complete and not contract_gaps:
                break
            if generated.error and not generated.transport.get("remote_ended", False):
                break
            unit = replace(
                unit,
                goal=PLAN_GOAL
                + prompt_text.PLANNING_REPAIR_HINT
                + " Observed protocol issues: "
                + (
                    ", ".join(generated.parsed.violations)
                    or "missing executable card/route/task structure"
                )
                + " Repair these parsed contract fields while preserving the original source: "
                + str(contract_gaps),
            )
        if not plan.complete:
            partial = plan
            plan = replace(
                generic_plan(plan.raw),
                card=partial.card,
                fields=partial.fields,
                contract=partial.contract,
            )
            self.store.event(
                "generic_planning",
                reason="no executable plan within the admitted planning attempts",
            )
        # A controller-generated generic plan is reviewable data, never a verified mathematical fact.
        if not plan.complete or artifact is None or not artifact.closed:
            artifact = Artifact(
                "plan-fallback",
                self.store.problem.digest,
                "planning",
                "planning",
                "CARD: "
                + plan.card
                + "; "
                + "; ".join(
                    "METHOD: " + r.method + "; TASK: " + r.first_goal
                    for r in plan.routes
                ),
                "controller",
                Scope(),
                (),
                (),
                True,
            )
            self.store.append(artifact)
        self.store.control["planning"] = {"plan": asdict(plan), "artifact": artifact.id}
        self.checkpoint()
        reports = self.review.initial_batch(artifact, deadline=self.budget.planning_end)
        findings = [
            finding
            for r in reports
            if r
            for finding in (r.findings or ((r.finding,) if r.finding else ()))
        ]
        findings = list(
            {
                finding.id: finding
                for finding in findings
                + [
                    c
                    for c in self.store.challenges.values()
                    if c.target == artifact.id
                    and c.status not in {"RESOLVED", "REPAIRED"}
                ]
            }.values()
        )
        method_report = next(
            (r for r in reports if r and r.role == "method" and r.complete), None
        )
        order = method_report.route_order if method_report else ()
        known_routes = {r.id for r in plan.routes}
        accepted_order = tuple(r for r in order if r in known_routes)
        accepted_order += tuple(r.id for r in plan.routes if r.id not in accepted_order)
        if order:
            plan = replace(
                plan,
                routes=tuple(
                    replace(
                        next(r for r in plan.routes if r.id == name), priority=i + 1
                    )
                    for i, name in enumerate(accepted_order)
                ),
            )
        if method_report and method_report.suggested_width:
            plan = replace(plan, suggested_width=method_report.suggested_width)
        self.store.control["route_review_decision"] = {
            "order": list(accepted_order),
            "suggested_width": plan.suggested_width,
            "width_basis": method_report.width_basis if method_report else "",
            "reason": "method advice checked against existing routes; width remains subject to method/resource checks",
            "unknown_roles": [
                role
                for role, r in zip(ROLES, reports)
                if r is None
                or not r.complete
                or r.interpretation in {"UNKNOWN", "PARTIAL_REVIEW"}
            ],
            "uncovered": [value for r in reports if r for value in r.uncovered],
            "conflict": material_conflict(reports),
            "unresolved_difference": any(
                r is None
                or r.interpretation == "UNKNOWN"
                or (r.findings and not r.stances)
                for r in reports
            ),
        }
        self.store.event(
            "initial_route_decision", **self.store.control["route_review_decision"]
        )
        self.store.control["planning"]["plan"] = asdict(plan)
        if material_conflict(reports):
            try:
                check = WorkUnit(
                    "initial-conflict",
                    "planning",
                    prompt_text.INITIAL_CONFLICT_GOAL,
                    "REVIEW_CONFLICT",
                )
                previous = self.store.control.get("initial_conflict_delivery")
                if previous:
                    parsed = parse_response(previous, finish_reason="stop")
                else:
                    if not self.can_start("initial_conflict_recheck"):
                        raise AdmissionError("planning phase time insufficient")
                    _, generated = self.call(
                        check,
                        deadline=self.budget.planning_end,
                        once="initial_conflict_recheck",
                        review_input="\n\n".join(r.raw for r in reports if r),
                    )
                    parsed = generated.parsed
                    if parsed.closed:
                        self.store.control["initial_conflict_delivery"] = parsed.raw
                report = parse_report(
                    role="method",
                    position="R0_conflict",
                    artifact=artifact,
                    parsed=parsed,
                )
                self.store.event(
                    "conflict_recheck_result",
                    interpretation=report.interpretation,
                    complete=report.complete,
                )
                if report.complete and report.finding:
                    self.store.challenge(report.finding)
                    if report.finding.id not in {finding.id for finding in findings}:
                        findings.insert(0, report.finding)
            except AdmissionError:
                pass
        if findings:
            # Global initial doubts are checked before assuming the route charter.
            self.store.event(
                "initial_challenges",
                targets=[c.target for c in findings],
                action="prioritize_condition_check",
                no_truth_promotion=True,
            )
        self.store.control["planning_reviewed"] = True
        if current(self.store) is None:
            adopt_contract(self.store, plan.contract, reports)
        at = self.review.clock()
        self.store.control["planning_phase"] = {
            "state": "CLOSED_SOFT" if at >= self.budget.planning_end else "COMPLETED",
            "closed_at": at,
            "deadline": self.budget.planning_end,
            "reopens_on_budget_growth": False,
            "skeleton_ready": plan.complete,
            "contract_ready": bool(current(self.store).get("usable")),
        }
        self.store.event(
            "phase_closed", phase="planning", **self.store.control["planning_phase"]
        )
        self.checkpoint()
        return plan, findings
