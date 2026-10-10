"""Scope-specific obligations and immutable source material references."""

from __future__ import annotations

from .goal_contracts import canonical_domain, current
from .runtime.config import fingerprint

PROPERTIES = {
    "VALUE": ("value",),
    "ONE_WITNESS": ("membership",),
    "ALL_SOLUTIONS": ("membership", "parameter_domain", "exceptions", "exhaustiveness"),
    "COUNT": ("object_domain", "exhaustiveness", "deduplication", "count"),
    "OPTIMIZE": ("global_bound", "attainment_or_limit"),
    "PROVE": ("proof",),
    "MULTI_SELECT": ("option_coverage", "label_consistency"),
    "MULTIPART": ("subgoal_types", "subgoal_coverage"),
    "UNKNOWN": ("clarification",),
}


def initialize_obligations(store, contract):
    state = store.control["goal_closure"]
    for target in contract["targets"] or ["clarify original target"]:
        kind = contract["kind"]
        if kind == "MULTIPART" and "::" in target:
            child_kind, child_target = target.split("::", 1)
            if (
                child_kind in PROPERTIES
                and child_kind not in {"MULTIPART", "UNKNOWN"}
                and child_target.strip()
            ):
                kind = child_kind
        for prop in PROPERTIES[kind]:
            key = fingerprint((contract["id"], target, prop))
            state["obligations"].setdefault(
                key,
                {
                    "id": key,
                    "problem": store.problem.digest,
                    "contract": contract["id"],
                    "target": target,
                    "property": prop,
                    "scope": contract["scope"],
                    "state": "OPEN",
                    "materials": [],
                    "evidence": [],
                    "dependencies": [],
                },
            )
    if contract["kind"] == "MULTI_SELECT":
        from .answer_contracts import choice_coverage

        for label in choice_coverage(store.problem.raw, "", "")["labels"]:
            key = fingerprint((contract["id"], label, "option_coverage"))
            state["obligations"].setdefault(
                key,
                {
                    "id": key,
                    "problem": store.problem.digest,
                    "contract": contract["id"],
                    "target": label,
                    "property": "option_coverage",
                    "scope": contract["scope"],
                    "state": "OPEN",
                    "materials": [],
                    "evidence": [],
                    "dependencies": [],
                },
            )
    if contract.get("field_gaps") and contract["kind"] != "UNKNOWN":
        key = fingerprint((contract["id"], "working contract", "clarification"))
        state["obligations"].setdefault(
            key,
            {
                "id": key,
                "problem": store.problem.digest,
                "contract": contract["id"],
                "target": "working contract",
                "property": "clarification",
                "scope": contract["scope"],
                "state": "OPEN",
                "materials": [],
                "evidence": [],
                "dependencies": [],
            },
        )


def active_obligations(store):
    contract = current(store)
    if not contract:
        return ()
    return tuple(
        o
        for o in store.control["goal_closure"]["obligations"].values()
        if o["contract"] == contract["id"]
    )


def ingest_material(store, artifact, *, text=None, origin=None):
    from .solution_branches import extract_branches, project_function_objects

    with store.lock:
        contract = current(store)
        if not contract or store.control.get("goal_closure_closed"):
            return
        bound = store.control.get("artifact_contracts", {}).get(
            artifact.id, contract["id"]
        )
        if bound != contract["id"]:
            return
        text = artifact.text if text is None else text
        # Code strings and TOOL explanations are not observed mathematical objects.
        if artifact.text.startswith(("TOOL:", "COMPUTATION_NEEDED:")):
            return
        key = fingerprint((artifact.id, origin, text, contract["id"]))
        state = store.control["goal_closure"]
        if key in state["materials"]:
            return
        state["materials"][key] = {
            "id": key,
            "artifact": artifact.id,
            "artifact_hash": artifact.digest,
            "contract": contract["id"],
            "origin": origin or "work_unit",
            "text": text,
            "state": "UNASSESSED",
            "branches": [],
        }
        if artifact.closed:
            branches = extract_branches(store, artifact, text, key)
            if origin != "source_candidate_projection":
                branches += project_function_objects(store, artifact, text, key)
            state["materials"][key]["branches"] = [b["id"] for b in branches]
            state["materials"][key]["state"] = "MATERIAL_AVAILABLE"
            from .content_fields import fields

            partition = fields(text, ["PARTITION_BASIS", "CASE"])
            if any(k == "PARTITION_BASIS" for k, _ in partition):
                state.setdefault("partitions", {})[key] = {
                    "material": key,
                    "contract": contract["id"],
                    "scope": contract["scope"],
                    "basis": [v for k, v in partition if k == "PARTITION_BASIS"],
                    "cases": [v for k, v in partition if k == "CASE"],
                    "coverage": "OPEN",
                    "overlap": "UNKNOWN",
                    "evidence": [],
                }
        store.event(
            "goal_material",
            material=key,
            artifact=artifact.id,
            branches=state["materials"][key]["branches"],
            truth_authority=False,
        )


def candidate_binding(store, candidate):
    with store.lock:
        contract = current(store)
        if not contract:
            return None
        state = store.control["goal_closure"]
        artifact = store.artifacts[candidate.artifact]
        ingest_material(store, artifact)
        branches = [
            b["id"]
            for b in state["branches"].values()
            if b["artifact"] == artifact.id and b["contract"] == contract["id"]
        ]
        if len(contract["targets"]) == 1:
            from .math_source import compile_candidate

            plan = compile_candidate(store.problem.raw, candidate.answer)
            if plan and plan.property == "source_function_satisfaction":
                # Compiler supplies explicit object boundaries; never split candidate prose.
                text = "; ".join(
                    "BRANCH: "
                    + op.arguments["function"]
                    + "("
                    + op.arguments["argument"]
                    + ")="
                    + op.arguments["expression"]
                    + "; BRANCH_DOMAIN: "
                    + contract["scope"]["domain"]
                    + "; PARAMETERS: NONE; BRANCH_CONDITIONS: NONE; BRANCH_TARGET: "
                    + contract["targets"][0]
                    for op in plan.checks
                )
                ingest_material(
                    store, artifact, text=text, origin="source_candidate_projection"
                )
                branches = [
                    b["id"]
                    for b in state["branches"].values()
                    if b["artifact"] == artifact.id
                    and b["contract"] == contract["id"]
                    and state["materials"][b["material"]]["origin"]
                    == "source_candidate_projection"
                ]
        row = {
            "contract": contract["id"],
            "artifact_hash": artifact.digest,
            "branches": branches,
            "coverage": "UNKNOWN",
            "evidence": [],
            "obligations": [o["id"] for o in active_obligations(store)],
        }
        state["candidate_bindings"].setdefault(candidate.id, row)
        return state["candidate_bindings"][candidate.id]


def bound_member_keys(store, candidate):
    """A checked superset tiebreak requires actual answer-to-object binding."""
    from .math_source import compile_candidate
    from .solution_branches import (
        canonical_function_object,
        checked_branch,
        rational_root_check,
    )
    from .verification import candidates, root_equation

    contract = current(store)
    if (
        not contract
        or contract["kind"] != "ALL_SOLUTIONS"
        or len(contract["targets"]) != 1
    ):
        return None
    binding = store.control["goal_closure"]["candidate_bindings"].get(candidate.id)
    if not binding or binding["contract"] != contract["id"]:
        return None
    branches = [
        store.control["goal_closure"]["branches"][key] for key in binding["branches"]
    ]
    if not branches or any(
        not (e := checked_branch(store, b)) or e.outcome != "SUPPORTS" for b in branches
    ):
        return None
    if root_equation(store.problem.raw):
        try:
            actual = {str(v) for v in candidates(candidate.answer)}
            mapped = {
                r["value"]
                for b in branches
                if (r := rational_root_check(store.problem.raw, b["object"]))
            }
            return actual if actual == mapped else None
        except (ValueError, TypeError, SyntaxError):
            return None
    plan = compile_candidate(store.problem.raw, candidate.answer)
    if not plan or plan.property != "source_function_satisfaction":
        return None
    expected = {canonical_function_object(op) for op in plan.checks}
    actual = set()
    for branch in branches:
        member = compile_candidate(store.problem.raw, branch["object"])
        if not member or len(member.checks) != 1:
            return None
        actual.add(canonical_function_object(member.checks[0]))
    return actual if actual == expected else None


def sync_candidate_evidence(store, candidate):
    from .verification import exact_goal_coverage

    with store.lock:
        binding = candidate_binding(store, candidate)
        contract = current(store)
        if not binding or binding["contract"] != contract["id"]:
            return
        full = exact_goal_coverage(store, candidate)
        if (
            full
            and contract.get("usable", True)
            and canonical_domain(contract["scope"]["domain"]) is not None
            and all(
                canonical_domain(contract["scope"]["domain"])
                == canonical_domain(e.scope.domain)
                for e in full
            )
        ):
            binding["coverage"] = "VERIFIED_FOR_SCOPE"
            binding["evidence"] = [e.id for e in full]
            for obligation in active_obligations(store):
                obligation["state"] = "VERIFIED_FOR_SCOPE"
                obligation["evidence"] = binding["evidence"]


def candidate_gap_summary(store, candidate):
    contract = current(store)
    if not contract:
        return []
    row = store.control["goal_closure"]["candidate_bindings"].get(candidate.id)
    if not row or row["contract"] != contract["id"]:
        return ["candidate requires current contract rebinding"]
    if row["coverage"] == "VERIFIED_FOR_SCOPE":
        from .verification import exact_goal_coverage

        if exact_goal_coverage(store, candidate):
            return []
    return [o["target"] + ": " + o["property"] for o in active_obligations(store)]
