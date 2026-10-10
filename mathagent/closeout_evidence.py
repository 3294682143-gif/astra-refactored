"""Expose selected-candidate obligations using actual artifact/task identities."""
from __future__ import annotations


def collect(store, candidate):
    if candidate is None:
        return []
    candidates = store.candidates
    pending = [candidate.artifact]
    visited, relevant, missing = set(), set(), set()
    while pending:
        aid = pending.pop()
        if aid in visited:
            continue
        visited.add(aid)
        artifact = store.artifacts.get(aid)
        if artifact is None:
            missing.add(aid)
            continue
        relevant.add(aid)
        pending.extend(artifact.dependencies)
        pending.extend(artifact.unverified_dependencies)
        if artifact.parent_revision:
            pending.append(artifact.parent_revision)
    items = [{'kind': 'missing_dependency', 'artifact': aid} for aid in sorted(missing)]
    for aid in sorted(relevant):
        artifact = store.artifacts[aid]
        node = store.tasks.nodes.get(artifact.work_unit)
        if not artifact.closed or (node and node.state == 'FAILED'):
            items.append({'kind': 'failed_dependency', 'artifact': aid,
                          'task': artifact.work_unit, 'state': node.state if node else 'INCOMPLETE'})
    for challenge in store.challenges.values():
        if challenge.target not in relevant | {candidate.id}:
            continue
        if challenge.status in {'RESOLVED', 'REPAIRED', 'CLOSED'}:
            continue
        items.append({'kind': 'candidate_check', 'candidate': candidate.id,
                      'check': challenge.id, 'target': challenge.target,
                      'status': challenge.status, 'issue': challenge.issue,
                      'replacement': challenge.replacement})
        # Native challenge replacements are ARTIFACT IDs, not candidate IDs.
        if challenge.replacement and challenge.replacement not in store.artifacts:
            items.append({'kind': 'missing_replacement_artifact', 'check': challenge.id,
                          'artifact': challenge.replacement})
    if candidate.parent and candidate.parent not in candidates:
        items.append({'kind': 'missing_parent_candidate', 'candidate': candidate.id,
                      'parent': candidate.parent})
    return items
