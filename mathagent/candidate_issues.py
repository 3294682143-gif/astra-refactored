"""Version/conditional ancestry of unresolved doubts; never transfers truth."""

import re


def issue_key(issue):
    """Exact normalized mathematical check, not the number of reviewer votes."""
    return re.sub(r"\s+", " ", issue.next_check or issue.issue).strip()


def artifact_lineage(store, artifact):
    with store.lock:
        pending, ancestry = [artifact.id], set()
        while pending:
            aid = pending.pop()
            if aid in ancestry or aid not in store.artifacts:
                continue
            current = store.artifacts[aid]
            if current.problem != artifact.problem or current.route != artifact.route:
                continue
            ancestry.add(aid)
            if current.parent_revision:
                pending.append(current.parent_revision)
            pending.extend(current.unverified_dependencies)
        return ancestry


def unresolved_issues(store, artifact):
    with store.lock:
        ancestry = artifact_lineage(store, artifact)
        return tuple(
            c
            for c in store.challenges.values()
            if c.target in ancestry and c.status not in {"RESOLVED", "REPAIRED"}
        )


def uncovered_reviews(store, artifact):
    rows = store.control.get("review_uncovered", {})
    return tuple(
        dict.fromkeys(
            text
            for aid in artifact_lineage(store, artifact)
            for text in rows.get(aid, ())
        )
    )
