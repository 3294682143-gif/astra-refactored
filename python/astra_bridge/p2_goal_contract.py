"""Single read-only authority mirroring ``@astra/protocol`` candidate kinds.

Which obligation kind carries a goal's final answer is a control-side decision
made in the TypeScript protocol package (``P2_ANSWER_OBLIGATION_KINDS``). The
Python Host never widens or narrows it: it re-reads the same fixed set only so
its protected-candidate projection can cross-check the control-side decision
instead of trusting it blindly. This one module is imported by both
``agent_context.py`` and ``p2_host_callback.py``, so the Host has a single
source for the rule rather than two.

The set is the image of the goal-kind -> answer-obligation map:
``VALUE->CANDIDATE_VALIDITY``, ``ALL_SOLUTIONS->EXHAUSTIVENESS``,
``COUNT->COUNT_OBJECTS``, ``OPTIMIZATION->GLOBAL_BOUND``, ``PROOF->PROOF_GOAL``,
``MULTIPART->SUBGOAL_COVERAGE``, ``UNKNOWN->ANSWER_REQUEST``. A COMPLETE packet
for any other obligation (a premise, a local lemma, a feasible point, a
boundary exception, a coverage statement) is never a whole-problem candidate.
"""

from __future__ import annotations

__all__ = ["ANSWER_OBLIGATION_KINDS", "is_answer_obligation_kind"]

# Mirrors P2_ANSWER_OBLIGATION_KINDS in packages/protocol/src/p2.ts.
ANSWER_OBLIGATION_KINDS = frozenset((
    "CANDIDATE_VALIDITY",
    "EXHAUSTIVENESS",
    "COUNT_OBJECTS",
    "GLOBAL_BOUND",
    "PROOF_GOAL",
    "SUBGOAL_COVERAGE",
    "ANSWER_REQUEST",
))


def is_answer_obligation_kind(kind):
    """True iff ``kind`` is the answer obligation of some goal kind."""
    return kind in ANSWER_OBLIGATION_KINDS
