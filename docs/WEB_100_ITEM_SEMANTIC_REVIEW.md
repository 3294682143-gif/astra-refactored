# 100 题真实模型实跑与逐题语义复核

- 分支：`feat/web-unified-math-integration`，起点提交 `bd98a87ea669bf4ef6d16341ec52d7b61a980193`
- 输入：`/home/ma-user/work/input/test0.txt`（100 行 JSONL，sha256 `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`）
- 运行器：`/home/ma-user/work/official_judge_emulator/run_judge.py`（`item_concurrency=4`、`item_timeout=1800s`、`max_model_calls=10000`、`api_concurrency=4`、`default_max_tokens=8192`、`model_max_attempts=1`、`judge_concurrency=4`）
- 客户端：`real_client_factory_retry2:build_client`（真实 Intern-S2 HTTPS 端点，`MAX_PROFILE` 注入 `engine=ts`、`max_model_calls=256`、`max_effects=2`、`max_reviews=2`、`max_method_loads=2`、`problem_seconds=1800`）
- 证据目录：`/tmp/astra-full100-bd98a87`（`outputs/` 逐题结果、`judgements/` 本地判分、`.work/` 调用日志）
- 实际耗时：约 95 分钟（12:30:50–14:05 UTC）

## 1 运行结果（机器口径）

- 完成题数：**100/100**，运行器 `status=completed`、`degraded=false`、`infra_error_count=0`
- 交付候选：**70/100**；未交付：30 题
- 模型调用：**1226** 次；报告 token：**9,532,989**
- `remote_outcome_unknown` 为真的题：**0**；`unknown_usage_requests` 合计：**0**
- 本地 ReferenceJudge（格式敏感）：A 18 / B 82 / C 0，accuracy `0.18`

停止原因分布：`REVIEWS_COMPLETE` 67、`CONTROL_REJECTED` 22、`ERROR` 8、`REVIEW_STOP` 3。

## 2 逐题语义复核（人工/独立复核口径）

- 复核 100 题：**正确 58**、部分正确 7、错误 3、判定存疑 2、未交付候选 30
- 在**已交付候选**中：正确率 58/70 = 83%（部分正确与存疑均不计入正确）

> 本地 ReferenceJudge 的 18/100 与语义复核的 58/100 差距来自格式敏感：它把等价但写法不同的答案判为 B。对外应引用语义复核口径，并明确这是**本机复核**、不是官方评测。

## 3 未交付候选的 30 题

| 题号 | stopReason | 说明 |
|---:|---|---|
| 1 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 3 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 4 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 6 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 9 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 10 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 11 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 12 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 15 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 18 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 19 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 20 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 22 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 23 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 25 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 26 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 32 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 34 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 35 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 39 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 41 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 42 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 49 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 55 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 56 | `CONTROL_REJECTED` | 控制层拒绝（模型产出的动作未被准入），无候选 |
| 57 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 58 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 59 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 60 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |
| 86 | `ERROR` | 系统级失败（预算/字段/传输），无候选 |

## 4 逐题明细（100 题）

| 题号 | 运行状态 | stopReason | 语义判定 | 说明 |
|---:|---|---|---|---|
| 0 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选A与参考答案一致；(I)因f不一定满射而错误，(II)由极大理想原像为素理想成立。 |
| 1 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 2 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | D中商环同构于C[y]，是主理想整环；其余均非整环或非PID，选D正确。 |
| 3 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 4 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 5 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | σ^{-2}=(14253)正确；但σ^{-1}(126)σ按右作用为(165)，模型答(156)是其逆，故第二空错误。 |
| 6 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 7 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | A、B正确；C缺有界等条件，D缺可测性，故选AB与参考一致。 |
| 8 | candidate | `REVIEW_STOP` | **CORRECT** | 整数集在p-adic度量下不完备且非紧，模型答No与参考一致。 |
| 9 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 10 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 11 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 12 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 13 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 五项判断均与参考一致：(1)(3)(4)(5)错，(2)对。 |
| 14 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 高斯分布间W2距离公式与参考完全一致。 |
| 15 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 16 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | 参考通解为 A+B q^x（A,B≥0 不全为零），模型仅给出 B q^x，漏掉常数不变测度 A。 |
| 17 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 布朗运动运行最大值过程不是马氏过程，与参考一致。 |
| 18 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 19 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 20 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 21 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 仿射簇上结构层高阶相干上同调消没，故H1=0，与参考一致。 |
| 22 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 23 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 24 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 系数 1/(2a√(πt)) 即 1/√(4πa²t)，初值项与边界项均与参考一致。 |
| 25 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 26 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 27 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 与参考仅指标上下位置及转置约定不同，利用Christoffel符号对称性等价。 |
| 28 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选择C、E，与参考 CE 一致。 |
| 29 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | 正确项确为B、C、D共3项，但仅写“3”未列选项，无法确定所指集合。 |
| 30 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | P₃(x)=(5x³−3x)/2，与参考仅书写顺序不同，完全等价。 |
| 31 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | A、B、C正确而D错误，与参考一致。 |
| 32 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 33 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选择A、D，与参考一致。 |
| 34 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 35 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 36 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | A、C正确（B错），但D按标准定义成立，参考含D；模型漏选D。 |
| 37 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 粘接每条带子使欧拉示性数减1，要求不变故n=0，与参考一致。 |
| 38 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 150e^{0.6}≈273.318，四舍五入即273.32。 |
| 39 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 40 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 恰当方程条件为 ∂M/∂y=∂N/∂x，模型选B，与参考一致。 |
| 41 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 42 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 43 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 兄弟关系在三个儿子间对称且非自反，额外指出的反自反性也成立。 |
| 44 | candidate | `REVIEWS_COMPLETE` | **INCORRECT** | 填空要求给出使全序集必为良序集的条件（有限），模型只答“并非每一个全序集都是良序集”，答非所问。 |
| 45 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | 按参考复合次序应得{(a,b),(b,b)}；模型主答案采用相反次序，虽补充了另一约定下的正确结果，但主答仍含错误。 |
| 46 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 正确选项 B、C、E，模型完全一致。 |
| 47 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | 参考为 A,C,D；模型仅选 C,D，漏选 A。 |
| 48 | candidate | `REVIEWS_COMPLETE` | **PARTIAL** | 两结论均正确，但模型只给“真”的结论，未给出题目要求的证明/反例骨架。 |
| 49 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 50 | candidate | `REVIEW_STOP` | **CORRECT** | 两平面法向量模长相同，角平分面为两方程加减所得，与参考一致。 |
| 51 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 按新基矩阵计算 P⁻¹MP，与参考一致。 |
| 52 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 将 -Σ∂ⱼ(bⱼv) 展开为 -Σbⱼ∂ⱼv-(div b)v，与参考的伴随算子等价。 |
| 53 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 两者均为 s < -n/2 - 2，仅书写顺序不同。 |
| 54 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 模型给出 1/3，与参考一致。 |
| 55 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 56 | unsolved | `CONTROL_REJECTED` | **未交付候选** | stopReason=CONTROL_REJECTED |
| 57 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 58 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 59 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 60 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 61 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选择B，与参考“调查单位”一致。 |
| 62 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选择C，与参考“统计数据的分析”一致。 |
| 63 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “假”与参考“错误”同义，判断一致。 |
| 64 | candidate | `REVIEWS_COMPLETE` | **UNSURE** | 参考答案存疑：两个总量指标数列相除也可得平均数时间数列，模型判“假”符合统计学，不宜仅因与参考相反判错。 |
| 65 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “假”与参考“错误”同义。 |
| 66 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 答“错误”与参考一致；不能直接对完成程度作算术平均。 |
| 67 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 答“拒绝”，与参考一致。 |
| 68 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 答“相关”，与参考一致。 |
| 69 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 不合格率8%正确；Wald区间≈[2.68%,13.32%]与参考(2.69%,13.31%)一致。 |
| 70 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | BCDE与参考完全一致。 |
| 71 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | A、B、C与参考ABC一致。 |
| 72 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | A、B与参考A,B一致。 |
| 73 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 填空“差异性”与参考一致。 |
| 74 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “平滑法（移动平均法）”包含参考要求的移动平均法。 |
| 75 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “同度量因素”（附注权数）与参考一致。 |
| 76 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “移动平均比率法”“季节分解法”与参考两空等价。 |
| 77 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 组间方差衡量均值间差异，故“错误”与参考一致。 |
| 78 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 充分统计量、MLE、Fisher信息1/θ²、渐近分布N(0,θ0²)四项与参考一致。 |
| 79 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 方差为常用离散程度指标，与参考标准差同类，题目答案不唯一。 |
| 80 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “样本均值”与参考“均值”在该语境下等价。 |
| 81 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 右偏数据可用对数/平方根/倒数变换，选D与参考一致。 |
| 82 | candidate | `REVIEW_STOP` | **CORRECT** | 最小值8低于第一组下限10，不在任何组内，选D与参考一致。 |
| 83 | candidate | `REVIEWS_COMPLETE` | **INCORRECT** | 单选题参考为A（直方图），模型选C（箱线图），不等价。 |
| 84 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 非线性增长趋势适合二次多项式回归，选B与参考一致。 |
| 85 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 综合评价需考虑权重，宜用加权平均，选C与参考一致。 |
| 86 | unsolved | `ERROR` | **未交付候选** | stopReason=ERROR |
| 87 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | β̂、α̂公式与参考等价，仅符号不同。 |
| 88 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “假”与参考一致：非线性模型也可线性化后用OLS估计。 |
| 89 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “错误”与参考一致：岭回归不置零系数。 |
| 90 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 答“相关”，与参考一致。 |
| 91 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | [0,1] 与参考区间等价。 |
| 92 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 逐步回归引入依据为偏F检验，与参考一致。 |
| 93 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | 选A，与参考一致。 |
| 94 | candidate | `REVIEWS_COMPLETE` | **INCORRECT** | 参考为D；模型只选B，遗漏旧变量t检验不显著、F检验不显著等情形。 |
| 95 | candidate | `REVIEWS_COMPLETE` | **UNSURE** | 参考答案只给A(最小二乘)，但非线性回归也用极大似然与牛顿/高斯-牛顿迭代，D亦可成立；题目与参考本身有歧义。 |
| 96 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | ABCD与参考完全一致。 |
| 97 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “假”即“错误”，与参考一致。 |
| 98 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | False 即错误，与参考一致。 |
| 99 | candidate | `REVIEWS_COMPLETE` | **CORRECT** | “假”即“错误”，与参考一致。 |

## 5 与整合前基线的对照

整合前 `feat/v4-dynamic-workflows`（`2265dff`）记录的 100 题全量为 **97/100 出候选**；本次整合树为 **70/100**。为判断差异来源，对本次 5 道 `CONTROL_REJECTED` 题在同一运行器、同一客户端、同一预算下用整合前树复跑（报告目录 `/tmp/astra-ab-base5`）：

| 题号 | 整合树 `bd98a87` | 整合前 `2265dff` |
|---:|---|---|
| 3 | unsolved / CONTROL_REJECTED（3 次调用） | unsolved / ERROR（13 次调用，FIELD_VALUE） |
| 4 | unsolved / CONTROL_REJECTED（3 次调用） | candidate / REVIEWS_COMPLETE（20 次调用） |
| 6 | unsolved / CONTROL_REJECTED（3 次调用） | candidate / REVIEWS_COMPLETE（15 次调用） |
| 10 | unsolved / CONTROL_REJECTED（3 次调用） | candidate / REVIEWS_COMPLETE（19 次调用） |

结论（保守）：整合树上这些题在 3 次调用内就被控制层拒绝，而整合前树能走到候选，**这不是随机波动可以解释的**；现有证据足以把它列为待查项，但样本只有 5 题、且两棵树的宿主/协议版本不同，还不能直接把候选率下降 27 个百分点全部归因于整合。

## 6 与本次三处修复的关系

- 计数回归（V5-P1）在真实负载下成立：1226 次调用全部计入 `client_method_calls`，`remote_outcome_unknown` 在 100 题中为 **0**。
- 未发送状态贯通（V5-P2）未被本次运行触发（没有题目落入预算耗尽的派发前拒绝分支）。
- 恢复路径（R1–R3）未被本次运行触发（运行期间没有进程重启）。

## 7 诚实边界

- 本文的「正确」是语义复核结论，允许记号与写法差异；它不是官方评测，也不构成数学正确率承诺。
- 判分器 `ReferenceJudge` 只是本地回归工具，`_emulator.official=false`。
- 复核中 2 题（#64、#95）判定为 UNSURE，原因是**参考答案本身可争议**，不是模型错误；若按统计学通行定义，模型答案可能应为正确。
- 未交付候选的 30 题中，`CONTROL_REJECTED` 有 22 题，其中 15 题模型完全没有发起任何资产/工具调用（直接输出文本结论），11 题在发起工具 effect 后被拒绝；使用统一数学资产的 78 题里有 70 题交付候选（90%）。
