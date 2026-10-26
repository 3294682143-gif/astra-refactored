# 100 题真实模型复跑与语义复核（2026-10-26）

- 输入：`/home/ma-user/work/input/test0.txt`，sha256 `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`
- 证据：`/tmp/astra-full100-final2-20261026`（真实 Intern-S2、`item_concurrency=12`、`max_effects=2`、`max_method_loads=2`、factory `real_client_factory_fast_20261026`）
- 机器口径：**94/100 交付候选**（88 `REVIEWS_COMPLETE`、6 `REVIEW_STOP`）；6 题未交付（1 超时、3 FIELD_VALUE、1 BUDGET、1 PACKET_REJECTED）
- 调用：1594 次；token：13,003,477；`retry_count=0`、`remote_outcome_unknown=0`、`unknown_usage_requests=0`
- 本地 `ReferenceJudge`：22/100（严格格式匹配，不是数学准确率）
- 独立语义判分（`/tmp/astra-full100-final2-semantic.jsonl`，非官方）：**74 CORRECT / 26 INCORRECT**；其中 6 题无候选
- 定向补跑 6 题（`/tmp/astra-fail6-final-20261026`）：4 题恢复候选，2 题仍失败；并集 **98/100 候选**，语义并集 **76/100 CORRECT**

## 与 §25 基线的对照

| 口径 | 2026-10-25 `bd98a87` | 2026-10-26 本轮 | 变化 |
|---|---:|---:|---:|
| 候选 | 70/100 | **94/100**（并集 98/100） | +24（并集 +28） |
| 语义正确 | 58/100 | **74/100**（并集 76/100） | +16（并集 +18） |
| CONTROL_REJECTED | 22 | **0** | -22 |
| 调用 | 1226 | 1594 | +368 |
| token | 9,532,989 | 13,003,477 | +3,470,488 |

## 非 CORRECT 逐题（自动语义判分）

| 题号 | 运行状态 | stopReason | 语义 | 判分理由（截断） |
|---:|---|---|---|---|
| 1 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate answer incorrectly identifies the splitting field as Q(\sqrt[4]{5}, i) (degree 8) rather than Q(5^{1/4}, \zeta_8) (degree 16). The correct splitting field requires the 8th root of unity \zeta_8, which involves \sqrt{2} in addition to i, making the actual degree 16 instead of 8. |
| 5 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate's second cycle (156) is not equal to the reference answer (165). Specifically, σ⁻¹(126)σ maps 1→6, 6→5, 5→1 which is (165), whereas (156) represents a different permutation (1→5, 5→6, 6→1). The first entry (14253) is correct, but the second entry is wrong. |
| 11 | None |  | INCORRECT | no candidate |
| 12 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate answer 5117 is not mathematically equal to the reference answer 5129. |
| 15 | unsolved | ERROR | INCORRECT | no candidate |
| 16 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer gives the general invariant measure as π_x = A + B((1-p)/p)^x, which includes an additive constant term A (valid because the homogeneous equation π=πP has constant solutions). The candidate answer only provides the geometric term C((1-p)/p)^x, omitting the constant term A, and t |
| 18 | candidate | REVIEW_STOP | INCORRECT | The candidate answer gives the CDF as 2Φ(x√2)Φ(x)−1, which does not match the reference answer 2Φ(√(2/5) a)−1. The candidate's expression is algebraically different (involving a product of two Φ terms and an incorrect scaling), making it mathematically inequivalent to the reference distribution. |
| 20 | unsolved | ERROR | INCORRECT | no candidate |
| 22 | candidate | REVIEW_STOP | INCORRECT | The candidate answer omits the required factor (-1)^n/(4^n c^{2n}) present in the reference coefficients. Consequently the given power series does not satisfy the PDE (except in the special case c = 1/2), so it is not mathematically equivalent to the reference answer. |
| 26 | candidate | REVIEW_STOP | INCORRECT | The reference answer gives the Laplacian restricted to the circle (the angular/second tangential derivative), which equals 0. The candidate answer 4 corresponds to the ambient planar Laplacian Δf = 4, not the Laplacian on the circle, so it fails to answer the question as posed. |
| 28 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer includes both C and E as correct. Candidate answer only lists E, omitting option C (the Heine-Borel characterization), so it fails to cover all requested correct parts. |
| 34 | unsolved | ERROR | INCORRECT | no candidate |
| 36 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate answer only lists A and C, missing the correct statement D. Therefore the answer is incomplete and does not match the reference answer A, C, D. |
| 42 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer evaluates to approximately 111.1 kg (240 - 475√30/18 ≈ 111.1), while the candidate answer is 95.46 kg. The values differ by roughly 15.6 kg, which is a significant numerical discrepancy. Therefore the candidate answer is not mathematically equivalent to the reference answer. |
| 43 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer specifies only 'symmetric' (对称), while the candidate answer claims the relation is an equivalence relation (reflexive, symmetric, transitive). These are not mathematically equivalent: the candidate asserts additional properties (reflexivity and transitivity) beyond the single pr |
| 47 | candidate | REVIEWS_COMPLETE | INCORRECT | The correct answer requires selecting statements A, C, and D. The candidate answer only includes C and D, omitting A, so it is incomplete. |
| 48 | unsolved | PACKET_REJECTED | INCORRECT | no candidate |
| 49 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate answer has an extra negative sign. The determinant evaluates to +(x²+y²+z²+w²)², so -(x²+y²+z²+w²)² is not equivalent. |
| 57 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer lists multiple valid discretization methods (finite difference, finite element, or finite volume), while the candidate answer only provides one method (finite difference), which is incomplete compared to the reference. |
| 60 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate provides '线性代数' (linear algebra), which is a field of mathematics, whereas the blank requires '线性方程组' (system of linear equations), which is the specific type of system being solved. The terms are not semantically equivalent in this context. |
| 64 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer states the statement is correct (正确), but the candidate answer claims it is false (假), which contradicts the reference answer. |
| 76 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer lists general methodological categories (移动平均法/Moving Average Method, 时间序列分解法/Time Series Decomposition Method) as typically taught in introductory Chinese statistics textbooks, while the candidate answer provides specific software implementations/algorithms (X-11, TRAMO/SEATS)  |
| 83 | candidate | REVIEWS_COMPLETE | INCORRECT | The reference answer identifies the histogram (A) as the correct choice for quickly understanding the basic characteristics of a large dataset, but the candidate selected the box plot (C), which does not match the reference. |
| 86 | unsolved | ERROR | INCORRECT | no candidate |
| 94 | candidate | REVIEWS_COMPLETE | INCORRECT | The candidate answer only selects option B, but the reference answer is D (All of the above). Since the response misses other valid possibilities and does not match the reference, it is incorrect. |
| 95 | candidate | REVIEWS_COMPLETE | INCORRECT | 非线性回归模型的参数估计通常（最常用、标准）方法是最小二乘法（A）。牛顿-拉夫森法仅是用于求解最小二乘问题的数值优化算法，而非独立的估计方法；极大似然法需依赖误差分布假设，并非非线性回归的通用默认方法。因此'B、C均正确'不成立，标准答案应为A而非D。 |

## 人工边界说明

- #1 的参考答案 `Q(5^{1/4},ζ8)/16` 在 HANDOFF §10.3 已被记录为“不是最小分裂域”；自动判分仍按参考判 INCORRECT，不能直接把该题算成模型错误。
- #64、#95 在 §25 已被标为“参考本身有争议/歧义”；本轮自动判分仍可能把它们判为 INCORRECT。
- 自动语义判分允许格式/等价写法差异，但不是官方评测；本文的 74/100 与 76/100 不是平台成绩。
- 6 个未交付中，#15、#48 定向补跑仍失败；其余 4 题补跑出候选，但其中 2 题答案仍错。
