"""Single-route graph execution; explicit collaborators, no Controller dependency."""

from dataclasses import asdict, dataclass, replace

from ..answer_contracts import answer_identity
from ..domain import Artifact, CandidateRevision, Challenge, Evidence, Scope, WorkUnit
from ..policy import WORKFLOW_DEFAULTS
from ..prompts import workflows as prompt_text
from ..runtime.config import fingerprint
from ..runtime.coordinator import AdmissionError
from ..skills import SkillCatalog
from ..task_graph import proposed_followups
from ..task_scope import scope_for_goal
from ..tool_feedback import failure_feedback
from ..work_delivery import bare_math, computational_kind, computational_method
from ..delivery_types import DeliveryType, classify, count_fact
from .candidates import candidate_gaps, candidate_payload
from .ports import (
    ArtifactProcessor,
    BranchReview,
    CandidateRegistrar,
    Checkpoint,
    WorkUnitCall,
)

RETRY_DELIVERY = object()


@dataclass(frozen=True)
class DeliveryOutcome:
    original: Artifact
    artifact: Artifact
    candidate: CandidateRevision | None
    evidence: Evidence | None
    tool_failed: bool
    delivery_gap: str
    waiting: bool = False


class RouteWorkflow:
    def __init__(
        self,
        *,
        store,
        budget,
        clock,
        experiment,
        progress,
        skills,
        review,
        verifier,
        call: WorkUnitCall,
        register_candidate: CandidateRegistrar,
        process_tool: ArtifactProcessor,
        process_challenge: ArtifactProcessor,
        pre_branch_review: BranchReview,
        checkpoint: Checkpoint,
        tighten_budget,
        suggest_budget,
        goal_scheduler=None,
    ):
        self.store, self.budget, self.clock = store, budget, clock
        self.experiment, self.progress, self.skills = experiment, progress, skills
        self.review, self.verifier, self.call = review, verifier, call
        self.register_candidate, self.process_tool = register_candidate, process_tool
        self.process_challenge, self.pre_branch_review = (
            process_challenge,
            pre_branch_review,
        )
        self.checkpoint, self.tighten_budget = checkpoint, tighten_budget
        self.suggest_budget = suggest_budget
        self.goal_scheduler = goal_scheduler
        self.tool_workflow = getattr(process_tool, "__self__", None)

    def run(self, route, plan, initial_findings, width, *, one_step=False):
        if self.clock() >= self.budget.solving_end:
            return
        if self.store.control.get("routes_finished", {}).get(route.id):
            return
        self.store.event("route_started", route=asdict(route), active_routes=width)
        self._seed_route(route, initial_findings)
        while self.clock() < self.budget.solving_end:
            if self._advance_tools(route):
                if one_step:
                    return
                continue
            if self.experiment.enabled("dynamic_budget"):
                self.tighten_budget(self.suggest_budget())
            delivery = self._next_delivery(route, plan)
            if delivery is RETRY_DELIVERY:
                if one_step:
                    return
                continue
            if delivery is None:
                break
            node, unit, artifact = delivery
            outcome = self._process_delivery(unit, artifact, defer_followup=one_step)
            if outcome.waiting:
                self.checkpoint()
                if one_step:
                    return
                continue
            own_candidate, pause = self._record_progress(route, unit, outcome)
            explicit_next, _ = proposed_followups(outcome.original.text)
            pending_gaps = candidate_gaps(self.store, outcome.artifact, actionable=True)
            if pause or (
                own_candidate
                and outcome.candidate is not None
                and not explicit_next
                and not pending_gaps
                and not self.store.tasks.ready(self.store, route.id)
            ):
                break
            # A leaf is not the route end while its sibling or JOIN is ready.
            if not self._expand(
                route, node, unit, outcome, pause
            ) and not self.store.tasks.ready(self.store, route.id):
                break
            if one_step:
                self.store.event(
                    "route_yielded", route=route.id, reason="safe dispatch boundary"
                )
                self.checkpoint()
                return
        if self.waiting(route):
            return
        with self.store.lock:
            self.store.control.setdefault("routes_finished", {})[route.id] = True
        self.store.event("route_stopped", route=route.id)
        self.checkpoint()

    def waiting(self, route):
        return any(
            n.state in {"WAITING_TOOL", "WAITING_ADOPTION"}
            for n in self.store.tasks.route_nodes(route.id)
        )

    def _risk_goal(self, unit):
        key = self.store.control.get("tool_consumers", {}).get(unit.id)
        return (
            self.store.control["tool_jobs"][key]["unit"]["goal"] if key else unit.goal
        )

    def _advance_tools(self, route):
        if not self.tool_workflow or not hasattr(self.tool_workflow, "jobs"):
            return False
        for parent in self.store.tasks.route_nodes(route.id):
            if parent.state != "WAITING_ADOPTION":
                continue
            key = self.store.control["task_tool_jobs"][parent.unit.id]
            row = self.tool_workflow.jobs.rows[key]
            consumer = self.store.tasks.nodes.get(row.get("consumer_task_id"))
            if (
                self.clock() >= row["effective_deadline"]
                or consumer is None
                or consumer.state in {"FAILED", "PAUSED", "WAITING_CHALLENGE"}
                or (
                    consumer.state == "READY"
                    and not any(
                        u.id == consumer.unit.id
                        for u in self.store.tasks.ready(self.store, route.id)
                    )
                )
            ):
                self.store.tasks.update(parent.unit.id, state="FAILED")
                self.tool_workflow.jobs.transition(
                    row,
                    "DEADLINE"
                    if self.clock() >= row["effective_deadline"]
                    else "REJECTED",
                    remaining_gap="consumer expired, unavailable or transport-unknown; no replay",
                )
                return True
        # Ready mathematical work gets a fair boundary even during a local computation.
        waiting = [
            n
            for n in self.store.tasks.route_nodes(route.id)
            if n.state == "WAITING_TOOL"
        ]
        if not waiting:
            return False
        node = waiting[0]
        key = self.store.control["task_tool_jobs"][node.unit.id]
        row = self.tool_workflow.jobs.rows[key]
        artifact = self.store.artifacts[row["proposal_artifact_id"]]
        bound_unit = self.tool_workflow.jobs.bound_unit(row)
        outcome = self.tool_workflow.jobs.advance(row, artifact, bound_unit)
        if outcome.disposition == "EXECUTED":
            observed = self.store.control.get("computation_results", {}).get(
                outcome.observation_id, {}
            )
            if not observed.get("usable_output"):
                row["remaining_gap"] = (
                    "execution produced only an observation, no bounded expected object; parent task remains undelivered"
                )
                self.store.tasks.update(node.unit.id, state="FAILED")
                self.checkpoint()
                return True
            consumer = node.unit.id + "-adopt-" + key[:10]
            if row["parent_task_id"] != node.unit.id:
                self.store.tasks.update(node.unit.id, state="FAILED")
                return True
            try:
                unit = replace(
                    bound_unit,
                    id=consumer,
                    goal=node.unit.goal,
                    kind="REPAIR" if node.unit.kind == "REPAIR" else "DERIVE",
                    dependencies=tuple(
                        dict.fromkeys(
                            (*bound_unit.dependencies, outcome.observation_id)
                        )
                    ),
                    bottleneck=node.unit.bottleneck or node.unit.goal,
                )
                with self.store.lock:
                    self.store.tasks.add(
                        unit
                    )  # Ownership is not a parent/child DAG cycle.
                    row["consumer_task_id"] = consumer
                    self.store.control.setdefault("tool_consumers", {})[consumer] = key
                    goal_key = self.store.control.get("goal_tasks", {}).get(
                        node.unit.id
                    )
                    if goal_key:
                        self.store.control["goal_tasks"][consumer] = goal_key
                    self.store.tasks.update(node.unit.id, state="WAITING_ADOPTION")
                    self.checkpoint()
            except ValueError:
                self.tool_workflow.jobs.transition(
                    row,
                    "REJECTED",
                    remaining_gap="consumer exceeds original task/context resource bound",
                )
                self.store.tasks.update(node.unit.id, state="FAILED")
        elif outcome.disposition != "PENDING":
            self.store.tasks.update(node.unit.id, state="FAILED", output=artifact.id)
            goal_key = self.store.control.get("goal_tasks", {}).get(node.unit.id)
            if goal_key:
                self.goal_scheduler._state()["jobs"][goal_key].update(
                    state="PARTIAL", remaining_gap=outcome.remaining_gap
                )
            elif (
                outcome.disposition in {"REJECTED", "FAILED"}
                and self.clock() < self.budget.solving_end
            ):
                from ..tools import parse_tool_proposal

                feedback = failure_feedback(self.store, artifact.id)
                if not feedback:
                    self.tool_workflow.reject_input(
                        artifact,
                        bound_unit,
                        parse_tool_proposal(artifact.text),
                        outcome.disposition,
                        outcome.remaining_gap
                        or "bounded tool step failed; repair the specific input, mapping or output error",
                    )
                    feedback = failure_feedback(self.store, artifact.id)
                failed = DeliveryOutcome(
                    artifact,
                    artifact,
                    None,
                    None,
                    True,
                    f"{feedback['tool']}: {feedback['message']}; supported scope: {feedback['supported_scope']}",
                )
                _, pause = self._record_progress(route, bound_unit, failed)
                self._expand(route, node, bound_unit, failed, pause)
        self.checkpoint()
        if outcome.disposition == "PENDING" and self.store.tasks.ready(
            self.store, route.id
        ):
            return False
        if outcome.disposition == "PENDING":
            self.tool_workflow.jobs.wait_for_local()
        return True

    def _seed_route(self, route, initial_findings):
        graph = self.store.tasks
        if not graph.route_nodes(route.id):
            with self.store.lock:
                parents = ()
                for index, finding in enumerate(initial_findings):
                    check_id = route.id + f"-prerequisite-{index}"
                    graph.add(
                        WorkUnit(
                            check_id,
                            route.id,
                            finding.next_check,
                            computational_kind(finding.next_check, "CHECK"),
                            (),
                            ("bounded_check",),
                            scope_for_goal(finding.next_check),
                            "initial issue: " + finding.issue,
                            1,
                        ),
                        parents,
                    )
                    self.store.control.setdefault("initial_checks", {})[check_id] = (
                        finding.id
                    )
                    parents = (check_id,)
                operation = (
                    self.store.control.get("planning", {})
                    .get("plan", {})
                    .get("operations", {})
                    .get(route.id, {})
                )
                mixed = operation.get("mode") == "MIXED"
                initial_goal = (
                    (
                        "Establish the finite mathematical model and original-source mapping for: "
                        + route.first_goal
                    )
                    if mixed
                    else route.first_goal
                )
                initial_kind = (
                    "DERIVE"
                    if mixed
                    else "COMPUTE"
                    if operation.get("mode") == "COMPUTE"
                    else computational_kind(route.first_goal)
                )
                graph.add(
                    WorkUnit(
                        route.id + "-0",
                        route.id,
                        initial_goal,
                        initial_kind,
                        (),
                        ("bounded_artifact",),
                        scope_for_goal(route.first_goal),
                        route.first_goal,
                    ),
                    parents,
                )
                if operation:
                    self.store.control.setdefault("task_operations", {})[
                        route.id + "-0"
                    ] = operation
                if mixed:
                    computation = route.id + "-compute"
                    graph.add(
                        WorkUnit(
                            computation,
                            route.id,
                            route.first_goal,
                            "COMPUTE",
                            (),
                            ("bounded_computation_result",),
                            scope_for_goal(route.first_goal),
                            route.first_goal,
                        ),
                        (route.id + "-0",),
                    )
                    self.store.control["task_operations"][computation] = operation
                if self.store.control.get("route_review_decision", {}).get(
                    "unknown_roles"
                ):
                    graph.update(route.id + "-0", conditional=True)
                self.checkpoint()

    def _next_delivery(self, route, plan):
        graph = self.store.tasks
        with self.store.lock:
            delivered = [
                n
                for n in graph.nodes.values()
                if n.unit.route == route.id and n.state == "DELIVERED"
            ]
            ready = graph.ready(self.store, route.id)
        if delivered:
            node = delivered[0]
            artifact = self.store.artifacts[node.output]
            unit = replace(
                node.unit, dependencies=artifact.dependencies, scope=artifact.scope
            )
        elif ready:
            # Every fourth boundary offers the oldest independent ready task;
            # short high-priority checks cannot indefinitely starve a long proof.
            rounds = self.store.control.setdefault("route_dispatch_rounds", {})
            turn = rounds.get(route.id, 0)
            order = {task: i for i, task in enumerate(graph.nodes)}
            unit = (
                min(ready, key=lambda u: order[u.id])
                if turn % 4 == 3 and ready[0].kind != "CONTRACT_CLARIFY"
                else ready[0]
            )
            rounds[route.id] = turn + 1
            node = graph.nodes[unit.id]
            try:
                pending_branch = self.store.control.get("pending_branch_units", {}).get(
                    unit.id
                )
                if pending_branch:
                    data = dict(pending_branch)
                    data["scope"] = Scope(
                        tuple(data["scope"]["conditions"]),
                        data["scope"]["domain"],
                        tuple(data["scope"]["quantifiers"]),
                    )
                    data["dependencies"] = tuple(data["dependencies"])
                    data["obligations"] = tuple(data["obligations"])
                    unit = WorkUnit(**data)
                elif (
                    unit.kind != "CONTRACT_CLARIFY"
                    and not (
                        self.goal_scheduler
                        and self.goal_scheduler.is_minimal_repair(unit)
                    )
                    and any(
                        k in self._risk_goal(unit).lower()
                        for k in WORKFLOW_DEFAULTS.pre_branch_risk_terms
                    )
                ):
                    unit = self.pre_branch_review(unit)
                    if unit.priority >= WORKFLOW_DEFAULTS.conditional_priority:
                        self.store.control.setdefault("pending_branch_units", {})[
                            unit.id
                        ] = asdict(unit)
                        graph.update(unit.id, conditional=True)
                        self.store.event(
                            "route_yielded",
                            route=route.id,
                            reason="prebranch UNKNOWN; offer normal alternatives before conditional exploration",
                        )
                        self.checkpoint()
                        return RETRY_DELIVERY
                graph.update(unit.id, state="RUNNING")
                self.checkpoint()
                search = getattr(self.skills, "search", None)
                context = (
                    self.store.problem.raw,
                    getattr(plan, "card", ""),
                    route.method,
                )
                if unit.kind == "CONTRACT_CLARIFY":
                    selected, skill = (), ""
                elif isinstance(self.skills, SkillCatalog):
                    selected = self.skills.search(
                        unit.goal, plan.fields, context=context
                    )
                    skill = self.skills.load_for(
                        unit.goal, plan.fields, context=context
                    )
                else:
                    selected = (
                        search(unit.goal, plan.fields) if callable(search) else ()
                    )
                    skill = self.skills.load_for(unit.goal, plan.fields)
                self.store.event(
                    "skill_candidates",
                    task=unit.id,
                    families=selected,
                    general_path=callable(search) and not selected,
                    discovery_available=callable(search),
                )
                self.store.event(
                    "skill_loaded",
                    task=unit.id,
                    family=selected[0] if selected else None,
                    enabled=self.experiment.enabled("skills"),
                    content_hash=fingerprint(skill),
                )
                artifact, generated = self.call(
                    unit,
                    deadline=self.goal_scheduler.delivery_deadline(unit)
                    if self.goal_scheduler
                    else self.budget.solving_end,
                    once=f"task:{unit.id}:{node.attempt}",
                    skill=skill,
                    review_input=""
                    if unit.kind == "CONTRACT_CLARIFY"
                    else prompt_text.ROUTE_METHOD_PREFIX
                    + route.method
                    + prompt_text.ROUTE_TASK_SEPARATOR
                    + route.first_goal
                    + self._draft_context(unit),
                    parent=node.prior_output,
                )
                if generated.error and not generated.transport.get(
                    "remote_ended", False
                ):
                    graph.update(unit.id, state="WAITING_CHALLENGE", output=artifact.id)
                    self.store.event(
                        "route_request_unknown",
                        task=unit.id,
                        request=generated.request_id,
                        next_action="other_independent_route_or_closeout",
                        no_duplicate_dispatch=True,
                    )
                    self.checkpoint()
                    return None
            except AdmissionError as exc:
                graph.update(unit.id, state="FAILED")
                self.store.event(
                    "work_not_admitted", reason=type(exc).__name__, task=unit.id
                )
                self.checkpoint()
                return RETRY_DELIVERY
        else:
            return None
        return node, unit, artifact

    def _draft_context(self, unit):
        aid = self.store.control.get("candidate_drafts", {}).get(unit.id)
        if aid not in self.store.artifacts:
            return ""
        return (
            "\nUNVALIDATED DRAFT (not a completed task or verified premise, and may answer only a subproblem):\n"
            + self.store.artifacts[aid].text
            + "\nIndependently organize an original-problem candidate from the source conditions. "
            "Do not copy a subproblem result as the original answer; preserve missing proofs in GAPS."
        )

    def _process_delivery(self, unit, artifact, *, defer_followup=False):
        graph = self.store.tasks
        self.tool_workflow = getattr(self.process_tool, "__self__", self.tool_workflow)
        existing = graph.nodes.get(unit.id)
        if existing and existing.state == "COMPLETE" and existing.output == artifact.id:
            return DeliveryOutcome(artifact, artifact, None, None, False, "")
        delivery_type = classify(unit, artifact.text, closed=artifact.closed)
        if (
            defer_followup
            and delivery_type == DeliveryType.MATHEMATICAL_ARTIFACT
            and self.goal_scheduler
            and self.goal_scheduler.is_minimal_repair(unit)
        ):
            pending = self.store.control.setdefault("pending_repair_reviews", {})
            if artifact.id not in pending:
                pending[artifact.id] = {
                    "schema": "repair-review-boundary-v1",
                    "deadline": self.goal_scheduler.delivery_deadline(unit),
                }
                graph.update(unit.id, state="DELIVERED", output=artifact.id)
                self.checkpoint()
                return DeliveryOutcome(
                    artifact,
                    artifact,
                    None,
                    None,
                    False,
                    "local result awaits bounded R4 at next dispatch boundary",
                    True,
                )
        if (
            delivery_type == DeliveryType.TOOL_PROPOSAL
            and self.tool_workflow
            and hasattr(self.tool_workflow, "process_outcome")
        ):
            problem = self.tool_workflow.preflight(artifact, unit)
            if problem:
                graph.update(unit.id, state="FAILED", output=artifact.id)
                feedback = failure_feedback(self.store, artifact.id)
                return DeliveryOutcome(
                    artifact,
                    artifact,
                    None,
                    None,
                    True,
                    f"{feedback['tool']}: {feedback['message']}; supported scope: {feedback['supported_scope']}"
                    if feedback
                    else problem,
                )
            deadline = (
                self.goal_scheduler.delivery_deadline(unit)
                if self.goal_scheduler
                else self.budget.solving_end
            )
            consumer_key = self.store.control.get("tool_consumers", {}).get(unit.id)
            if consumer_key:
                # Do not turn an adoption failure into an unlimited new proposal chain.
                graph.update(unit.id, state="FAILED", output=artifact.id)
                row = self.tool_workflow.jobs.rows[consumer_key]
                graph.update(row["parent_task_id"], state="FAILED")
                self.tool_workflow.jobs.transition(
                    row,
                    "REJECTED",
                    remaining_gap="adoption returned another proposal; requires a distinct bounded repair under original retry limits",
                )
                return DeliveryOutcome(
                    artifact, artifact, None, None, True, row["remaining_gap"]
                )
            result = self.tool_workflow.process_outcome(
                artifact, unit, deadline=deadline, step=True
            )
            row = next(
                r
                for r in self.tool_workflow.jobs.rows.values()
                if r["proposal_hash"] == result.proposal_hash
                and r["parent_task_id"] == result.parent_task_id
            )
            if row["parent_task_id"] != unit.id or row["state"] in {
                "ADOPTED",
                "REJECTED",
                "FAILED",
                "DEADLINE",
                "INTERRUPTED_WITHOUT_RECEIPT",
            }:
                if existing.state != "COMPLETE":
                    graph.update(unit.id, state="FAILED", output=artifact.id)
                return DeliveryOutcome(
                    artifact,
                    artifact,
                    None,
                    None,
                    True,
                    "proposal already spent; no replay",
                )
            with self.store.lock:
                self.store.control.setdefault("task_tool_jobs", {})[unit.id] = row["id"]
                scheduled = self.store.control.setdefault(
                    "route_computation_scheduled", []
                )
                if unit.route not in scheduled:
                    scheduled.append(unit.route)
                graph.update(unit.id, state="WAITING_TOOL", output=artifact.id)
                self.checkpoint()
            return DeliveryOutcome(
                artifact,
                artifact,
                None,
                None,
                False,
                "await actual execution and mathematical adoption",
                True,
            )
        if delivery_type in {
            DeliveryType.COMPUTATION_NEEDED,
            DeliveryType.PARTIAL_OR_BLOCKED,
        }:
            graph.update(unit.id, state="FAILED", output=artifact.id)
            if unit.id in self.store.control.get("initial_checks", {}):
                holder = self._initial_prerequisite(
                    unit, artifact, artifact, False, None
                )
                return DeliveryOutcome(
                    artifact,
                    holder,
                    None,
                    None,
                    False,
                    "prerequisite not established; conditional route preserved",
                )
            if delivery_type == DeliveryType.COMPUTATION_NEEDED and unit.kind in {
                "DERIVE",
                "CHECK",
                "REPAIR",
                "CANDIDATE",
                "ASSEMBLE",
                "FALLBACK",
            }:
                from ..computation_policy import intent

                need = artifact.text.removeprefix("COMPUTATION_NEEDED:").strip()
                if need and len(need) <= 2000 and intent(need).mode != "REASON":
                    child = replace(
                        unit,
                        id=unit.id + "-compute-needed",
                        kind="COMPUTE",
                        goal="Form a bounded executable proposal for: "
                        + need
                        + ". Establish the mapping to the original conditions first; otherwise state the concrete gap.",
                        obligations=("bounded_computation_result",),
                        bottleneck=unit.bottleneck or unit.goal,
                    )
                    try:
                        graph.add(child)
                        self.store.control.setdefault("computation_requests", {})[
                            child.id
                        ] = {
                            "schema": "computation-request-v1",
                            "parent": unit.id,
                            "artifact": artifact.id,
                        }
                        self.checkpoint()
                    except ValueError:
                        pass  # Resource exhaustion is not authority to reset the task budget.
            return DeliveryOutcome(
                artifact,
                artifact,
                None,
                None,
                False,
                "bounded computation/mapping or complete mathematical artifact still required",
            )
        consumer_key = self.store.control.get("tool_consumers", {}).get(unit.id)
        if consumer_key:
            row = self.tool_workflow.jobs.rows[consumer_key]
            if self.clock() >= row[
                "effective_deadline"
            ] or not self.tool_workflow.jobs.valid_binding(row):
                graph.update(unit.id, state="FAILED", output=artifact.id)
                graph.update(row["parent_task_id"], state="FAILED")
                return DeliveryOutcome(
                    artifact,
                    artifact,
                    None,
                    None,
                    False,
                    "expired or stale execution consumer",
                )
            graph.update(row["parent_task_id"], state="COMPLETE", output=artifact.id)
            self.tool_workflow.jobs.transition(
                row, "ADOPTED", adoption_artifact_id=artifact.id
            )
            count_fact(
                self.store,
                "result_consumed",
                row["id"],
                task=unit.id,
                dependency=row["observation_id"],
                artifact=artifact.id,
                meaning="explicit artifact dependency, not proof of model adherence",
            )
            count_fact(
                self.store,
                "math_task_delivered",
                row["parent_task_id"],
                task=row["parent_task_id"],
                artifact=artifact.id,
                work_unit_kind="parent_mathematical_task",
            )
        count_fact(
            self.store,
            "math_task_delivered",
            artifact.id,
            task=unit.id,
            work_unit_kind=unit.kind,
        )
        if self.goal_scheduler and self.goal_scheduler.is_minimal_repair(unit):
            # A scheduler-owned local correction is not another whole-answer
            # attempt. Its bound R4 and member checks share one time window.
            graph.update(
                unit.id,
                state="COMPLETE" if artifact.closed else "FAILED",
                output=artifact.id,
            )
            self.goal_scheduler.completed(unit, artifact)
            return DeliveryOutcome(artifact, artifact, None, None, False, "")
        if unit.kind == "CONTRACT_CLARIFY":
            # Parse engineering repairs before reviewing them as interpretations;
            # they are not mathematical lemmas or tool proposals.
            graph.update(
                unit.id,
                state="COMPLETE" if artifact.closed else "FAILED",
                output=artifact.id,
            )
            if self.goal_scheduler:
                self.goal_scheduler.completed(unit, artifact)
            return DeliveryOutcome(artifact, artifact, None, None, False, "")
        candidate = (
            self.register_candidate(artifact) if unit.kind == "CANDIDATE" else None
        )
        with self.store.lock:
            has_candidate = any(
                c.artifact == artifact.id for c in self.store.candidates.values()
            )
        original = artifact
        delivery_gap = next(
            (
                e["details"].get("task_gap") or e["details"].get("gap", "")
                for e in reversed(self.store.events)
                if e["kind"] == "delivery"
                and e["details"].get("request") == original.request
            ),
            "",
        )
        evidence = None
        tool_failed = False
        if artifact.closed:
            artifact = self.process_tool(artifact, unit)
            tool_failed = any(
                f.target == original.id
                and f.reason.startswith(("tool_", "generated_python_"))
                for f in self.store.failures
            )
            if tool_failed:
                graph.update(unit.id, state="FAILED", output=artifact.id)
                issues = [
                    c.next_check
                    for c in self.store.challenges.values()
                    if c.target == original.id
                ]
                feedback = failure_feedback(self.store, original.id)
                return DeliveryOutcome(
                    original,
                    artifact,
                    candidate,
                    None,
                    True,
                    f"{feedback['tool']}: {feedback['message']}; supported scope: {feedback['supported_scope']}"
                    if feedback
                    else issues[0]
                    if issues
                    else "Repair the concrete tool input/mapping or supply a sound bounded alternative.",
                )
            if not has_candidate:
                evidence = self.verifier.check(
                    self.store,
                    artifact,
                    goal=unit.goal,
                    proposed=artifact.text,
                    candidate=False,
                    unit=unit,
                )
                if evidence is None and artifact.id in self.store.control.get(
                    "mapped_tool_goals", {}
                ):
                    mapped_id = self.store.control["mapped_tool_goals"][artifact.id][
                        "evidence"
                    ]
                    evidence = self.store.evidence[mapped_id]
                if evidence and evidence.outcome == "REFUTES":
                    self.store.challenge(
                        Challenge(
                            "exact-target-" + artifact.id,
                            artifact.id,
                            "bound work unit assertion refuted",
                            "independent exact local check",
                            unit.goal,
                        )
                    )
                    artifact = self.process_challenge(artifact, unit)
            risk_review = has_candidate or any(
                k in self._risk_goal(unit).lower()
                for k in WORKFLOW_DEFAULTS.post_delivery_risk_terms
            )
            if risk_review:
                self.review.review(
                    "task_tool", "R2", artifact, deadline=self.budget.solving_end
                )
            if risk_review or any(
                c.target == artifact.id for c in self.store.challenges.values()
            ):
                artifact = self.process_challenge(artifact, unit)
            graph.update(
                unit.id,
                state="FAILED" if tool_failed else "COMPLETE",
                output=artifact.id,
            )
        else:
            graph.update(unit.id, state="FAILED")
        artifact = self._initial_prerequisite(
            unit, original, artifact, tool_failed, evidence
        )
        if self.goal_scheduler:
            self.goal_scheduler.completed(unit, artifact)
        return DeliveryOutcome(
            original, artifact, candidate, evidence, tool_failed, delivery_gap
        )

    def _initial_prerequisite(self, unit, original, artifact, tool_failed, evidence):
        graph = self.store.tasks
        initial_issue = self.store.control.get("initial_checks", {}).get(unit.id)
        if initial_issue:
            if not artifact.closed or tool_failed or artifact.id in self.store.refuted:
                ancestry = set(unit.dependencies)
                for dep in unit.dependencies:
                    ancestry.update(self.store.artifacts[dep].unverified_dependencies)
                holder = Artifact(
                    "unverified-check-" + original.id,
                    self.store.problem.digest,
                    unit.route,
                    unit.id + "-unknown",
                    prompt_text.UNVERIFIED_PREREQUISITE_PREFIX
                    + unit.goal
                    + prompt_text.UNVERIFIED_PREREQUISITE_SUFFIX,
                    "controller_unverified_premise",
                    unit.scope,
                    unit.dependencies,
                    tuple(sorted(ancestry)),
                    True,
                    original.id,
                )
                self.store.append(holder)
                artifact = holder
            self.store.update_challenge(
                initial_issue,
                "UNKNOWN",
                check_artifact=original.id,
                evidence_ids=(evidence.id,) if evidence else (),
                resolution="route prerequisite attempted; no automatic semantic discharge of planning challenge",
            )
            graph.update(
                unit.id, state="COMPLETE", output=artifact.id, conditional=True
            )
        return artifact

    def _record_progress(self, route, unit, outcome):
        if unit.kind == "CONTRACT_CLARIFY":
            return any(
                c.route == route.id for c in self.store.candidates.values()
            ), False
        graph = self.store.tasks
        original = outcome.original
        candidate, evidence, tool_failed = (
            outcome.candidate,
            outcome.evidence,
            outcome.tool_failed,
        )
        with self.store.lock:
            gain, pause = self.progress.record(
                unit,
                original.text if original.closed and not tool_failed else "",
                result_gain=candidate is not None
                or bool(
                    evidence and evidence.outcome == "SUPPORTS" and evidence.obligations
                ),
                result_key=(
                    "candidate:"
                    + fingerprint(
                        answer_identity(self.store.problem.raw, candidate.answer)
                    )
                )
                if candidate
                else fingerprint(
                    (
                        evidence.property,
                        evidence.input_hash,
                        asdict(evidence.scope),
                        evidence.obligations,
                    )
                )
                if evidence
                else None,
                context=(self.store.problem.raw,)
                + tuple(
                    self.store.public_text(self.store.artifacts[dep])
                    for dep in unit.dependencies
                ),
            )
            own_candidate = any(
                c.route == route.id and c.artifact not in self.store.refuted
                for c in self.store.candidates.values()
            )
            key = self.progress.identities[unit.id]
            degraded = self.store.control.setdefault("exploration_deprioritized", {})
            if gain == "EXPLORATION" and self.progress.exploration_budget_exhausted(
                unit
            ):
                degraded[key] = True
                self.store.event(
                    "exploration_budget",
                    bottleneck=key,
                    action="deprioritize_further_derivation",
                    reason="exploration_priority_allowance_exhausted",
                    observed_progress=gain,
                    no_progress_count=self.progress.stalled[key],
                    original_deadlines_unchanged=True,
                )
            elif gain == "UNASSESSED":
                degraded[key] = True
                self.store.event(
                    "progress_unassessed",
                    bottleneck=key,
                    action="deprioritize_further_derivation",
                    reason="related_mathematical_statement_outside_recognition_scope",
                    exploration_reward=False,
                    no_progress_pause=False,
                )
            elif gain == "RESULT":
                degraded.pop(key, None)
        self.store.event("progress", bottleneck=key, gain=gain, paused=pause)
        if self.goal_scheduler:
            self.goal_scheduler.note_route_progress(unit, gain)
        if pause:
            for pending in graph.route_nodes(route.id):
                task_id = pending.unit.id
                if (
                    pending.unit.bottleneck_key == unit.bottleneck_key
                    and pending.state == "READY"
                ):
                    graph.update(task_id, state="PAUSED")
        return own_candidate, pause

    def _expand(self, route, node, unit, outcome, pause):
        from ..verification import arithmetic_goal, root_equation

        graph = self.store.tasks
        if unit.id in self.store.control.get("goal_tasks", {}):
            goals, join_goal = proposed_followups(outcome.original.text)
            return bool(
                self.goal_scheduler
                and not pause
                and not outcome.tool_failed
                and self.goal_scheduler.expand_followups(
                    unit, outcome.artifact, goals, join_goal
                )
            )
        original, artifact = outcome.original, outcome.artifact
        tool_failed, delivery_gap = outcome.tool_failed, outcome.delivery_gap
        with self.store.lock:
            expanded = self.store.control.setdefault("expanded_tasks", [])
            if unit.id not in expanded:
                route_nodes = graph.route_nodes(route.id)
                if len(route_nodes) >= WORKFLOW_DEFAULTS.expansion_stop_nodes:
                    self.store.event(
                        "task_graph_bound",
                        route=route.id,
                        max_nodes=WORKFLOW_DEFAULTS.reported_route_node_limit,
                    )
                    return False
                if not graph.descendants(unit.id):
                    assessment = self.store.control.get("delivery_assessments", {}).get(
                        original.id, {}
                    )
                    bridges = self.store.control.setdefault("draft_bridge_routes", [])
                    if (
                        assessment.get("protocol_closed")
                        and assessment.get("status") == "MISMATCH"
                        and unit.kind != "COMPUTE"
                        and (
                            bare_math(original.text)
                            or candidate_payload(original.text) is not None
                        )
                        and route.id not in bridges
                        and not pause
                    ):
                        # Preserve a potentially useful draft only as REVIEW_INPUT,
                        # never as a completed parent. One bridge per route.
                        next_id = unit.id + ".organize-draft"
                        graph.add(
                            replace(
                                unit,
                                id=next_id,
                                kind="CANDIDATE",
                                goal=prompt_text.NEXT_CANDIDATE_GOAL,
                                dependencies=(),
                                obligations=("original_goal_coverage",),
                            ),
                            node.parents,
                        )
                        self.store.control.setdefault("candidate_drafts", {})[
                            next_id
                        ] = original.id
                        bridges.append(route.id)
                        self.store.event(
                            "candidate_draft_bridge",
                            task=next_id,
                            draft=original.id,
                            draft_is_premise=False,
                            candidate_not_yet_created=True,
                        )
                        expanded.append(unit.id)
                        self.checkpoint()
                        return True
                    goals, join_goal = (
                        proposed_followups(original.text)
                        if artifact.closed and not tool_failed
                        else ((), None)
                    )
                    gaps = candidate_gaps(self.store, artifact, actionable=True)
                    if not goals and gaps and artifact.closed and not tool_failed:
                        goals = (
                            "Resolve this original-goal gap using the original conditions: "
                            + gaps[0],
                        )
                        self.store.event(
                            "candidate_gap_continuation",
                            route=route.id,
                            target=artifact.id,
                            gap=gaps[0],
                            no_truth_promotion=True,
                        )
                    if goals:
                        self.store.event(
                            "followup_parsed",
                            target=artifact.id,
                            goals=goals,
                            join=join_goal,
                            normalization="bounded labels; mathematical content preserved",
                        )
                    if goals:
                        siblings = []
                        for index, goal in enumerate(goals):
                            next_id = f"{unit.id}.next{index + 1}"
                            siblings.append(next_id)
                            graph.add(
                                replace(
                                    unit,
                                    id=next_id,
                                    goal=goal,
                                    kind=computational_kind(goal),
                                    dependencies=(),
                                    obligations=("bounded_artifact",),
                                    scope=scope_for_goal(
                                        goal, Scope(conditions=unit.scope.conditions)
                                    ),
                                    bottleneck=("task:" + next_id)
                                    if len(goals) > 1
                                    else unit.bottleneck,
                                ),
                                (unit.id,),
                            )
                        if len(siblings) > 1 or join_goal:
                            graph.add(
                                replace(
                                    unit,
                                    id=unit.id + ".join",
                                    goal=join_goal or prompt_text.JOIN_CANDIDATE_GOAL,
                                    kind="DERIVE" if join_goal else "CANDIDATE",
                                    dependencies=(),
                                    obligations=("bounded_artifact",)
                                    if join_goal
                                    else ("original_goal_coverage",),
                                    scope=scope_for_goal(
                                        join_goal or self.store.problem.raw,
                                        Scope(conditions=unit.scope.conditions),
                                    ),
                                    bottleneck="task:" + unit.id + ".join",
                                ),
                                tuple(siblings),
                            )
                    elif (
                        artifact.closed
                        and not tool_failed
                        and not pause
                        and unit.kind == "DERIVE"
                        and computational_method(route.method)
                        and root_equation(self.store.problem.raw) is None
                        and arithmetic_goal(self.store.problem.raw) is None
                        and artifact.request
                        not in {"local_registered_tool", "local_generated_python"}
                        and route.id
                        not in self.store.control.get("route_computation_scheduled", [])
                    ):
                        self.store.control.setdefault(
                            "route_computation_scheduled", []
                        ).append(route.id)
                        graph.add(
                            replace(
                                unit,
                                id=unit.id + ".compute",
                                kind="COMPUTE",
                                goal="Execute one bounded computation required by the proposed route: "
                                + route.method
                                + ". Bind it to the original conditions and the complete available model. If no sound finite mapping is available, state the missing mapping instead of guessing a result.",
                                dependencies=(),
                                obligations=("bounded_computation",),
                            ),
                            (unit.id,),
                        )
                        self.store.event(
                            "computation_scheduled",
                            route=route.id,
                            task=unit.id + ".compute",
                        )
                    elif artifact.closed and not tool_failed and not pause:
                        graph.add(
                            replace(
                                unit,
                                id=unit.id + ".candidate",
                                goal=prompt_text.NEXT_CANDIDATE_GOAL,
                                kind="CANDIDATE",
                                dependencies=(),
                                obligations=("original_goal_coverage",),
                                scope=scope_for_goal(
                                    self.store.problem.raw,
                                    Scope(conditions=unit.scope.conditions),
                                ),
                            ),
                            (unit.id,),
                        )
                    elif not pause:
                        feedback = (
                            failure_feedback(self.store, original.id)
                            if tool_failed
                            else None
                        )
                        next_id = unit.id + ".smaller"
                        graph.add(
                            replace(
                                node.unit,
                                id=next_id,
                                goal=(
                                    "Correct the rejected tool proposal for the SAME original task: "
                                    + feedback["original_task"]
                                )
                                if feedback
                                else (
                                    prompt_text.SMALLER_TASK_PREFIX
                                    + delivery_gap
                                    + prompt_text.SMALLER_TASK_SUFFIX
                                )
                                if delivery_gap and delivery_gap != "NONE"
                                else prompt_text.SMALLER_WORK_GOAL,
                                kind="COMPUTE" if unit.kind == "COMPUTE" else "DERIVE",
                            ),
                            node.parents,
                        )
                        if feedback:
                            self.store.control.setdefault("task_tool_feedback", {})[
                                next_id
                            ] = original.id
                            self.store.event(
                                "tool_retry_scheduled",
                                task=next_id,
                                rejected_artifact=original.id,
                                original_parameters_preserved=True,
                                failed_result_not_a_parent=True,
                            )
                expanded.append(unit.id)
            self.checkpoint()
        return True
