"""Target-bound checks, conditional contexts, revision repair and R1/R4 review."""

from dataclasses import replace

from ..domain import Artifact, Challenge, WorkUnit
from ..policy import WORKFLOW_DEFAULTS
from ..prompts import workflows as prompt_text
from ..runtime.config import fingerprint
from ..runtime.coordinator import AdmissionError
from ..verification import exact_goal_coverage
from ..work_delivery import computational_kind
from .candidates import candidate_payload
from .ports import CandidateRegistrar, Checkpoint, WorkUnitCall, WorkUnitResolver


class ChallengeWorkflow:
    def __init__(
        self,
        *,
        store,
        budget,
        clock,
        call: WorkUnitCall,
        review,
        verifier,
        register_candidate: CandidateRegistrar,
        resolve_unit: WorkUnitResolver,
        checkpoint: Checkpoint,
        process_tool=None,
        defer_candidate_repair=None,
    ):
        self.store, self.budget, self.clock = store, budget, clock
        self.call, self.review, self.verifier = call, review, verifier
        self.register_candidate, self.resolve_unit = register_candidate, resolve_unit
        self.checkpoint = checkpoint
        self.process_tool = process_tool or (lambda a, u: a)
        self.defer_candidate_repair = defer_candidate_repair

    def process(self, artifact, unit):
        issues = [
            c
            for c in self.store.challenges.values()
            if c.target == artifact.id and c.status in {"OPEN", "CONFIRMED", "CHECKING"}
        ]
        if not issues:
            cached_repair = self._cached_repair(artifact, unit)
            if cached_repair is not None:
                return self._resume_revision(cached_repair, unit)
            return self._cached_context(artifact) or artifact
        if self.clock() >= self.budget.solving_end:
            return artifact
        issue = issues[0]
        paused = self._pause_tasks(artifact)
        evidence = self._target_evidence(artifact, unit, issue)
        if (
            evidence
            and evidence.outcome == "SUPPORTS"
            and not artifact.unverified_dependencies
        ):
            self.store.update_challenge(
                issue.id,
                "RESOLVED",
                evidence_ids=(evidence.id,),
                resolution="entire original bound WorkUnit assertion independently checked",
            )
            self.store.tasks.release_challenge(paused, conditional=False)
            self.checkpoint()
            return artifact
        if evidence and evidence.outcome in {"REFUTES", "INCOMPLETE"}:
            self.store.update_challenge(
                issue.id,
                "CONFIRMED",
                evidence_ids=(evidence.id,),
                resolution="independent exact target check establishes error or incompleteness",
            )
            if self.defer_candidate_repair and self.defer_candidate_repair(
                artifact, unit, issue, evidence
            ):
                self.store.tasks.release_challenge(paused, conditional=True)
                self.checkpoint()
                return artifact
            return self._repair(artifact, unit, issue, paused)
        return self._check_unknown(artifact, unit, issue, paused)

    def _cached_context(self, artifact):
        existing_context = next(
            (
                self.store.artifacts[c.replacement]
                for c in reversed(list(self.store.challenges.values()))
                if c.target == artifact.id
                and c.status == "UNKNOWN"
                and c.replacement in self.store.artifacts
                and self.store.artifacts[c.replacement].request
                == "controller_conditional_context"
            ),
            None,
        )
        return existing_context

    def _cached_repair(self, artifact, unit):
        cached_repair = next(
            (
                self.store.artifacts[c.replacement]
                for c in reversed(list(self.store.challenges.values()))
                if c.target == artifact.id
                and c.status in {"REPAIRED", "UNKNOWN"}
                and c.replacement in self.store.artifacts
                and self.store.artifacts[c.replacement].work_unit.startswith(
                    "repair-" + unit.id
                )
                and self.store.artifacts[c.replacement].closed
            ),
            None,
        )
        return cached_repair

    def _resume_revision(self, cached_repair, unit):
        repair_unit = self.resolve_unit(cached_repair, unit)
        original = self.store.artifacts[cached_repair.parent_revision]
        issue = next(
            c
            for c in self.store.challenges.values()
            if c.target == original.id and c.replacement == cached_repair.id
        )
        report = self.review.review(
            "task_tool",
            "R4",
            cached_repair,
            deadline=self.budget.solving_end,
            context=self._repair_context(original, cached_repair, repair_unit, issue),
        )
        if report and report.finding:
            cached_repair = self.process(cached_repair, repair_unit)
        self.checkpoint()
        return cached_repair

    def _pause_tasks(self, artifact):
        paused = self.store.tasks.pause_for_artifact(artifact.id, self.store)
        self.store.event(
            "tasks_paused",
            target=artifact.id,
            dependents=sorted(self.store.affected(artifact.id)),
            graph_tasks=paused,
        )
        return paused

    def _target_evidence(self, artifact, unit, issue):
        evidence = None
        if issue.id.startswith("coverage-"):
            evidence = next(
                (
                    e
                    for e in self.store.evidence.values()
                    if e.artifact_id == artifact.id
                    and e.outcome in {"INCOMPLETE", "REFUTES"}
                ),
                None,
            )
        elif issue.next_check.strip() == unit.goal.strip():
            evidence = self.verifier.check(
                self.store, artifact, goal=unit.goal, proposed=artifact.text, unit=unit
            )
        return evidence

    def _check_unknown(self, artifact, unit, issue, paused):
        self.store.update_challenge(issue.id, "CHECKING")
        check_unit = WorkUnit(
            "challenge-check-" + issue.id,
            unit.route,
            issue.next_check,
            computational_kind(issue.next_check, "CHECK"),
            artifact.dependencies,
            ("bounded_check",),
            unit.scope,
            unit.bottleneck,
            1,
        )
        checked, check_evidence = None, None
        try:
            cached = [
                a for a in self.store.artifacts.values() if a.work_unit == check_unit.id
            ]
            if cached:
                checked = cached[-1]
                check_unit = self.resolve_unit(checked, check_unit)
            else:
                checked, _ = self.call(
                    check_unit,
                    deadline=self.budget.solving_end,
                    once="challenge-check:" + issue.id,
                    review_input=self.store.public_text(artifact),
                )
            if checked.closed:
                checked = self.process_tool(checked, check_unit)
                check_evidence = self.verifier.check(
                    self.store,
                    checked,
                    goal=check_unit.goal,
                    proposed=checked.text,
                    unit=check_unit,
                )
        except (AdmissionError, ValueError):
            pass
        self.store.update_challenge(
            issue.id,
            "UNKNOWN",
            check_artifact=checked.id if checked else None,
            evidence_ids=(check_evidence.id,) if check_evidence else (),
            resolution="local check is not a sound binding that discharges the original challenge",
        )
        context = self._conditional_context(
            artifact, unit, issue, check_unit, checked, check_evidence
        )
        self.store.tasks.release_challenge(paused, conditional=True)
        self.store.event(
            "conditional_resume",
            target=artifact.id,
            unresolved_challenge=issue.id,
            priority="low",
            mathematical_truth_not_assumed=True,
        )
        self.checkpoint()
        return context

    def _conditional_context(
        self, artifact, unit, issue, check_unit, checked, check_evidence
    ):
        context = artifact
        if (
            checked
            and checked.closed
            and not (
                {artifact.id, checked.id}
                & (self.store.refuted | self.store.invalid_proofs)
            )
        ):
            earlier_checks = [
                self.store.artifacts[c.check_artifact]
                for c in self.store.challenges.values()
                if c.target == artifact.id
                and c.id != issue.id
                and c.check_artifact in self.store.artifacts
                and self.store.artifacts[c.check_artifact].closed
                and c.check_artifact
                not in self.store.refuted | self.store.invalid_proofs
            ]
            deps = tuple(
                dict.fromkeys(
                    (artifact.id, checked.id, *(a.id for a in earlier_checks))
                )
            )
            ancestry = (
                set(deps)
                | set(artifact.unverified_dependencies)
                | set(checked.unverified_dependencies)
                | {dep for a in earlier_checks for dep in a.unverified_dependencies}
            )
            context = Artifact(
                "conditional-" + issue.id,
                self.store.problem.digest,
                unit.route,
                unit.id + "-context",
                self.store.public_text(artifact)
                + prompt_text.TARGETED_CHECK_PREFIX
                + check_unit.goal
                + prompt_text.TARGETED_CHECK_SUFFIX
                + self.store.public_text(checked)
                + "".join(
                    "\nAdditional unresolved check material:\n"
                    + self.store.public_text(a)
                    for a in earlier_checks
                ),
                "controller_conditional_context",
                unit.scope,
                deps,
                tuple(sorted(ancestry)),
                True,
                artifact.id,
            )
            self.store.append(context)
            self.store.update_challenge(
                issue.id,
                "UNKNOWN",
                check_artifact=checked.id,
                evidence_ids=(check_evidence.id,) if check_evidence else (),
                replacement=context.id,
                resolution="complete check material carried conditionally; no target promotion",
            )
            if unit.id in self.store.tasks.nodes:
                self.store.tasks.update(unit.id, output=context.id)
        return context

    def _repair(self, artifact, unit, issue, paused):
        other_repair = any(
            c.id != issue.id
            and c.target == artifact.id
            and c.replacement in self.store.artifacts
            and self.store.artifacts[c.replacement].work_unit.startswith(
                "repair-" + unit.id
            )
            for c in self.store.challenges.values()
        )
        suffix = "-issue-" + issue.id if other_repair else ""
        repair_unit = WorkUnit(
            "repair-" + unit.id + suffix,
            unit.route,
            prompt_text.REPAIR_ISSUE_PREFIX
            + issue.issue
            + prompt_text.REPAIR_BASIS_SEPARATOR
            + issue.basis
            + prompt_text.REPAIR_TASK_SEPARATOR
            + issue.next_check
            + prompt_text.REPAIR_DERIVATION_HINT
            + prompt_text.REPAIR_ANSWER_HINT
            if candidate_payload(artifact.text)
            else unit.goal,
            "CANDIDATE" if candidate_payload(artifact.text) else "REPAIR",
            tuple(
                d
                for d in artifact.dependencies
                if d not in self.store.refuted and d not in self.store.invalid_proofs
            ),
            unit.obligations,
            unit.scope,
            unit.bottleneck,
        )
        existing = [
            a
            for a in self.store.artifacts.values()
            if a.parent_revision == artifact.id and a.work_unit == repair_unit.id
        ]
        try:
            if existing:
                repaired = existing[-1]
            else:
                repaired, _ = self.call(
                    repair_unit,
                    deadline=self.budget.solving_end,
                    once="repair:" + artifact.id + suffix,
                    review_input=self.store.public_text(artifact)
                    + prompt_text.SPECIFIC_ISSUE_SEPARATOR
                    + issue.issue,
                    parent=artifact.id,
                )
        except AdmissionError:
            self.store.tasks.release_challenge(paused, conditional=True)
            self.checkpoint()
            return artifact
        new_evidence = self._record_revision(artifact, repaired, repair_unit, issue)
        return self._review_repaired(
            artifact, repaired, repair_unit, issue, paused, new_evidence
        )

    def _record_revision(self, artifact, repaired, repair_unit, issue):
        parent_candidate = next(
            (c.id for c in self.store.candidates.values() if c.artifact == artifact.id),
            None,
        )
        repaired_candidate = (
            self.register_candidate(repaired, parent=parent_candidate)
            if parent_candidate
            else None
        )
        if not parent_candidate and repaired.closed:
            self.verifier.check(
                self.store,
                repaired,
                goal=repair_unit.goal,
                proposed=repaired.text,
                unit=repair_unit,
            )
        new_evidence = (
            list(exact_goal_coverage(self.store, repaired_candidate))
            if repaired_candidate
            else [
                e
                for e in self.store.evidence.values()
                if e.artifact_id == repaired.id
                and e.outcome == "SUPPORTS"
                and e.kind == "EXACT_CHECK"
            ]
        )
        if new_evidence:
            self.store.update_challenge(
                issue.id,
                "REPAIRED",
                replacement=repaired.id,
                evidence_ids=tuple(e.id for e in new_evidence),
                resolution="new revision checked; old revision does not become true",
            )
        else:
            self.store.update_challenge(
                issue.id,
                "UNKNOWN",
                replacement=repaired.id,
                resolution="repair proposed without sufficient independent evidence",
            )
        for outstanding in tuple(self.store.challenges.values()):
            if outstanding.target == artifact.id and outstanding.status not in {
                "RESOLVED",
                "REPAIRED",
            }:
                self.store.challenge(
                    Challenge(
                        fingerprint(
                            (repaired.id, outstanding.issue, outstanding.basis)
                        ),
                        repaired.id,
                        outstanding.issue,
                        outstanding.basis,
                        outstanding.next_check,
                    )
                )
        return new_evidence

    def _repair_context(self, artifact, repaired, repair_unit, issue):
        from ..review_context import ReviewContext

        original_unit = self.store.control.get("artifact_units", {}).get(
            artifact.id, {}
        )
        return ReviewContext(
            task=original_unit.get("goal", repair_unit.goal),
            issue=issue.issue,
            basis=issue.basis,
            old_derivation=self.store.public_text(artifact),
            conditions=f"Old conditions: {artifact.scope}; revised conditions: {repaired.scope}; "
            f"unverified dependencies remain: {bool(repaired.unverified_dependencies)}",
            bindings=(artifact.digest, repaired.digest, issue.id, issue.next_check),
        )

    def _review_repaired(
        self, artifact, repaired, repair_unit, issue, paused, new_evidence
    ):
        report = self.review.review(
            "task_tool",
            "R4",
            repaired,
            deadline=self.budget.solving_end,
            context=self._repair_context(artifact, repaired, repair_unit, issue),
        )
        if new_evidence and report and report.finding:
            # At most a check of the already checked revision, not recursive repair rolls.
            self.process(repaired, repair_unit)
        still_open = any(
            c.target == repaired.id and c.status != "RESOLVED"
            for c in self.store.challenges.values()
        )
        self.store.tasks.release_challenge(
            paused, conditional=not new_evidence or still_open
        )
        self.store.event(
            "conditional_resume",
            target=repaired.id,
            unresolved_challenge=issue.id,
            mathematical_truth_not_assumed=True,
        )
        self.checkpoint()
        return repaired if repaired.closed else artifact

    def pre_branch_review(self, unit):
        deps = unit.dependencies
        unverified = set()
        for dep in deps:
            parent = self.store.artifacts[dep]
            if not self.store.applicable_evidence(dep, unit.scope):
                unverified.update((dep, *parent.unverified_dependencies))
        intent = Artifact(
            "intent-"
            + unit.id
            + "-"
            + fingerprint((unit.goal, unit.dependencies))[:12],
            self.store.problem.digest,
            unit.route,
            unit.id,
            prompt_text.BRANCH_INTENT_PREFIX + unit.goal,
            "controller_intent",
            unit.scope,
            deps,
            tuple(sorted(unverified)),
            True,
        )
        self.store.append(intent)
        report = self.review.review(
            "method", "R1", intent, deadline=self.budget.solving_end
        )
        if not report or not report.finding:
            return unit
        self.store.event("tasks_paused", target=unit.id, reason=report.finding.issue)
        self.store.update_challenge(report.finding.id, "CHECKING")
        evidence = None
        checked = None
        check_unit = replace(
            unit,
            id="precheck-" + unit.id,
            goal=report.finding.next_check,
            kind=computational_kind(report.finding.next_check, "CHECK"),
        )
        try:
            checked, _ = self.call(
                check_unit,
                deadline=self.budget.solving_end,
                once="precheck:" + unit.bottleneck_key,
                review_input=intent.text,
            )
            if checked.closed:
                checked = self.process_tool(checked, check_unit)
                evidence = self.verifier.check(
                    self.store,
                    checked,
                    goal=check_unit.goal,
                    proposed=checked.text,
                    candidate=False,
                    unit=check_unit,
                )
                if checked.id not in self.store.refuted:
                    deps = deps + (checked.id,)
        except AdmissionError:
            pass
        self.store.update_challenge(
            report.finding.id,
            "UNKNOWN",
            check_artifact=checked.id if checked else None,
            evidence_ids=(evidence.id,) if evidence else (),
            resolution="a local check alone does not establish the proposed branch's applicability",
        )
        self.checkpoint()
        self.store.event(
            "conditional_resume",
            target=unit.id,
            unresolved_challenge=report.finding.id,
            priority="low",
            no_verified_promotion=True,
        )
        return replace(
            unit, dependencies=deps, priority=WORKFLOW_DEFAULTS.conditional_priority
        )
