"""G3/PR4 §6.1 matrix rows E05/E06 at the real public ``engine="ts"`` entry.

Only the injected public client is fake; the real ``user_agent.ReasoningAgent``,
the real Python Host, the real Node ``main.js --agent-loop`` profile and the
legacy-solver-disabled negative control all run.

DECISION-0150 ruling B2 (bounded scope, frozen authority untouched): the single
whole-problem candidate authority (``PROOF -> PROOF_GOAL``,
``OPTIMIZATION -> GLOBAL_BOUND``) is preserved verbatim; ``Test candidate kinds``
is not modified. What is added is the honest reporting of the *auxiliary*
(non-answer) obligations that are still unclosed when the candidate is released:

- E05: a proof's ``PREMISES`` (a provisional/contrapositive assumption that was
  never discharged) stays in ``unresolvedObligations`` and the candidate stays
  unverified — the local derivation is never promoted to an unconditional,
  cross-route shared theorem.
- E06: an optimization's ``ATTAINMENT`` (the equality/witness obligation) stays
  in ``unresolvedObligations`` — a bound with no attained case must not claim
  attainment.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import user_agent  # noqa: E402

from test_ts_entry import (  # noqa: E402
    FakeClient,
    no_legacy_solver,
    process_tracker,
)
from test_ts_candidate_kinds import CASES, CandidateClient, _BUDGET  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker", "FakeClient"]


def _solve(client, problem, **kwargs):
    agent = user_agent.ReasoningAgent(client=client, engine="ts", **kwargs)
    return agent.solve(problem, {"source": "e2e"})


def test_e05_unclosed_proof_premise_is_reported_and_never_verified(process_tracker):
    """E05: the proof answer is released; the unclosed PREMISES stays reported."""
    case = CASES["proof"]
    client = CandidateClient(case)
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == case["answer"]
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    # The proof's premise obligation is still open and reported; the answer
    # obligation (PROOF_GOAL) is not in the unresolved-auxiliary list.
    assert "goal-1:PREMISES" in result["unresolvedObligations"]
    assert "goal-1:PROOF_GOAL" not in result["unresolvedObligations"]
    assert process_tracker


def test_e06_unclosed_optimization_attainment_is_reported_and_never_verified(process_tracker):
    """E06: the global bound is released; the unclosed ATTAINMENT stays reported."""
    case = CASES["optimization"]
    client = CandidateClient(case)
    result = _solve(client, case["problem"], **_BUDGET)
    assert result["engine"] == "ts"
    assert result["status"] == "candidate"
    assert result["final_response"] == case["answer"]
    assert result["candidate_verified"] is False
    assert result["strictAcceptance"] == "NOT_PERFORMED"
    assert "goal-1:ATTAINMENT" in result["unresolvedObligations"]
    assert "goal-1:GLOBAL_BOUND" not in result["unresolvedObligations"]
    assert process_tracker
