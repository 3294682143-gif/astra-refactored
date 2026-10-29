"""Inspectable profiling and tool-model contracts, not semantic proof automation.

Reviews are supplied by a trusted host after actual independent/human review.
Matching quotations, hashes, or record fields cannot prove mathematical meaning.
"""

import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def profile_view(profile):
    return {key: profile.get(key) for key in
            ("problem_id", "original", "goal", "constraints", "ambiguities", "interpretation")}


def profile_digest(profile):
    return digest(profile_view(profile))


def mapping_digest(mapping):
    return digest({k: v for k, v in mapping.items()
                   if k not in {"profile_review_ref", "mapping_review_ref"}})


def candidate_digest(delivery):
    """Bind immutable mathematical content, not mutable completion/check flags."""
    return digest({key: value for key, value in delivery.items()
                   if key not in {"solution_status", "checks", "open_obligations"}})


def inspect_profile(profile):
    errors, warnings, ids, assumptions, unknowns = [], [], [], [], []
    if not isinstance(profile, dict):
        return {"record_status": "invalid", "errors": ["profile must be an object"],
                "semantic_correctness_automatically_proved": False}
    for key in ("problem_id", "original", "goal"):
        if not _text(profile.get(key)):
            errors.append("missing " + key)
    rows = profile.get("constraints")
    if not isinstance(rows, list) or not rows or len(rows) > 64:
        errors.append("constraints must be a nonempty bounded list")
        rows = []
    original = profile.get("original") if isinstance(profile.get("original"), str) else ""
    for row in rows:
        if not isinstance(row, dict):
            errors.append("constraint must be an object")
            continue
        cid, origin = row.get("id"), row.get("origin")
        if not _text(cid) or cid in ids:
            errors.append("missing or duplicate constraint identity")
        else:
            ids.append(cid)
        if not _text(row.get("statement")):
            errors.append("constraint statement required")
        if not isinstance(origin, str) or origin not in {"explicit", "derived", "assumption", "unknown"}:
            errors.append("invalid constraint origin")
        elif origin == "explicit":
            quote = row.get("source_quote")
            if not _text(quote) or quote not in original:
                errors.append("explicit condition lacks an exact source quotation")
        elif origin == "derived" and not _text(row.get("evidence_ref")):
            errors.append("derived condition lacks an evidence reference")
        elif origin == "assumption":
            assumptions.append(cid)
        elif origin == "unknown":
            unknowns.append(cid)
    ambiguities = profile.get("ambiguities", [])
    if not isinstance(ambiguities, list) or any(not _text(x) for x in ambiguities):
        errors.append("ambiguities must be a string list")
    if assumptions or unknowns or ambiguities:
        warnings.append("interpretation/conditions remain to be resolved or disclosed")
    return {"record_status": "valid" if not errors else "invalid",
            "errors": errors, "warnings": warnings, "constraint_ids": ids,
            "assumption_ids": assumptions, "unknown_ids": unknowns,
            "semantic_correctness_automatically_proved": False,
            "scope": "record structure and quotation existence only; no entailment or completeness proof"}


def selection_record(profile, method_id):
    """Report supplied rationale without inventing mathematical support from tags."""
    constraints = profile.get("constraints", [])
    by_id = {row["id"]: row for row in constraints
             if isinstance(row, dict) and _text(row.get("id"))} if isinstance(constraints, list) else {}
    notes = profile.get("selection_notes", {})
    note = notes.get(method_id, {}) if isinstance(notes, dict) else {}
    if not isinstance(note, dict):
        note = {}
    supports = note.get("supports", [])
    if not isinstance(supports, list) or any(not _text(x) for x in supports):
        supports = []
    missing = [cid for cid in supports if cid not in by_id]
    supplied = (_text(note.get("why")) and _text(note.get("expected_step"))
                and bool(supports) and not missing)
    failures = profile.get("failure_evidence", [])
    failures = failures if isinstance(failures, list) else []
    triggers = [{key: item[key] for key in
                 ("obligation", "observation", "evidence_ref", "next_change")}
                for item in failures if isinstance(item, dict)
                and item.get("method_id") == method_id
                and all(_text(item.get(key)) for key in
                        ("obligation", "observation", "evidence_ref", "next_change"))]
    return {"rationale_status": "supplied_not_semantically_verified" if supplied else "missing_or_incomplete",
            "supporting_constraints": supports, "unknown_constraint_refs": missing,
            "why": note.get("why") if _text(note.get("why")) else None,
            "expected_step": note.get("expected_step") if _text(note.get("expected_step")) else None,
            "unconfirmed_preconditions": note.get("unconfirmed", []),
            "failure_triggers": triggers,
            "failure_semantics_independently_verified": False,
            "semantic_correctness_automatically_proved": False}


# Features implemented by the existing fixed operations. A feature name is not
# a semantic interpretation of a quoted condition; the review still must check it.
FEATURE_ARGUMENTS = {
    "exact": {"rational_expression": {"expression"}},
    "mod_pow": {"integer_base": {"base"}, "nonnegative_exponent": {"exponent"}, "modulus": {"modulus"}},
    "crt": {"congruence_system": {"residues", "moduli"}},
    "roots_unity": {"canonical_residue_domain": {"modulus"}, "square_equals_one": {"modulus"}},
    "binary_strings": {
        "binary_alphabet": set(), "fixed_length": {"length"}, "no_adjacent_ones": set(),
        "ones_congruence": {"ones_modulus", "residue"}},
    "linear_solve": {"affine_equations": {"matrix", "rhs"}, "scalar_domain": {"domain"}},
}


def _review_ok(review, expected, required_flags):
    return (isinstance(review, dict)
            and all(review.get(k) == v for k, v in expected.items())
            and review.get("status") == "pass"
            and review.get("source") in ("independent_review", "human_review")
            and _text(review.get("reviewer"))
            and all(review.get(flag) is True for flag in required_flags))


def assess_mapping(profile, mapping, reviews, *, expected_problem=None,
                   expected_candidate=None, expected_request=None, expected_scope=None,
                   expected_candidate_digest=None):
    """Check coverage and trusted review binding for an equivalent full model.

Partial/diagnostic computations remain useful but are not certified here as the
original goal. Correctness of the trusted semantic reviews is not automated.
"""
    errors, pending = [], []
    profile_report = inspect_profile(profile)
    result_base = {"semantic_correctness_automatically_proved": False,
                   "scope": "record/coverage and host-reviewed mapping policy only",
                   "profile_record": profile_report}
    if profile_report["record_status"] != "valid":
        return {**result_base, "status": "unknown", "reasons": ["profile record incomplete"]}
    if not isinstance(mapping, dict) or not isinstance(reviews, dict):
        return {**result_base, "status": "unknown", "reasons": ["mapping/review ledger missing"]}
    try:
        p_hash = profile_digest(profile)
        m_hash = mapping_digest(mapping)
        request = mapping.get("request")
        if not isinstance(request, dict) or set(request) != {"op", "args"} or not isinstance(request.get("args"), dict):
            raise ValueError("mapping requires the full fixed-operation request")
        from math_tools import validate_request
        validate_request(request)
        op, args = request.get("op"), request["args"]
        if not isinstance(op, str) or op not in FEATURE_ARGUMENTS:
            raise ValueError("this mapping adapter supports only the six fixed operations")
        # Must match math_tools.request_hash; this is call binding, not semantics.
        request_hash = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":"),
                                                allow_nan=False).encode()).hexdigest()
        pid, cid = mapping.get("problem_id"), mapping.get("candidate_id")
        if pid != profile["problem_id"] or not _text(cid):
            errors.append("mapping problem/candidate identity mismatch")
        if expected_problem is not None and pid != expected_problem:
            errors.append("mapping belongs to another problem")
        if expected_candidate is not None and cid != expected_candidate:
            errors.append("mapping belongs to another candidate")
        content_hash = mapping.get("candidate_sha256")
        if (not isinstance(content_hash, str) or len(content_hash) != 64
                or any(c not in "0123456789abcdef" for c in content_hash)):
            errors.append("mapping lacks immutable candidate content identity")
        if expected_candidate_digest is not None and content_hash != expected_candidate_digest:
            errors.append("mapping candidate content differs from delivery")
        if expected_request is not None and request_hash != expected_request:
            errors.append("mapping request differs from actual tool receipt")
        if expected_scope is not None and mapping.get("target_scope") != expected_scope:
            errors.append("mapping target scope differs from obligation")
        for key in ("computed_subproblem", "target_scope", "forward_map", "reverse_map", "multiplicity"):
            if not _text(mapping.get(key)):
                errors.append("missing " + key)
        if mapping.get("relation") != "equivalent":
            pending.append("only a subproblem/diagnostic/one-directional relation has been claimed")
        if mapping.get("covers_all_cases") is not True:
            pending.append("full domain/case coverage remains open")
        remaining = mapping.get("remaining_obligations")
        if not isinstance(remaining, list) or any(not _text(x) for x in remaining):
            errors.append("remaining_obligations must be an explicit string list")
        elif remaining:
            pending.append("separate proof obligations remain")
        coverage = mapping.get("constraint_coverage")
        if not isinstance(coverage, list):
            raise ValueError("constraint coverage list required")
        expected_ids = set(profile_report["constraint_ids"])
        seen = set()
        for item in coverage:
            if not isinstance(item, dict):
                errors.append("malformed coverage item")
                continue
            condition = item.get("constraint_id")
            if not _text(condition) or condition in seen or condition not in expected_ids:
                errors.append("unknown/duplicate coverage condition")
                continue
            seen.add(condition)
            if not _text(item.get("justification")):
                errors.append("coverage justification missing")
            treatment = item.get("handling")
            if treatment == "encoded":
                feature, argument_refs = item.get("tool_feature"), item.get("argument_refs")
                if not isinstance(feature, str) or feature not in FEATURE_ARGUMENTS[op]:
                    errors.append("tool does not implement the claimed encoded feature")
                    continue
                required_args = FEATURE_ARGUMENTS[op][feature]
                if (not isinstance(argument_refs, list)
                        or any(not isinstance(x, str) for x in argument_refs)
                        or set(argument_refs) != required_args or not required_args <= args.keys()):
                    errors.append("encoded feature argument references are missing or incorrect")
            elif treatment in {"by_reduction", "irrelevant"}:
                # A text rationale is not a proof: the bound independent mapping
                # review below must actually assess the reduction/irrelevance.
                pass
            elif treatment == "deferred":
                pending.append("constraint deferred: " + condition)
            else:
                errors.append("invalid constraint handling")
        omitted = sorted(expected_ids-seen)
        if omitted:
            errors.append("original constraints omitted: " + ",".join(omitted))
        profile_ref, mapping_ref = mapping.get("profile_review_ref"), mapping.get("mapping_review_ref")
        profile_review = reviews.get(profile_ref) if isinstance(profile_ref, str) else None
        mapping_review = reviews.get(mapping_ref) if isinstance(mapping_ref, str) else None
        if not _review_ok(profile_review,
                          {"kind": "profile_review", "problem_id": pid, "profile_sha256": p_hash},
                          ["constraint_inventory_complete"]):
            pending.append("independent original-problem profile review missing/mismatched")
        if profile_report["assumption_ids"] or profile_report["unknown_ids"] or profile.get("ambiguities"):
            pending.append("profile still has assumptions, unknown conditions or ambiguities")
        if not _review_ok(mapping_review,
                          {"kind": "mapping_review", "problem_id": pid, "candidate_id": cid,
                           "candidate_sha256": content_hash,
                           "profile_sha256": p_hash, "mapping_sha256": m_hash,
                           "request_sha256": request_hash},
                          ["forward_checked", "reverse_checked", "multiplicity_checked",
                           "domain_coverage_checked", "output_correspondence_checked"]):
            pending.append("independent mapping review missing/mismatched")
        return {**result_base, "status": "pass" if not errors and not pending else "unknown",
                "reasons": errors+pending, "omitted_constraints": omitted,
                "request_sha256": request_hash, "mapping_sha256": m_hash,
                "review_scope": "trusted human/independent reviews; no automatic semantic proof"}
    except (ValueError, SyntaxError, TypeError, KeyError, RecursionError, OverflowError) as exc:
        return {**result_base, "status": "unknown", "reasons": [type(exc).__name__ + ": " + str(exc)]}
