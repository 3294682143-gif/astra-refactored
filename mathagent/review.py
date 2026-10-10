from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from .content_fields import fields
from .domain import Artifact, Challenge
from .experiments import ExperimentConfig
from .observability import admission_wait_estimate, note_admission_wait
from .policy import WORKFLOW_DEFAULTS
from .prompts.review import ROLES, review_goal
from .runtime.config import fingerprint
from .runtime.coordinator import AdmissionError
from .runtime.protocol import parse_response

__all__ = [
    "ROLES",
    "ReviewReport",
    "ReviewService",
    "material_conflict",
    "parse_report",
]


@dataclass(frozen=True)
class ReviewReport:
    role: str
    position: str
    target: str
    raw: str
    complete: bool
    finding: Challenge | None
    interpretation: str
    findings: tuple[Challenge, ...] = ()
    route_order: tuple[str, ...] = ()
    suggested_width: int | None = None
    stances: tuple[tuple[str, str, str], ...] = ()
    uncovered: tuple[str, ...] = ()
    width_basis: str = ""


def parse_report(*, role, position, artifact, parsed):
    from .solution_branches import BRANCH_LABELS

    text = parsed.result
    entries = fields(
        text,
        [
            "COVERAGE",
            "FINDING",
            "BASIS",
            "CHECK",
            "ORDER",
            "WIDTH",
            "UNCOVERED",
            "POSITION",
            "STANCE",
            "SCOPE",
            *BRANCH_LABELS,
        ],
    )
    findings, stances = [], []
    no_issues = set()
    interpretation = "UNKNOWN"
    coverage = any(k == "COVERAGE" and v for k, v in entries)
    for index, (label, value) in enumerate(entries):
        if label != "FINDING":
            continue
        if re.fullmatch(
            r"(?:no (?:concrete |specific )?issues?(?: (?:was |were |is |are )?(?:found|detected))?|no omissions, added assumptions, or changed goals detected|本次未发现具体问题)[.!。]?",
            value.strip(),
            re.IGNORECASE,
        ):
            no_issues.add(value)
            continue
        if re.match(
            r"^(?:no (?:concrete |specific )?issues?(?: (?:was |were |is |are )?(?:found|detected))?)[.!。]?\s*[;；]",
            value.strip(),
            re.IGNORECASE,
        ):
            # Real 0.7.1 R4 output mixed a no-issue declaration with unstructured
            # commentary. Preserve it as UNCOVERED/PARTIAL, neither invent a
            # Challenge nor discard a possible qualification as NO_SPECIFIC_ISSUE.
            continue
        tail = entries[index + 1 :]
        end = next((i for i, (k, _) in enumerate(tail) if k == "FINDING"), len(tail))
        data = {}
        for key, entry in tail[:end]:
            data.setdefault(key, entry)
        if not value or not data.get("BASIS") or not data.get("CHECK"):
            continue
        findings.append(
            Challenge(
                fingerprint((artifact.id, value, data["BASIS"])),
                artifact.id,
                value,
                data["BASIS"],
                data["CHECK"],
            )
        )
        explicit = re.fullmatch(r"(AFFIRMS|DENIES):\s*(.+)", value, re.IGNORECASE)
        natural = re.fullmatch(
            r"Route\s+([1-3])\s+is\s+(not\s+)?applicable(?:\s+under\s+(.+))?[.]?",
            value,
            re.IGNORECASE,
        )
        if explicit:
            stances.append(
                (
                    explicit[2].strip(),
                    data.get("SCOPE", "same supplied context"),
                    explicit[1].upper(),
                )
            )
        elif natural:
            stances.append(
                (
                    "route " + natural[1] + " applicability",
                    (natural[3] or data.get("SCOPE", "same supplied context")).lower(),
                    "DENIES" if natural[2] else "AFFIRMS",
                )
            )
    for index, (label, proposition) in enumerate(entries):
        if label == "POSITION":
            tail = entries[index + 1 :]
            end = next(
                (i for i, (k, _) in enumerate(tail) if k == "POSITION"), len(tail)
            )
            data = dict(tail[:end])
            if data.get("STANCE", "").upper() in {"AFFIRMS", "DENIES"} and data.get(
                "SCOPE"
            ):
                stances.append(
                    (
                        proposition.strip(),
                        data["SCOPE"].strip(),
                        data["STANCE"].upper(),
                    )
                )
    if coverage and findings:
        interpretation = "CHALLENGE"
    elif coverage and (
        no_issues
        or re.search(r"(?:^|[;；]\s*)NO_ISSUE(?:[.;；]|$)", text, re.IGNORECASE)
    ):
        interpretation = "NO_SPECIFIC_ISSUE"
    order = (
        next((v for k, v in entries if k == "ORDER"), "") if role == "method" else ""
    )
    route_order = tuple(
        "route-" + value
        for value in re.findall(r"(?:Route\s+)?([1-3])\b", order, re.IGNORECASE)
    )
    if len(set(route_order)) != len(route_order):
        route_order = ()
    width_text = (
        next((v for k, v in entries if k == "WIDTH"), "") if role == "method" else ""
    )
    width = re.fullmatch(r"([12])", width_text.strip())
    width_index = next(
        (i for i, (k, _) in enumerate(entries) if k == "WIDTH"), len(entries)
    )
    width_basis = (
        next((v for k, v in entries[width_index + 1 :] if k == "BASIS"), "")
        if role == "method"
        else ""
    )
    uncovered = tuple(v for k, v in entries if k == "UNCOVERED" and v.upper() != "NONE")
    uncovered += tuple(
        value
        for label, value in entries
        if label == "FINDING"
        and value not in {f.issue for f in findings}
        and value not in no_issues
    )
    if uncovered:
        interpretation = "PARTIAL_REVIEW"
    return ReviewReport(
        role,
        position,
        artifact.id,
        parsed.raw,
        parsed.closed,
        findings[0] if findings else None,
        interpretation,
        tuple(findings),
        route_order,
        int(width[1]) if width else None,
        tuple(stances),
        uncovered,
        width_basis,
    )


def material_conflict(reports):
    """Only explicit opposite positions on the same proposition, not absence of a finding."""
    affirm, deny = set(), set()
    for report in reports:
        if not report:
            continue
        for proposition, scope, stance in report.stances:
            (affirm if stance == "AFFIRMS" else deny).add((proposition, scope))
        if not report.finding or report.stances:
            continue
        match = re.match(r"^(AFFIRMS|DENIES):\s*(.+)$", report.finding.issue)
        if match:
            key = re.sub(r"\s+", " ", match[2].strip())
            (affirm if match[1] == "AFFIRMS" else deny).add(
                (key, "same supplied context")
            )
    return bool(affirm & deny)


class ReviewService:
    def __init__(self, adapter, item, store, experiment=None, *, clock=None):
        self.adapter, self.item, self.store = adapter, item, store
        self.experiment = experiment or ExperimentConfig()
        self.clock = clock or getattr(
            getattr(adapter, "coordinator", None), "clock", lambda: 0
        )

    def review(
        self,
        role: str,
        position: str,
        artifact: Artifact,
        *,
        deadline,
        context=None,
        attempts=None,
        closing=False,
        purpose=None,
        evidence_revision=(),
    ):
        from .goal_contracts import current, render_contract
        from .goal_ledger import ingest_material
        from .review_tasks import ReviewTask

        contract = current(self.store)
        if purpose is None and position == "R4" and contract:
            purpose = "REVISION"
        verified, provisional = self.store.context(
            artifact.route, artifact.scope, artifact.dependencies
        )
        review_input = (
            context.render(self.store.public_text(artifact))
            if context
            else self.store.public_text(artifact)
        ) + render_contract(self.store)
        if position == "R0":
            from .goal_contracts import render_proposal, restore_proposal

            saved = self.store.control.get("planning", {}).get("plan", {})
            review_input += render_proposal(
                restore_proposal(saved.get("contract")), self.store.problem.raw
            )
            if saved.get("operations"):
                import json

                review_input += (
                    "\nCONTROLLER_PARSED_OPERATION_SUGGESTIONS (not dispatch permission):\n"
                    + json.dumps(saved["operations"], ensure_ascii=False)
                )
        elif (
            self.store.control.get("artifact_units", {})
            .get(artifact.id, {})
            .get("kind")
            == "CONTRACT_CLARIFY"
        ):
            from .goal_contracts import contract_fields, parse_proposal, render_proposal

            review_input += render_proposal(
                parse_proposal(contract_fields(artifact.text)), self.store.problem.raw
            )
        goal = review_goal(role, purpose)
        if position == "R0":
            goal += (
                " Compare the CONTROLLER_PARSED_WORKING_CONTRACT in REVIEW_INPUT "
                "against SOURCE_PROBLEM. Inspect its actual TARGET_KIND, TARGETS, DOMAIN, "
                "QUANTIFIERS and FIELD_GAPS, not only the natural-language CARD. "
                "Name incorrect or missing fields explicitly; do not treat method uncertainty as a missing answer type."
            )
        if (
            contract
            and contract["kind"] == "ALL_SOLUTIONS"
            and purpose
            and self.store.control.get("artifact_units", {})
            .get(artifact.id, {})
            .get("kind")
            != "CONTRACT_CLARIFY"
        ):
            from .solution_branches import BRANCH_HINT

            goal += (
                " If the inspection identifies an explicit possible mathematical member, preserve it without promoting it. "
                + BRANCH_HINT
            )
        task = ReviewTask(
            self.store.problem.digest,
            contract["id"] if contract else None,
            artifact.id,
            artifact.digest,
            role,
            position,
            purpose,
            fingerprint((goal, review_input, verified, provisional)),
            tuple(evidence_revision),
        )
        modern = bool(contract or purpose)
        if self.store.control.get("goal_closure_closed"):
            return None
        if not self.experiment.enabled("risk_review") and position in {
            "R1",
            "R2",
        }:
            self.store.event(
                "review_ablation",
                position=position,
                role=role,
                target=artifact.id,
                interpretation="UNKNOWN",
                mathematical_checks_retained=True,
            )
            return None
        for event in reversed(self.store.events):
            value = event["details"]
            if (
                event["kind"] == "review"
                and value.get("role") == role
                and value.get("position") == position
                and value.get("target") == artifact.id
                and value.get("context_hash") == (context.digest if context else None)
                and value.get("purpose") == purpose
                and (not modern or value.get("review_task") == task.id)
                and value.get("complete")
                and value.get("interpretation") != "UNKNOWN"
            ):
                self.store.event(
                    'review_reused', original_request=value.get('request'),
                    review_task=task.id, problem=self.store.problem.digest,
                    role=role, position=position, target=artifact.id,
                    artifact_hash=artifact.digest, new_model_call=False,
                )
                return parse_report(
                    role=role,
                    position=position,
                    artifact=artifact,
                    parsed=parse_response(
                        value["raw"],
                        finish_reason=value.get("finish_reason")
                        if value.get("transport", {}).get("runtime_mode") == "platform"
                        else "stop",
                        complete_public_return=value.get("transport", {}).get(
                            "delivery_basis"
                        )
                        == "baseline_public_return",
                        prefill=value.get("transport", {}).get("runtime_mode")
                        != "platform",
                    ),
                )
        if context and position == "R4":
            goal += " Review whether the specified original doubt is resolved by the new derivation; identify any new gaps separately."
        final = position == "R5" or closing
        report = None
        pending_key = f"{position}:{role}:{artifact.id}"
        if modern:
            pending_key += ":" + task.id
        if pending_key in self.store.control.get("unknown_review_requests", {}):
            return None
        verified, provisional = self.store.context(
            artifact.route, artifact.scope, artifact.dependencies
        )
        for attempt in (
            range(WORKFLOW_DEFAULTS.missing_review_attempts)
            if attempts is None
            else attempts
        ):
            if modern:
                with self.store.lock:
                    tasks = self.store.control.setdefault("review_task_registry", {})
                    record = tasks.setdefault(
                        task.id, {**asdict(task), "attempts": [], "state": "OPEN"}
                    )
                    if (
                        attempt in record["attempts"]
                        or record["state"] == "REMOTE_UNKNOWN"
                    ):
                        continue
            coord = getattr(self.adapter, "coordinator", None)
            remaining = deadline - self.clock()
            estimate = getattr(
                coord, "estimated_call_seconds", lambda: 0
            )() + admission_wait_estimate(self.store)
            if remaining <= 0 or (position == "R0" and estimate > remaining):
                self.store.event(
                    "review_not_started",
                    role=role,
                    position=position,
                    reason="phase_time_insufficient",
                    remaining=max(0, remaining),
                    estimated_call_seconds=estimate,
                    interpretation="UNKNOWN",
                )
                break
            try:
                if modern:
                    with self.store.lock:
                        if attempt in record["attempts"]:
                            continue
                        record["attempts"].append(attempt)
                        record["state"] = "RUNNING"
                options = {}
                if hasattr(self.adapter, "request_profile") and purpose:
                    options["purpose"] = purpose
                from .task_resources import admit_task

                admit_task(self.store, "review-task-" + task.id)
                if (
                    getattr(self.adapter, "request_profile", "fixed_8192")
                    != "fixed_8192"
                ):
                    from .request_policy import task_class

                    options["output_class"] = task_class(
                        kind="REVIEW",
                        purpose=purpose,
                        material=review_input,
                        profile=self.adapter.request_profile,
                        position=position,
                        goal=goal,
                    )
                generated = self.adapter.generate(
                    self.item,
                    goal=goal,
                    kind="review_" + role,
                    problem=self.store.problem.raw,
                    review_input=review_input,
                    verified=verified,
                    provisional=provisional,
                    deadline=deadline,
                    once=f"review:{position}:{role}:{artifact.id}:{attempt}"
                    + (
                        ":" + task.id
                        if modern
                        else ":" + context.digest
                        if context
                        else ""
                    ),
                    final=final,
                    priority=1,
                    **options,
                )
            except AdmissionError:
                if modern:
                    record["state"] = "NOT_ADMITTED"
                break
            report = parse_report(
                role=role, position=position, artifact=artifact, parsed=generated.parsed
            )
            note_admission_wait(self.store, generated)
            self.store.event(
                "review",
                role=role,
                position=position,
                target=artifact.id,
                request=generated.request_id,
                complete=report.complete,
                interpretation=report.interpretation,
                raw=report.raw,
                finish_reason=generated.finish_reason,
                error=generated.error,
                violations=generated.parsed.violations,
                **({"transport": generated.transport} if generated.transport else {}),
                **({"context_hash": context.digest} if context else {}),
                **(
                    {
                        "purpose": purpose,
                        "review_task": task.id,
                        "contract_revision": task.contract,
                    }
                    if modern
                    else {}
                ),
            )
            if modern:
                record["state"] = "DELIVERED" if report.complete else "PARTIAL"
                record["request"] = generated.request_id
            live = current(self.store)
            if generated.error and not generated.transport.get("remote_ended", False):
                self.store.control.setdefault("unknown_review_requests", {})[
                    pending_key
                ] = generated.request_id
                if modern:
                    record["state"] = "REMOTE_UNKNOWN"
            if (
                generated.late
                or self.store.control.get("goal_closure_closed")
                or (task.contract and (not live or live["id"] != task.contract))
            ):
                self.store.event("review_stale", review_task=task.id, adopted=False)
                return None
            ingest_material(
                self.store,
                artifact,
                text=generated.parsed.result,
                origin="review:" + generated.request_id,
            )
            for finding in report.findings:
                self.store.challenge(finding)
            coord = getattr(self.adapter, "coordinator", None)
            if (
                report.complete
                and report.interpretation != "UNKNOWN"
                and callable(getattr(coord, "record_request_fact", None))
            ):
                from .runtime.coordinator import Lease

                coord.record_request_fact(
                    Lease(
                        generated.request_id, self.item.id, deadline, "review_" + role
                    ),
                    "task_delivered",
                )
            if generated.error and not generated.transport.get("remote_ended", False):
                # A missing report is not a license to duplicate an unknown live call.
                self.store.control.setdefault("unknown_review_requests", {})[
                    pending_key
                ] = generated.request_id
                if modern:
                    record["state"] = "REMOTE_UNKNOWN"
                break
            if report.uncovered:
                self.store.control.setdefault("review_uncovered", {})[artifact.id] = (
                    list(report.uncovered)
                )
            if report.complete and report.interpretation not in {
                "UNKNOWN",
                "PARTIAL_REVIEW",
            }:
                return report
        if report is None:
            self.store.event(
                "review_missing",
                role=role,
                position=position,
                target=artifact.id,
                interpretation="UNKNOWN",
            )
        return report

    def initial_batch(self, artifact, *, deadline):
        import threading
        from concurrent.futures import ThreadPoolExecutor

        def initial(role):
            thread = threading.current_thread()
            original = thread.name
            thread.name = "r0-review-" + role
            try:
                return self.review(
                    role, "R0", artifact, deadline=deadline, attempts=(0,)
                )
            finally:
                thread.name = original

        # Every role first gets its independent initial opportunity. Retries may
        # not consume the entire stage before the third role has been considered.
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="r0-review") as pool:
            futures = [pool.submit(initial, role) for role in ROLES]
            reports = [future.result() for future in futures]
        for index, (role, report) in enumerate(zip(ROLES, reports)):
            if (
                report is None
                or not report.complete
                or report.interpretation in {"UNKNOWN", "PARTIAL_REVIEW"}
            ):
                retry = self.review(
                    role, "R0", artifact, deadline=deadline, attempts=(1,)
                )
                if retry is not None:
                    reports[index] = retry
        return reports
