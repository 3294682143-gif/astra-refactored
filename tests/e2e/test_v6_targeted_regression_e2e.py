"""End-to-end targeted regression suite on real benchmark problems (Stage V6-6).

Executes the full public ReasoningAgent.solve -> Node stdio-runtime -> Python
astra_bridge -> use_math_asset -> declarative ANSWER_CLOSURE -> R2/R4 review
verification pipeline on the real benchmark problem statements:
1. Symmetric group S_6 cycle power and conjugation word evaluation (idx=5)
2. Symmetric binomial two-sided normal quantile allocation threshold (idx=12)
3. 1D random walk harmonic function 2D solution space basis (idx=16)
4. Fourier-transformed 1D periodic Laplacian operator (idx=21)
5. 4x4 presentation matrix Alexander polynomial invariant via maximal minors (idx=34)
6. Open-set neighborhood intersection proposition counterexample refutation (idx=36)
7. Post-consensus ANSWER_CLOSURE projection consistency without CERT1|FINAL row (idx=15, idx=33)
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


class V6TargetedClient(FakeClient):
    """Drives real ReasoningAgent.solve with an initial historical wrong answer
    that must be caught by math_asset observation + declarative ANSWER_CLOSURE.
    """

    def __init__(
        self,
        *,
        asset_call: dict | None,
        initial_candidate: str,
        initial_checks: list[str],
        repaired_candidate: str,
        repaired_checks: list[str],
        answer_suffix: str = "ANSWER_REQUEST",
    ):
        super().__init__()
        self.asset_call = asset_call
        self.initial_candidate = initial_candidate
        self.initial_checks = initial_checks
        self.repaired_candidate = repaired_candidate
        self.repaired_checks = repaired_checks
        self.answer_suffix = answer_suffix
        self.asset_turns = 0
        self.closure_turns = 0
        self.answer_calls = 0
        self._in_closure = False

    def chat(self, messages, temperature=0.2, max_tokens=8192):
        system = messages[0]["content"]
        self._in_closure = "ANSWER CLOSURE." in system
        if self._in_closure:
            self.closure_turns += 1
        if ("MATH ASSET TURN" in system or "EXACT CHECK TURN" in system) and self.asset_call is not None and self.asset_turns == 0:
            self.seen.append((messages, temperature, max_tokens))
            self.calls += 1
            self.asset_turns += 1
            return {
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(self.asset_call, ensure_ascii=False),
                        },
                    }
                ]
            }
        return super().chat(messages, temperature=temperature, max_tokens=max_tokens)

    def _is_answer_task(self, body):
        suffix = body["task"]["taskId"].rsplit(":", 1)[-1]
        return suffix in (self.answer_suffix, "CANDIDATE_VALIDITY", "ANSWER_REQUEST", "EXHAUSTIVENESS")

    def _work(self, body):
        if not self._is_answer_task(body):
            return super()._work(body)
        self.answer_calls += 1
        if self._in_closure:
            cand = self.repaired_candidate
            checks = self.repaired_checks
        else:
            cand = self.initial_candidate
            checks = self.initial_checks if self.answer_calls >= 2 else []
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
                "claim": "v6 targeted regression claim",
                "derivation": "v6 targeted regression derivation",
                "assumptions": [],
                "dependencies": body["task"]["inputArtifactRefs"],
                "pendingObligations": [],
                "suggestedChecks": checks,
                "deliveryStatus": "COMPLETE",
                "candidateProposal": cand,
            },
            ensure_ascii=False,
        )


def _run_agent(client: V6TargetedClient, problem: str) -> dict:
    agent = user_agent.ReasoningAgent(
        client=client,
        engine="ts",
        max_model_calls=14,
        max_work_units=8,
        max_effects=1,
        max_reviews=1,
        max_repairs=1,
        max_consensus=1,
        max_method_loads=0,
    )
    return agent.solve(problem, {"source": "v6-regression"})


def test_v6_idx05_permutation_word_eval_closes_wrong_conjugation(process_tracker):
    r"""idx=5: \sigma=(12345) \in S_6, \sigma^{-2}=(14253), \sigma^{-1}(126)\sigma=(165).
    Verifies right-to-left standard composition and closure repair of (236) -> (165).
    """
    problem = "设$\\sigma=(12345)\\in S_6$,则$\\sigma^{-2}=(\\quad),\\sigma^{-1}(126)\\sigma=(\\quad)$"
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.algebraic-structures",
            "target": "permutation_word_eval",
            "input": {
                "cycles_map": {"sigma": [[1, 2, 3, 4, 5]], "tau": [[1, 2, 6]]},
                "word": ["sigma^-2"],
                "words": ["sigma^-2", "sigma^-1 * tau * sigma"],
                "degree": 6,
            },
        },
        initial_candidate="$\\sigma^{-2}=(14253)$，$\\sigma^{-1}(126)\\sigma=(236)$",
        initial_checks=[
            "CERT1|CHECK|C1|EVALUATE|sigma^-2 = (14253) => PASS",
            "CERT1|FINAL|$\\sigma^{-2}=(14253)$，$\\sigma^{-1}(126)\\sigma=(236)$",
        ],
        repaired_candidate="$\\sigma^{-2}=(14253)$，$\\sigma^{-1}(126)\\sigma=(165)$",
        repaired_checks=[
            "CERT1|CHECK|C1|EVALUATE|sigma^-2 = (14253), sigma^-1(126)sigma = (165) => PASS",
            "CERT1|FINAL|$\\sigma^{-2}=(14253)$，$\\sigma^{-1}(126)\\sigma=(165)$",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert "(14253)" in res["final_response"] and "(165)" in res["final_response"]
    assert "(236)" not in res["final_response"]
    assert client.asset_turns == 1
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx12_two_sided_normal_quantile_closes_one_sided_5117(process_tracker):
    """idx=12: 10000 independent binary choices with alpha=0.01 symmetric two-sided bound.
    Verifies continuousProbabilityWording does not misroute to enumerate,
    sampling_distribution_quantiles computes 5129 (two-sided) vs 5117 (one-sided),
    and closure rejects 5117 in favor of 5129.
    """
    problem = (
        "某地区有 $10000$ 名独立个体，每个个体等可能地从两个对称场所中任选一个。"
        "若要求两个场所均不发生溢出的概率不小于 $99\\%$，每个场所至少应配置多少个位置？"
        "($\\Phi(2.33)=0.99$, $\\Phi(2.58)=0.995$, $\\Phi(2.326)=0.99$, $\\Phi(2.576)=0.995$, $\\Phi$ 是标准正态函数)"
    )
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.statistics",
            "target": "sampling_distribution_quantiles",
            "input": {
                "dist_type": "normal",
                "alpha": 0.01,
                "two_sided": True,
                "compound_n": 10000,
                "compound_p": 0.5,
            },
        },
        initial_candidate="5117",
        initial_checks=[
            "CERT1|CHECK|C1|QUANTILE|5000 + 2.33*50 = 5116.5 => PASS",
            "CERT1|FINAL|5117",
        ],
        repaired_candidate="5129",
        repaired_checks=[
            "CERT1|CHECK|C1|QUANTILE|two-sided alpha=0.01 gives 5000 + 2.576*50 = 5128.8 -> 5129 => PASS",
            "CERT1|FINAL|5129",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == "5129"
    assert client.asset_turns == 1
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx16_harmonic_function_2d_basis_closes_1d_family(process_tracker):
    """idx=16: 1D random walk harmonic functions Lf = 0 have 2D basis {1, ((1-p)/p)^x}.
    Verifies characteristic_general_solution symbolic roots and closure rejection of
    1D family c((1-p)/p)^x missing the constant mode.
    """
    problem = (
        "考虑$\\mathbb{Z}$上的随机游走,其转移概率为$p(x,x-1)=p,p(x,x+1)=1-p$,其中$p\\neq \\frac{1}{2}$。"
        "找到所有满足$Lf=0$的调和函数$f:\\mathbb{Z}\\to\\mathbb{R}$。"
    )
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.recurrence",
            "target": "characteristic_general_solution",
            "input": {
                "characteristic_coeffs": ["p", "-1", "1-p"],
                "var": "x",
            },
        },
        initial_candidate="$f(x)=c\\left(\\frac{1-p}{p}\\right)^x$",
        initial_checks=[
            "CERT1|CHECK|C1|SUBSTITUTE|Lf=0 => PASS",
            "CERT1|COMPLETENESS|characteristic equation solved => PASS",
            "CERT1|FINAL|$f(x)=c\\left(\\frac{1-p}{p}\\right)^x$",
        ],
        repaired_candidate="$f(x)=A+B\\left(\\frac{1-p}{p}\\right)^x$（$A,B\\in\\mathbb{R}$为任意常数）",
        repaired_checks=[
            "CERT1|CHECK|C1|SUBSTITUTE|L(1)=0 and L(((1-p)/p)^x)=0 => PASS",
            "CERT1|COMPLETENESS|2nd-order linear recurrence has 2D solution space spanned by 1 and ((1-p)/p)^x => PASS",
            "CERT1|FINAL|$f(x)=A+B\\left(\\frac{1-p}{p}\\right)^x$（$A,B\\in\\mathbb{R}$为任意常数）",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert "A+B" in res["final_response"]
    assert client.asset_turns == 1
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx21_circle_laplacian_zero_eigenvalue_at_zero_mode(process_tracker):
    """idx=21: Circle Laplacian applied to constant mode n=0 gives 0.
    Verifies circle_laplacian observation and exact scalar closure.
    """
    problem = "求单位圆 $S^1$ 上的拉普拉斯算子作用于常数函数 $f(\\theta)=1$ 的结果。"
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.differential",
            "target": "circle_laplacian",
            "input": {"expression": "1"},
        },
        initial_candidate="2*pi",
        initial_checks=[
            "CERT1|CHECK|C1|EVALUATE|integral is 2*pi => PASS",
            "CERT1|FINAL|2*pi",
        ],
        repaired_candidate="0",
        repaired_checks=[
            "CERT1|CHECK|C1|CIRCLE_LAPLACIAN|d^2(1)/dtheta^2 = 0 => PASS",
            "CERT1|FINAL|0",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == "0"
    assert client.asset_turns == 1
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx34_alexander_polynomial_closes_without_cert_final_crash(process_tracker):
    """idx=34: 4x4 presentation matrix Alexander polynomial P(t) = t^6 - 5*t^5 + 10*t^4 - 13*t^3 + 10*t^2 - 5*t + 1.
    Also reproduces the exact v10 failure mode where the ANSWER CLOSURE packet omits CERT1|FINAL|
    while R2 review is enabled (max_reviews=1), verifying zero FIELD_VALUE crash in agent_history.py!
    """
    problem = (
        "给定亏格为 1 的闭可定向曲面上的展示矩阵\n"
        "$$ M = \\begin{pmatrix} -t^2+2t-1 & -t & t & t^2-2t+1 \\\\ "
        "t^2-2t+1 & -t^2+2t-1 & -t & t \\\\ "
        "t & t^2-2t+1 & -t^2+2t-1 & -t \\\\ "
        "-t & t & t^2-2t+1 & -t^2+2t-1 \\end{pmatrix} $$\n"
        "利用 $M$ 的三阶子式的行列式计算亚历山大多项式 $P(t)$。"
    )
    expected_poly = "t^6 - 5*t^5 + 10*t^4 - 13*t^3 + 10*t^2 - 5*t + 1"
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.linear-algebra",
            "target": "maximal_minors",
            "input": {
                "matrix": [
                    ["-t**2+2*t-1", "-t", "t", "t**2-2*t+1"],
                    ["t**2-2*t+1", "-t**2+2*t-1", "-t", "t"],
                    ["t", "t**2-2*t+1", "-t**2+2*t-1", "-t"],
                    ["-t", "t", "t**2-2*t+1", "-t**2+2*t-1"],
                ],
                "variable": "t",
            },
        },
        initial_candidate="t^2 - t + 1",
        initial_checks=[
            "CERT1|CHECK|1|ALGEBRAIC|det(B)=t^2-t+1 => PASS",
            "CERT1|FINAL|t^2 - t + 1",
        ],
        # Intentionally omit CERT1|FINAL| in repaired_checks to test the exact v10 #15/#33/#34 crash fix!
        repaired_candidate=expected_poly,
        repaired_checks=[
            f"CERT1|CHECK|1|DEGREE_CONSERVATION|maximal minor gcd is {expected_poly} => PASS",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == expected_poly
    assert client.asset_turns == 1
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx36_multiple_choice_option_closure_delivers_acd(process_tracker):
    """idx=36: Open neighborhood propositions where A, C, D are true and B is false.
    Verifies option coverage closure repairs single-letter B to A, C, D with R2 review active.
    """
    problem = (
        "设 $S \\subseteq \\mathbb{R}^n$，集合 $U$ 满足存在开集 $O$ 使得 $S \\subseteq O \\subseteq U$。"
        "判断下列命题哪些正确：\n"
        "A. 若 $A \\subseteq B$，则 $B$ 的包含 $A$ 的开集性质保持\n"
        "B. 任意两个包含 $S$ 的此类集合的交集是开集\n"
        "C. 任意有限个包含 $S$ 的此类集合的交集仍包含某个含 $S$ 的开集\n"
        "D. 若 $U$ 是开集且 $S \\subseteq U$，则 $U$ 满足该性质"
    )
    client = V6TargetedClient(
        asset_call=None,
        initial_candidate="B",
        initial_checks=[
            "CERT1|CHECK|C1|EVALUATE|checked B => PASS",
            "CERT1|FINAL|B",
        ],
        repaired_candidate="A, C, D",
        repaired_checks=[
            "CERT1|OPTIONS|A=TRUE,B=FALSE,C=TRUE,D=TRUE",
            "CERT1|CHECK|C1|COUNTEREXAMPLE|B is refuted by U1=U2=(-1,1)\\cup{2} whose intersection is not open => PASS",
            "CERT1|FINAL|A, C, D",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == "A, C, D"
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx15_density_closure_without_cert_final_row_delivers_candidate(process_tracker):
    """idx=15: Asymptotic lognormal density closure where the ANSWER CLOSURE packet
    omits CERT1|FINAL| while R2 review is active (reproducing the exact v10 #15 crash).
    """
    problem = (
        "设独立同分布正随机变量序列满足对数中心极限定理，求首项极限分布与第二项极限概率密度函数 $f(x)$。"
    )
    expected_ans = "退化分布于点1; f(x)=\\frac{1}{x\\sqrt{2\\pi}}e^{-(\\ln x)^2/2},\\ x>0"
    client = V6TargetedClient(
        asset_call={
            "action": "math_asset",
            "assetId": "math.probability",
            "target": "density_check",
            "input": {
                "expression": "exp(-log(x)**2/2)/(x*sqrt(2*pi))",
                "variable": "x",
                "lower": "0",
                "upper": "oo",
            },
        },
        initial_candidate="\\delta_e; f(x)=\\frac{1}{x\\sqrt{2\\pi}}e^{-(\\ln x)^2/2}",
        initial_checks=[
            "CERT1|CHECK|1|EVALUATE|limit is e => PASS",
            "CERT1|FINAL|\\delta_e; f(x)=\\frac{1}{x\\sqrt{2\\pi}}e^{-(\\ln x)^2/2}",
        ],
        # Omit CERT1|FINAL| in repaired_checks to verify agent_history.py projection fix on idx=15
        repaired_candidate=expected_ans,
        repaired_checks=[
            "CERT1|CHECK|1|LIMIT|1/n -> 0 so limit is 1 => PASS",
            "CERT1|CHECK|2|DENSITY_CHECK|integral_{0}^{oo} 1/(x*sqrt(2*pi))*exp(-(ln x)^2/2) dx = 1 => PASS",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == expected_ans
    assert client.closure_turns == 1
    assert process_tracker


def test_v6_idx33_option_closure_without_cert_final_row_delivers_ad(process_tracker):
    """idx=33: Multiple-choice option closure where the ANSWER CLOSURE packet repairs
    CERT1|OPTIONS| without repeating CERT1|FINAL| while R2 review is active (reproducing v10 #33).
    """
    problem = (
        "设 $(X,\\mathcal{F},\\mu)$ 为测度空间，判断下列关于可测函数收敛性的命题哪些正确：\n"
        "A. 处处收敛蕴含依测度收敛（有限测度下）\n"
        "B. 依测度收敛蕴含处处收敛\n"
        "C. $L^1$ 收敛蕴含处处收敛\n"
        "D. $L^1$ 收敛蕴含依测度收敛"
    )
    client = V6TargetedClient(
        asset_call=None,
        initial_candidate="A, D",
        # Missing CERT1|OPTIONS| triggers OPTION_COVERAGE closure, and repaired packet omits CERT1|FINAL|
        initial_checks=[
            "CERT1|CHECK|1|EVALUATE|A and D hold => PASS",
            "CERT1|FINAL|A, D",
        ],
        repaired_candidate="A, D",
        repaired_checks=[
            "CERT1|OPTIONS|A=TRUE,B=FALSE,C=FALSE,D=TRUE",
            "CERT1|CHECK|1|EVALUATE|A true by Egorov, D true by Markov inequality => PASS",
        ],
    )
    res = _run_agent(client, problem)
    assert res["status"] == "candidate"
    assert res["final_response"] == "A, D"
    assert client.closure_turns == 1
    assert process_tracker

