from __future__ import annotations

import re

from .answer_contracts import answer_identity, choice_coverage, output_payload
from .candidate_issues import issue_key, uncovered_reviews, unresolved_issues
from .store import ArtifactStore
from .verification import answer_verified, exact_goal_coverage

UNSOLVED = "在本题预算内未形成可提交答案。"


def select(store: ArtifactStore):
    with store.lock:
        return _select(store)


def _select(store: ArtifactStore):
    from .goal_ledger import bound_member_keys

    eligible = [
        c
        for c in store.candidates.values()
        if c.artifact not in store.refuted
        and c.answer.strip().upper() not in {"NONE", "UNKNOWN", "N/A"}
    ]

    methods = {
        row["id"]: row["mechanism"]
        for row in store.control.get("planning", {}).get("plan", {}).get("routes", [])
    }

    def rank(c):
        complete = bool(exact_goal_coverage(store, c))
        shape = choice_coverage(
            store.problem.raw, store.artifacts[c.artifact].text, c.answer
        )
        # Revisions and conditional ancestry retain unresolved proof obligations.
        # Deduplicate exact normalized checks instead of counting review votes.
        open_issues = {}
        for issue in unresolved_issues(store, store.artifacts[c.artifact]):
            open_issues.setdefault(issue_key(issue), issue)

        def impact(issue):
            text = (issue.issue + " " + issue.basis).lower()
            if re.search(
                r"violat|wrong (?:answer|root)|division by zero|违反|除零", text
            ):
                return 3
            if re.search(
                r"missing.*(?:root|solution|goal)|omitted|漏解|遗漏目标", text
            ):
                return 2
            if re.search(r"format|typograph|punctuation|格式|排版", text):
                return 0
            return 1

        impacts = [impact(issue) for issue in open_issues.values()]
        if uncovered_reviews(store, store.artifacts[c.artifact]):
            impacts.append(1)
        r5 = {
            e["details"].get("target")
            for e in store.events
            if e["kind"] == "review"
            and e["details"].get("position") == "R5"
            and e["details"].get("complete")
        }
        if r5 and c.artifact not in r5:
            impacts.append(1)  # Missing inspection is not a doubt-free advantage.
        agreement = {
            methods.get(other.route)
            for other in eligible
            if answer_identity(store.problem.raw, other.answer)
            == answer_identity(store.problem.raw, c.answer)
            and other.artifact not in store.invalid_proofs
        } - {None, "UNKNOWN"}
        # One known method (including this candidate itself) is not independent
        # support. Two distinct declared mechanisms remain only a tiebreaker.
        independent_support = len(agreement) if len(agreement) >= 2 else 0
        members = bound_member_keys(store, c)
        covers_smaller_checked_answer = bool(
            members
            and any(
                (other_members := bound_member_keys(store, other))
                and other_members < members
                and not exact_goal_coverage(store, other)
                for other in eligible
                if other.id != c.id
            )
        )
        return (
            -int(answer_verified(store, c)),
            c.artifact in store.invalid_proofs,
            max(impacts, default=-1),
            min(sum(impacts), 3),
            -int(complete),
            -int(
                shape["complete_claimed_coverage"]
                and shape["answer_consistent_with_claims"]
            ),  # Self-reported coverage cannot override a substantive doubt.
            -independent_support,
            -int(
                covers_smaller_checked_answer
            ),  # Strict source-checked inclusion, never raw solution count.
            c.route,
            c.id,
        )

    return min(eligible, key=rank) if eligible else None


def finalize(store: ArtifactStore):
    with store.lock:
        return _finalize(store)


def _finalize(store: ArtifactStore):
    from .goal_contracts import current
    from .goal_ledger import candidate_gap_summary, sync_candidate_evidence

    candidate = select(store)
    if candidate is None:
        store.control["goal_closure_closed"] = True
        return {
            "final_response": UNSOLVED,
            "status": "unsolved",
            "trace": list(store.events),
        }
    # Only lossless shape normalization; never generate or change mathematics.
    verified = answer_verified(store, candidate)
    sync_candidate_evidence(store, candidate)
    gaps = candidate_gap_summary(store, candidate)
    from .closeout_evidence import collect

    unresolved = collect(store, candidate)
    verified = verified and not unresolved
    store.event(
        "selection",
        candidate_revision=candidate.id,
        artifact=candidate.artifact,
        verified=verified,
        rule="coverage_evidence_doubts_declared_methods_stable_id",
    )
    contract = current(store)
    store.control["goal_closure_closed"] = True
    return {
        "final_response": output_payload(store.problem.raw, candidate.answer),
        "status": "candidate",
        "candidate_revision": candidate.id,
        "candidate_verified": verified,
        "answer_target_kind": contract["kind"] if contract else "UNKNOWN",
        "goal_coverage_gaps": gaps,
        "unresolved_evidence": unresolved,
        "unresolved_obligations": sorted({row['kind'] for row in unresolved}),
        "verification_note": ("Candidate remains unverified: unresolved checks/dependencies are explicit."
                              if unresolved else "Verification is limited to recorded original-goal evidence."),
        "trace": list(store.events),
    }
