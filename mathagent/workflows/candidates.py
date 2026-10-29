"""Version-bound candidate registration; retains its existing atomic flush."""

import re
from dataclasses import dataclass

from ..answer_contracts import answer_identity, choice_coverage
from ..candidate_issues import uncovered_reviews, unresolved_issues
from ..content_fields import fields
from ..domain import Artifact, CandidateRevision, Challenge
from .ports import Checkpoint


def candidate_payload(text: str):
    # Anchored labeled extraction. Preserve the rest of the complete artifact.
    entries = fields(
        text.strip(),
        ["ANSWER", "答案", "最终答案", "BASIS", "依据", "CONDITIONS", "GAPS"],
        after_math=True,
    )
    if not entries or entries[0][0] not in {"ANSWER", "答案", "最终答案"}:
        return None
    if sum(k in {"ANSWER", "答案", "最终答案"} for k, _ in entries) != 1:
        return None
    answer = entries[0][1].strip()
    return answer if answer.upper() not in {"NONE", "UNKNOWN", "N/A"} else None


def candidate_gaps(store, artifact, *, actionable=False):
    """Concrete recorded gaps only; absence of evidence is not a refutation."""
    gaps = [
        c.next_check
        for c in unresolved_issues(store, artifact)
        if c.next_check.strip()
        and not (
            actionable and c.status == "UNKNOWN" and (c.check_artifact or c.replacement)
        )
    ]
    if not actionable:
        gaps.extend(
            text for text in uncovered_reviews(store, artifact) if 0 < len(text) <= 2000
        )
        conflict = store.control.get("answer_conflicts", {}).get(artifact.id)
        if conflict:
            gaps.append(conflict["check"])
    # A conditional context concatenates several complete artifacts. Its trailing
    # "GAPS: NONE\nTargeted check ..." is not a new mathematical gap field.
    if artifact.request == "controller_conditional_context":
        parent = store.artifacts.get(artifact.parent_revision)
        if parent is not None:
            gaps.extend(candidate_gaps(store, parent, actionable=actionable))
        return tuple(dict.fromkeys(gaps))
    for key, value in fields(
        artifact.text,
        ["ANSWER", "答案", "最终答案", "BASIS", "依据", "CONDITIONS", "GAPS"],
        after_math=True,
    ):
        if (
            key == "GAPS"
            and value.strip().upper()
            not in {"NONE", "UNKNOWN", "N/A", "无", "无缺口", "无剩余缺口"}
            and 0 < len(value) <= 2000
        ):
            gaps.append(value)
    return tuple(dict.fromkeys(gaps))


@dataclass(frozen=True)
class RegistrationResult:
    revision: CandidateRevision | None
    new_revision: bool = False
    new_answer: bool = False
    requires_review: bool = False


class CandidateRegistration:
    def __init__(self, *, store, verifier, persist: Checkpoint):
        self.store, self.verifier, self.persist = store, verifier, persist

    def register(self, artifact: Artifact, *, parent=None):
        with self.store.lock:
            candidate = self._prepare(artifact, parent=parent)
        if candidate:
            self._check_candidate(candidate)
        return candidate

    def register_result(self, artifact: Artifact, *, parent=None):
        """Explicit version result; a duplicate answer can still need R4/R5."""
        with self.store.lock:
            before = set(self.store.candidates)
            answers = {
                answer_identity(self.store.problem.raw, c.answer)
                for c in self.store.candidates.values()
            }
        candidate = self.register(artifact, parent=parent)
        with self.store.lock:
            if candidate is None:
                return RegistrationResult(None)
            return RegistrationResult(
                candidate,
                candidate.id not in before,
                answer_identity(self.store.problem.raw, candidate.answer)
                not in answers,
                not bool(
                    self.store.applicable_evidence(candidate.artifact, artifact.scope)
                ),
            )

    def _prepare(self, artifact: Artifact, *, parent=None):
        from ..goal_contracts import current

        contract = current(self.store)
        bound = self.store.control.get("artifact_contracts", {}).get(artifact.id)
        if self.store.control.get("goal_closure_closed") or (
            bound and contract and bound != contract["id"]
        ):
            return None
        if artifact.request == "controller_conditional_context":
            return None
        if not artifact.closed:
            return None
        unit = self.store.control.get("artifact_units", {}).get(artifact.id, {})
        if unit and unit.get("kind") not in {
            "CANDIDATE",
            "ASSEMBLE",
            "FALLBACK",
            "REPAIR",
        }:
            return None
        if unit.get("kind") == "REPAIR" and "original_goal_coverage" not in unit.get(
            "obligations", ()
        ):
            # Local repair may contain quoted ANSWER labels, but is not an
            # original-problem candidate generation task.
            return None
        answer = candidate_payload(artifact.text)
        if answer and re.search(
            r"\b(?:prove|proof)\b|证明", self.store.problem.raw, re.IGNORECASE
        ):
            basis = [
                value
                for label, value in fields(
                    artifact.text,
                    [
                        "ANSWER",
                        "答案",
                        "最终答案",
                        "BASIS",
                        "依据",
                        "CONDITIONS",
                        "GAPS",
                    ],
                    after_math=True,
                )
                if label in {"BASIS", "依据"}
            ]
            if len(basis) == 1:
                answer += "\n" + basis[0]
        if not answer and unit.get("kind") in {"CANDIDATE", "ASSEMBLE", "FALLBACK"}:
            from ..verification import arithmetic_goal

            # Only a declared original scalar arithmetic target licenses bare recovery.
            if arithmetic_goal(self.store.problem.raw) is not None and re.fullmatch(
                r"[+-]?\d+(?:/\d+|\.\d+)?", artifact.text.strip()
            ):
                answer = artifact.text.strip()
        if not answer:
            return None
        candidate = CandidateRevision(
            "candidate-" + artifact.id, artifact.id, answer, artifact.route, parent
        )
        previous = self.store.candidates.get(candidate.id)
        if previous is not None:
            if previous != candidate:
                raise ValueError("immutable candidate collision")
            return previous
        self.store.add_candidate(candidate)
        self.store.control.setdefault("candidate_check_states", {})[candidate.id] = {
            "state": "PENDING",
            "contract": contract["id"] if contract else None,
        }
        from ..goal_ledger import candidate_binding

        candidate_binding(self.store, candidate)
        task_key = self.store.control.get("goal_tasks", {}).get(artifact.work_unit)
        if task_key:
            state = self.store.control["goal_closure"]
            job = state["scheduler"]["jobs"][task_key]
            if job["purpose"] == "MERGE":
                for merge in state["merges"].values():
                    if (
                        merge["branches"] == job["refs"]
                        and merge["contract"] == job["contract"]
                    ):
                        merge["candidate"] = candidate.id
                        self.store.event(
                            "goal_merge_candidate",
                            merge=merge["id"],
                            candidate=candidate.id,
                            complete_coverage_not_assumed=True,
                        )
        coverage = choice_coverage(self.store.problem.raw, artifact.text, answer)
        if coverage["labels"]:
            self.store.control.setdefault("answer_shape_coverage", {})[candidate.id] = (
                coverage
            )
            self.store.event(
                "answer_shape_coverage", candidate=candidate.id, **coverage
            )
            if (
                coverage["complete_claimed_coverage"]
                and not coverage["answer_consistent_with_claims"]
            ):
                self.store.challenge(
                    Challenge(
                        "option-consistency-" + artifact.id,
                        artifact.id,
                        "The selected options disagree with the explicit OPTION truth claims in BASIS.",
                        "Mechanical consistency of submitted labels with the candidate's own claims, not a proof that the claims are true.",
                        "Recheck each option against the source, then align ANSWER with all true options and retain unresolved options as gaps.",
                    )
                )
        return candidate

    def _check_candidate(self, candidate):
        from ..goal_contracts import current

        artifact, answer = self.store.artifacts[candidate.artifact], candidate.answer
        with self.store.lock:
            checks = self.store.control.setdefault("candidate_check_states", {})
            if checks.get(candidate.id, {}).get("state") not in {None, "PENDING"}:
                return
            contract = current(self.store)
            revision = contract["id"] if contract else None
            checks[candidate.id] = {"state": "STARTED", "contract": revision}
        evidence = self.verifier.check(
            self.store, artifact, goal="original goal", proposed=answer, candidate=True
        )
        with self.store.lock:
            live = current(self.store)
            if self.store.control.get("goal_closure_closed") or (
                revision and (not live or live["id"] != revision)
            ):
                checks[candidate.id]["state"] = "STALE"
                return
            checks[candidate.id]["state"] = "FINISHED"
        # Recheck each member against the entire source, independently of the
        # aggregate verdict and its proof ancestry. Also runs during closeout.
        if revision:
            from ..math_source import compile_candidate
            from ..solution_branches import check_branch

            branches = self.store.control.get("goal_closure", {}).get("branches", {})
            pending = [
                b
                for b in list(branches.values())
                if b["artifact"] == artifact.id
                and b["contract"] == revision
                and b["membership"] == "CHECK_PENDING"
            ]
            for branch in pending[:32]:
                if self.verifier.clock() >= self.verifier.deadline():
                    break
                plan = compile_candidate(self.store.problem.raw, branch["object"])
                if plan and plan.property == "source_function_satisfaction":
                    check_branch(self.store, branch["id"], self.verifier)
            from ..solution_branches import checked_branch

            state = self.store.control.get("goal_closure", {})
            answer_members = set(
                state.get("candidate_bindings", {})
                .get(candidate.id, {})
                .get("branches", [])
            )
            recovered = [
                b["id"]
                for b in pending
                if b["id"] not in answer_members
                and (check := checked_branch(self.store, b))
                and check.outcome == "SUPPORTS"
            ]
            if artifact.id in self.store.refuted and recovered:
                self.store.control.setdefault("answer_member_reconciliation", {})[
                    candidate.id
                ] = {
                    "state": "REASSEMBLY_REQUIRED",
                    "artifact_hash": artifact.digest,
                    "contract": revision,
                    "retained_members": recovered,
                    "answer_members": sorted(answer_members),
                    "exhaustiveness": "UNKNOWN",
                }
                self.store.event(
                    "answer_reconciliation_required",
                    candidate=candidate.id,
                    retained_members=recovered,
                    old_answer_refuted=True,
                )
        if evidence and evidence.outcome in {"INCOMPLETE", "REFUTES"}:
            source_bound = evidence.property.startswith("source_")
            self.store.challenge(
                Challenge(
                    "coverage-" + artifact.id,
                    artifact.id,
                    "candidate_violates_bound_source_constraint"
                    if source_bound
                    else "candidate_satisfies_but_all_solutions_missing"
                    if evidence.outcome == "INCOMPLETE"
                    else "candidate_violates_original_equation",
                    evidence.verified_statement
                    if source_bound
                    else "Independent original polynomial root coverage check",
                    "Repair the original-goal candidate using the exact bound counterexample or remainder; preserve every source condition."
                    if source_bound
                    else "Recover the omitted roots and recheck all solutions.",
                )
            )
        self.persist()
        # Answer novelty belongs to ProgressTracker, not registration success.
        # Returning None here previously made identical repairs skip R4/R5.
        return candidate
