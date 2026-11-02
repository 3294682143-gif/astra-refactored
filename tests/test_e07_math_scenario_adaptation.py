"""E07: Mathematics Full Scenario Adaptation and Controlled Delegation Tests.

Verifies:
1. ReasoningAgent binds MATH_SCENARIO_CONTRACT and SCENARIO_ID="math.research".
2. Explicit engine dispatch (ts, legacy, lite) with zero silent engine switching.
3. resume_checkpoint restriction (requires engine="ts", raises TypeError on legacy/lite).
4. Role source mappings (R0, WORK, AUDIT, REVIEW) fidelity.
5. Invariant I15: candidate_verified is always False.
6. Integration with Atria/Mock client.
"""
from __future__ import annotations

import pytest
from user_agent import ReasoningAgent
from python.astra_bridge.scenario_contracts import MATH_SCENARIO_CONTRACT, ROLE_SOURCE_MAPPINGS


class DummyClient:
    """Mock public client satisfying chat contract."""
    def __init__(self):
        self.calls = []

    def chat(self, messages, temperature=0.0, max_tokens=100):
        self.calls.append(messages)
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": '{"candidateProposal": "x=42", "deliveryStatus": "COMPLETE"}',
                    }
                }
            ]
        }


def test_e07_scenario_contract_binding():
    """Verify ReasoningAgent binds scenario metadata and contract."""
    assert ReasoningAgent.SCENARIO_ID == "math.research"
    contract = ReasoningAgent.get_scenario_contract()
    assert contract == MATH_SCENARIO_CONTRACT
    assert contract.manifest.scenario_id == "math.research"
    assert contract.manifest.name == "数学研究场景"
    assert contract.inputs.input_kind == "PROBLEM_STATEMENT"
    assert len(contract.team.roles) >= 4


def test_e07_role_mappings():
    """Verify role mappings from legacy stages to multi-agent roles."""
    ts_mappings = ReasoningAgent.get_role_mappings("ts")
    assert len(ts_mappings) >= 3

    target_roles = [m.target_role_id for m in ts_mappings]
    assert "math_problem_analyst" in target_roles
    assert "math_solver_worker" in target_roles


def test_e07_explicit_engines_initialization():
    """Verify all 3 engines initialize honestly and unknown engines fail."""
    client = DummyClient()

    # ts engine (default)
    agent_ts = ReasoningAgent(client=client)
    assert agent_ts.engine == "ts"

    # legacy engine
    agent_legacy = ReasoningAgent(client=client, engine="legacy")
    assert agent_legacy.engine == "legacy"

    # lite engine
    agent_lite = ReasoningAgent(client=client, engine="lite")
    assert agent_lite.engine == "lite"

    # Unknown engine must raise ValueError, never silently fallback
    with pytest.raises(ValueError, match="unknown engine"):
        ReasoningAgent(client=client, engine="unsupported_engine")


def test_e07_argument_type_enforcement():
    """Verify ts and lite accept keyword arguments only."""
    client = DummyClient()

    with pytest.raises(TypeError, match="ts engine accepts keyword arguments only"):
        ReasoningAgent(client, "unexpected_positional_arg", engine="ts")

    with pytest.raises(TypeError, match="lite engine accepts keyword arguments only"):
        ReasoningAgent(client, "unexpected_positional_arg", engine="lite")


def test_e07_resume_checkpoint_engine_restriction():
    """resume_checkpoint strictly requires engine='ts'."""
    client = DummyClient()

    agent_legacy = ReasoningAgent(client=client, engine="legacy")
    with pytest.raises(TypeError, match="resume_checkpoint requires engine='ts'"):
        agent_legacy.solve("证明根号2是无理数", resume_checkpoint={"some": "checkpoint"})

    agent_lite = ReasoningAgent(client=client, engine="lite")
    with pytest.raises(TypeError, match="resume_checkpoint requires engine='ts'"):
        agent_lite.solve("证明根号2是无理数", resume_checkpoint={"some": "checkpoint"})


def test_e07_lite_engine_honest_execution():
    """Verify lite engine execution maintains candidate_verified=False invariant."""
    client = DummyClient()
    agent_lite = ReasoningAgent(client=client, engine="lite", max_steps=2)
    result = agent_lite.solve("求方程 x^2 = 4 的正整数解")

    assert isinstance(result, dict)
    assert result.get("candidate_verified") is False
