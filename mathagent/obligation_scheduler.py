"""Bounded empty-queue audit, using the existing generation/review/task graph."""

from __future__ import annotations

from dataclasses import asdict, replace

from .domain import Route, Scope, WorkUnit
from .goal_contracts import current, render_contract
from .goal_ledger import active_obligations, sync_candidate_evidence
from .goal_policy import policy_for
from .observability import admission_wait_estimate
from .review_context import ReviewContext
from .runtime.config import fingerprint
from .solution_branches import (
    BRANCH_HINT,
    check_branch,
    checked_branch,
    eligible_merge_branches,
    propose_merge,
)
from .verification import exact_goal_coverage

TASK_GOALS = {
    "exhaustiveness": "Start with an arbitrary source solution. Derive a necessary classification and state exactly which cases remain unexcluded. Do not infer completeness from substitution.",
    "membership": "Establish original-condition satisfaction of one explicitly stated object or family, with its domain and parameter restrictions. Give a bounded tool proposal if useful.",
    "parameter_domain": "Determine parameter restrictions and degenerate cases of the stated family from the original conditions.",
    "exceptions": "Resolve one specific zero-denominator, endpoint, or exceptional parameter case from the current derivation. State the affected transformation.",
    "global_bound": "Derive a bound valid over the entire original feasible domain. A feasible example alone is not an optimum.",
    "attainment_or_limit": "Give and justify attainability of the proposed bound, or a valid limiting construction if only a supremum or infimum is meant.",
    "clarification": "Repair only the specified parsed contract fields against the original SOURCE_PROBLEM. Return TARGET_KIND: one allowed type; TARGETS: the original goal; SOURCE_REF: ORIGINAL; DOMAIN: original domain; QUANTIFIERS: original quantifiers; CONDITIONS: source constraints; OBLIGATIONS: remaining properties; UNCERTAINTIES: actual ambiguities or NONE. Separate fields with semicolons on one RESULT line. Do not transcribe SOURCE. An optimum is OPTIMIZE even when its answer is a number. Do not solve a different problem.",
    "proof": "Derive one missing implication from the original assumptions to the proof target; preserve all provisional premises explicitly.",
    "value": "Derive the requested value from the original definitions and convention, not from an unsupported numerical guess.",
    "option_coverage": "Assess the specified option under the original definitions. Preserve distinct correct labels even when semantically equivalent.",
    "label_consistency": "Reconcile the explicitly assessed option labels with the proposed selection; do not remove equivalent correct labels.",
    "object_domain": "Define the counted objects and full admissible domain from the original source.",
    "deduplication": "Establish whether the counting construction counts each object exactly once; resolve a concrete overlap.",
    "count": "Compute the count in the established finite domain with its completeness and deduplication assumptions explicit.",
    "subgoal_types": "Identify the independent subquestions and their required answer types from the original text.",
    "subgoal_coverage": "Supply the derivation for an uncovered subquestion without dropping the other requested outputs.",
}


class ObligationScheduler:
    def __init__(
        self,
        *,
        store,
        budget,
        clock,
        coordinator,
        review,
        verifier,
        process_challenge,
        resolve_unit,
        register_candidate,
        checkpoint,
        item=None,
        total_items=None,
    ):
        self.store, self.budget, self.clock = store, budget, clock
        self.coordinator, self.review, self.verifier = coordinator, review, verifier
        self.process_challenge, self.resolve_unit = process_challenge, resolve_unit
        self.register_candidate, self.checkpoint = register_candidate, checkpoint
        self.item, self.total_items = item, total_items

    def _grow_on_checked_progress(self):
        if (
            self.item is None
            or self.store.control.get("goal_closure_closing")
            or self.store.control.get("goal_closure_closed")
        ):
            return
        if not self.store.control.get("planning_reviewed"):
            return
        suggested = self.coordinator.suggested_soft_seconds(
            self.item, known_total=self.total_items
        )
        previous = self.budget.soft
        if self.budget.grow(suggested, started=self.item.started):
            self.store.event(
                "goal_budget_growth",
                previous_soft=previous,
                new_soft=self.budget.soft,
                planning_end_unchanged=self.budget.planning_end,
                hard_end=self.budget.hard_end,
                reason="new independently checked source member; current public capacity permits more work",
            )

    def _state(self):
        return self.store.control["goal_closure"]["scheduler"]

    def _capacity(self):
        preview = getattr(self.coordinator, "scheduling_capacity", None)
        if callable(preview) and self.item is not None:
            return preview(self.item, deadline=self.budget.solving_end)
        metrics = getattr(self.coordinator, "metrics", dict)()
        remaining = getattr(
            getattr(self.coordinator, "limits", None), "logical_requests", 10000
        ) - metrics.get("calls", 0)
        return {
            "logical_remaining": remaining,
            "effective_remaining": max(0, remaining - 2),
        }

    def _payable(self, required_calls=1):
        estimate = max(
            1.0, getattr(self.coordinator, "estimated_call_seconds", lambda: 0)()
        )
        remaining = min(self.budget.solving_end, self.budget.finish_end) - self.clock()
        wait = admission_wait_estimate(self.store)
        capacity = self._capacity()
        result = (
            remaining > required_calls * (estimate + wait)
            and capacity["effective_remaining"] >= required_calls
        )
        self.store.event(
            "goal_budget_decision",
            remaining_seconds=max(0, remaining),
            estimated_generation_seconds=estimate,
            estimated_wait=wait,
            logical_remaining=capacity["logical_remaining"],
            effective_remaining=capacity["effective_remaining"],
            capacity=capacity,
            payable=result,
            hard_deadline_extended=False,
            reason="preserve generation and closeout capacity",
        )
        return result

    def _enqueue(
        self,
        route,
        target,
        purpose,
        goal,
        *,
        kind="DERIVE",
        material="",
        refs=(),
        repair_issue=None,
    ):
        contract = current(self.store)
        policy = policy_for(self.store)
        state = self._state()
        if self._capacity()["effective_remaining"] <= 0:
            self.store.event(
                "goal_task_not_scheduled", reason="NO_EFFECTIVE_CALL_BUDGET"
            )
            return False
        if (
            kind == "CONTRACT_CLARIFY"
            and len(state.get("contract_repair_failures", []))
            >= policy.contract_repair_failures_max
        ):
            self.store.event(
                "goal_task_not_scheduled", reason="CONTRACT_REPAIR_FAILURE_BOUND"
            )
            return False
        bottleneck = fingerprint((self.store.problem.digest, target, purpose))
        with self.store.lock:
            self._refresh_progress()
            obligation = self._obligation(target, purpose)
            attempts = state.setdefault("obligation_attempts", {})
            if (
                obligation
                and attempts.get(obligation["id"], 0) >= policy.obligation_attempts_max
            ):
                self.store.event(
                    "goal_task_not_scheduled",
                    reason="TOTAL_ATTEMPT_BOUND",
                    obligation=obligation["id"],
                )
                return False
            scope, dependencies = self._continuation_materials(route.id, obligation)
            key = fingerprint(
                (
                    contract["id"],
                    target,
                    purpose,
                    refs,
                    goal,
                    material,
                    asdict(scope),
                    [(aid, self.store.artifacts[aid].digest) for aid in dependencies],
                )
            )
            jobs = state.setdefault("jobs", {})
            if (
                key in jobs
                or state.get("stalls", {}).get(bottleneck, 0)
                >= policy.no_progress_pause_after
            ):
                return False
            if state.get('unassessed_streaks', {}).get(bottleneck, 0) >= policy.unassessed_repeat_limit:
                self.store.event('goal_task_yielded', reason='UNASSESSED_REPETITION',
                    target=target, purpose=purpose, bottleneck=bottleneck,
                    mathematical_status='UNKNOWN', obligations_preserved=True,
                    note='Yield repeated unassessed work on the same target/purpose; no false progress or refutation.')
                return False
            if len(self.store.tasks.nodes) >= policy.task_nodes_per_problem_max:
                self.store.event("goal_scheduler_stop", reason="TASK_NODE_BOUND")
                return False
            unit = WorkUnit(
                "goal-" + key[:24],
                route.id,
                goal,
                kind,
                dependencies,
                ("original_goal_coverage",)
                if kind == "CANDIDATE"
                else ("goal_property",),
                scope,
                bottleneck,
                0 if kind == "CONTRACT_CLARIFY" else 3,
            )
            self.store.tasks.add(unit)
            jobs[key] = {
                "task": unit.id,
                "target": target,
                "purpose": purpose,
                "bottleneck": bottleneck,
                "contract": contract["id"],
                "state": "READY",
                "material": material,
                "refs": list(refs),
                "before": self._progress_signature(),
                "before_keys": sorted(self._progress_keys(target)),
            }
            if repair_issue is not None:
                jobs[key].update(
                    repair_issue=repair_issue.id, repair_source=repair_issue.target
                )
                self.store.tasks.update(unit.id, prior_output=repair_issue.target)
                state["minimal_repairs"][repair_issue.id].update(
                    state="SCHEDULED", task=unit.id
                )
            if obligation:
                attempts[obligation["id"]] = attempts.get(obligation["id"], 0) + 1
            self.store.control.setdefault("goal_tasks", {})[unit.id] = key
            self.store.control.setdefault("routes_finished", {}).pop(route.id, None)
            self.store.event(
                "goal_task_scheduled",
                task=unit.id,
                target=target,
                purpose=purpose,
                reason="specific open source obligation",
            )
        self.checkpoint()
        return True

    def _obligation(self, target, purpose):
        return next(
            (
                o
                for o in active_obligations(self.store)
                if o["target"] == target and o["property"] == purpose
            ),
            None,
        )

    def _continuation_materials(self, route, obligation):
        """Whole, live mathematical dependency bundles, never an unvalidated cross-route premise."""
        if not obligation or obligation["property"] == "clarification":
            return Scope(), ()
        store, revision = self.store, current(self.store)["id"]

        def live(a):
            return (
                a is not None
                and a.closed
                and a.problem == store.problem.digest
                and a.id not in store.refuted | store.invalid_proofs
                and store.control.get("artifact_contracts", {}).get(a.id, revision)
                == revision
            )

        materials = [store.artifacts.get(aid) for aid in obligation["materials"]]
        own = [a for a in materials if live(a) and a.route == route]
        scope = own[-1].scope if own else Scope()
        selected = []

        def bundle(a, visiting):
            if not live(a) or a.id in visiting:
                raise ValueError("invalid continuation material")
            if a.route != route and not store.applicable_evidence(a.id, scope):
                raise ValueError("unverified cross-route continuation")
            result = []
            for dep in a.dependencies:
                result.extend(bundle(store.artifacts.get(dep), visiting | {a.id}))
            return result + [a.id]

        for a in materials:
            if not live(a) or not a.scope.covers(scope):
                continue
            try:
                selected.extend(bundle(a, set()))
            except ValueError:
                continue
        return scope, tuple(dict.fromkeys(selected))

    def _progress_keys(self, target, *, task=None, artifact=None):
        store = self.store
        result = set()

        def belongs(aid):
            a = store.artifacts.get(aid)
            return a is not None and (
                task is None or a.work_unit == task or aid == artifact
            )

        for b in store.control["goal_closure"]["branches"].values():
            if b["target"] != target or not belongs(b["artifact"]):
                continue
            e = checked_branch(store, b)
            if e:
                result.add(
                    fingerprint(
                        (
                            b["target"],
                            e.verified_statement
                            if e.property == "branch_membership"
                            else b["object"],
                            e.scope.domain,
                            b["parameters"],
                            b["conditions"],
                            e.outcome,
                        )
                    )
                )
        related = {
            j.get("artifact")
            for j in self._state().get("jobs", {}).values()
            if j["target"] == target
        }
        for e in store.evidence.values():
            a = store.artifacts.get(e.artifact_id)
            if (
                a
                and a.id in related
                and belongs(a.id)
                and e.artifact_hash == a.digest
                and e.checker == "registered_exact_checker"
                and e.checker_version == self.verifier.version
                and e.outcome in {"SUPPORTS", "REFUTES"}
            ):
                result.add(
                    fingerprint(
                        (e.property, asdict(e.scope), e.outcome, e.verified_statement)
                    )
                )
        return result

    def _refresh_progress(self):
        """Recompute consecutive stalls from completed jobs; late local checks can supply progress."""
        state = self._state()
        streaks, unassessed, seen = {}, {}, {}
        for key in state.get("completed_jobs", []):
            row = state["jobs"][key]
            if row["contract"] != current(self.store)["id"]:
                continue
            bottle = row["bottleneck"]
            keys = self._progress_keys(
                row["target"], task=row["task"], artifact=row.get("artifact")
            )
            new = (
                keys - set(row.get("before_keys", [])) - seen.setdefault(bottle, set())
            )
            seen[bottle].update(keys)
            gain = bool(new) or row.get("solver_gain") in {"EXPLORATION", "RESULT"}
            row["checked_progress"] = bool(new)
            row["productive"] = gain
            if gain:
                streaks[bottle] = 0
                unassessed[bottle] = 0
            elif row.get("solver_gain") == "UNASSESSED":
                streaks.setdefault(bottle, 0)
                unassessed[bottle] = unassessed.get(bottle, 0) + 1
            else:
                streaks[bottle] = streaks.get(bottle, 0) + 1
        state.setdefault("stalls", {}).update(streaks)
        state.setdefault('unassessed_streaks', {}).update(unassessed)

    def note_route_progress(self, unit, gain):
        with self.store.lock:
            key = self.store.control.get("goal_tasks", {}).get(unit.id)
            if key:
                row = self._state()["jobs"][key]
                row["solver_gain"] = (
                    "NONE" if row.get("state") == "CONTRACT_REPAIR_FAILED" else gain
                )
                self._refresh_progress()

    def expand_followups(self, unit, artifact, goals, join_goal):
        """Keep explicit NEXT/JOIN on the same obligation, without a default whole-answer task."""
        from .work_delivery import computational_kind

        if self.is_minimal_repair(unit):
            if goals:
                self.store.event(
                    "goal_followups_not_scheduled",
                    reason="BOUNDED_LOCAL_REPAIR",
                    target=artifact.id,
                )
            return False
        with self.store.lock:
            store, graph = self.store, self.store.tasks
            key = store.control["goal_tasks"][unit.id]
            row = self._state()["jobs"][key]
            expanded = store.control.setdefault("expanded_tasks", [])
            if unit.id in expanded:
                return bool(graph.descendants(unit.id))
            if (
                not artifact.closed
                or row["contract"] != current(store)["id"]
                or not goals
            ):
                return False
            if self.clock() >= self.budget.solving_end:
                return False
            specs = []
            for i, goal in enumerate(goals):
                child = replace(
                    unit,
                    id=f"{unit.id}.next{i + 1}",
                    goal=goal,
                    kind=computational_kind(goal),
                    obligations=("goal_property",),
                )
                specs.append((child, (unit.id,)))
            if len(specs) > 1 or join_goal:
                child = replace(
                    unit,
                    id=unit.id + ".join",
                    kind="DERIVE",
                    goal=join_goal
                    or "Combine the supplied subtask results to advance this obligation: "
                    + row["target"],
                    dependencies=tuple(
                        dict.fromkeys((*unit.dependencies, artifact.id))
                    ),
                    obligations=("goal_property",),
                )
                specs.append((child, tuple(c.id for c, _ in specs)))
            policy = policy_for(store)
            obligation = self._obligation(row["target"], row["purpose"])
            attempts = self._state().setdefault("obligation_attempts", {})
            if len(
                set(graph.nodes) | set(graph.external_ids()) | {u.id for u, _ in specs}
            ) > graph.max_nodes or (
                obligation
                and attempts.get(obligation["id"], 0) + len(specs)
                > policy.obligation_attempts_max
            ):
                store.event(
                    "goal_followups_not_scheduled",
                    reason="TASK_OR_ATTEMPT_BOUND",
                    target=artifact.id,
                )
                return False
            for child, parents in specs:
                if (
                    not child.goal.strip()
                    or len(child.goal) > 5000
                    or (
                        child.id in graph.nodes
                        and (
                            graph.nodes[child.id].unit != child
                            or graph.nodes[child.id].parents != parents
                        )
                    )
                ):
                    store.event(
                        "goal_followups_not_scheduled",
                        reason="INVALID_OR_CONFLICTING_TASK",
                        target=artifact.id,
                    )
                    return False
            for child, parents in specs:
                graph.add(child, parents)
                child_key = fingerprint((key, child.id, artifact.digest))
                self._state()["jobs"][child_key] = {
                    **{
                        k: row[k]
                        for k in (
                            "target",
                            "purpose",
                            "bottleneck",
                            "contract",
                            "material",
                            "refs",
                        )
                    },
                    "task": child.id,
                    "state": "READY",
                    "before_keys": sorted(self._progress_keys(row["target"])),
                    "parent_job": key,
                }
                store.control["goal_tasks"][child.id] = child_key
            if obligation:
                attempts[obligation["id"]] = attempts.get(obligation["id"], 0) + len(
                    specs
                )
            expanded.append(unit.id)
            store.event(
                "goal_followups_scheduled",
                target=artifact.id,
                tasks=[u.id for u, _ in specs],
                goal=row["target"],
                purpose=row["purpose"],
                default_candidate_created=False,
            )
            self.checkpoint()
            return True

    def _progress_signature(self):
        state = self.store.control["goal_closure"]
        branches = {
            fingerprint(
                (
                    b["target"],
                    b["object"],
                    b["domain"],
                    b["parameters"],
                    b["conditions"],
                    e.outcome,
                )
            )
            for b in state["branches"].values()
            if (e := checked_branch(self.store, b))
        }
        evidence = {
            fingerprint((e.property, asdict(e.scope), e.outcome, e.verified_statement))
            for e in self.store.evidence.values()
        }
        return fingerprint((sorted(branches), sorted(evidence)))

    def completed(self, unit, artifact):
        from .delivery_types import DeliveryType, classify

        if classify(unit, artifact.text, closed=artifact.closed) not in {
            DeliveryType.MATHEMATICAL_ARTIFACT,
            DeliveryType.CONTRACT_OR_BINDING_REPAIR,
        }:
            return
        key = self.store.control.get("goal_tasks", {}).get(unit.id)
        if not key:
            return
        row = self._state()["jobs"][key]
        if row["contract"] != current(self.store)["id"] or self.store.control.get(
            "goal_closure_closed"
        ):
            return
        if unit.kind == "CONTRACT_CLARIFY":
            return self._complete_clarification(unit, artifact, row, key)
        if row["purpose"] == "MINIMAL_REPAIR" and not row.get(
            "repair_review_attempted"
        ):
            row["repair_review_attempted"] = True
            issue = self.store.challenges[row["repair_issue"]]
            old = self.store.artifacts[row["repair_source"]]
            repair_review = None
            if artifact.closed and self.clock() < self.delivery_deadline(unit):
                for branch in list(
                    self.store.control["goal_closure"]["branches"].values()
                ):
                    if branch[
                        "artifact"
                    ] == artifact.id and self.clock() < self.delivery_deadline(unit):
                        from .verification import VerificationEngine

                        scoped = VerificationEngine(
                            self.verifier.executor,
                            clock=self.clock,
                            deadline=lambda: min(
                                self.verifier.deadline(), self.delivery_deadline(unit)
                            ),
                        )
                        check_branch(self.store, branch["id"], scoped)
                repair_review = self.review.review(
                    "task_tool",
                    "R4",
                    artifact,
                    deadline=self.delivery_deadline(unit),
                    context=ReviewContext(
                        task=unit.goal,
                        issue=issue.issue,
                        basis=issue.basis,
                        old_derivation=self.store.public_text(old),
                        conditions="Only this local repair is being assessed; the refuted original answer remains refuted and exhaustiveness remains open.",
                        bindings=(
                            old.digest,
                            artifact.digest,
                            issue.id,
                            issue.next_check,
                        ),
                    ),
                )
            row["repair_review_state"] = (
                "COMPLETE"
                if repair_review
                and repair_review.complete
                and self.clock() < self.delivery_deadline(unit)
                else "INCOMPLETE_OR_DEADLINE"
            )
            if row["repair_review_state"] != "COMPLETE":
                row["remaining_gap"] = (
                    "local mathematical material retained; bounded R4 not complete within original group deadline"
                )
            self._state()["minimal_repairs"][issue.id].update(
                state="DELIVERED" if artifact.closed else "PARTIAL",
                replacement=artifact.id,
            )
            self.store.event(
                "minimal_repair_delivered",
                artifact=artifact.id,
                original=old.id,
                closed=artifact.closed,
                original_candidate_promoted=False,
            )
        row["state"], row["artifact"] = (
            "DELIVERED" if artifact.closed else "PARTIAL",
            artifact.id,
        )
        for obligation in active_obligations(self.store):
            if (
                obligation["target"] == row["target"]
                and obligation["property"] == row["purpose"]
            ):
                if artifact.id not in obligation["materials"]:
                    obligation["materials"].append(artifact.id)
                if obligation["state"] != "VERIFIED_FOR_SCOPE":
                    obligation["state"] = (
                        "MATERIAL_AVAILABLE" if artifact.closed else "UNKNOWN"
                    )
        completed = self._state().setdefault("completed_jobs", [])
        if key not in completed:
            completed.append(key)
        self._refresh_progress()
        stalls = self._state()["stalls"]
        self.store.event(
            "goal_task_progress",
            task=unit.id,
            progress="CHECKED_RESULT" if row.get("checked_progress") else "UNASSESSED",
            no_new_checked_result=stalls[row["bottleneck"]],
        )
        if not artifact.closed or row["contract"] != current(self.store)["id"]:
            return
        if unit.kind == "ROUTE_EXTENSION":
            from .planning import parse_plan

            parsed = parse_plan(
                "CARD: remaining obligations; FIELDS: general; " + artifact.text
            )
            initial = (
                self.store.control.get("planning", {}).get("plan", {}).get("routes", [])
            )
            known = {r["mechanism"] for r in initial}
            additions = self._state().setdefault("new_routes", [])
            for proposed in parsed.routes[
                : policy_for(self.store).new_routes_per_extension_max
            ]:
                if proposed.mechanism == "UNKNOWN" or proposed.mechanism in known:
                    continue
                known.add(proposed.mechanism)
                route = Route(
                    "route-extension-" + str(len(additions) + 1),
                    proposed.method,
                    "Check all necessary applicability assumptions of the proposed method, then "
                    + proposed.first_goal,
                    proposed.mechanism,
                    len(initial) + len(additions) + 1,
                )
                additions.append(asdict(route))
                self.store.event(
                    "goal_route_proposed", route=asdict(route), requires_R1=True
                )

    def _complete_clarification(self, unit, artifact, row, key):
        from .goal_contracts import (
            adopt_contract,
            contract_fields,
            parse_proposal,
            prepare_proposal,
            proposal_issues,
        )

        if row.get("state") in {"CONTRACT_REPAIR_FAILED", "CONTRACT_REPAIRED"}:
            return
        row["artifact"] = artifact.id
        parsed = prepare_proposal(
            parse_proposal(contract_fields(artifact.text)), self.store.problem.raw
        )
        gaps = proposal_issues(parsed, self.store.problem.raw)
        if not artifact.closed:
            gaps["DELIVERY"] = "clarification was not delivered completely"
        review = None
        if not gaps and self._payable():
            review = self.review.review(
                "meaning",
                "R1",
                artifact,
                deadline=self.budget.solving_end,
                purpose="REVISION",
            )
        if (
            not gaps
            and review
            and review.complete
            and review.interpretation == "NO_SPECIFIC_ISSUE"
        ):
            revised = adopt_contract(
                self.store,
                parsed,
                [review],
                parent=row["contract"],
                reason="source-based interpretation correction",
                required_roles={"meaning"},
            )
            row["state"] = "CONTRACT_REPAIRED"
            self.store.event(
                "contract_repair_result",
                task=unit.id,
                repaired=True,
                contract=revised["id"],
            )
            if (
                self.item is not None
                and callable(getattr(self.coordinator, "record_request_fact", None))
                and any(
                    event["kind"] == "delivery"
                    and event["details"].get("request") == artifact.request
                    for event in self.store.events
                )
            ):
                from .runtime.coordinator import Lease

                self.coordinator.record_request_fact(
                    Lease(
                        artifact.request,
                        self.item.id,
                        self.budget.solving_end,
                        "contract_clarify",
                    ),
                    "task_delivered",
                )
        else:
            row["state"], row["solver_gain"] = "CONTRACT_REPAIR_FAILED", "NONE"
            row["field_gaps"] = gaps or {"MEANING_REVIEW": "correction not accepted"}
            failures = self._state().setdefault("contract_repair_failures", [])
            if key not in failures:
                failures.append(key)
            completed = self._state().setdefault("completed_jobs", [])
            if key not in completed:
                completed.append(key)
            self._refresh_progress()
            self.store.event(
                "contract_repair_result",
                task=unit.id,
                repaired=False,
                field_gaps=row["field_gaps"],
                engineering_failure=True,
                failure_count=len(failures),
            )
        for material in self.store.control["goal_closure"]["materials"].values():
            if material["artifact"] == artifact.id:
                material["state"] = row["state"]
        self.checkpoint()

    def advance_urgent(self, routes):
        """Contract repair and goal work compete before ordinary routes drain."""
        contract = current(self.store)
        if not contract or not routes or self.store.control.get("goal_closure_closed"):
            return False
        if self.clock() >= self.budget.finish_end:
            return False
        # A refuted aggregate can contain useful members. Local checks do not
        # depend on a model permit, an eligible whole answer, or an empty graph.
        if self._check_pending_member():
            return True
        if any(
            node.state in {"READY", "RUNNING", "DELIVERED"}
            for node in self.store.tasks.nodes.values()
            if node.unit.id in self.store.control.get("goal_tasks", {})
        ):
            return False
        if not contract.get("usable", contract["kind"] != "UNKNOWN"):
            obligation = next(
                (
                    o
                    for o in active_obligations(self.store)
                    if o["property"] == "clarification"
                ),
                None,
            )
            if obligation and self._payable(required_calls=2):
                state = self._state()
                used = state.get("obligation_attempts", {}).get(obligation["id"], 0)
                return self._enqueue(
                    routes[0],
                    obligation["target"],
                    "clarification",
                    TASK_GOALS["clarification"]
                    + "\nRepair exactly: "
                    + str(contract.get("field_gaps", {})),
                    kind="CONTRACT_CLARIFY",
                    refs=(str(used),),
                )
            return False
        # No surviving candidate and an already fully proved candidate are
        # different states. Recovery work must not reopen a solved question.
        if any(
            c.artifact not in self.store.refuted and exact_goal_coverage(self.store, c)
            for c in self.store.candidates.values()
        ):
            return False
        candidates = [
            c
            for c in self.store.candidates.values()
            if c.artifact not in self.store.refuted
            and not exact_goal_coverage(self.store, c)
        ]
        if not self._payable():
            return False
        if self._schedule_merge(routes[0], contract):
            return True
        if self._schedule_binding_repair(routes[0], contract):
            return True
        if not candidates:
            if contract["kind"] == "ALL_SOLUTIONS" and self.store.candidates:
                for target in contract["targets"]:
                    if target in self._state().setdefault("outside_scheduled", []):
                        continue
                    if self._enqueue(
                        routes[0],
                        target,
                        "OUTSIDE_SEARCH",
                        "No complete answer has survived source checks. Derive one new source-valid object or a specific necessary case from the original conditions. Do not assume any rejected candidate is true."
                        + BRANCH_HINT,
                        kind="OUTSIDE_SEARCH",
                    ):
                        self._state()["outside_scheduled"].append(target)
                        return True
            return self._schedule_minimal_repair(routes[0])
        # Only one auditable goal action at this dispatch boundary. The normal
        # worker still handles its own checks; no extra unbounded review loop.
        candidate = candidates[-1]
        if self._special_review(candidate):
            return True
        contract_id = contract["id"]
        if contract["kind"] in {"ALL_SOLUTIONS", "COUNT", "MULTI_SELECT"}:
            state = self._state()
            for target in contract["targets"]:
                if target in state.setdefault("outside_scheduled", []):
                    continue
                if self._enqueue(
                    routes[0],
                    target,
                    "OUTSIDE_SEARCH",
                    "Find a source-valid object outside the stated candidate set or a specific unexcluded case. No object found means UNKNOWN."
                    + BRANCH_HINT,
                    kind="OUTSIDE_SEARCH",
                    material="Current claimed objects, not a uniqueness proof:\n"
                    + candidate.answer,
                ):
                    state["outside_scheduled"].append(target)
                    self.store.event(
                        "goal_early_dispatch",
                        contract=contract_id,
                        purpose="OUTSIDE_SEARCH",
                    )
                    return True
        return self._schedule_minimal_repair(routes[0])

    def _check_pending_member(self):
        contract = current(self.store)
        if not contract or self.store.control.get("goal_closure_closed"):
            return False
        for branch in list(self.store.control["goal_closure"]["branches"].values()):
            if (
                branch["contract"] == contract["id"]
                and branch["membership"] == "CHECK_PENDING"
            ):
                before = self._progress_signature()
                evidence = check_branch(self.store, branch["id"], self.verifier)
                if evidence and self._progress_signature() != before:
                    self._grow_on_checked_progress()
                self.checkpoint()
                return True
        return False

    def _schedule_merge(self, route, contract):
        state = self._state()
        for target in contract["targets"]:
            merge = propose_merge(
                self.store, eligible_merge_branches(self.store, target), target
            )
            if not merge or merge["id"] in state.setdefault("merges_scheduled", []):
                continue
            if self._enqueue(
                route,
                target,
                "MERGE",
                "Organize the supplied source-checked objects into a candidate for the original target. Preserve their exact domains. State explicitly if exhaustiveness has not been proved. Return ANSWER and BASIS.",
                kind="CANDIDATE",
                material="\n".join(
                    "Source-checked object: " + obj for obj in merge["objects"]
                ),
                refs=tuple(merge["branches"]),
            ):
                state["merges_scheduled"].append(merge["id"])
                return True
        return False

    def _schedule_binding_repair(self, route, contract):
        import json

        state = self._state()
        attempted = state.setdefault("binding_repairs", [])
        for key, row in (
            self.store.control["goal_closure"]
            .get("unbound_branch_proposals", {})
            .items()
        ):
            if len(attempted) >= policy_for(self.store).binding_repairs_max:
                break
            if key in attempted or row["contract"] != contract["id"]:
                continue
            if self._enqueue(
                route,
                contract["targets"][0] if contract["targets"] else "Original problem",
                "BIND_MEMBER",
                "Bind the explicitly proposed object to a current original target, preserving its domain, parameter restrictions and case conditions. A polynomial subclass is not the full function class. Return complete BRANCH fields with the exact current target, or UNBOUND; do not assert completeness."
                + BRANCH_HINT,
                kind="EXTRACT_BRANCHES",
                material=json.dumps(row["proposal"], ensure_ascii=False),
                refs=(key,),
            ):
                attempted.append(key)
                return True
        return False

    def defer_candidate_repair(self, artifact, unit, issue, evidence):
        """Yield whole-answer repair to the ordinary task scheduler."""
        contract = current(self.store)
        if (
            not contract
            or contract["kind"] != "ALL_SOLUTIONS"
            or not contract["targets"]
            or evidence.property != "source_function_satisfaction"
            or not any(
                c.artifact == artifact.id for c in self.store.candidates.values()
            )
        ):
            return False
        with self.store.lock:
            rows = self._state().setdefault("minimal_repairs", {})
            if issue.id not in rows:
                rows[issue.id] = {
                    "artifact": artifact.id,
                    "issue": issue.id,
                    "contract": contract["id"],
                    "target": contract["targets"][0],
                    "state": "PENDING",
                }
                self.store.event(
                    "candidate_repair_deferred",
                    artifact=artifact.id,
                    issue=issue.id,
                    whole_answer_roll=False,
                )
        self.checkpoint()
        return True

    def _schedule_minimal_repair(self, route):
        state = self._state()
        for row in state.get("minimal_repairs", {}).values():
            if (
                row["state"] != "PENDING"
                or row["contract"] != current(self.store)["id"]
            ):
                continue
            issue = self.store.challenges[row["issue"]]
            artifact = self.store.artifacts[row["artifact"]]
            if self._enqueue(
                route,
                row["target"],
                "MINIMAL_REPAIR",
                "Repair one mathematical defect only: "
                + issue.issue
                + ". "
                + issue.basis
                + ". Deliver a corrected necessary relation or explicit candidate member, not a complete classification or a repeated final ANSWER."
                + BRANCH_HINT,
                kind="REPAIR",
                material=self.store.public_text(artifact),
                refs=(issue.id,),
                repair_issue=issue,
            ):
                return True
        return False

    def is_minimal_repair(self, unit):
        key = self.store.control.get("goal_tasks", {}).get(unit.id)
        return bool(key and self._state()["jobs"][key]["purpose"] == "MINIMAL_REPAIR")

    def delivery_deadline(self, unit):
        if not self.is_minimal_repair(unit):
            return self.budget.solving_end
        row = self._state()["jobs"][self.store.control["goal_tasks"][unit.id]]
        if "delivery_deadline" not in row:
            policy = policy_for(self.store)
            row["delivery_started"] = self.clock()
            row["delivery_deadline"] = min(
                row["delivery_started"]
                + min(
                    policy.minimal_repair_seconds_max,
                    policy.minimal_repair_soft_fraction * self.budget.soft,
                ),
                self.budget.solving_end,
                self.budget.finish_end,
            )
            self.checkpoint()
        return min(
            row["delivery_deadline"], self.budget.solving_end, self.budget.finish_end
        )

    def _special_review(self, candidate):
        if (
            len(self.store.tasks.nodes)
            >= policy_for(self.store).task_nodes_per_problem_max
        ):
            return False
        contract, state = current(self.store), self._state()
        if contract["kind"] not in {
            "ALL_SOLUTIONS",
            "MULTI_SELECT",
            "MULTIPART",
            "COUNT",
            "OPTIMIZE",
        }:
            return False
        artifact = self.store.artifacts[candidate.artifact]
        if artifact.id in self.store.invalid_proofs:
            return False
        target = " | ".join(contract["targets"])
        # Goal-wide budget survives new candidate IDs or new route names.
        used = state.setdefault("reviews_used", {})
        scope_identity = fingerprint(
            (
                contract["id"],
                candidate.answer,
                artifact.text,
                tuple(artifact.dependencies),
            )
        )
        done = state.setdefault("special_reviews", {})
        for purpose, role in (
            ("MEMBERSHIP", "task_tool"),
            ("EXHAUSTIVENESS", "method"),
            ("EXCEPTIONS", "meaning"),
        ):
            key = fingerprint((scope_identity, purpose))
            if (
                key in done
                or used.get(target, 0) >= policy_for(self.store).initial_cycles * 3
            ):
                continue
            context = ReviewContext(
                task=target,
                conditions=render_contract(self.store),
                bindings=(contract["id"], artifact.digest),
            )
            # Only the exact candidate and necessary premises; no other reports or votes.
            done[key] = {
                "purpose": purpose,
                "candidate": candidate.id,
                "state": "STARTED",
            }
            used[target] = used.get(target, 0) + 1
            self.checkpoint()
            report = self.review.review(
                role,
                "R2",
                artifact,
                deadline=self.budget.solving_end,
                context=context,
                purpose=purpose,
            )
            done[key]["state"] = (
                "DELIVERED" if report and report.complete else "UNKNOWN"
            )
            self.checkpoint()
            return True
        return False

    def advance(self, routes):
        """One bounded audit step. True means a new action actually occurred."""
        store, contract = self.store, current(self.store)
        if not contract or store.control.get("goal_closure_closed"):
            return False
        if (
            store.control.get("recovery_lost_deliveries")
            and not store.candidates
            and not any(
                a.closed and a.route != "planning" for a in store.artifacts.values()
            )
        ):
            # A finished but lost generation cannot be replayed as a reread task.
            # Preserve the separately admitted original ASSEMBLE/FALLBACK opportunity.
            store.event(
                "goal_scheduler_stop", reason="LOST_DELIVERY_USE_BOUNDED_CLOSEOUT"
            )
            return False
        if self.clock() >= self.budget.finish_end:
            store.event("goal_scheduler_stop", reason="ORIGINAL_FINISH_WINDOW")
            return False
        # Local checks do not need a new model lease or remaining logical quota.
        if self._check_pending_member():
            return True
        if not self._payable():
            store.event("goal_scheduler_stop", reason="NO_PAYABLE_WINDOW")
            return False
        state = self._state()
        self._refresh_progress()
        # Each independent pending issue has its own once, even after a cached context.
        for issue in list(store.challenges.values()):
            if issue.status not in {
                "OPEN",
                "CONFIRMED",
                "CHECKING",
            } or issue.id in state.setdefault("issues_attempted", []):
                continue
            artifact = store.artifacts[issue.target]
            fallback = WorkUnit(
                artifact.work_unit,
                artifact.route,
                issue.next_check,
                "CHECK",
                artifact.dependencies,
                ("bounded_check",),
                artifact.scope,
            )
            state["issues_attempted"].append(issue.id)
            self.process_challenge(artifact, self.resolve_unit(artifact, fallback))
            self.checkpoint()
            return True
        for candidate in list(store.candidates.values()):
            sync_candidate_evidence(store, candidate)
            if exact_goal_coverage(store, candidate):
                store.event(
                    "goal_scheduler_stop",
                    reason="FULL_SOURCE_COVERAGE",
                    candidate=candidate.id,
                )
                return False
            from .claim_bindings import check_outside_claim

            for branch in list(store.control["goal_closure"]["branches"].values()):
                if checked_branch(store, branch):
                    check_outside_claim(store, candidate, branch)
        route = routes[0] if routes else None
        if route is None:
            return False
        if self._schedule_minimal_repair(route):
            return True
        if self._schedule_merge(route, contract):
            return True
        eligible = [
            c for c in store.candidates.values() if c.artifact not in store.refuted
        ]
        candidate = eligible[-1] if eligible else None
        if contract["kind"] == "ALL_SOLUTIONS" and contract["targets"]:
            extracts = state.setdefault("extraction_tasks", [])
            for material in store.control["goal_closure"]["materials"].values():
                unit = store.control.get("artifact_units", {}).get(
                    material["artifact"], {}
                )
                if (
                    len(extracts) >= 2
                    or material["id"] in extracts
                    or material["branches"]
                    or material["contract"] != contract["id"]
                    or unit.get("kind") not in {"DERIVE", "CHECK", "OUTSIDE_SEARCH"}
                    or store.artifacts[material["artifact"]].route != route.id
                ):
                    continue
                extracts.append(material["id"])
                if self._enqueue(
                    route,
                    contract["targets"][0],
                    "EXTRACT_BRANCHES",
                    "Extract only explicit mathematical objects actually present in the supplied material. Do not infer families or invent missing conditions. If no object is identifiable say UNEXTRACTABLE and preserve the exact gap."
                    + BRANCH_HINT,
                    kind="EXTRACT_BRANCHES",
                    material=material["text"],
                    refs=(material["id"],),
                ):
                    return True
        if candidate and self._special_review(candidate):
            return True
        for target in contract["targets"]:
            if (
                contract["kind"] in {"ALL_SOLUTIONS", "COUNT", "MULTI_SELECT"}
                and candidate
            ):
                scope = contract["scope"]
                material = (
                    "Current claimed objects (not a uniqueness proof):\n"
                    + candidate.answer
                    + "\nDomain: "
                    + scope["domain"]
                )
                if target not in state.setdefault("outside_scheduled", []):
                    state["outside_scheduled"].append(target)
                    if self._enqueue(
                        route,
                        target,
                        "OUTSIDE_SEARCH",
                        "Find an original-condition object outside the stated candidate set, or a concrete unexcluded case. Use a different representation where useful. No object found means UNKNOWN, not nonexistence."
                        + BRANCH_HINT,
                        kind="OUTSIDE_SEARCH",
                        material=material,
                    ):
                        return True
        # Missing first-read fields retain general route work. Explicit ambiguities get a bounded clarification.
        latest = {
            (j["target"], j["purpose"]): j.get("productive", False)
            for key in state.get("completed_jobs", [])
            for j in (state["jobs"][key],)
        }
        obligations = sorted(
            active_obligations(store),
            key=lambda o: (
                state.get("obligation_attempts", {}).get(o["id"], 0),
                not latest.get((o["target"], o["property"]), False),
            ),
        )
        for obligation in obligations:
            key = obligation["id"]
            used = state.setdefault("obligation_attempts", {}).get(key, 0)
            if used >= policy_for(store).obligation_attempts_max:
                continue
            purpose = obligation["property"]
            material = ""
            if candidate:
                a = store.artifacts[candidate.artifact]
                # Unverified material is kept route-local; never inserted in Verified Parent.
                if a.route == route.id:
                    material = store.public_text(a)
            goal = (
                TASK_GOALS[purpose]
                + "\nSpecific source target: "
                + obligation["target"]
            )
            if self._enqueue(
                route,
                obligation["target"],
                purpose,
                goal,
                kind="CONTRACT_CLARIFY" if purpose == "clarification" else "DERIVE",
                material=material,
                refs=(str(used),),
            ):
                return True
        # One upper-level route proposal, not a restarted PLAN/R0.
        if (
            contract["targets"]
            and not state.get("route_extension_requested")
            and len(routes) < policy_for(store).routes_max
        ):
            state["route_extension_requested"] = True
            return self._enqueue(
                route,
                " | ".join(contract["targets"]),
                "ROUTE_EXTENSION",
                "For the remaining source obligations propose at most two substantively different methods with assumptions, not paraphrases of existing methods. Return ROUTE 1: method; TASK: one bounded next mathematical task; ROUTE 2: method; TASK: task. Do not solve the whole problem.",
                kind="ROUTE_EXTENSION",
                material="Existing methods: " + "; ".join(r.method for r in routes),
            )
        attempts_capped = [
            o["id"]
            for o in obligations
            if state.get("obligation_attempts", {}).get(o["id"], 0)
            >= policy_for(store).obligation_attempts_max
        ]
        store.event(
            "goal_scheduler_stop",
            reason="TOTAL_ATTEMPT_BOUND"
            if obligations and len(attempts_capped) == len(obligations)
            else "NO_PRODUCTIVE_TASK",
            unresolved=[o["id"] for o in active_obligations(store)],
            attempts_capped=attempts_capped,
        )
        return False
