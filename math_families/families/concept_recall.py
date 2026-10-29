"""concept_recall family.

Structural criterion: concept discrimination / multiple-choice /
true-false / short-recall questions with no algorithmic structure.

By design this family ships NO tools: there is nothing to compute, and any
"tool" here would be an answer-shaped lookup — which the project forbids.
The module exists so the catalog can mark the family as deliberately
tool-less (status "none_by_design") and the static gates stay green.
"""
from __future__ import annotations

#: Deliberately empty: no computational tools for concept questions.
TOOLS: tuple = ()
