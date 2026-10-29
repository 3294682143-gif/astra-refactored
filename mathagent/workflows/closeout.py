"""Assembly/fallback orchestration and R5, separate from deterministic formatting."""

import sqlite3
from dataclasses import replace

from ..answer_contracts import answer_identity
from ..domain import Challenge, WorkUnit
from ..finalization import finalize, select
from ..prompts import workflows as prompt_text
from ..prompts.protocol import ContextCapacityError
from ..runtime.config import fingerprint
from ..runtime.coordinator import AdmissionError
from ..task_scope import scope_for_goal
from ..tool_feedback import failure_feedback, render_feedback
from ..verification import exact_goal_coverage
from ..work_delivery import computational_kind
from .candidates import candidate_gaps
from .ports import CandidateRegistrar, WorkUnitCall


class CloseoutWorkflow:
    def __init__(
        self,
        *,
        store,
        budget,
        clock,
        call: WorkUnitCall,
        register_candidate: CandidateRegistrar,
        review,
        experiment,
        context_check=None,
        process_closing_tool=None,
        request_states=None,
        check_pending_member=None,
    ):
        self.store, self.budget, self.clock = store, budget, clock
        self.call, self.register_candidate = call, register_candidate
        self.review, self.experiment = review, experiment
        self.context_check = context_check
        self.process_closing_tool = process_closing_tool
        self.request_states = request_states
        self.check_pending_member = check_pending_member

    def materials(self):
        eligible = {
            a.id: a
            for a in self.store.artifacts.values()
            if a.closed
            and a.route != "planning"
            and a.id not in self.store.refuted
            and a.id not in self.store.invalid_proofs
            and a.request not in {"controller_intent"}
        }
        planned = self.store.control.get("route_review_decision", {}).get("order", [])
        groups = {a.route: [] for a in eligible.values()}
        for a in eligible.values():
            groups[a.route].append(a)
        if not groups:
            return "closeout", ()

        def rank(route):
            units = self.store.control.get("artifact_units", {})
            explicit = sum(
                bool(
                    set(units.get(a.id, {}).get("obligations", ()))
                    & set(self.store.problem.goals)
                )
                for a in groups[route]
            )
            return (
                -explicit,
                route not in planned,
                planned.index(route) if route in planned else 0,
                -len(groups[route]),
                route,
            )

        route = min(groups, key=rank)
        # Union of independent route contributions, not only one terminal node's
        # ancestors. Required ancestry is kept in insertion/topological order.
        units = self.store.control.get("artifact_units", {})
        selected = (
            {
                a.id
                for a in groups[route]
                if set(units.get(a.id, {}).get("obligations", ()))
                & set(self.store.problem.goals)
            }
            if self.store.problem.goals
            else set()
        )
        if not selected:
            selected = {a.id for a in groups[route]}
        pending = list(selected)
        while pending:
            aid = pending.pop()
            for dep in self.store.artifacts[aid].dependencies:
                if (
                    dep in eligible
                    and eligible[dep].route == route
                    and dep not in selected
                ):
                    selected.add(dep)
                    pending.append(dep)
        deps = tuple(aid for aid in self.store.artifacts if aid in selected)
        self.store.event(
            "closeout_materials",
            route=route,
            selected=list(deps),
            reason="union of complete route contributions and required ancestry; no last-N cut",
            excluded=[aid for aid in eligible if aid not in selected],
            exclusion_reasons={
                aid: "different route or no binding to declared target obligations"
                for aid in eligible
                if aid not in selected
            },
        )
        return route, deps

    def fit_materials(self, unit):
        if self.context_check is None:
            return unit
        try:
            self.context_check(unit)
            return unit
        except ContextCapacityError:
            pass
        # Verify that the complete source problem itself fits before attempting
        # whole bundles. Never truncate a proof, a condition or the original task.
        empty = replace(unit, dependencies=())
        self.context_check(empty)
        units = self.store.control.get("artifact_units", {})
        targets = set(self.store.problem.goals) | {"original_goal_coverage"}

        def bundle(aid):
            pending, closure = [aid], set()
            while pending:
                dep = pending.pop()
                if dep in closure:
                    continue
                a = self.store.artifacts[dep]
                if (
                    not a.closed
                    or dep in self.store.refuted
                    or dep in self.store.invalid_proofs
                ):
                    return None
                if a.route != unit.route and not self.store.applicable_evidence(
                    dep, unit.scope
                ):
                    return None
                closure.add(dep)
                pending.extend(a.dependencies)
            return closure

        def rank(aid):
            a = self.store.artifacts[aid]
            return (
                -bool(targets & set(units.get(aid, {}).get("obligations", ()))),
                -bool(self.store.applicable_evidence(aid, unit.scope)),
                len(a.text),
                aid,
            )

        selected = set()
        for aid in sorted(unit.dependencies, key=rank):
            closure = bundle(aid)
            if closure is None:
                continue
            trial = selected | closure
            candidate = replace(
                unit,
                dependencies=tuple(dep for dep in self.store.artifacts if dep in trial),
            )
            try:
                self.context_check(candidate)
            except ContextCapacityError:
                continue
            selected = trial
        if not selected and unit.kind == "ASSEMBLE" and unit.dependencies:
            # Assembly cannot consume any existing complete material. Leave the
            # distinct fallback free to reason from the original problem alone.
            raise ContextCapacityError("no_complete_assembly_bundle_fits")
        result = replace(
            unit,
            dependencies=tuple(aid for aid in self.store.artifacts if aid in selected),
        )
        self.store.event(
            "closeout_context_selection",
            task_kind=unit.kind,
            selected=list(result.dependencies),
            omitted=[aid for aid in unit.dependencies if aid not in selected],
            reason="capacity-bounded whole dependency bundles; target/checked-property priority; omitted material is not assumed",
            source_problem_only=not selected,
        )
        return result

    def run(self):
        self.store.control["goal_closure_closing"] = True
        for kind, once in (
            ("ASSEMBLE", "candidate_assembly"),
            ("FALLBACK", "fallback_roll"),
        ):
            if kind == "FALLBACK" and not self.experiment.enabled("fallback"):
                self.store.event("fallback_ablation", original_limits_retained=True)
                continue
            if select(self.store) or self.clock() >= self.budget.finish_end:
                break
            route, deps = self.materials()
            unit = WorkUnit(
                once,
                route,
                prompt_text.CLOSEOUT_GOAL,
                kind,
                deps,
                ("original_goal_coverage",),
                scope_for_goal(self.store.problem.raw),
            )
            try:
                unit = self.fit_materials(unit)
                a, _ = self.call(
                    unit, deadline=self.budget.finish_end, once=once, final=True
                )
                self.register_candidate(a)
            except AdmissionError:
                # An assembly opportunity already spent before recovery does not
                # erase the separate, still-available fallback opportunity.
                continue
            except ContextCapacityError:
                self.store.event(
                    "closeout_context_unavailable",
                    task_kind=kind,
                    reason="complete_context_does_not_fit",
                    no_dispatch=True,
                    fallback_opportunity_preserved=kind == "ASSEMBLE",
                )
                continue
        for candidate in tuple(self.store.candidates.values()):
            if candidate.artifact in self.store.refuted:
                continue
            artifact = self.store.artifacts[candidate.artifact]
            coverage = exact_goal_coverage(self.store, candidate)
            self.store.event(
                "goal_coverage",
                position="R5",
                candidate=candidate.id,
                interpretation="EXACT" if coverage else "UNKNOWN",
                evidence_ids=[e.id for e in coverage],
            )
            if not coverage:
                try:
                    self.review.review(
                        "meaning",
                        "R5",
                        artifact,
                        deadline=self.budget.finish_end,
                        **(
                            {"purpose": "FINAL_COVERAGE"}
                            if self.store.problem.goals
                            else {}
                        ),
                    )
                except ContextCapacityError:
                    self.store.control.setdefault("review_uncovered", {})[
                        artifact.id
                    ] = [
                        "R5 complete context exceeded capacity; semantic coverage UNKNOWN"
                    ]
                    self.store.event(
                        "review_missing",
                        role="meaning",
                        position="R5",
                        target=artifact.id,
                        interpretation="UNKNOWN",
                    )
        self.record_answer_conflict()
        self.repair_selected_gap()
        # Closing revisions can contain new member proposals after the solving
        # scheduler has stopped. No model dispatch or phase reopening is needed.
        if self.check_pending_member is not None:
            for _ in range(32):
                if (
                    self.clock() >= self.budget.finish_end
                    or not self.check_pending_member()
                ):
                    break
        result = finalize(self.store)
        errors = [
            e["details"].get("error")
            for e in self.store.events
            if e["kind"] in {"delivery", "review"} and e["details"].get("error")
        ]
        remote = {"available": False, "current_remote_unknown": None}
        if self.request_states is not None:
            try:
                remote = self.request_states()
            except (OSError, RuntimeError, ValueError, sqlite3.Error):
                # A failed read is not evidence of an outstanding request.
                remote["reason"] = "request_status_unavailable"
        reason = (
            "CANDIDATE_SELECTED"
            if select(self.store)
            else (
                "TRANSPORT_UNKNOWN"
                if remote.get("available") and remote.get("current_remote_unknown", 0)
                else "NO_CANDIDATE"
            )
        )
        refusals = [
            e["details"]["reason"]
            for e in self.store.events
            if e["kind"] == "admission_refused"
        ]
        if not select(self.store) and "LOGICAL_BUDGET_EXHAUSTED" in refusals:
            reason = "LOGICAL_BUDGET_EXHAUSTED"
        result.update(
            termination_reason=reason,
            remote_request_state=remote,
            failed_phase=None if select(self.store) else "closeout",
            budget_remaining={
                "soft_seconds": max(0, self.budget.finish_end - self.clock())
            },
            blocked_by=list(dict.fromkeys(errors + refusals)),
        )
        return result

    def record_answer_conflict(self):
        candidates = [
            c
            for c in self.store.candidates.values()
            if c.artifact not in self.store.refuted
        ]
        if any(exact_goal_coverage(self.store, c) for c in candidates):
            return

        def key(candidate):
            return answer_identity(self.store.problem.raw, candidate.answer)

        if len({key(c) for c in candidates}) < 2:
            return
        conflicts = self.store.control.setdefault("answer_conflicts", {})
        for c in candidates:
            if c.artifact in conflicts:
                continue
            other = next(x for x in candidates if key(x) != key(c))
            conflicts[c.artifact] = {
                "alternative": other.artifact,
                "check": "Resolve the disagreement between the supplied original-goal candidates from the original conditions. Check every requested solution, option and parameter case. A candidate count or reviewer vote is not evidence.",
            }
        self.store.event(
            "answer_conflict",
            candidates=[c.id for c in candidates],
            interpretation="needs_comparison_not_refutation",
            extra_repair_rolls=False,
        )

    def repair_selected_gap(self):
        """One bound closeout repair round, not a new assembly/fallback roll."""
        candidate = select(self.store)
        if candidate is None or self.clock() >= self.budget.finish_end:
            return
        if exact_goal_coverage(self.store, candidate):
            return  # A checked answer need not regenerate to fix an unrelated parent proof.
        artifact = self.store.artifacts[candidate.artifact]
        gaps = candidate_gaps(self.store, artifact)
        if not gaps:
            return
        # Route and mathematical gap, not a renamed candidate/review identifier.
        key = fingerprint((candidate.route, gaps[0]))
        attempts = self.store.control.setdefault("r5_gap_repairs", {})
        if attempts:
            return
        unit = WorkUnit(
            "r5-repair-" + key[:16],
            candidate.route,
            "Resolve this specific original-goal gap: "
            + gaps[0]
            + ". "
            + prompt_text.REPAIR_ANSWER_HINT,
            "REPAIR",
            tuple(
                d
                for d in artifact.dependencies
                if d not in self.store.refuted and d not in self.store.invalid_proofs
            ),
            candidate.obligations,
            artifact.scope,
            gaps[0],
            0,
        )
        try:
            review_input = artifact.text
            conflict = self.store.control.get("answer_conflicts", {}).get(artifact.id)
            if conflict:
                alternative = self.store.artifacts[conflict["alternative"]]
                review_input += (
                    "\nALTERNATIVE CANDIDATE FOR COMPARISON ONLY (its route assumptions are NOT verified parents):\n"
                    + alternative.text
                )
            if (
                self.process_closing_tool
                and computational_kind(gaps[0], "CHECK") == "COMPUTE"
            ):
                compute_unit = replace(
                    unit,
                    id="r5-compute-" + key[:16],
                    kind="COMPUTE",
                    goal=gaps[0],
                    obligations=("bounded_computation",),
                )
                computed = next(
                    (
                        a
                        for a in self.store.artifacts.values()
                        if a.work_unit == compute_unit.id
                    ),
                    None,
                )
                if computed is None:
                    computed, _ = self.call(
                        compute_unit,
                        deadline=self.budget.finish_end,
                        once="r5-computation",
                        review_input=review_input,
                        final=True,
                    )
                if computed.closed:
                    observation = self.process_closing_tool(computed, compute_unit)
                    feedback = failure_feedback(self.store, computed.id)
                    if feedback:
                        review_input += "\n" + render_feedback(feedback)
                    if observation.request in {
                        "local_registered_tool",
                        "local_generated_python",
                    }:
                        unit = replace(
                            unit,
                            dependencies=tuple(
                                dict.fromkeys((*unit.dependencies, observation.id))
                            ),
                        )
                self.store.event(
                    "r5_computation_attempted",
                    task=compute_unit.id,
                    original_deadline=self.budget.finish_end,
                )
            revised, _ = self.call(
                unit,
                deadline=self.budget.finish_end,
                once="r5-gap-repair",
                review_input=review_input,
                parent=artifact.id,
                final=True,
            )
            attempts[key] = revised.id
            replacement = self.register_candidate(revised, parent=candidate.id)
            self.store.event(
                "r5_gap_repair",
                original=candidate.id,
                revised=revised.id,
                gap=gaps[0],
                assembly_and_fallback_not_reset=True,
            )
            if not replacement:
                return
            from ..review_context import ReviewContext

            self.review.review(
                "task_tool",
                "R4",
                revised,
                deadline=self.budget.finish_end,
                closing=True,
                context=ReviewContext(
                    task=unit.goal,
                    issue=gaps[0],
                    old_derivation=artifact.text,
                    bindings=(artifact.digest, revised.digest),
                ),
            )
            if not exact_goal_coverage(self.store, replacement):
                doubt_id = "r5-unverified-" + revised.id
                self.store.challenge(
                    Challenge(
                        doubt_id,
                        revised.id,
                        gaps[0],
                        "Repair proposed; original doubt not independently discharged",
                        gaps[0],
                    )
                )
                self.store.update_challenge(
                    doubt_id,
                    "UNKNOWN",
                    check_artifact=revised.id,
                    resolution="repair candidate retained with original doubt; no independent discharge",
                )
                self.review.review(
                    "meaning",
                    "R5",
                    revised,
                    deadline=self.budget.finish_end,
                    **(
                        {"purpose": "FINAL_COVERAGE"}
                        if self.store.problem.goals
                        else {}
                    ),
                )
        except (AdmissionError, ContextCapacityError):
            self.store.event(
                "r5_gap_repair_unavailable",
                candidate=candidate.id,
                gap=gaps[0],
                original_candidate_retained=True,
            )
