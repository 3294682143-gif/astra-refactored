"""Bottleneck progress policy; independent of provider, store and orchestration."""

import re

from .claim_context import statement_segments
from .domain import WorkUnit
from .policy import WORKFLOW_DEFAULTS
from .progress_claims import related_keys, unassessed_statement
from .progress_formula import formula_signal, math_identifiers
from .runtime.config import fingerprint

_TOPICS = (
    r"\bidentit(?:y|ies)\b|恒等式",
    r"\binequalit(?:y|ies)\b|不等式",
    r"\b(?:polynomial|factorization|expansion)\b|多项式|因式分解|展开",
)


def _relations(text, *, segments=None):
    return [
        (signal.key, signal.objects)
        for segment in (statement_segments(text) if segments is None else segments)
        if (signal := formula_signal(segment.frame)).key is not None
    ]


class ProgressTracker:
    def __init__(self):
        self.stalled = {}
        self.seen = {}
        self.exploration = {}
        self.identities = {}
        self.result_keys = {}
        self.semantic_seen = {}

    def record(
        self,
        unit: WorkUnit,
        text: str,
        *,
        result_gain=False,
        result_key=None,
        context=(),
    ):
        key = self.identities.setdefault(unit.id, unit.bottleneck_key)
        segments = statement_segments(text)
        canonical = re.sub(
            r"\s+", " ", "\n".join(segment.raw for segment in segments).strip()
        )
        target = unit.goal + " " + unit.bottleneck
        required_objects = math_identifiers(target) or math_identifiers(
            " ".join(context)
        )
        topic_match = any(re.search(topic, target, re.IGNORECASE) for topic in _TOPICS)
        mathematical = _relations(text, segments=segments)
        related = {
            value
            for value, objects in mathematical
            if objects
            and (bool(required_objects & objects) if required_objects else topic_match)
        }
        related.update(related_keys(text, target, context, segments=segments))
        semantic = "|".join(sorted(value for value, _ in mathematical)) or canonical
        result_id = result_key or fingerprint(semantic)
        result_seen = self.result_keys.setdefault(key, set())
        result_gain = bool(result_gain and result_id not in result_seen)
        if result_gain:
            result_seen.add(result_id)
        seen = self.seen.setdefault(key, set())
        semantic_seen = self.semantic_seen.setdefault(key, set())
        novel = (
            bool(related - semantic_seen)
            and canonical not in seen
            and canonical.lower() not in {"", "none", "unknown"}
        )
        gain = (
            "RESULT"
            if result_gain
            else "EXPLORATION"
            if novel
            else "UNASSESSED"
            if canonical not in seen
            and unassessed_statement(text, target, context, segments=segments)
            else "NONE"
        )
        seen.add(canonical)
        semantic_seen.update(related)
        if gain == "EXPLORATION":
            self.exploration[key] = self.exploration.get(key, 0) + 1
        self.stalled[key] = self.stalled.get(key, 0) + 1 if gain == "NONE" else 0
        return gain, self.stalled[key] >= WORKFLOW_DEFAULTS.no_progress_pause

    def exploration_budget_exhausted(self, unit):
        key = self.identities.get(unit.id, unit.bottleneck_key)
        return self.exploration.get(key, 0) > WORKFLOW_DEFAULTS.exploration_rewards
