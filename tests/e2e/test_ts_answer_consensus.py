"""Public-entry bounded answer consensus: blind re-solve, then adjudication."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import user_agent  # noqa: E402
from test_ts_entry import FakeClient, no_legacy_solver, process_tracker  # noqa: E402

__all__ = ["no_legacy_solver", "process_tracker"]

PROBLEM = "设$R_1,R_2$是带$1$的环，$f:R_1\\to R_2$是非零环同态. 判断命题 (I) 与 (II) 是否正确."
ANSWER_TASK = "goal-1:ANSWER_REQUEST"


class ConsensusClient(FakeClient):
    def __init__(self, same=False, candidates=None, first_incomplete=False):
        super().__init__()
        self.same = same
        self.candidates = candidates
        self.first_incomplete = first_incomplete
        self.answer_calls = 0

    def _work(self, body):
        task = body["task"]
        candidate = None
        claim = "prerequisite"
        derivation = "prerequisite"
        delivery = "COMPLETE"
        if task["taskId"] == ANSWER_TASK:
            self.answer_calls += 1
            if self.first_incomplete and self.answer_calls == 1:
                delivery = "INCOMPLETE"
            elif self.candidates is not None:
                candidate = self.candidates[self.answer_calls - 1]
                claim, derivation = "majority attempt", "majority derivation"
            elif self.same:
                candidate, claim, derivation = "(A)", "same attempt", "same derivation"
            elif self.answer_calls == 1:
                candidate, claim, derivation = "(A)", "first attempt", "first derivation"
            elif self.answer_calls == 2:
                candidate, claim, derivation = "(B)", "second attempt", "second derivation"
            else:
                candidate, claim, derivation = "(C)", "adjudicated attempt", "adjudicated derivation"
        return json.dumps(
            {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": task["taskId"],
                "goalId": task["goalId"],
                "scopeId": task["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": claim,
                "derivation": derivation,
                "assumptions": [],
                "dependencies": task["inputArtifactRefs"],
                "pendingObligations": [],
                "suggestedChecks": [],
                "deliveryStatus": delivery,
                "candidateProposal": candidate,
            }
        )


def test_answer_consensus_adds_blind_attempt_and_adjudication(process_tracker):
    client = ConsensusClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(C)"
    assert result["metrics"]["logical_model_calls"] == 5
    assert result["metrics"]["work_units"] == 3
    assert client.answer_calls == 3
    assert process_tracker


def test_agreeing_blind_attempt_still_runs_final_certificate(process_tracker):
    client = ConsensusClient(same=True)
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["logical_model_calls"] == 5
    assert result["metrics"]["work_units"] == 3
    assert client.answer_calls == 3
    assert process_tracker


def test_strict_candidate_majority_selects_the_repeated_answer(process_tracker):
    client = ConsensusClient(candidates=["(A)", "(B)", "(A)"])
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["logical_model_calls"] == 5
    assert client.answer_calls == 3
    assert process_tracker


def test_incomplete_first_answer_is_repaired_by_blind_consensus(process_tracker):
    client = ConsensusClient(same=True, first_incomplete=True)
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})
    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["logical_model_calls"] == 5
    assert client.answer_calls == 3
    assert process_tracker


class IncompleteFirstWithMethodClient(ConsensusClient):
    """Count method-selection turns so an INCOMPLETE draft cannot force one."""

    def __init__(self):
        super().__init__(same=True, first_incomplete=True)
        self.method_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        if "METHOD SELECTION TURN" in messages[0]["content"]:
            self.method_turns += 1
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_incomplete_first_answer_does_not_force_method_selection(process_tracker):
    client = IncompleteFirstWithMethodClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=10,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=1,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["method_loads"] == 0
    assert result["metrics"]["effect_calls"] == 0
    assert client.method_turns == 0
    assert client.answer_calls >= 3
    assert process_tracker


class OverlongFirstClient(ConsensusClient):
    """First complete packet exceeds the Host WorkPacket text bound."""

    def __init__(self):
        super().__init__(same=True)

    def _work(self, body):
        text = super()._work(body)
        if body["task"]["taskId"] == ANSWER_TASK and self.answer_calls == 1:
            packet = json.loads(text)
            packet["derivation"] = "x" * 4097
            return json.dumps(packet)
        return text


def test_overlong_first_packet_is_replaced_by_blind_consensus(process_tracker):
    client = OverlongFirstClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["logical_model_calls"] == 5
    assert result["metrics"]["work_units"] == 3
    assert client.answer_calls >= 2
    assert process_tracker


class InvalidThenRecoveredClient(ConsensusClient):
    """First WORK and its schema repair are malformed; CONSENSUS recovers."""

    def __init__(self):
        super().__init__(same=True)

    def _work(self, body):
        if body["task"]["taskId"] == ANSWER_TASK and self.answer_calls < 2:
            self.answer_calls += 1
            return "{not a work packet"
        return super()._work(body)


def test_malformed_packet_is_recovered_by_consensus(process_tracker):
    client = InvalidThenRecoveredClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=10,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert result["metrics"]["logical_model_calls"] >= 3
    assert client.answer_calls >= 3
    assert process_tracker


def test_extended_audit_chain_selects_last_corrected_candidate(process_tracker):
    client = ConsensusClient(candidates=["(A)", "(B)", "(C)", "(D)", "(E)"])
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=4,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(E)"
    assert client.answer_calls == 5
    assert process_tracker


class InvalidMiddleClient(ConsensusClient):
    """A malformed audit must not split the same-task Host artifact run."""

    def __init__(self):
        super().__init__()
        self.answer_calls = 0

    def _work(self, body):
        task = body["task"]
        if task["taskId"] == ANSWER_TASK:
            self.answer_calls += 1
            if self.answer_calls == 3:
                return "{this is not a work packet"
            candidate = "(A)" if self.answer_calls in (1, 4) else "(B)"
            return json.dumps(
                {
                    "schemaVersion": "p2a-work-v1",
                    "sessionId": body["sessionId"],
                    "problemHash": body["problemHash"],
                    "contractVersion": body["contractVersion"],
                    "taskId": task["taskId"],
                    "goalId": task["goalId"],
                    "scopeId": task["scopeId"],
                    "routeId": body["route"]["routeId"],
                    "sourceRequestId": body["sourceRequestId"],
                    "claim": "audited answer",
                    "derivation": "audited derivation",
                    "assumptions": [],
                    "dependencies": task["inputArtifactRefs"],
                    "pendingObligations": [],
                    "suggestedChecks": [],
                    "deliveryStatus": "COMPLETE",
                    "candidateProposal": candidate,
                }
            )
        return super()._work(body)


def test_malformed_middle_audit_keeps_one_host_artifact_run(process_tracker):
    client = InvalidMiddleClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=3,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(A)"
    assert client.answer_calls == 4
    assert process_tracker


class CertifiedCorrectionClient(ConsensusClient):
    """The final certificate corrects an answer already repeated by audits."""

    def __init__(self):
        super().__init__(candidates=["(A)", "(A)", "(A)", "(B)", "(B)"])

    def _work(self, body):
        text = super()._work(body)
        if body["task"]["taskId"] == ANSWER_TASK and self.answer_calls == 4:
            packet = json.loads(text)
            packet["suggestedChecks"] = [
                "CERT1|CHECK|C1|RECOMPUTE|independent check => PASS",
                "CERT1|CHECK|C2|COUNTEREXAMPLE|no counterexample => PASS",
                "CERT1|FINAL|(B)",
            ]
            return json.dumps(packet)
        return text


def test_final_certificate_wins_over_correlated_majority(process_tracker):
    client = CertifiedCorrectionClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=3,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "(B)"
    assert client.answer_calls == 4
    assert process_tracker


class OptionClosureClient(ConsensusClient):
    """A certificate option table contradicts the candidate; closure repairs it."""

    def __init__(self):
        super().__init__(candidates=["(A)", "(A)", "(A)", "(A)", "(A)"])

    def _work(self, body):
        text = super()._work(body)
        if body["task"]["taskId"] != ANSWER_TASK:
            return text
        if self.answer_calls == 4:
            packet = json.loads(text)
            packet["candidateProposal"] = "A、C"
            packet["suggestedChecks"] = [
                "CERT1|CHECK|C1|EVALUATE|A true => PASS",
                "CERT1|CHECK|C2|EVALUATE|D true => PASS",
                "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
                "CERT1|FINAL|A、C",
            ]
            return json.dumps(packet)
        if self.answer_calls == 5:
            packet = json.loads(text)
            packet["candidateProposal"] = "A、C、D"
            packet["suggestedChecks"] = [
                "CERT1|CHECK|C1|EVALUATE|A true => PASS",
                "CERT1|CHECK|C2|EVALUATE|D true => PASS",
                "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
                "CERT1|FINAL|A、C、D",
            ]
            return json.dumps(packet)
        return text


def test_option_certificate_closure_adds_missing_true_option(process_tracker):
    client = OptionClosureClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=3,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "A、C、D"
    assert client.answer_calls == 5
    assert process_tracker


def test_canonical_fraction_keys_drive_majority_and_latest_tiebreak(process_tracker):
    # Without canonical keys, "1/2" would have two votes and win. With the
    # shared key all three attempts tie, so the existing latest tie-break keeps
    # the certificate attempt's original text.
    client = ConsensusClient(candidates=["1/2", "1/2", "\\frac12"])
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=8,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=2,
        max_method_loads=0,
    )
    result = agent.solve(PROBLEM, {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "\\frac12"
    assert client.answer_calls == 3
    assert process_tracker
