# A 组 100 题逐项复核 v3（`/tmp/astra-full100-c9`）

> **并列口径声明**：这是 2026-10-21 的**复核批次 A**（本文）。仓库里另有一份
> 2026-10-22 的**批次 B**：`docs/ITEM_AUDIT_20261022.md` / HANDOFF §11.1，
> 结论 73 正确 / 19 错误 / 5 争议 / 3 未解。两次复核相互独立、方法不同，
> 结果相差 ≤1 个“正确档”（A 的 77 正确 ≈ B 的 73 正确 + 5 争议中的 4），
> 所以**“约 77/100 正确、约 20/100 错误”是当前可信区间**，不要拿单次结果当平台分。
> 两批都认定 `#1` 的参考答案有误、`#64` 参考值有误。
复核方式：4 名评审先各审 24–25 题（第一遍），再把 74 道非未解题交给 3 名对抗评审重判（“try to break the verdict”：只允许在记号/等价形式/参考本身错误时翻案）。另以本地严格判分器（格式敏感的 ReferenceJudge）做第三路交叉核对。
## 汇总

| 口径 | 正确 | 错误 | 未解 | 说明 |
| --- | --- | --- | --- | --- |
| 逐项复核（本次） | **77** | **20** | **3** | 74 题经二轮对抗复核，23 题为单轮 |
| 严格 ReferenceJudge | 23 | 77 | 0 | 纯字符串匹配，把同义/等价写法判错 |

被二轮复核推翻的初判：`52`、`69`（初判错→实为对）、`94`（初判对→实为错，漏 D）。

## 逐题

| idx | 运行状态 | 复核判定 | 复核来源 | 依据 |
| --- | --- | --- | --- | --- |
| 0 | candidate | **correct** | first-pass-only | image of an ideal need not be an ideal without surjectivity, but the inverse image of a maximal ideal is prime |
| 1 | candidate | **incorrect** | verified | candidate field Q(nrt5,i) deg 8 contains no root; ref deg 16 also wrong |
| 2 | candidate | **correct** | first-pass-only | D is C[y], a PID, while A and C are not domains and Z[x] is not a PID |
| 3 | candidate | **correct** | verified | B and D hold |
| 4 | candidate | **correct** | first-pass-only | A4 has identity, three double transpositions, and two classes of 3-cycles, giving four classes |
| 5 | candidate | **correct** | verified | sigma^-2=(14253) and conjugate (165) |
| 6 | candidate | **incorrect** | verified | inverse does not multiply to 1; reference inverse is right |
| 7 | candidate | **correct** | verified | A and B hold under standard convention |
| 8 | candidate | **correct** | verified | Z not p-adically complete so not compact |
| 9 | candidate | **correct** | verified | limit 2/pi |
| 10 | candidate | **correct** | first-pass-only | uniform integrability with convergence in measure gives L1 convergence |
| 11 | unsolved | **unsolved** | run | run produced no candidate |
| 12 | candidate | **incorrect** | verified | two-sided overflow needs z=2.58, x=5129 |
| 13 | candidate | **correct** | verified | only (2) true; all five match |
| 14 | candidate | **correct** | verified | comonotone coupling gives stated W2 |
| 15 | unsolved | **unsolved** | run | run produced no candidate |
| 16 | candidate | **incorrect** | verified | drops constant invariant measure and double-root family |
| 17 | candidate | **correct** | verified | running maximum not Markov |
| 18 | candidate | **incorrect** | verified | exact CDF is 2Phi(sqrt(2/5)a)-1 |
| 19 | candidate | **correct** | verified | identity  |
| 20 | candidate | **incorrect** | verified | value right but requested contour not stated |
| 21 | candidate | **correct** | verified | affine conic H^1=0 |
| 22 | candidate | **incorrect** | verified | series must alternate, candidate has wrong sign |
| 23 | candidate | **correct** | first-pass-only | modes 15, 45/2 cos x, 9 cos 2x, 3/2 cos 3x with stated decays |
| 24 | candidate | **correct** | verified | half-line formula matches |
| 25 | candidate | **correct** | verified | mean curvature 1/2 |
| 26 | candidate | **incorrect** | verified | intrinsic Laplacian on circle is 0 |
| 27 | candidate | **correct** | verified | connection form convention-equivalent |
| 28 | candidate | **correct** | verified | C and E correct |
| 29 | candidate | **incorrect** | verified | full answer is B,C,D; "3" is not options |
| 30 | candidate | **correct** | verified | P3(x)=(5x^3-3x)/2 |
| 31 | candidate | **correct** | verified | det J = e^{2x} |
| 32 | candidate | **correct** | verified | Cauchy and complete |
| 33 | candidate | **correct** | verified | A and D correct |
| 34 | candidate | **incorrect** | verified | all minors equal the degree-6 product |
| 35 | candidate | **correct** | first-pass-only | a single vertex is the smallest nontrivial complex, dimension 0 |
| 36 | candidate | **incorrect** | verified | answer set is A,C,D |
| 37 | candidate | **correct** | verified | n=0 |
| 38 | candidate | **correct** | verified | 273.32 |
| 39 | candidate | **correct** | verified | about 13:55 |
| 40 | candidate | **correct** | first-pass-only | exactness requires M_y=N_x, option B |
| 41 | candidate | **correct** | verified | stated y matches |
| 42 | candidate | **correct** | verified | 95.462 kg |
| 43 | candidate | **incorrect** | verified | relation fails transitivity, only symmetry holds |
| 44 | candidate | **correct** | first-pass-only | every finite total order is well ordered |
| 45 | candidate | **incorrect** | verified | composed in reverse order |
| 46 | candidate | **correct** | verified | B,C,E true |
| 47 | candidate | **incorrect** | verified | A is true for nonempty bounded polyhedra |
| 48 | unsolved | **unsolved** | run | run produced no candidate |
| 49 | candidate | **correct** | first-pass-only | the determinant is (x^2+y^2+z^2+w^2)^2 |
| 50 | candidate | **correct** | verified | both bisector planes |
| 51 | candidate | **correct** | verified | P^-1 M P matches |
| 52 | candidate | **correct** | verified | differs from reference only by swapping dummy indices |
| 53 | candidate | **correct** | verified | multiplier  |
| 54 | candidate | **correct** | verified | factor 1/3 |
| 55 | candidate | **correct** | first-pass-only | both interpolation methods pass through all data points |
| 56 | candidate | **correct** | verified | Lagrange formula |
| 57 | candidate | **correct** | verified | valid discretization |
| 58 | candidate | **correct** | verified | Runge near endpoints |
| 59 | candidate | **correct** | verified | first-order Taylor |
| 60 | candidate | **correct** | verified | blank is linear |
| 61 | candidate | **correct** | verified | survey unit definition |
| 62 | candidate | **correct** | first-pass-only | statistical analysis is the core content |
| 63 | candidate | **correct** | verified | positive correlation direction |
| 64 | candidate | **correct** | verified | reference wrong, candidate right |
| 65 | candidate | **correct** | verified | key units by share |
| 66 | candidate | **correct** | first-pass-only | unweighted mean is invalid unless plan totals are equal |
| 67 | candidate | **correct** | first-pass-only | p < alpha leads to rejecting the null hypothesis |
| 68 | candidate | **correct** | first-pass-only | regression analyses correlation/dependence among variables |
| 69 | candidate | **correct** | verified | requested rate and Wald interval correct |
| 70 | candidate | **correct** | verified | BCDE components |
| 71 | candidate | **correct** | verified | ABC quality indices |
| 72 | candidate | **correct** | verified | type I/II errors |
| 73 | candidate | **correct** | verified | variability |
| 74 | candidate | **correct** | first-pass-only | moving average method is correct |
| 75 | candidate | **correct** | verified | commensurable factor |
| 76 | candidate | **incorrect** | verified | additive/multiplicative are model forms not methods |
| 77 | candidate | **correct** | first-pass-only | between-group variance measures differences among group means |
| 78 | candidate | **correct** | verified | four blanks correct |
| 79 | candidate | **correct** | verified | both dispersion measures |
| 80 | candidate | **correct** | verified | sample mean |
| 81 | candidate | **correct** | first-pass-only | all three transformations can reduce right skew |
| 82 | candidate | **correct** | first-pass-only | with the first lower limit at 10, the value 8 falls outside the classes |
| 83 | candidate | **incorrect** | verified | histogram is the conventional answer |
| 84 | candidate | **correct** | first-pass-only | quadratic polynomial regression is suitable for the stated growth |
| 85 | candidate | **correct** | first-pass-only | weighted averaging is appropriate for multi-indicator evaluation |
| 86 | candidate | **correct** | verified | A,B,C true |
| 87 | candidate | **correct** | verified | OLS formulas |
| 88 | candidate | **correct** | verified | linearizable models |
| 89 | candidate | **correct** | first-pass-only | ridge does not select variables, so the statement is false |
| 90 | candidate | **correct** | first-pass-only | regression studies relationships described as correlation or dependence |
| 91 | candidate | **correct** | verified | R2 in [0,1] |
| 92 | candidate | **correct** | verified | partial F criterion |
| 93 | candidate | **correct** | first-pass-only | after adding a variable the included variables are retested |
| 94 | candidate | **incorrect** | verified | D is the all-of-the-above removal ground |
| 95 | candidate | **incorrect** | verified | nonlinear least squares is the method |
| 96 | candidate | **incorrect** | verified | full answer ABCD |
| 97 | candidate | **correct** | verified | no causation |
| 98 | candidate | **incorrect** | verified | claim is false as the reference says |
| 99 | candidate | **correct** | verified | autocorrelation outside time series |

## 未解 3 题的补跑（传输层）

| idx | 本题 | 补跑结果 | 复核判定 |
| --- | --- | --- | --- |
| 11 | 扑克牌花色数>点数数的概率 | `223/8330` | **正确**（与参考一致） |
| 15 | 乘积开 n 次方的弱极限 | 退化 δ₁ + 对数正态密度 | **正确**（两空都对） |
| 48 | 两个 5 级矩阵 AB/BA 可对角化判断 | “两问都正确” | **错误**（两问都错，反例 A=E12,B=E21） |

→ 带传输重试的有效口径：**79 正确 / 21 错误 / 0 未解**。

## 错误分类（20 题）

- 漏选/选项不完整（4）：`29`、`36`、`47`、`96`（另有 `94` 属同一个 D 选项问题）
- 数值/公式算错（4）：`6`（逆元）、`12`（单侧 z 值）、`18`（CDF）、`1`（分裂域取错域，同时参考给错次数）
- 完备性/多解遗漏（3）：`16`（平稳分布漏常数族）、`22`（级数符号/解族）、`45`（复合次序反）
- 概念/模型选择错（4）：`26`（圆周内在 Laplacian）、`76`、`83`、`95`
- 关系/证明类（2）：`43`（传递性）、`20`（未写出要求的半圆围道）
- 其他（3）：`34`（特征多项式降次）、`98`（异方差结论）

## 交叉信号

- 严格判分器的 23 个 A 与逐项复核的“正确”**完全一致**（23/23）。
- 严格判分器把 53 道正确答案判成 B，全部是记号/等价式/中英文差异 → 严格分不能当准确率。
- 复核中另有 4 题**参考答案本身有错**（`1` 的次数 16、`64`、`87`、`99` 的参考值），已按数学判定。
