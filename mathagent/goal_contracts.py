"""First-read working contracts. Adoption is interpretation, never proof."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, replace

from .domain import Scope
from .runtime.config import fingerprint

KINDS = frozenset(
    {
        "VALUE",
        "ONE_WITNESS",
        "ALL_SOLUTIONS",
        "COUNT",
        "OPTIMIZE",
        "PROVE",
        "MULTI_SELECT",
        "MULTIPART",
        "UNKNOWN",
    }
)
LABELS = (
    "TARGET_KIND",
    "TARGETS",
    "SOURCE",
    "SOURCE_REF",
    "DOMAIN",
    "QUANTIFIERS",
    "CONDITIONS",
    "OBLIGATIONS",
    "UNCERTAINTIES",
)


def canonical_domain(value):
    """Explicit domain-name aliases only; never infer mathematical scope inclusion."""
    aliases = {
        "real": {
            "real",
            "real numbers",
            "the real numbers",
            "R",
            "ℝ",
            r"\mathbb{R}",
            "实数",
            "实数域",
        },
        "complex": {
            "complex",
            "complex numbers",
            "C",
            "ℂ",
            r"\mathbb{C}",
            "复数",
            "复数域",
        },
        "rational": {"rational", "rational numbers", "Q", "ℚ", r"\mathbb{Q}", "有理数"},
    }
    text = value.strip().removesuffix(".").removesuffix("。")
    return next((key for key, names in aliases.items() if text in names), None)


@dataclass(frozen=True)
class ContractProposal:
    kind: str = "UNKNOWN"
    targets: tuple[str, ...] = ()
    source: str = ""
    domain: str = "unspecified"
    quantifiers: tuple[str, ...] = ()
    conditions: tuple[str, ...] = ()
    obligations: tuple[str, ...] = ()
    uncertainties: tuple[str, ...] = ()
    field_errors: tuple[tuple[str, str], ...] = ()
    normalizations: tuple[str, ...] = ()


def parse_proposal(entries):
    data, ambiguous, errors, normalized = {}, [], [], []
    for key, value in entries:
        if key not in LABELS:
            continue
        if key in data and data[key] == value:
            normalized.append("identical_duplicate_" + key)
            continue
        if key in data or len(value) > 4000:
            ambiguous.append("ambiguous or oversized " + key)
            errors.append((key, "ambiguous or oversized field"))
        else:
            data[key] = value
    kind = data.get("TARGET_KIND", "UNKNOWN")
    token = re.fullmatch(r"([A-Za-z_]+)[.。]?", kind.strip())
    if token and token[1].upper() in KINDS:
        canonical = token[1].upper()
        if canonical != kind:
            normalized.append("target_kind_token")
        kind = canonical
    # A known literal field alias seen in real PLANs, not free-form extraction.
    alias = re.fullmatch(
        r"([A-Za-z_]+)\s*:\s*source goals\s*:\s*(.+)", kind, re.IGNORECASE
    )
    if alias and alias[1].upper() in KINDS and "TARGETS" not in data:
        kind, data["TARGETS"] = alias[1].upper(), alias[2]
        normalized.append("source_goals_field_alias")
    if kind not in KINDS:
        ambiguous.append("unrecognized target kind: " + kind[:80])
        errors.append(("TARGET_KIND", "unrecognized target kind"))
        kind = "UNKNOWN"
    # Pipes delimit explicitly named goals, never mathematical solution objects.
    targets = tuple(
        v.strip() for v in data.get("TARGETS", "").split(" | ") if v.strip()
    )
    if len(targets) > 16:
        targets = ()
        ambiguous.append("too many target labels")
        errors.append(("TARGETS", "too many target labels"))
    uncertainty = data.get("UNCERTAINTIES", "")
    if re.fullmatch(r"NONE[.。]?", uncertainty.strip(), re.IGNORECASE):
        if uncertainty != "NONE":
            normalized.append("uncertainty_none_token")
        uncertainty = ""
    return ContractProposal(
        kind,
        targets,
        data.get("SOURCE", ""),
        data.get("DOMAIN", "unspecified"),
        (data["QUANTIFIERS"],) if data.get("QUANTIFIERS") else (),
        (data["CONDITIONS"],) if data.get("CONDITIONS") else (),
        (data["OBLIGATIONS"],) if data.get("OBLIGATIONS") else (),
        tuple(ambiguous) + ((uncertainty,) if uncertainty else ()),
        tuple(errors),
        tuple(normalized),
    )


def contract_fields(text):
    """Read the explicit contract block, not similarly named CARD prose."""
    from .content_fields import fields

    entries = fields(
        text,
        ["CARD", "FIELDS", "WIDTH", r"ROUTE\s+[1-3]", "TASK", *LABELS],
        adjacent_labels=LABELS,
    )
    start = next(
        (i for i, (key, _) in enumerate(entries) if key == "TARGET_KIND"), None
    )
    if start is None:
        return () if any(key == "CARD" for key, _ in entries) else entries
    return entries[start:]


def prepare_proposal(proposal, source):
    """The controller owns source provenance; model quotations have no authority."""
    domain = source_domain_notation(proposal.domain, source)
    if domain != proposal.domain:
        proposal = replace(
            proposal,
            domain=domain,
            normalizations=proposal.normalizations
            + ("source_bound_function_domain_notation",),
        )
    if (
        proposal.kind in KINDS - {"UNKNOWN", "MULTIPART"}
        and not proposal.targets
        and not any(key == "TARGETS" for key, _ in proposal.field_errors)
    ):
        proposal = replace(
            proposal,
            targets=("Original problem",),
            normalizations=proposal.normalizations
            + ("target_bound_to_original_problem",),
        )
    return proposal


def source_domain_notation(value, source):
    """Interpret a total R->R/C->C declaration only when the source has that domain."""
    text = value.strip().removesuffix(".").removesuffix("。")
    aliases = {"R": "real", "ℝ": "real", "C": "complex", "ℂ": "complex"}
    match = re.fullmatch(r"(?:[A-Za-z]\s*:\s*)?([RCℝℂ])\s*(?:->|→|\\to)\s*\1", text)
    if not match:
        return value
    letter = "R" if aliases[match[1]] == "real" else "C"
    symbol = "ℝ" if letter == "R" else "ℂ"
    domain = rf"(?:{letter}|{symbol}|\\mathbb\s*\{{{letter}\}})"
    if re.search(
        rf"[A-Za-z]\s*:\s*{domain}\s*(?:->|→|\\to|\\rightarrow)\s*{domain}"
        r"(?=\s*(?:such\s+that|satisfying|[.,;$]|\\\)|\\\]|$))",
        source,
    ):
        return aliases[match[1]]
    return value


def source_grammar_fallback(proposal, source):
    """Only existing whole-source grammars may supply a missing legacy contract."""
    if proposal.kind != "UNKNOWN" or proposal.field_errors or proposal.targets:
        return prepare_proposal(proposal, source)
    from .tool_mapping import odd_part_goal
    from .verification import arithmetic_goal, root_equation

    if root_equation(source):
        kind, domain, quantifier = "ALL_SOLUTIONS", "real", "all real roots"
    elif arithmetic_goal(source) is not None:
        kind, domain, quantifier = "VALUE", "rational", "the specified arithmetic value"
    elif odd_part_goal(source) is not None or re.fullmatch(
        r"Find the odd part of [1-9]\d*[.]?", source.strip(), re.IGNORECASE
    ):
        kind, domain, quantifier = "VALUE", "positive_integer", "the specified integer"
    else:
        return prepare_proposal(proposal, source)
    return ContractProposal(
        kind,
        (source,),
        "",
        domain,
        (quantifier,),
        (source,),
        normalizations=("controller_existing_source_grammar",),
    )


def proposal_issues(proposal, source=""):
    issues = dict(proposal.field_errors)
    if proposal.kind == "UNKNOWN":
        issues.setdefault("TARGET_KIND", "target kind missing or unknown")
    if not proposal.targets:
        issues.setdefault("TARGETS", "explicit target or subtargets missing")
    if proposal.domain.strip().casefold() in {
        "",
        "unknown",
        "unspecified",
        "none",
        "none.",
    }:
        issues.setdefault("DOMAIN", "domain missing")
    if not proposal.quantifiers:
        issues.setdefault("QUANTIFIERS", "quantifiers missing")
    # Only an explicit objective directive; no keyword guessing from a lemma.
    objective = re.search(
        r"\b(?:find|determine)\s+(?:the\s+)?(?:minimum|maximum|smallest|largest|least|greatest)\b"
        r"|求(?:出)?(?:.{0,12}的)?最[大小]值",
        source,
        re.IGNORECASE,
    )
    if objective and proposal.kind == "VALUE":
        issues["TARGET_KIND"] = (
            "source explicitly requests an optimum, not only a scalar value"
        )
    all_objects = re.search(
        r"\b(?:find|determine)\s+all\s+(?:(?:possible|real|complex)\s+)?(?:functions?|solutions?|roots?|values?)\b"
        r"|求(?:出)?所有(?:.{0,8})解",
        source,
        re.IGNORECASE,
    )
    if all_objects and proposal.kind not in {"ALL_SOLUTIONS", "MULTIPART", "UNKNOWN"}:
        issues["TARGET_KIND"] = (
            "source explicitly requests all objects, not a single value or witness"
        )
    if proposal.uncertainties:
        issues.setdefault("INTERPRETATION", "; ".join(proposal.uncertainties))
    return issues


def render_proposal(proposal, source):
    proposal = prepare_proposal(proposal, source)
    issues = proposal_issues(proposal, source)
    return (
        "\nCONTROLLER_PARSED_WORKING_CONTRACT (interpretation, not proof):\n"
        f"TARGET_KIND: {proposal.kind}\nTARGETS: {' | '.join(proposal.targets) or 'MISSING'}\n"
        f"DOMAIN: {proposal.domain}\nQUANTIFIERS: {'; '.join(proposal.quantifiers) or 'MISSING'}\n"
        f"CONDITIONS: {'; '.join(proposal.conditions) or 'original source conditions retained'}\n"
        "SOURCE_BINDING: the complete SOURCE_PROBLEM is retained by the controller; "
        "a model quotation is not a provenance or semantic certificate.\n"
        f"FIELD_GAPS: {issues or 'NONE'}\n"
        "Review this exact parsed structure against the source, not only the CARD prose. "
        "In particular distinguish an optimum from an answer that happens to be a number. "
        "Identify wrong or missing fields explicitly; method doubts are separate from target interpretation."
    )


def restore_proposal(data):
    data = dict(data or {})
    for key in (
        "targets",
        "quantifiers",
        "conditions",
        "obligations",
        "uncertainties",
        "normalizations",
    ):
        if key in data:
            data[key] = tuple(data[key])
    if "field_errors" in data:
        data["field_errors"] = tuple(tuple(row) for row in data["field_errors"])
    return ContractProposal(**data)


def current(store):
    state = store.control.get("goal_closure", {})
    return state.get("contracts", {}).get(state.get("current_contract"))


def adopt_contract(
    store,
    proposal,
    reports,
    *,
    reason="initial PLAN and R0",
    parent=None,
    required_roles=None,
):
    from .goal_ledger import initialize_obligations
    from .review import ROLES, material_conflict

    with store.lock:
        if store.control.get("goal_closure_closed"):
            raise ValueError("cannot revise a closed problem")
        previous = current(store)
        if parent != (previous["id"] if previous else None):
            raise ValueError("contract parent mismatch")
        proposal = prepare_proposal(proposal, store.problem.raw)
        gaps = proposal_issues(proposal, store.problem.raw)
        uncertainties = list(proposal.uncertainties)
        reviewed = {
            r.role
            for r in reports
            if r
            and r.complete
            and r.interpretation not in {"UNKNOWN", "PARTIAL_REVIEW"}
        }
        expected_roles = set(ROLES) if required_roles is None else set(required_roles)
        if required_roles is not None and (
            parent is None or expected_roles != {"meaning"}
        ):
            raise ValueError(
                "only explicit contract revisions may use a targeted meaning review"
            )
        missing_roles = sorted(expected_roles - reviewed)
        if "meaning" in missing_roles:
            gaps["MEANING_REVIEW"] = "meaning review missing or incomplete"
        meaning_doubts = any(
            r and r.role == "meaning" and (r.findings or r.uncovered) for r in reports
        )
        if meaning_doubts:
            gaps["MEANING_REVIEW"] = "source interpretation requires a targeted check"
        route_doubts = [
            r.role
            for r in reports
            if r and r.role != "meaning" and (r.findings or r.uncovered)
        ]
        if material_conflict(reports):
            route_doubts.append("initial_applicability_conflict")
        uncertainties = list(dict.fromkeys(uncertainties + list(gaps.values())))
        accepted = not gaps
        row = {
            "problem": store.problem.digest,
            "parent": parent,
            "proposal": asdict(proposal),
            # Preserve understood fields while keeping action-specific readiness
            # separate. A method doubt cannot erase an explicit ALL_SOLUTIONS.
            "kind": proposal.kind,
            "targets": list(proposal.targets),
            "scope": asdict(
                Scope(proposal.conditions, proposal.domain, proposal.quantifiers)
            ),
            "uncertainties": uncertainties,
            "reason": reason,
            "review_sources": [r.raw for r in reports if r],
            "adoption": "WORKING_CONSTRAINT" if accepted else "NEEDS_CLARIFICATION",
            "field_gaps": gaps,
            "usable": accepted,
            "route_uncertainties": sorted(set(route_doubts + missing_roles)),
            "source_binding": {
                "kind": "controller_original_problem",
                "source_hash": store.problem.digest,
                "model_excerpt_verbatim": bool(
                    proposal.source and proposal.source in store.problem.raw
                ),
            },
        }
        row["id"] = fingerprint(row)
        state = store.control.setdefault(
            "goal_closure",
            {
                "schema": "goal-closure-state-v1",
                "contracts": {},
                "obligations": {},
                "branches": {},
                "materials": {},
                "candidate_bindings": {},
                "merges": {},
                "claims": {},
                "review_tasks": {},
                "scheduler": {},
            },
        )
        state["contracts"][row["id"]] = row
        state["current_contract"] = row["id"]
        store.problem = replace(
            store.problem,
            goals=proposal.targets,
            scope=Scope(proposal.conditions, proposal.domain, proposal.quantifiers),
            answer_shape=row["kind"],
            uncertainties=tuple(uncertainties),
        )
        initialize_obligations(store, row)
        if previous:
            for obligation in state["obligations"].values():
                if obligation["contract"] != row["id"]:
                    obligation["state"] = "PAUSED"
            for route in list(store.control.get("routes_finished", {})):
                store.control["routes_finished"].pop(route, None)
            for job in state["scheduler"].get("jobs", {}).values():
                if job["contract"] != row["id"] and job["task"] in store.tasks.nodes:
                    store.tasks.update(job["task"], state="PAUSED")
        store.event(
            "contract_adopted", contract=row, mathematical_truth_not_assigned=True
        )
        return row


def render_contract(store):
    contract = current(store)
    if not contract:
        return ""
    scope = contract["scope"]
    return (
        "\nWorking interpretation (not a proof): "
        + contract["kind"]
        + "\nTargets: "
        + " | ".join(contract["targets"])
        + "\nDomain: "
        + scope["domain"]
        + "\nQuantifiers: "
        + "; ".join(scope["quantifiers"])
        + "\nConditions: "
        + "; ".join(scope["conditions"])
        + "\nUncertainties: "
        + "; ".join(contract["uncertainties"])
        + "\nField readiness gaps: "
        + str(contract.get("field_gaps", {}))
        + "\nCheck membership and exhaustive coverage separately. A completed task or NO_ISSUE does not close a mathematical obligation."
    )


def restore_contract(store):
    state = store.control.get("goal_closure")
    if state is None:
        return
    if state.get("schema") != "goal-closure-state-v1":
        raise ValueError("unsupported goal closure snapshot")
    for key, row in state.get("contracts", {}).items():
        if (
            row.get("id") != key
            or row.get("problem") != store.problem.digest
            or fingerprint({k: v for k, v in row.items() if k != "id"}) != key
            or row.get("kind") not in KINDS
        ):
            raise ValueError("invalid contract snapshot")
        if row["parent"] is not None and row["parent"] not in state["contracts"]:
            raise ValueError("missing contract parent")
    contract = current(store)
    if contract is None:
        raise ValueError("missing adopted contract")
    scope = contract["scope"]
    store.problem = replace(
        store.problem,
        goals=tuple(contract["targets"]),
        scope=Scope(
            tuple(scope["conditions"]), scope["domain"], tuple(scope["quantifiers"])
        ),
        answer_shape=contract["kind"],
        uncertainties=tuple(contract["uncertainties"]),
    )
