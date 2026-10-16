"""G8/PR8 — executable behaviour tests for the retained Python modules that the
migration ledger had reopened (they were previously closed on a *mapping only*).

These exercise the real retained modules (not a file mapping): the review-input
identity, the purpose-specific review identity, the closeout-evidence collection,
the finalization selector, and the material-conflict rule. No model, no network.
"""
from __future__ import annotations

from mathagent.closeout_evidence import collect
from mathagent.domain import Artifact, ProblemContract, Scope
from mathagent.finalization import UNSOLVED, finalize, select
from mathagent.review import material_conflict
from mathagent.review_context import ReviewContext
from mathagent.review_tasks import PURPOSES, ReviewTask
from mathagent.store import ArtifactStore
from mathagent.workflows.closeout import CloseoutWorkflow


class _Report:
    """Minimal duck-typed review report for the pure rule under test."""

    def __init__(self, stances=(), finding=None):
        self.stances = stances
        self.finding = finding


class _Candidate:
    def __init__(self, artifact, identifier="c1", parent=None):
        self.artifact = artifact
        self.id = identifier
        self.parent = parent


def _empty_store(problem="Solve x(x-1)=0 for all real solutions."):
    return ArtifactStore(ProblemContract(problem))


def test_review_context_digest_is_version_bound_and_render_is_ordered():
    base = ReviewContext(task="T", issue="I", basis="B")
    same = ReviewContext(task="T", issue="I", basis="B")
    changed = ReviewContext(task="T", issue="I", basis="B2")
    assert base.digest == same.digest
    assert base.digest != changed.digest
    rendered = base.render("DERIVATION")
    assert rendered.index("Original task:") < rendered.index("Specific doubt:")
    assert "DERIVATION" in rendered
    # Empty sections are omitted, never rendered as blank labels.
    assert "Mathematical basis:" in rendered
    assert ReviewContext(task="T").render("D").count("Specific doubt:") == 0


def test_review_task_identity_and_purposes():
    assert {"MEMBERSHIP", "EXHAUSTIVENESS", "EXCEPTIONS", "REVISION", "FINAL_COVERAGE"} <= set(PURPOSES)
    first = ReviewTask(problem="P", contract=None, target="t", artifact_hash="h1",
                       role="R2", position="R2", purpose="REVISION", context_identity="c")
    second = ReviewTask(problem="P", contract=None, target="t", artifact_hash="h2",
                        role="R2", position="R2", purpose="REVISION", context_identity="c")
    assert isinstance(first.id, str) and first.id
    assert first.id != second.id


def test_closeout_evidence_reports_missing_and_failed_dependencies():
    store = _empty_store()
    assert collect(store, None) == []
    # A candidate whose artifact is absent from the store is a missing dependency,
    # never silently dropped.
    items = collect(store, _Candidate("a1"))
    assert {"kind": "missing_dependency", "artifact": "a1"} in items
    # A candidate referencing a parent that is not a registered candidate is explicit.
    items = collect(store, _Candidate("a1", identifier="c9", parent="p-missing"))
    assert any(row["kind"] == "missing_parent_candidate" for row in items)


def test_finalization_selects_nothing_and_reports_unsolved_on_an_empty_store():
    store = _empty_store()
    assert select(store) is None
    result = finalize(store)
    assert result["status"] == "unsolved"
    assert result["final_response"] == UNSOLVED


def test_material_conflict_requires_opposite_positions():
    affirm = _Report(stances=(("prop", "scope", "AFFIRMS"),))
    deny = _Report(stances=(("prop", "scope", "DENIES"),))
    other = _Report(stances=(("prop2", "scope", "DENIES"),))
    assert material_conflict([affirm, deny]) is True
    assert material_conflict([affirm, other]) is False
    # Absence of a finding is NOT a conflict.
    assert material_conflict([_Report(), _Report()]) is False
    assert material_conflict([None, affirm]) is False


def _workflow(store):
    return CloseoutWorkflow(
        store=store, budget=None, clock=None, call=None,
        register_candidate=None, review=None, experiment=None,
    )


def test_closeout_workflow_materials_empty_store_is_closeout():
    flow = _workflow(_empty_store())
    assert flow.store is not None
    assert flow.materials() == ("closeout", ())


def test_closeout_workflow_materials_selects_the_closed_route():
    store = _empty_store("Solve x=1.")
    store.append(Artifact(
        id="a1", problem=store.problem.digest, route="r1", work_unit="w1",
        text="x=1", request="work", scope=Scope(), dependencies=(),
        unverified_dependencies=(), closed=True,
    ))
    route, deps = _workflow(store).materials()
    assert route == "r1"
    assert deps == ("a1",)
    assert any(e["kind"] == "closeout_materials" for e in store.events)
