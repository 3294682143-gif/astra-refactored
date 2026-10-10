"""Narrow oracle-free checks. Unsupported mathematics remains provisional.

The pipeline follows the source Parser/Enumerator/D0/Soundness/Completion design.
No experiment runner, expected answer, model verdict, or self_check marker is used.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

import sympy as sp

from .answer_contracts import math_problem_text
from .check_templates import (
    TemplateTask,
    enumerate_templates,
    evaluate_assertion,
    rational,
)
from .domain import Artifact, CandidateRevision, Evidence, Scope, WorkUnit
from .expressions import safe_expr
from .runtime.config import fingerprint
from .store import ArtifactStore
from .tool_mapping import has_mapped_ancestor, odd_part_goal


@dataclass(frozen=True)
class CheckBinding:
    artifact: str
    artifact_hash: str
    property: str
    expression: str
    proposed: str
    obligations: tuple[str, ...]
    scope: Scope
    template: TemplateTask | None = None


def root_equation(problem: str) -> str | None:
    """Only exact declared grammar; do not silently drop extra problem conditions."""
    patterns = (
        r"Solve\s+([x\d\s+*/^()=.-]+)\s+over (?:the )?real numbers\.?",
        r"求(?:方程)?\s*([x\d\s+*/^()=.-]+)\s*的所有实数解[。.]?",
    )
    for pattern in patterns:
        m = re.fullmatch(pattern, math_problem_text(problem), re.IGNORECASE)
        if m and m[1].count("=") == 1:
            return m[1].strip()
    return None


def arithmetic_goal(goal: str):
    m = re.fullmatch(
        r"(?:Compute|Calculate|Evaluate|计算)\s+([\d\s+*/^()-]+)"
        r"(?:\s+and state the result as an integer)?"
        r"(?:;\s*completion criterion:\s*a single integer value is produced)?[。.]*",
        math_problem_text(goal),
        re.IGNORECASE,
    )
    if not m:
        return None
    expression = m[1].strip()
    if "as an integer" in goal.lower():
        try:
            if safe_expr(expression).is_integer is not True:
                return None
        except (ValueError, SyntaxError, TypeError):
            return None
    return expression


def candidates(text: str):
    payload = text.strip()
    if payload.startswith("\\boxed{") and payload.endswith("}"):
        payload = payload[7:-1]
    payload = payload.strip("{} ").replace("x=", "").replace("x =", "")
    parts = re.split(r"[,，]", payload)
    if not parts or len(parts) > 8:
        raise ValueError("unsupported candidate set")
    values = tuple(
        rational(part)
        if re.fullmatch(r"[+-]?\d{1,77}", part.strip())
        else safe_expr(part, constants_only=True)
        for part in parts
    )
    if any(x.free_symbols or x.is_real is not True for x in values):
        raise ValueError("candidate must contain explicit real values")
    return values


class VerificationEngine:
    version = "exact-bounded-v8-computation-contracts"

    def __init__(
        self, executor=None, *, clock=time.monotonic, deadline=None, persist=None
    ):
        self.executor = executor
        self.clock = clock
        self.deadline = deadline or (lambda: self.clock() + 5)
        self.persist = persist or (lambda: None)

    def enumerate(
        self,
        store: ArtifactStore,
        artifact: Artifact,
        *,
        goal: str,
        proposed: str,
        candidate=False,
        unit: WorkUnit | None = None,
    ) -> tuple[CheckBinding, ...]:
        if unit is not None and (
            unit.id != artifact.work_unit
            or unit.route != artifact.route
            or unit.dependencies != artifact.dependencies
            or unit.scope != artifact.scope
            or unit.goal != goal
            or (not candidate and proposed != artifact.text)
        ):
            return ()
        if not candidate and unit is not None:
            tasks = enumerate_templates(goal)
            if tasks:
                return tuple(
                    CheckBinding(
                        artifact.id,
                        artifact.digest,
                        task.property,
                        goal,
                        proposed,
                        (task.obligation,),
                        Scope(
                            conditions=artifact.scope.conditions,
                            domain=task.domain,
                            quantifiers=artifact.scope.quantifiers,
                        ),
                        task,
                    )
                    for task in tasks
                    if unit.scope.domain in {"unspecified", task.domain}
                )
        expression = (
            root_equation(store.problem.raw) if candidate else arithmetic_goal(goal)
        )
        original_arithmetic = arithmetic_goal(store.problem.raw) if candidate else None
        if expression is None and original_arithmetic is not None:
            return (
                CheckBinding(
                    artifact.id,
                    artifact.digest,
                    "arithmetic_value",
                    original_arithmetic,
                    proposed,
                    ("original_goal_coverage",),
                    Scope(domain="rational"),
                ),
            )
        mapped = (
            odd_part_goal(store.problem.raw)
            if candidate
            or (
                unit is not None
                and odd_part_goal(goal) == odd_part_goal(store.problem.raw)
            )
            else None
        )
        if (
            expression is None
            and mapped is not None
            and has_mapped_ancestor(store, artifact)
        ):
            return (
                CheckBinding(
                    artifact.id,
                    artifact.digest,
                    "odd_part_value",
                    str(mapped),
                    proposed,
                    ("original_goal_coverage",) if candidate else unit.obligations,
                    Scope(domain="positive_integer"),
                ),
            )
        if expression is None:
            return ()
        property = "all_real_roots" if candidate else "arithmetic_value"
        scope = Scope(domain="real" if candidate else "rational")
        return (
            CheckBinding(
                artifact.id,
                artifact.digest,
                property,
                expression,
                proposed,
                ("original_goal_coverage",) if candidate else ("value",),
                scope,
            ),
        )

    def d0(self, bindings):
        return bindings[0] if len(bindings) == 1 else None

    def soundness(self, store, binding):
        artifact = store.artifacts.get(binding.artifact)
        if (
            artifact is None
            or binding.artifact_hash != artifact.digest
            or not artifact.closed
        ):
            return False
        if binding.property == "all_real_roots":
            return binding.expression == root_equation(store.problem.raw)
        if binding.property == "odd_part_value":
            return binding.expression == str(
                odd_part_goal(store.problem.raw)
            ) and has_mapped_ancestor(store, artifact)
        if binding.template is not None:
            return (
                binding.template in enumerate_templates(binding.expression)
                and binding.property == binding.template.property
                and binding.obligations == (binding.template.obligation,)
                and binding.scope.domain == binding.template.domain
            )
        if binding.property == "arithmetic_value":
            # The expression must be controller-bound at check(), not model-supplied.
            return (
                binding.expression == arithmetic_goal(store.problem.raw)
                if "original_goal_coverage" in binding.obligations
                else bool(binding.expression)
            )
        return False

    def check(
        self,
        store: ArtifactStore,
        artifact: Artifact,
        *,
        goal: str,
        proposed: str,
        candidate=False,
        unit: WorkUnit | None = None,
    ) -> Evidence | None:
        if candidate:
            from .math_source import compile_candidate

            if compile_candidate(store.problem.raw, proposed) is not None:
                from .source_verification import check_candidate_locked

                if self.executor is None:
                    from .tools import RegisteredExecutor

                    self.executor = RegisteredExecutor()
                return check_candidate_locked(
                    store,
                    artifact,
                    proposed,
                    executor=self.executor,
                    deadline=self.deadline,
                    clock=self.clock,
                    persist=self.persist,
                    checker_version=self.version,
                )
        with store.lock:
            return self._check(
                store,
                artifact,
                goal=goal,
                proposed=proposed,
                candidate=candidate,
                unit=unit,
            )

    def _check(self, store, artifact, *, goal, proposed, candidate=False, unit=None):
        if candidate:
            from .math_source import compile_candidate
            from .source_verification import check_candidate

            if compile_candidate(store.problem.raw, proposed) is not None:
                if self.executor is None:
                    from .tools import RegisteredExecutor

                    self.executor = RegisteredExecutor()
                return check_candidate(
                    store,
                    artifact,
                    proposed,
                    executor=self.executor,
                    deadline=self.deadline,
                    clock=self.clock,
                    persist=self.persist,
                    checker_version=self.version,
                )
        binding = self.d0(
            self.enumerate(
                store,
                artifact,
                goal=goal,
                proposed=proposed,
                candidate=candidate,
                unit=unit,
            )
        )
        if binding is None or not self.soundness(store, binding):
            store.event(
                "check_undecidable",
                artifact=artifact.id,
                reason="no_unique_sound_binding",
            )
            return None
        outcome, kind, closed = "INCONCLUSIVE", "AUDIT_ONLY", ()
        statement = ""
        try:
            if binding.template is not None:
                ok, statement = evaluate_assertion(binding.template, binding.proposed)
                outcome = "SUPPORTS" if ok else "REFUTES"
                kind = "EXACT_CHECK" if ok else "EXACT_COUNTEREXAMPLE"
                closed = binding.obligations if ok else ()
            elif binding.property == "arithmetic_value":
                proposed_values = candidates(binding.proposed)
                expected = safe_expr(binding.expression)
                if expected.free_symbols or len(proposed_values) != 1:
                    raise ValueError("not a scalar check")
                ok = expected == proposed_values[0]
                outcome = "SUPPORTS" if ok else "REFUTES"
                kind = "EXACT_CHECK" if ok else "EXACT_COUNTEREXAMPLE"
                closed = binding.obligations if ok else ()
            elif binding.property == "odd_part_value":
                proposed_values = candidates(binding.proposed)
                expected = int(binding.expression)
                while expected % 2 == 0:
                    expected //= 2
                ok = len(proposed_values) == 1 and proposed_values[0] == expected
                outcome, kind, closed = (
                    ("SUPPORTS", "EXACT_CHECK", binding.obligations)
                    if ok
                    else ("REFUTES", "EXACT_COUNTEREXAMPLE", ())
                )
            else:
                proposed_values = candidates(binding.proposed)
                left, right = binding.expression.split("=")
                x = sp.Symbol("x", real=True)
                # Validate each ORIGINAL AST before any simplifying arithmetic.
                # Being polynomial after cancellation does not preserve its domain.
                polynomial = sp.Poly(
                    safe_expr(left, polynomial_only=True)
                    - safe_expr(right, polynomial_only=True),
                    x,
                )
                if not 1 <= polynomial.degree() <= 4:
                    raise ValueError("outside finite low-degree polynomial scope")
                roots = set(sp.real_roots(polynomial))
                satisfaction = all(polynomial.eval(v) == 0 for v in proposed_values)
                complete = satisfaction and set(proposed_values) == roots
                outcome = (
                    "SUPPORTS"
                    if complete
                    else "INCOMPLETE"
                    if satisfaction
                    else "REFUTES"
                )
                kind = "EXACT_CHECK" if satisfaction else "EXACT_COUNTEREXAMPLE"
                closed = (
                    binding.obligations
                    if complete
                    else ("candidate_satisfies",)
                    if satisfaction
                    else ()
                )
        except (
            ValueError,
            SyntaxError,
            TypeError,
            sp.PolynomialError,
            NotImplementedError,
        ):
            pass
        evidence = Evidence(
            fingerprint(
                (
                    self.version,
                    binding.artifact_hash,
                    binding.property,
                    binding.proposed,
                    outcome,
                )
            ),
            artifact.id,
            artifact.digest,
            binding.property,
            "registered_exact_checker",
            self.version,
            fingerprint((binding.expression, binding.proposed)),
            binding.scope,
            outcome,
            kind,
            closed,
            statement
            or f"{binding.property}: {binding.expression}; checked result: {binding.proposed}",
        )
        store.evidence[evidence.id] = evidence
        store.event(
            "evidence", evidence=evidence.__dict__ | {"scope": evidence.scope.__dict__}
        )
        if (
            outcome == "SUPPORTS"
            and not artifact.unverified_dependencies
            and artifact.id not in store.refuted
            and artifact.id not in store.invalid_proofs
        ):
            store.verified.add(artifact.id)
        if outcome == "REFUTES":
            store.refute(artifact.id, evidence)
        return evidence


def exact_goal_coverage(
    store: ArtifactStore, candidate: CandidateRevision
) -> tuple[Evidence, ...]:
    """Return current, target-bound full-goal receipts, never a syntax-only verdict.

    This is coverage of the candidate answer, not verification of every statement
    in its derivation. Provisional ancestry is still handled by ArtifactStore.
    Old checker versions, other payloads/properties/scopes and incomplete checks
    cannot suppress R5 or provide final candidate-verification authority.
    """
    with store.lock:
        from .goal_contracts import current

        contract = current(store)
        binding = (
            store.control.get("goal_closure", {})
            .get("candidate_bindings", {})
            .get(candidate.id)
        )
        if contract and binding and binding["contract"] != contract["id"]:
            return ()
        from .source_verification import goal_coverage

        source_receipts = goal_coverage(store, candidate, VerificationEngine.version)
        if source_receipts:
            # Independent answer coverage does not make provisional derivations
            # or their ancestors into verified premises.
            return source_receipts
        artifact = store.artifacts.get(candidate.artifact)
        expression = root_equation(store.problem.raw)
        mapped = odd_part_goal(store.problem.raw)
        property_name, domain = "all_real_roots", "real"
        if expression is None and arithmetic_goal(store.problem.raw) is not None:
            expression, property_name, domain = (
                arithmetic_goal(store.problem.raw),
                "arithmetic_value",
                "rational",
            )
        if (
            expression is None
            and mapped is not None
            and artifact is not None
            and has_mapped_ancestor(store, artifact)
        ):
            expression, property_name, domain = (
                str(mapped),
                "odd_part_value",
                "positive_integer",
            )
        if (
            artifact is None
            or artifact.problem != store.problem.digest
            or not artifact.closed
            or artifact.id in store.refuted
            or artifact.id in store.invalid_proofs
            or expression is None
        ):
            return ()
        obligations = set(candidate.obligations) | {"original_goal_coverage"}
        expected_input = fingerprint((expression, candidate.answer))
        return tuple(
            e
            for e in store.evidence.values()
            if e.artifact_id == artifact.id
            and e.artifact_hash == artifact.digest
            and e.property == property_name
            and e.input_hash == expected_input
            and e.checker == "registered_exact_checker"
            and e.checker_version == VerificationEngine.version
            and e.kind == "EXACT_CHECK"
            and e.outcome == "SUPPORTS"
            and e.scope == Scope(domain=domain)
            and obligations <= set(e.obligations)
        )


def answer_verified(store, candidate):
    receipts = exact_goal_coverage(store, candidate)
    return bool(receipts) and (
        candidate.artifact in store.verified
        or any(e.property == "source_algebraic_minimum" for e in receipts)
    )
