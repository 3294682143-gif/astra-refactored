"""Generic answer-closure e2e: degree, normalization, options and completeness.

The only fake is the injected public client. The real public ReasoningAgent,
Host, Node agent loop and registered exact-check tool execute.
"""

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

ALEXANDER_MATRIX = [
    ["-t**2+2*t-1", "-t", "t", "t**2-2*t+1"],
    ["t**2-2*t+1", "-t**2+2*t-1", "-t", "t"],
    ["t", "t**2-2*t+1", "-t**2+2*t-1", "-t"],
    ["-t", "t", "t**2-2*t+1", "-t**2+2*t-1"],
]
ALEXANDER_POLYNOMIAL = (
    "t^6 - 5*t^5 + 10*t^4 - 13*t^3 + 10*t^2 - 5*t + 1"
)


class ClosureClient(FakeClient):
    """Base fake that records closure and exact-check turns."""

    ANSWER_SUFFIX = "CANDIDATE_VALIDITY"

    def __init__(self):
        super().__init__()
        self.answer_calls = 0
        self.closure_turns = 0
        self.exact_turns = 0
        self._closure = False
        self._exact = False

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        self._closure = "ANSWER CLOSURE" in system
        self._exact = "EXACT CHECK TURN" in system
        if self._closure:
            self.closure_turns += 1
        if self._exact:
            self.exact_turns += 1
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "action": "tool",
                                    "name": "exact_check_expr",
                                    "args": {
                                        "operation": "MAXIMAL_MINORS",
                                        "matrix": ALEXANDER_MATRIX,
                                        "variable": "t",
                                    },
                                    "scope": "all maximal minors of the supplied matrix",
                                }
                            ),
                        },
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    def _is_answer_task(self, body):
        return body["task"]["taskId"].rsplit(":", 1)[-1] == self.ANSWER_SUFFIX

    def _work(self, body):
        if not self._is_answer_task(body):
            return super()._work(body)
        self.answer_calls += 1
        candidate, checks = self._answer(body, self.answer_calls)
        return json.dumps(
            {
                "schemaVersion": "p2a-work-v1",
                "sessionId": body["sessionId"],
                "problemHash": body["problemHash"],
                "contractVersion": body["contractVersion"],
                "taskId": body["task"]["taskId"],
                "goalId": body["task"]["goalId"],
                "scopeId": body["task"]["scopeId"],
                "routeId": body["route"]["routeId"],
                "sourceRequestId": body["sourceRequestId"],
                "claim": "answer closure fixture",
                "derivation": "answer closure fixture derivation",
                "assumptions": [],
                "dependencies": body["task"]["inputArtifactRefs"],
                "pendingObligations": [],
                "suggestedChecks": checks,
                "deliveryStatus": "COMPLETE",
                "candidateProposal": candidate,
            }
        )

    def _answer(self, body, answer_calls):
        raise NotImplementedError


class OptionClosureClient(ClosureClient):
    ANSWER_SUFFIX = "ANSWER_REQUEST"

    def _answer(self, body, answer_calls):
        if self._closure:
            return (
                "A、C、D",
                [
                    "CERT1|CHECK|C1|EVALUATE|A true => PASS",
                    "CERT1|CHECK|C2|EVALUATE|D true => PASS",
                    "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
                    "CERT1|FINAL|A、C、D",
                ],
            )
        if answer_calls == 1:
            return "A", []
        return (
            "A、C",
            [
                "CERT1|CHECK|C1|EVALUATE|A true => PASS",
                "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE",
                "CERT1|FINAL|A、C",
            ],
        )


def test_option_coverage_closure_completes_every_stated_option(process_tracker):
    client = OptionClosureClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(
        "选择正确选项：\nA. 甲\nB. 乙\nC. 丙\nD. 丁",
        {"source": "e2e"},
    )

    assert result["status"] == "candidate"
    assert result["final_response"] == "A、C、D"
    assert client.closure_turns == 1
    assert client.answer_calls == 3
    assert process_tracker


class DegreeClosureClient(ClosureClient):
    def _answer(self, body, answer_calls):
        if self._closure:
            return (
                ALEXANDER_POLYNOMIAL,
                [
                    "CERT1|CHECK|C1|MAXIMAL_MINORS|all maximal minors agree => PASS",
                    "CERT1|FINAL|"
                    + ALEXANDER_POLYNOMIAL,
                ],
            )
        return "t^2 - t + 1", []


def test_degree_closure_preserves_the_exact_invariant_degree(process_tracker):
    client = DegreeClosureClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=14,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(
        "给定矩阵 M，计算亚历山大多项式 P(t) 使用其子式的行列式。",
        {"source": "e2e"},
    )

    assert result["status"] == "candidate"
    assert result["final_response"] == ALEXANDER_POLYNOMIAL
    assert client.exact_turns == 1
    assert client.closure_turns == 1
    assert result["metrics"]["effect_calls"] == 1
    assert result["metrics"]["routed"] >= 1
    assert result["metrics"]["obeyed"] >= 1
    assert result["metrics"]["observation_used"] >= 1
    assert "exact_check_expr" in result["metrics"]["tool_names"]
    assert process_tracker


class NormalizationClosureClient(ClosureClient):
    ANSWER_SUFFIX = "ANSWER_REQUEST"

    def _answer(self, body, answer_calls):
        if self._closure:
            return (
                "2*exp(-x^2/5)/sqrt(5*pi)",
                [
                    "CERT1|CHECK|C1|DENSITY_CHECK|integral over R = 1 => PASS",
                    "CERT1|FINAL|2*exp(-x^2/5)/sqrt(5*pi)",
                ],
            )
        return "4*exp(-x^2/2)/sqrt(2*pi)", []


def test_normalization_closure_requires_a_normalized_density(process_tracker):
    client = NormalizationClosureClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve("求随机变量 X 的概率密度函数 f(x)。", {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "2*exp(-x^2/5)/sqrt(5*pi)"
    assert client.closure_turns == 1
    assert process_tracker


class CompletenessClosureClient(ClosureClient):
    ANSWER_SUFFIX = "EXHAUSTIVENESS"

    def _answer(self, body, answer_calls):
        if self._closure:
            return (
                "{-1,1}",
                [
                    "CERT1|CHECK|C1|CASE_SPLIT|both signs satisfy x^2=1 => PASS",
                    "CERT1|COMPLETENESS|quadratic has exactly two roots, both listed => PASS",
                    "CERT1|FINAL|{-1,1}",
                ],
            )
        return "{1}", []


def test_solution_completeness_closure_returns_the_whole_exact_set(process_tracker):
    client = CompletenessClosureClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=0,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve("求方程 x^2 = 1 的所有解。", {"source": "e2e"})

    assert result["status"] == "candidate"
    assert result["final_response"] == "{-1,1}"
    assert client.closure_turns == 1
    assert process_tracker


class InterpolationToolClient(FakeClient):
    """Fake model that obeys the unified interpolation math asset once."""

    def __init__(self):
        super().__init__()
        self.interpolation_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "MATH ASSET TURN" in system and self.interpolation_turns == 0:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.interpolation_turns += 1
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "action": "math_asset",
                                    "assetId": "math.numerics",
                                    "target": "interpolation_fit",
                                    "input": {
                                        "points": [
                                            {"x": "0", "y": "1"},
                                            {"x": "1", "y": "4"},
                                            {"x": "2", "y": "9"},
                                        ],
                                        "expression": "x^2+2*x+1",
                                        "variable": "x",
                                    },
                                }
                            ),
                        },
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_interpolation_tool_observation_reaches_a_candidate(
    process_tracker, monkeypatch
):
    # Use the workspace build so this slice is exercised without rebuilding the
    # separately shipped release bundle.
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")
    client = InterpolationToolClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(
        "给定数据点 (0,1)、(1,4)、(2,9)，用拉格朗日插值求过这些点的多项式。",
        {"source": "e2e"},
    )

    assert result["status"] == "candidate"
    assert result["final_response"]
    assert client.interpolation_turns == 1
    assert result["metrics"]["asset_calls"] == 1
    assert result["metrics"]["tool_effect_calls"] == 1
    assert process_tracker


class GroupStructureToolClient(FakeClient):
    """Fake model that obeys the unified group-structure math asset once."""

    def __init__(self):
        super().__init__()
        self.group_turns = 0

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        if "MATH ASSET TURN" in system and self.group_turns == 0:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.group_turns += 1
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "action": "math_asset",
                                    "assetId": "math.algebraic-structures",
                                    "target": "group_structure",
                                    "input": {
                                        "generators": ["(12)", "(123)"],
                                        "degree": 3,
                                    },
                                }
                            ),
                        },
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)


def test_group_structure_tool_observation_reaches_a_candidate(
    process_tracker, monkeypatch
):
    # Use the workspace build so this slice is exercised without rebuilding the
    # separately shipped release bundle.
    monkeypatch.setenv("ASTRA_STDIO_RUNTIME", "dev")
    client = GroupStructureToolClient()
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=12,
        max_work_units=8,
        max_effects=1,
        max_reviews=0,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    result = agent.solve(
        "在 S_3 中，求由置换 (12) 和 (123) 生成的子群的阶、元素阶与共轭类。",
        {"source": "e2e"},
    )

    assert result["status"] == "candidate"
    assert result["final_response"]
    assert client.group_turns == 1
    assert result["metrics"]["asset_calls"] == 1
    assert result["metrics"]["tool_effect_calls"] == 1
    # A later WORK request carries the exact tool observation, so the
    # candidate is produced after the model has seen the group bookkeeping.
    observations = []
    for messages, _, _ in client.seen:
        body = json.loads(messages[1]["content"])
        observations.extend(
            json.loads(row["observation"])
            for row in body.get("toolObservations", [])
            if row["source"] == "PROGRAM_OBSERVATION"
        )
    assert any(
        row["result"]["order"] == 6
        and row["result"]["element_orders"] == {"1": 1, "2": 3, "3": 2}
        for row in observations
    )
    assert process_tracker
