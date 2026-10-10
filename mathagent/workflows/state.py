"""Shared budget/progress checkpoint ownership; no workflow decision logic."""

from dataclasses import dataclass

from ..observability import admission_wait_estimate
from ..runtime.config import Limits


@dataclass
class BudgetWindow:
    soft: float
    planning_end: float
    solving_end: float
    finish_end: float
    hard_end: float | None = None

    @classmethod
    def start(cls, item, *, soft_seconds=None, generation_deadline=None):
        end = min(
            item.deadline,
            generation_deadline if generation_deadline is not None else item.deadline,
        )
        window = max(0, end - item.started)
        soft = min(window, soft_seconds if soft_seconds is not None else window)
        limits = Limits()
        return cls(
            soft,
            item.started + soft * limits.planning_fraction,
            item.started + soft * (1 - limits.final_fraction),
            min(end, item.started + soft),
            end,
        )

    def grow(self, seconds, *, started):
        """Only a new soft allocation; the completed planning phase never reopens."""
        if self.hard_end is None:
            return False
        new = min(max(self.soft, seconds), self.hard_end - started)
        if new <= self.soft:
            return False
        self.soft = new
        self.finish_end = min(self.hard_end, started + new)
        self.solving_end = started + new * (1 - Limits().final_fraction)
        return True

    def tighten(self, seconds, *, started):
        limits = Limits()
        self.soft = min(self.soft, max(0, seconds))
        self.planning_end = min(
            self.planning_end, started + self.soft * limits.planning_fraction
        )
        self.solving_end = min(
            self.solving_end, started + self.soft * (1 - limits.final_fraction)
        )
        self.finish_end = min(self.finish_end, started + self.soft)


class CheckpointState:
    def __init__(self, *, coordinator, item, store, budget, progress):
        self.coordinator, self.item, self.store = coordinator, item, store
        self.budget, self.progress = budget, progress

    def persist(self):
        """Protect closing actions then flush; do not alter progress or once flags."""
        reserve = getattr(self.coordinator, "reserve_closeout", None)
        if callable(reserve):
            from ..policy import WORKFLOW_DEFAULTS
            from ..verification import exact_goal_coverage
            from ..work_delivery import computational_kind
            from .candidates import candidate_gaps

            candidates = [
                c
                for c in self.store.candidates.values()
                if c.artifact not in self.store.refuted
                and c.artifact not in self.store.invalid_proofs
                and self.store.control.get("candidate_check_states", {})
                .get(c.id, {})
                .get("state")
                not in {"PENDING", "STARTED", "STALE"}
            ]
            unchecked = [
                c for c in candidates if not exact_goal_coverage(self.store, c)
            ]
            # Assembly/fallback plus R5, or existing R5s and one repair with R4/R5.
            requested = (
                4 if not candidates else 2 * len(unchecked) + (5 if unchecked else 0)
            )
            if any(
                computational_kind(gap, "CHECK") == "COMPUTE"
                for c in unchecked
                for gap in candidate_gaps(self.store, self.store.artifacts[c.artifact])
            ):
                requested += 3  # One closing computation plus at most two R3 attempts.
            outcome = reserve(self.item, requested)
            previous = self.store.control.get("closeout_call_reserve")
            self.store.control["closeout_call_reserve"] = outcome
            if outcome != previous:
                self.store.event(
                    "closeout_call_reserve", **outcome, no_additional_quota=True
                )
            # Only undo shortening owned by this reservation, never an external
            # budget tightening, and never reopen a closing/closed question.
            last = self.store.control.get("closeout_solving_end")
            base = self.store.control.get(
                "closeout_base_solving_end", self.budget.solving_end
            )
            if last is None or self.budget.solving_end != last:
                base = self.budget.solving_end
            base = min(
                base,
                self.item.started + self.budget.soft * (1 - Limits().final_fraction),
                self.budget.finish_end,
            )
            self.store.control["closeout_base_solving_end"] = base
            desired, estimated = base, 0
            if unchecked:
                estimated = requested * (
                    self.coordinator.estimated_call_seconds()
                    + admission_wait_estimate(self.store)
                )
                window = min(
                    estimated,
                    self.budget.soft
                    * WORKFLOW_DEFAULTS.closeout_prediction_max_fraction,
                )
                desired = min(
                    base, max(self.coordinator.clock(), self.budget.finish_end - window)
                )
            old = self.budget.solving_end
            if desired > old and (
                self.store.control.get("goal_closure_closing")
                or self.store.control.get("goal_closure_closed")
                or self.coordinator.clock() >= self.budget.finish_end
            ):
                desired = old
            if desired != old:
                self.budget.solving_end = desired
                self.store.control["closeout_solving_end"] = desired
                self.store.event(
                    "closeout_advanced" if desired < old else "closeout_rebalanced",
                    previous_solving_end=old,
                    solving_end=desired,
                    predicted_seconds=estimated,
                    original_finish_end=self.budget.finish_end,
                    reason="current eligible candidate reserve within original allocation",
                )
        return self.coordinator.checkpoint(self.item, self.store.snapshot())

    def checkpoint(self):
        with self.store.lock:
            self.store.control["soft_seconds"] = self.budget.soft
            self.store.control["progress"] = {
                "stalled": dict(self.progress.stalled),
                "seen": {k: sorted(v) for k, v in self.progress.seen.items()},
                "exploration": dict(self.progress.exploration),
                "identities": dict(self.progress.identities),
                "result_keys": {
                    k: sorted(v) for k, v in self.progress.result_keys.items()
                },
                "semantic_seen": {
                    k: sorted(v) for k, v in self.progress.semantic_seen.items()
                },
            }
            return self.persist()

    def tighten_budget(self, seconds):
        with self.store.lock:
            old = self.budget.soft
            self.budget.tighten(seconds, started=self.item.started)
            if self.budget.soft != old:
                self.store.event(
                    "budget_tightened",
                    old_soft_seconds=old,
                    soft_seconds=self.budget.soft,
                    reason="public run progress/capacity; original start retained",
                    finalization_reserve_shortfall=self.coordinator.clock()
                    >= self.budget.solving_end
                    if hasattr(self.coordinator, "clock")
                    else False,
                )
