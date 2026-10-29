"""Composition root and top-level orchestration for controller-owned workflows.

Workflow components receive explicit ports, not this facade. Compatibility
methods preserve callers while state transitions live in independently testable
components. This module does not implement their mathematical state machines.
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from functools import partial

from .domain import Artifact, Route
from .experiments import ExperimentConfig
from .goal_policy import DEFAULT as GOAL_DEFAULT
from .goal_policy import policy_for
from .obligation_scheduler import ObligationScheduler
from .policy import WORKFLOW_DEFAULTS
from .progress import ProgressTracker
from .review import ReviewService
from .skills import SkillCatalog
from .store import ArtifactStore
from .tools import RegisteredExecutor
from .verification import VerificationEngine, exact_goal_coverage
from .workflows.candidates import CandidateRegistration, candidate_payload
from .workflows.challenges import ChallengeWorkflow
from .workflows.closeout import CloseoutWorkflow
from .workflows.generated_python import GeneratedPythonWorkflow
from .workflows.generation import WorkUnitExecution
from .workflows.planning import PlanningWorkflow
from .workflows.routes import RouteWorkflow
from .workflows.state import BudgetWindow, CheckpointState
from .workflows.tools import ToolWorkflow

__all__ = ["Controller", "ProgressTracker", "candidate_payload"]


class Controller:
    def __init__(
        self,
        adapter,
        item,
        store: ArtifactStore,
        *,
        soft_seconds=None,
        total_items=None,
        experiment=None,
        python_sandbox=None,
        clock=None,
        registered_executor=None,
        method_catalog=None,
    ):
        self.adapter, self.item, self.store = adapter, item, store
        self.coord, self.clock = adapter.coordinator, clock or adapter.coordinator.clock
        self.total_items = total_items
        self.experiment = experiment or ExperimentConfig()
        if not self.experiment.enabled("python"):
            python_sandbox = None
        if python_sandbox is not None:
            if not python_sandbox.available or not python_sandbox.identity:
                raise ValueError("explicit accepted Python sandbox required")
            previous = store.control.get(
                "python_sandbox_profile", python_sandbox.identity
            )
            if previous != python_sandbox.identity:
                raise ValueError("cannot change Python sandbox during recovery")
            store.control["python_sandbox_profile"] = python_sandbox.identity
        elif store.control.get("python_sandbox_profile"):
            raise ValueError("cannot omit Python sandbox during recovery")
        existing_experiment = store.control.get("ablation", self.experiment.ablation)
        if existing_experiment != self.experiment.ablation:
            raise ValueError("cannot change an experiment during recovery")
        store.control["ablation"] = self.experiment.ablation
        from .entrypoint import code_version

        runtime_hash = code_version()
        if (
            store.control.setdefault("tool_flow_runtime_hash", runtime_hash)
            != runtime_hash
        ):
            raise ValueError(
                "cannot resume a mathematical run under changed runtime source"
            )
        expected_policy = asdict(
            replace(
                GOAL_DEFAULT,
                request_profile=getattr(adapter, "request_profile", "fixed_8192"),
            )
        )
        if "goal_policy" in store.control:
            if asdict(policy_for(store)) != expected_policy:
                raise ValueError("cannot change goal/request policy during recovery")
        else:
            store.control["goal_policy"] = expected_policy
        store.tasks.max_nodes = policy_for(store).task_nodes_per_problem_max
        cutoff = getattr(self.coord, "generation_cutoff", lambda value: value.deadline)(
            item
        )
        self.budget = BudgetWindow.start(
            item, soft_seconds=soft_seconds, generation_deadline=cutoff
        )
        self.skills = method_catalog if method_catalog is not None else SkillCatalog()
        self.review = ReviewService(
            adapter, item, store, self.experiment, clock=self.clock
        )
        self.tools = registered_executor or RegisteredExecutor()
        from .local_execution import GatedPython, GatedRegistered, LocalExecutionGate

        coordinator_path = getattr(adapter.coordinator, "path", None)
        if coordinator_path is not None:
            from pathlib import Path

            gate = LocalExecutionGate(
                Path(coordinator_path).parent / "local-execution-slots"
            )
            self.tools = GatedRegistered(self.tools, gate)
            if python_sandbox is not None:
                python_sandbox = GatedPython(python_sandbox, gate)
        self.verifier = VerificationEngine(
            self.tools,
            clock=self.clock,
            deadline=lambda: min(self.budget.finish_end, self.item.deadline),
        )
        self.progress = ProgressTracker()
        progress = store.control.get("progress", {})
        self.progress.stalled = dict(progress.get("stalled", {}))
        self.progress.seen = {k: set(v) for k, v in progress.get("seen", {}).items()}
        self.progress.exploration = dict(progress.get("exploration", {}))
        self.progress.identities = dict(progress.get("identities", {}))
        self.progress.result_keys = {
            k: set(v) for k, v in progress.get("result_keys", {}).items()
        }
        self.progress.semantic_seen = {
            k: set(v) for k, v in progress.get("semantic_seen", {}).items()
        }
        self._state = CheckpointState(
            coordinator=self.coord,
            item=item,
            store=store,
            budget=self.budget,
            progress=self.progress,
        )
        self.verifier.persist = self._state.persist
        self._generation = WorkUnitExecution(
            adapter=adapter,
            item=item,
            store=store,
            experiment=self.experiment,
            checkpoint=self._state.checkpoint,
            python_available=bool(python_sandbox and python_sandbox.available),
            skills=self.skills,
        )
        self._candidates = CandidateRegistration(
            store=store, verifier=self.verifier, persist=self._state.persist
        )
        self._challenges = ChallengeWorkflow(
            store=store,
            budget=self.budget,
            clock=self.clock,
            call=self._generation.call,
            review=self.review,
            verifier=self.verifier,
            register_candidate=self._candidates.register,
            resolve_unit=self._generation.unit_for_artifact,
            checkpoint=self._state.checkpoint,
        )
        self._tool_workflow = ToolWorkflow(
            store=store,
            budget=self.budget,
            review=self.review,
            executor=self.tools,
            process_challenge=self._challenges.process,
            generated_python=GeneratedPythonWorkflow(
                store=store,
                budget=self.budget,
                review=self.review,
                sandbox=python_sandbox,
                checkpoint=self._state.checkpoint,
            ),
            checkpoint=self._state.checkpoint,
        )
        # Wire the explicit port after both sides of the challenge/tool cycle
        # exist. Computational CHECK tasks use the same R3-gated executor.
        self._challenges.process_tool = self._tool_workflow.process_artifact
        self._planning = PlanningWorkflow(
            store=store,
            budget=self.budget,
            call=self._generation.call,
            review=self.review,
            skills=self.skills,
            checkpoint=self._state.checkpoint,
        )
        self._goal_scheduler = ObligationScheduler(
            store=store,
            budget=self.budget,
            clock=self.clock,
            coordinator=self.coord,
            review=self.review,
            verifier=self.verifier,
            process_challenge=self._challenges.process,
            resolve_unit=self._generation.unit_for_artifact,
            register_candidate=self._candidates.register,
            checkpoint=self._state.checkpoint,
            item=item,
            total_items=total_items,
        )
        self._challenges.defer_candidate_repair = (
            self._goal_scheduler.defer_candidate_repair
        )
        self._routes = RouteWorkflow(
            store=store,
            budget=self.budget,
            clock=self.clock,
            experiment=self.experiment,
            progress=self.progress,
            skills=self.skills,
            review=self.review,
            verifier=self.verifier,
            call=self._generation.call,
            register_candidate=self._candidates.register,
            process_tool=self._tool_workflow.process_artifact,
            process_challenge=self._challenges.process,
            pre_branch_review=self._challenges.pre_branch_review,
            checkpoint=self._state.checkpoint,
            tighten_budget=self._state.tighten_budget,
            suggest_budget=partial(
                self.coord.suggested_soft_seconds, item, known_total=total_items
            ),
            goal_scheduler=self._goal_scheduler,
        )
        self._closeout = CloseoutWorkflow(
            store=store,
            budget=self.budget,
            clock=self.clock,
            call=self._generation.call,
            register_candidate=self._candidates.register,
            review=self.review,
            experiment=self.experiment,
            context_check=self._generation.check_context,
            process_closing_tool=partial(
                self._tool_workflow.process_artifact, closing=True
            ),
            request_states=partial(self.coord.request_states, item)
            if callable(getattr(self.coord, "request_states", None))
            else None,
            check_pending_member=self._goal_scheduler._check_pending_member,
        )
        if self.experiment.enabled("dynamic_budget"):
            self.tighten_budget(
                self.coord.suggested_soft_seconds(item, known_total=total_items)
            )
        if "soft_seconds" in store.control:
            self.tighten_budget(store.control["soft_seconds"])
        if "closeout_solving_end" in store.control:
            self.budget.solving_end = min(
                self.budget.solving_end, store.control["closeout_solving_end"]
            )

    # Explicit compatibility properties share the same live budget object.

    @property
    def soft(self):
        return self.budget.soft

    @soft.setter
    def soft(self, value):
        self.budget.soft = value

    @property
    def planning_end(self):
        return self.budget.planning_end

    @planning_end.setter
    def planning_end(self, value):
        self.budget.planning_end = value

    @property
    def solving_end(self):
        return self.budget.solving_end

    @solving_end.setter
    def solving_end(self, value):
        self.budget.solving_end = value

    @property
    def finish_end(self):
        return self.budget.finish_end

    @finish_end.setter
    def finish_end(self, value):
        self.budget.finish_end = value

    @property
    def sequence(self):
        return self._generation.sequence

    @sequence.setter
    def sequence(self, value):
        self._generation.sequence = value

    @property
    def sequence_lock(self):
        return self._generation.sequence_lock

    def checkpoint(self):
        return self._state.checkpoint()

    def tighten_budget(self, seconds: float):
        return self._state.tighten_budget(seconds)

    def _tighten_budget(self, seconds: float):
        return self._state.tighten_budget(seconds)

    def artifact(self, generated, unit, parent=None):
        return self._generation.artifact(generated, unit, parent)

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
        return self._generation.call(
            unit,
            deadline=deadline,
            once=once,
            review_input=review_input,
            skill=skill,
            parent=parent,
            final=final,
        )

    def process_tool(self, artifact, unit):
        return self._tool_workflow.process_artifact(artifact, unit)

    def initial_plan(self):
        return self._planning.run()

    def candidate(self, artifact: Artifact, *, parent=None):
        return self._candidates.register(artifact, parent=parent)

    def _candidate(self, artifact: Artifact, *, parent=None):
        return self._candidates.register(artifact, parent=parent)

    def process_challenge(self, artifact, unit):
        return self._challenges.process(artifact, unit)

    def unit_for_artifact(self, artifact, fallback):
        return self._generation.unit_for_artifact(artifact, fallback)

    def solve(self):
        if self.store.tasks.nodes:
            lost = self.store.tasks.recover(self.store)
            if lost:
                self.store.control["recovery_lost_deliveries"] = lost
            self.store.event(
                "task_graph_recovery", lost_deliveries=lost, no_generation_replayed=True
            )
        plan, initial_findings = self.initial_plan()
        # Method classes are a conservative scheduling signal, not proof of true
        # mathematical independence. Unknown mechanisms never justify extra width.
        routes, known, signatures = [], set(), set()
        for route in plan.routes:
            signature = tuple(
                re.sub(
                    r"\s+",
                    " ",
                    re.sub(r"\btemperature\s*[:=]?\s*[\d.]+", "", value.lower()),
                ).strip()
                for value in (route.method, route.first_goal)
            )
            if signature in signatures:
                self.store.event(
                    "duplicate_method", route=route.id, mechanism=route.mechanism
                )
                continue
            signatures.add(signature)
            if route.mechanism != "UNKNOWN":
                known.add(route.mechanism)
            routes.append(route)
        advised_basis = self.store.control.get("route_review_decision", {}).get(
            "width_basis", ""
        )
        advised_difference = bool(
            advised_basis
            and len(signatures) >= 2
            and all(
                re.sub(
                    r"\btemperature\s*[:=]?\s*[\d.]+", "", route.method.lower()
                ).strip()
                for route in routes
            )
        )
        width = (
            WORKFLOW_DEFAULTS.max_active_routes
            if plan.suggested_width == 2 and (len(known) >= 2 or advised_difference)
            else 1
        )
        if not self.experiment.enabled("alternate_routes"):
            routes, width = routes[:1], 1
        self.store.event(
            "route_policy",
            active_limit=width,
            mechanisms_independence="not_proven_by_labels",
            requested_width=plan.suggested_width,
            width_reason="two distinct known mechanism descriptions"
            if width == 2 and len(known) >= 2
            else "adopted method review rationale: " + advised_basis
            if width == 2
            else "normal one route; extra independence not established or not requested",
        )
        findings = {}
        for route in routes:

            def applies(finding, route_id=route.id):
                mentioned = {
                    "route-" + number
                    for number in re.findall(
                        r"\bRoute\s+([1-3])\b",
                        finding.issue + " " + finding.basis,
                        re.IGNORECASE,
                    )
                }
                return not mentioned or route_id in mentioned

            findings[route.id] = [
                finding for finding in initial_findings if applies(finding)
            ]
            self._routes._seed_route(route, findings[route.id])
        with ThreadPoolExecutor(
            max_workers=WORKFLOW_DEFAULTS.max_active_routes,
            thread_name_prefix="math-route",
        ) as pool:
            while self.clock() < self.solving_end:
                additions = (
                    self.store.control.get("goal_closure", {})
                    .get("scheduler", {})
                    .get("new_routes", [])
                )
                for row in additions:
                    if (
                        row["id"] in {r.id for r in routes}
                        or len(routes) >= policy_for(self.store).routes_max
                    ):
                        continue
                    route = Route(**row)
                    routes.append(route)
                    findings[route.id] = []
                    self._routes._seed_route(route, [])
                    if self.experiment.enabled("alternate_routes"):
                        width = (
                            min(2, len({r.mechanism for r in routes} - {"UNKNOWN"}))
                            or 1
                        )
                    self.store.event(
                        "goal_route_adopted", route=row, active_limit=width
                    )
                if self._goal_scheduler.advance_urgent(routes):
                    self.checkpoint()
                if (
                    width == 1
                    and not any(
                        node.state
                        in {
                            "DELIVERED",
                            "WAITING_CHALLENGE",
                            "RUNNING",
                            "WAITING_TOOL",
                            "WAITING_ADOPTION",
                        }
                        for node in self.store.tasks.nodes.values()
                    )
                    and any(
                        c.artifact in self.store.verified
                        and exact_goal_coverage(self.store, c)
                        for c in self.store.candidates.values()
                    )
                ):
                    break
                pending = []
                for route in routes:
                    if self.store.control.get("routes_finished", {}).get(route.id):
                        continue
                    ready = self.store.tasks.ready(self.store, route.id)
                    delivered = any(
                        n.state == "DELIVERED"
                        for n in self.store.tasks.route_nodes(route.id)
                    )
                    waiting = self._routes.waiting(route)
                    if ready or delivered or waiting:
                        pending.append(
                            (
                                0 if delivered else ready[0].priority if ready else 20,
                                route.priority,
                                route.id,
                                route,
                            )
                        )
                if not pending:
                    advanced = False
                    for _ in range(policy_for(self.store).dispatch_batch_max):
                        if not self._goal_scheduler.advance(routes):
                            break
                        advanced = True
                        # Start a newly available mathematical task promptly;
                        # the batch may also include preceding local checks/reviews.
                        if self.store.tasks.ready(self.store):
                            break
                    if advanced:
                        continue
                    break
                turns = self.store.control.setdefault("route_service_turns", {})
                chosen = [
                    row[-1]
                    for row in sorted(
                        pending,
                        key=lambda row: (
                            turns.get(row[-1].id, 0)
                            // (WORKFLOW_DEFAULTS.exploration_rewards + 1),
                            *row[:-1],
                        ),
                    )[:width]
                ]
                for route in chosen:
                    turns[route.id] = turns.get(route.id, 0) + 1
                futures = [
                    (
                        route,
                        pool.submit(
                            self._routes.run,
                            route,
                            plan,
                            findings[route.id],
                            width,
                            one_step=True,
                        ),
                    )
                    for route in chosen
                ]
                for route, future in futures:
                    try:
                        future.result()
                    except Exception as exc:  # noqa: BLE001 - preserve other routes and fail this route closed
                        self.store.control.setdefault("routes_finished", {})[
                            route.id
                        ] = True
                        self.store.event(
                            "route_error", route=route.id, error_type=type(exc).__name__
                        )
        return self.closeout()

    def solve_route(self, route, plan, initial_findings, width):
        return self._routes.run(route, plan, initial_findings, width)

    def pre_branch_review(self, unit):
        return self._challenges.pre_branch_review(unit)

    def closeout(self):
        return self._closeout.run()
