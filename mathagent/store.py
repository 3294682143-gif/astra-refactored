from __future__ import annotations

import copy
import json
import threading
from dataclasses import asdict, replace
from functools import wraps

from .domain import (
    Artifact,
    CandidateRevision,
    Challenge,
    Evidence,
    FailureRecord,
    ProblemContract,
    Scope,
)
from .task_graph import TaskGraph


def synchronized(fn):
    @wraps(fn)
    def wrapped(self, *args, **kwargs):
        with self.lock:
            return fn(self, *args, **kwargs)

    return wrapped


class ArtifactStore:
    def __init__(self, problem: ProblemContract):
        self.problem = problem
        self.lock = threading.RLock()
        self.artifacts: dict[str, Artifact] = {}
        self.candidates: dict[str, CandidateRevision] = {}
        self.evidence: dict[str, Evidence] = {}
        self.challenges: dict[str, Challenge] = {}
        self.verified: set[str] = set()
        self.refuted: set[str] = set()
        self.invalid_proofs: set[str] = set()
        self.events: list[dict] = []
        self.tasks = TaskGraph(self.lock)
        self.control: dict = {}
        self.tasks.external_ids = lambda: self.control.get("task_resource_ids", ())
        self.failures: list[FailureRecord] = []
        self.event_sink = None

    @synchronized
    def event(self, kind: str, **details):
        self.events.append(
            {"sequence": len(self.events), "kind": kind, "details": details}
        )
        if self.event_sink is not None:
            self.event_sink(self.events[-1])

    @synchronized
    def append(self, artifact: Artifact):
        if artifact.problem != self.problem.digest:
            raise ValueError("cross-problem artifact")
        previous = self.artifacts.get(artifact.id)
        if previous is not None:
            if previous != artifact:
                raise ValueError("immutable artifact collision")
            return previous
        if artifact.parent_revision and artifact.parent_revision not in self.artifacts:
            raise ValueError("unknown parent revision")
        inherited = set()
        for dep in artifact.dependencies:
            parent = self.artifacts.get(dep)
            if parent is None or not parent.closed:
                raise ValueError("missing or partial dependency")
            if dep in self.refuted or dep in self.invalid_proofs:
                raise ValueError("invalidated dependency")
            usable = bool(self.applicable_evidence(dep, artifact.scope))
            if parent.route != artifact.route and not usable:
                raise ValueError("cross-route provisional or scope mismatch")
            if not usable:
                inherited.add(dep)
                inherited.update(parent.unverified_dependencies)
        if not inherited <= set(artifact.unverified_dependencies):
            raise ValueError("lost provisional ancestry")
        self.artifacts[artifact.id] = artifact
        self.event("artifact", artifact=asdict(artifact))
        return artifact

    @synchronized
    def add_candidate(self, candidate: CandidateRevision):
        artifact = self.artifacts.get(candidate.artifact)
        if (
            artifact is None
            or candidate.route != artifact.route
            or not candidate.answer.strip()
        ):
            raise ValueError("candidate must bind a known artifact and route")
        if (
            candidate.id in self.candidates
            and self.candidates[candidate.id] != candidate
        ):
            raise ValueError("immutable candidate collision")
        if candidate.parent and candidate.parent not in self.candidates:
            raise ValueError("missing parent candidate")
        if candidate.id in self.candidates:
            return
        self.candidates[candidate.id] = candidate
        self.event("candidate", candidate=asdict(candidate))

    @synchronized
    def challenge(self, challenge: Challenge):
        if challenge.target not in self.artifacts:
            raise ValueError("challenge must bind an exact artifact")
        if not challenge.issue.strip() or not challenge.basis.strip():
            raise ValueError("unlocated criticism is not a refutation")
        existing = self.challenges.get(challenge.id)
        if existing is not None:
            if (
                existing.target,
                existing.issue,
                existing.basis,
                existing.next_check,
            ) != (
                challenge.target,
                challenge.issue,
                challenge.basis,
                challenge.next_check,
            ):
                raise ValueError("challenge identity collision")
            return existing
        if challenge.status != "OPEN":
            raise ValueError("new model challenges cannot assign resolution authority")
        self.challenges[challenge.id] = challenge
        self.event("challenge", challenge=asdict(challenge))

    @synchronized
    def update_challenge(
        self,
        challenge_id,
        status,
        *,
        check_artifact=None,
        evidence_ids=(),
        replacement=None,
        resolution="",
    ):
        from .verification import VerificationEngine

        if status not in {"CHECKING", "UNKNOWN", "CONFIRMED", "RESOLVED", "REPAIRED"}:
            raise ValueError("invalid challenge state")
        challenge = self.challenges[challenge_id]
        evidence = [self.evidence[eid] for eid in evidence_ids]
        if any(
            e.checker != "registered_exact_checker"
            or e.checker_version != VerificationEngine.version
            or e.artifact_hash != self.artifacts[e.artifact_id].digest
            or (e.outcome == "SUPPORTS" and e.kind != "EXACT_CHECK")
            or (e.outcome == "REFUTES" and e.kind != "EXACT_COUNTEREXAMPLE")
            for e in evidence
        ):
            raise ValueError("challenge evidence must be current and version-bound")
        if status in {"CONFIRMED", "RESOLVED"}:
            outcomes = (
                {"REFUTES", "INCOMPLETE"} if status == "CONFIRMED" else {"SUPPORTS"}
            )
            if not evidence or any(
                e.artifact_id != challenge.target or e.outcome not in outcomes
                for e in evidence
            ):
                raise ValueError(
                    "unrelated evidence cannot resolve or confirm a challenge"
                )
            if (
                status == "RESOLVED"
                and self.artifacts[challenge.target].unverified_dependencies
            ):
                raise ValueError(
                    "conditional evidence cannot eliminate an unconditional doubt"
                )
        if status == "REPAIRED":
            if (
                replacement not in self.artifacts
                or self.artifacts[replacement].parent_revision != challenge.target
            ):
                raise ValueError("repair must link a concrete new revision")
            if not evidence or any(
                e.artifact_id != replacement or e.outcome != "SUPPORTS"
                for e in evidence
            ):
                raise ValueError("repair requires new-version exact evidence")
        if check_artifact is not None and check_artifact not in self.artifacts:
            raise ValueError("unknown check artifact")
        updated = replace(
            challenge,
            status=status,
            check_artifact=check_artifact,
            evidence_ids=tuple(evidence_ids),
            replacement=replacement,
            resolution=resolution,
        )
        self.challenges[challenge_id] = updated
        self.event("challenge_transition", challenge=asdict(updated))
        return updated

    @synchronized
    def affected(self, target):
        affected = {target}
        while True:
            expanded = affected | {
                a.id for a in self.artifacts.values() if set(a.dependencies) & affected
            }
            if expanded == affected:
                return affected
            affected = expanded

    @synchronized
    def refute(self, target: str, evidence: Evidence):
        artifact = self.artifacts[target]
        if (
            evidence.artifact_id != target
            or evidence.artifact_hash != artifact.digest
            or evidence.outcome != "REFUTES"
            or evidence.kind != "EXACT_COUNTEREXAMPLE"
            or evidence.id not in self.evidence
        ):
            raise ValueError(
                "refutation requires registered, exact version-bound evidence"
            )
        self.refuted.add(target)
        children = self.affected(target) - {target}
        self.invalid_proofs.update(
            children
        )  # A false premise does NOT prove child statements false.
        self.verified.difference_update(children | {target})
        self.failures.append(
            FailureRecord(target, "exact_refutation", tuple(sorted(children)))
        )
        self.event(
            "refutation",
            target=target,
            evidence=evidence.id,
            reopened_proofs=sorted(children),
            children_are_not_refuted=True,
        )
        reopened = self.tasks.reopen_invalidated(self)
        if reopened:
            for task_id in reopened:
                self.control.get("routes_finished", {}).pop(
                    self.tasks.nodes[task_id].unit.route, None
                )
            self.event("tasks_reopened", tasks=reopened, cause=target)

    @synchronized
    def applicable_evidence(self, artifact_id: str, requested_scope: Scope):
        # Verification is property- and scope-specific, not a transferable state bit.
        from .verification import VerificationEngine

        artifact = self.artifacts.get(artifact_id)
        from .goal_contracts import current

        contract = current(self)
        revision = self.control.get("artifact_contracts", {}).get(artifact_id)
        if revision and contract and revision != contract["id"]:
            return ()
        if (
            artifact is None
            or artifact_id not in self.verified
            or artifact_id in self.refuted
            or artifact_id in self.invalid_proofs
            or artifact.unverified_dependencies
            or not artifact.closed
            or not artifact.scope.covers(requested_scope)
        ):
            return ()
        return tuple(
            e
            for e in self.evidence.values()
            if e.artifact_id == artifact_id
            and e.artifact_hash == artifact.digest
            and e.outcome == "SUPPORTS"
            and e.kind == "EXACT_CHECK"
            and e.checker == "registered_exact_checker"
            and e.checker_version == VerificationEngine.version
            and e.scope.covers(requested_scope)
            and e.verified_statement
        )

    def public_text(self, artifact):
        if artifact.request != "local_registered_tool":
            return artifact.text
        value = json.loads(artifact.text)
        # Preserve mathematical output/certificate, but never send control receipts or hashes.
        return json.dumps(
            {
                key: value.get(key)
                for key in (
                    "tool",
                    "status",
                    "result",
                    "evidence_kind",
                    "declared_scope",
                    "certificate",
                )
            }
            | {"original_problem_mapping": "UNVERIFIED"},
            ensure_ascii=False,
        )

    @synchronized
    def context(self, route: str, scope: Scope, dependencies: tuple[str, ...]):
        verified, provisional = [], []
        for dep in dependencies:
            a = self.artifacts[dep]
            if not a.closed or dep in self.refuted or dep in self.invalid_proofs:
                raise ValueError("partial/invalid artifact cannot be a premise")
            text = f"Conditions: {a.scope.conditions}; Domain: {a.scope.domain}; Quantifiers: {a.scope.quantifiers}\n{self.public_text(a)}"
            checked = self.applicable_evidence(dep, scope)
            if checked:
                # A checker verifies a property, never all prose in a model artifact.
                verified.extend(
                    f"Conditions: {e.scope.conditions}; Domain: {e.scope.domain}; "
                    f"Quantifiers: {e.scope.quantifiers}\n{e.verified_statement}"
                    for e in checked
                )
            elif a.route == route:
                provisional.append(
                    "UNVERIFIED, conditional route-local premise:\n" + text
                )
            else:
                raise ValueError("cross-route context leak")
        return tuple(verified), tuple(provisional)

    @synchronized
    def snapshot(self):
        return {
            "problem_hash": self.problem.digest,
            "events": list(self.events),
            "verified": sorted(self.verified),
            "refuted": sorted(self.refuted),
            "invalid_proofs": sorted(self.invalid_proofs),
            "artifacts": [asdict(a) for a in self.artifacts.values()],
            "candidates": [asdict(c) for c in self.candidates.values()],
            "evidence": [asdict(e) for e in self.evidence.values()],
            "challenges": [asdict(c) for c in self.challenges.values()],
            "tasks": self.tasks.snapshot(),
            "control": copy.deepcopy(self.control),
            "failures": [asdict(f) for f in self.failures],
        }

    @classmethod
    def restore(cls, problem, snapshot):
        if snapshot["problem_hash"] != problem.digest:
            raise ValueError("snapshot problem mismatch")
        store = cls(problem)

        def scope(value):
            return Scope(
                tuple(value["conditions"]), value["domain"], tuple(value["quantifiers"])
            )

        for row in snapshot["artifacts"]:
            value = dict(row)
            value["scope"] = scope(value["scope"])
            value["dependencies"] = tuple(value["dependencies"])
            value["unverified_dependencies"] = tuple(value["unverified_dependencies"])
            # Cross-route receipts must be restored before checking context reuse.
            a = Artifact(**value)
            if a.problem != problem.digest or any(
                d not in store.artifacts for d in a.dependencies
            ):
                raise ValueError("invalid snapshot ancestry")
            store.artifacts[a.id] = a
        for row in snapshot["evidence"]:
            value = dict(row)
            value["scope"] = scope(value["scope"])
            value["obligations"] = tuple(value["obligations"])
            e = Evidence(**value)
            if e.artifact_hash != store.artifacts[e.artifact_id].digest:
                raise ValueError("stale evidence snapshot")
            store.evidence[e.id] = e
        for row in snapshot["candidates"]:
            value = dict(row)
            value["obligations"] = tuple(value["obligations"])
            store.add_candidate(CandidateRevision(**value))
        for row in snapshot["challenges"]:
            row = dict(row)
            row["evidence_ids"] = tuple(row.get("evidence_ids", ()))
            challenge = Challenge(**row)
            store.challenge(replace(challenge, status="OPEN"))
            if challenge.status != "OPEN":
                store.update_challenge(
                    challenge.id,
                    challenge.status,
                    check_artifact=challenge.check_artifact,
                    evidence_ids=challenge.evidence_ids,
                    replacement=challenge.replacement,
                    resolution=challenge.resolution,
                )
        store.verified = set(snapshot["verified"])
        store.refuted = set(snapshot["refuted"])
        store.invalid_proofs = set(snapshot["invalid_proofs"])
        for aid in store.verified:
            if not any(
                e.artifact_id == aid and e.outcome == "SUPPORTS"
                for e in store.evidence.values()
            ):
                raise ValueError("unbacked verified snapshot")
        store.events = list(snapshot["events"])
        store.tasks.restore(snapshot.get("tasks", []))
        store.control = dict(snapshot.get("control", {}))
        from .goal_contracts import restore_contract

        restore_contract(store)
        if (
            len(
                set(store.tasks.nodes) | set(store.control.get("task_resource_ids", ()))
            )
            > store.tasks.max_nodes
        ):
            raise ValueError("snapshot mathematical task node bound exceeded")
        store.failures = [
            FailureRecord(row["target"], row["reason"], tuple(row["affected"]))
            for row in snapshot.get("failures", [])
        ]
        return store
