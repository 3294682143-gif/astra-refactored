"""Explicit mathematical branches, bounded source checks and controlled unions."""

from __future__ import annotations

import re
from dataclasses import asdict
from fractions import Fraction

from .content_fields import fields
from .domain import Artifact, Evidence, Scope
from .goal_contracts import canonical_domain, current, source_domain_notation
from .runtime.config import fingerprint

BRANCH_LABELS = (
    "BRANCH",
    "BRANCH_DOMAIN",
    "PARAMETERS",
    "BRANCH_CONDITIONS",
    "BRANCH_TARGET",
)
BRANCH_HINT = (
    "\nPreserve newly found objects with explicit repeated fields inside RESULT: "
    "BRANCH: one object or one parameterized family; BRANCH_DOMAIN: exact domain; "
    "PARAMETERS: parameter constraints or NONE; BRANCH_CONDITIONS: case conditions or NONE; "
    "BRANCH_TARGET: the exact target being addressed. Do not claim these are all solutions without a necessity proof. "
    "Do not split an object merely at punctuation. If extraction is uncertain preserve the mathematics and state the gap."
)


def extract_branches(store, artifact, text, material):
    contract = current(store)
    if not contract or not artifact.closed or len(text) > 64000:
        return ()
    entries = fields(
        text,
        [
            *BRANCH_LABELS,
            "ANSWER",
            "BASIS",
            "GAPS",
            "NEXT",
            "COVERAGE",
            "FINDING",
            "CHECK",
            "UNCOVERED",
        ],
    )
    result = []
    starts = [i for i, (k, _) in enumerate(entries) if k == "BRANCH"]
    if len(starts) > 16:
        return ()
    state = store.control["goal_closure"]
    for i, start in enumerate(starts):
        stop = starts[i + 1] if i + 1 < len(starts) else len(entries)
        data, duplicate = {}, False
        for key, value in entries[start:stop]:
            if key in BRANCH_LABELS:
                duplicate |= key in data
                data[key] = value
        if (
            duplicate
            or set(data) != set(BRANCH_LABELS)
            or any(not v or len(v) > 4000 for v in data.values())
            or data["BRANCH_TARGET"] not in contract["targets"]
        ):
            key = fingerprint(
                (contract["id"], artifact.digest, material, data, duplicate)
            )
            pending = state.setdefault("unbound_branch_proposals", {})
            if key not in pending:
                pending[key] = {
                    "id": key,
                    "contract": contract["id"],
                    "artifact": artifact.id,
                    "artifact_hash": artifact.digest,
                    "material": material,
                    "proposal": data,
                    "state": "BINDING_REQUIRED",
                    "reason": "ambiguous_or_incomplete_branch"
                    if duplicate or set(data) != set(BRANCH_LABELS)
                    else "target_not_in_current_contract",
                }
                store.event(
                    "branch_binding_required",
                    proposal=key,
                    reason=pending[key]["reason"],
                )
            continue
        domain = source_domain_notation(data["BRANCH_DOMAIN"], store.problem.raw)
        if canonical_domain(domain) == canonical_domain(contract["scope"]["domain"]):
            domain = contract["scope"]["domain"]
        row = {
            "problem": store.problem.digest,
            "contract": contract["id"],
            "target": data["BRANCH_TARGET"],
            "object": data["BRANCH"],
            "domain": domain,
            "parameters": data["PARAMETERS"],
            "conditions": data["BRANCH_CONDITIONS"],
            "route": artifact.route,
            "artifact": artifact.id,
            "artifact_hash": artifact.digest,
            "material": material,
            "unverified_dependencies": list(artifact.unverified_dependencies),
        }
        key = fingerprint(row)
        row.update(id=key, membership="CHECK_PENDING", evidence=[], check_artifact=None)
        if key not in state["branches"]:
            state["branches"][key] = row
            store.event("branch_registered", branch=row, truth_authority=False)
        result.append(state["branches"][key])
    return tuple(result)


def canonical_function_object(operation):
    """Canonicalize only the closed rational-polynomial grammar already compiled."""
    from .output_checks.algebraic import poly

    args = operation.arguments
    terms = poly(args["expression"], [args["argument"]])
    variable = "x" if args["function"] != "x" else "t"
    parts = [
        f"({coefficient})" + (f"*{variable}**{powers[0]}" if powers[0] else "")
        for powers, coefficient in sorted(terms.items(), reverse=True)
        if coefficient
    ]
    return args["function"] + "(" + variable + ")=" + ("+".join(parts) or "0")


def project_function_objects(store, artifact, text, material):
    """Quoted polynomial objects are proposals, even if their surrounding proof is wrong."""
    from .math_source import compile_candidate

    contract = current(store)
    if (
        not artifact.closed
        or len(text) > 64000
        or not contract
        or not contract.get("usable", False)
        or contract["kind"] != "ALL_SOLUTIONS"
        or len(contract["targets"]) != 1
    ):
        return ()
    fragments = re.finditer(
        r"\$\$(?P<display>[^$]{1,2000})\$\$"
        r"|\$(?!\$)(?P<inline>[^$\n]{1,2000})\$"
        r"|\\\((?P<paren>.{1,2000}?)\\\)",
        text,
    )
    objects = {}
    for match in fragments:
        fragment = next(
            value for value in match.groupdict().values() if value is not None
        )
        if not re.match(r"\s*[A-Za-z]\s*\(\s*[A-Za-z]\s*\)\s*=", fragment):
            continue
        plan = compile_candidate(store.problem.raw, fragment)
        if plan is None or plan.property != "source_function_satisfaction":
            continue
        for operation in plan.checks:
            obj = canonical_function_object(operation)
            objects.setdefault(obj, fragment)
        if len(objects) >= 16:
            break
    result = []
    for obj, fragment in list(objects.items())[:16]:
        projected = (
            f"BRANCH: {obj}; BRANCH_DOMAIN: {contract['scope']['domain']}; "
            "PARAMETERS: NONE; BRANCH_CONDITIONS: NONE; BRANCH_TARGET: "
            + contract["targets"][0]
        )
        branches = extract_branches(store, artifact, projected, material)
        result.extend(branches)
        if branches:
            store.event(
                "inline_member_proposal",
                artifact=artifact.id,
                source_fragment=fragment,
                object=obj,
                branch=branches[0]["id"],
                truth_authority=False,
            )
    return tuple(result)


def rational_root_check(raw, obj):
    """Two implementations must agree; only exact original polynomial grammar."""
    import sympy as sp

    from .expressions import safe_expr
    from .output_checks.expressions import poly_value, polynomial
    from .verification import root_equation

    equation = root_equation(raw)
    literal = re.fullmatch(
        r"(?:x\s*=\s*)?([+-]?\d{1,30}(?:/[1-9]\d{0,29})?)", obj.strip()
    )
    if not equation or not literal or len(equation) > 500:
        return None
    try:
        value = Fraction(literal[1])
        left, right = equation.split("=")
        a, b = polynomial(left, ["x"]), polynomial(right, ["x"])
        residual = poly_value(a, (value,)) - poly_value(b, (value,))
        x = sp.Symbol("x", real=True)
        p = sp.Poly(
            safe_expr(left, polynomial_only=True)
            - safe_expr(right, polynomial_only=True),
            x,
        )
        if not 1 <= p.degree() <= 4:
            return None
        production = p.eval(sp.Rational(value.numerator, value.denominator))
        if production != sp.Rational(residual.numerator, residual.denominator):
            return None
        return {
            "equation": equation,
            "value": str(value),
            "residual": str(residual),
            "outcome": "SUPPORTS" if residual == 0 else "REFUTES",
        }
    except (ValueError, TypeError, SyntaxError, ZeroDivisionError):
        return None


def checked_branch(store, branch):
    """Never trust serialized membership bits without their original binding."""
    contract = current(store)
    identity = {
        k: v
        for k, v in branch.items()
        if k
        not in {"id", "membership", "evidence", "check_artifact", "canonical_object"}
    }
    if fingerprint(identity) != branch.get("id"):
        return None
    artifact = store.artifacts.get(branch.get("artifact"))
    if (
        not contract
        or branch.get("contract") != contract["id"]
        or not artifact
        or (
            artifact.digest != branch.get("artifact_hash")
            or branch["domain"] != contract["scope"]["domain"]
            or branch["parameters"] != "NONE"
            or branch["conditions"] != "NONE"
        )
    ):
        return None
    surrogate = store.artifacts.get(branch.get("check_artifact"))
    if (
        not surrogate
        or surrogate.text != branch["object"]
        or surrogate.problem != store.problem.digest
    ):
        return None
    for eid in branch.get("evidence", []):
        evidence = store.evidence.get(eid)
        if (
            not evidence
            or evidence.artifact_id != surrogate.id
            or evidence.artifact_hash != surrogate.digest
        ):
            continue
        if (
            evidence.outcome == "SUPPORTS"
            and "canonical_object" in branch
            and branch["canonical_object"]
            != fingerprint(_member_identity(store, branch, evidence))
        ):
            continue
        if (
            evidence.checker == "goal_branch_rational_v1"
            and canonical_domain(branch["domain"]) == "real"
            and evidence.checker_version == "1"
            and evidence.property == "branch_membership"
            and evidence.scope == Scope(domain="real")
            and evidence.obligations == ("membership",)
            and evidence.kind
            == (
                "EXACT_CHECK"
                if evidence.outcome == "SUPPORTS"
                else "EXACT_COUNTEREXAMPLE"
            )
        ):
            result = rational_root_check(store.problem.raw, branch["object"])
            if (
                result
                and fingerprint((branch["id"], result)) == evidence.input_hash
                and result["outcome"] == evidence.outcome
            ):
                return evidence
        elif evidence.property == "source_function_satisfaction":
            from .math_source import compile_candidate
            from .source_verification import (
                _checked_values,
                _outcome,
                _statement,
                receipt_key,
            )
            from .verification import VerificationEngine

            plan = compile_candidate(store.problem.raw, branch["object"])
            if plan and canonical_domain(branch["domain"]) == plan.domain:
                receipt = store.control.get("source_check_receipts", {}).get(
                    receipt_key(surrogate, plan, VerificationEngine.version)
                )
                values = _checked_values(plan, receipt)
                if (
                    values is not None
                    and evidence.checker == "registered_exact_checker"
                    and evidence.input_hash == plan.digest
                    and evidence.scope == Scope(domain=plan.domain)
                    and evidence.verified_statement
                    == _statement(plan, values, evidence.outcome == "SUPPORTS")
                    and evidence.checker_version == VerificationEngine.version
                    and (
                        ("SUPPORTS" if _outcome(plan, values) else "REFUTES")
                        == evidence.outcome
                    )
                ):
                    return evidence
    return None


def check_branch(store, branch_id, verifier):
    # Register intent under lock, execute outside; adopt only the same live version.
    with store.lock:
        state, contract = store.control["goal_closure"], current(store)
        branch = state["branches"][branch_id]
        if (
            store.control.get("goal_closure_closed")
            or branch["contract"] != contract["id"]
            or branch["membership"] != "CHECK_PENDING"
        ):
            return checked_branch(store, branch)
        branch["membership"] = "UNKNOWN"
        if (
            branch["domain"] != contract["scope"]["domain"]
            or branch["parameters"] != "NONE"
            or branch["conditions"] != "NONE"
        ):
            return None
        artifact = Artifact(
            "branch-check-" + branch_id,
            store.problem.digest,
            branch["route"],
            "branch-check-" + branch_id,
            branch["object"],
            "controller_source_branch",
            Scope(),
            (),
            (),
            True,
        )
        store.append(artifact)
        branch["check_artifact"] = artifact.id
        revision = contract["id"]
    if verifier.clock() >= verifier.deadline():
        return None
    result = rational_root_check(store.problem.raw, branch["object"])
    evidence = None
    if result:
        if canonical_domain(branch["domain"]) != "real":
            return None
        digest = fingerprint((branch_id, result))
        evidence = Evidence(
            "branch-evidence-" + digest,
            artifact.id,
            artifact.digest,
            "branch_membership",
            "goal_branch_rational_v1",
            "1",
            digest,
            Scope(domain="real"),
            result["outcome"],
            "EXACT_CHECK"
            if result["outcome"] == "SUPPORTS"
            else "EXACT_COUNTEREXAMPLE",
            ("membership",),
            "Original equation residual at "
            + result["value"]
            + " is "
            + result["residual"],
        )
    else:
        from .math_source import compile_candidate

        plan = compile_candidate(store.problem.raw, branch["object"])
        if (
            plan
            and plan.property == "source_function_satisfaction"
            and canonical_domain(branch["domain"]) == plan.domain
        ):
            evidence = verifier.check(
                store,
                artifact,
                goal=store.problem.raw,
                proposed=branch["object"],
                candidate=True,
            )
    with store.lock:
        if (
            current(store)["id"] != revision
            or store.control.get("goal_closure_closed")
            or verifier.clock() >= verifier.deadline()
        ):
            store.event("branch_check_late", branch=branch_id, adopted=False)
            return None
        if evidence:
            store.evidence[evidence.id] = evidence
            branch["evidence"] = [evidence.id]
            branch["membership"] = (
                "VERIFIED_FOR_SCOPE" if evidence.outcome == "SUPPORTS" else "EXCLUDED"
            )
            if evidence.outcome == "SUPPORTS":
                branch["canonical_object"] = fingerprint(
                    _member_identity(store, branch, evidence)
                )
                from .delivery_types import count_fact

                count_fact(
                    store,
                    "evidence_accepted",
                    branch["canonical_object"],
                    task=artifact.work_unit,
                    evidence=evidence.id,
                    scope=evidence.property,
                )
            store.event(
                "branch_checked",
                branch=branch_id,
                evidence=asdict(evidence),
                exhaustiveness_closed=False,
            )
        return evidence


def _member_identity(store, branch, evidence):
    obj = branch["object"]
    if evidence.property == "source_function_satisfaction":
        from .math_source import compile_candidate

        plan = compile_candidate(store.problem.raw, obj)
        if plan and len(plan.checks) == 1:
            obj = canonical_function_object(plan.checks[0])
    return (obj, branch["domain"], branch["parameters"], branch["conditions"])


def eligible_merge_branches(store, target):
    """Select a valid subset; excluded/unknown rows remain in the ledger."""
    with store.lock:
        contract = current(store)
        if not contract:
            return ()
        selected = {}
        for branch in store.control["goal_closure"]["branches"].values():
            if branch["target"] != target or branch["contract"] != contract["id"]:
                continue
            if branch["membership"] != "VERIFIED_FOR_SCOPE":
                continue
            evidence = checked_branch(store, branch)
            if evidence and evidence.outcome == "SUPPORTS":
                selected.setdefault(
                    _member_identity(store, branch, evidence), branch["id"]
                )
        # Repeated receipts cannot consume the distinct-object merge capacity.
        return tuple(selected.values())[:16]


def propose_merge(store, branch_ids, target):
    with store.lock:
        contract = current(store)
        if not contract or contract["kind"] not in {"ALL_SOLUTIONS", "MULTI_SELECT"}:
            return None
        rows = [
            store.control["goal_closure"]["branches"][key]
            for key in dict.fromkeys(branch_ids)
        ]
        if len(rows) < 2 or len(rows) > 16 or any(b["target"] != target for b in rows):
            return None
        checks = [checked_branch(store, b) for b in rows]
        if any(e is None or e.outcome != "SUPPORTS" for e in checks):
            return None
        # Independent source membership does not rely on provisional route assumptions.
        # Only bound rational-polynomial objects admit alpha normalization.
        # No casefold, semantic similarity, or guessed family containment.
        unique = {}
        for b, e in zip(rows, checks):
            unique.setdefault(_member_identity(store, b, e), (b, e))
        if len(unique) < 2:
            return None
        result = {
            "contract": contract["id"],
            "target": target,
            "branches": [b["id"] for b, _ in unique.values()],
            "evidence": [e.id for _, e in unique.values()],
            "objects": [b["object"] for b, _ in unique.values()],
            "coverage": "UNKNOWN",
            "candidate": None,
        }
        key = fingerprint((result["contract"], result["branches"], result["evidence"]))
        result["id"] = key
        return store.control["goal_closure"]["merges"].setdefault(key, result)
