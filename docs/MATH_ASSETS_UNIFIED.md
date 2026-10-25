# Astra 统一数学资产架构规范 (Unified Math Assets)

## 1. 架构总览与核心设计原则

Astra 统一数学资产（Unified Math Assets）将原先分裂的三套体系（20 个方法卡、22 个数学族技能说明、76 项注册表工具与执行器）彻底收敛为单一、权威且可机械验证的现代架构体系。

### 核心统一原则
1. **单一事实源 (Single Source of Truth)**:
   - 全局唯一权威定义位于 `mathagent/resources/math-assets.json`。
   - 包含 26 个正式数学资产，82 个明确界定的数学计算行为。
   - 禁止在代码、Prompt 或外部注册表中维护散落的人工重复资产列表。
2. **单一模型交互动作 (Single Model Action)**:
   - 模型端唯一的计算请求格式：
     ```json
     {
       "action": "math_asset",
       "assetId": "math.linear-algebra",
       "input": {
         "target": "gf2_rank",
         "rows": [[1, 0], [0, 1]]
       }
     }
     ```
   - 彻底废止歧义的四选一操作（不再存在并列的 tool、method、family、explore）。
3. **单一 Host 统一调用入口 (Single Execution Entry)**:
   - Python Host 端唯一的执行分发函数：
     ```python
     use_math_asset(request, *, context=context, catalog=catalog, executor=executor, deadline=deadline)
     ```
   - 接受统一 `MathAssetRequest`，返回经过 schema 校验的统一结构 `MathAssetResult`。
4. **严格审计与证据等级边界**:
   - 计算结果统一封装为 `observations`，携带精确数学结论与输入 hash。
   - 证据等级分为 `EXACT_FOR_INPUT`、`EXHAUSTIVE`、`SAMPLE_SATISFIED`、`HEURISTIC` 等，严禁弱证据或部分见证越界升级为数学证明。
   - 最终交付的 `candidate_verified` 永远诚实保持为 `false`（符合非形式化验证系统的诚实原则）。

---

## 2. 权威资产目录 (26 Canonical Assets)

| # | 资产 ID | 资产名称 | 包含行为数 | 核心数学能力与覆盖范围 |
|---|---|---|---|---|
| 1 | `math.equations` | 方程与代数等式 | 4 | 代数化简、多项式实根严格计数 (Sturm)、多元方程组求解、多项式恒等式检验 |
| 2 | `math.proof` | 形式证明与反例 | 0 | 形式逻辑结构推理、反例寻找与形式化证明元指导 |
| 3 | `math.invariants` | 不变量与极值原理 | 2 | 多项式不变量验证、双计数上界与离散极值构造 |
| 4 | `math.recurrence` | 递推序列与差分 | 0 | 线性递推序列通项构造、母函数展开与差分方程分析 |
| 5 | `math.finite-states` | 有限状态机与网格路径 | 6 | 自动机转移计数、独立集多项式、数位DP、网格汉密尔顿路径与滑动窗口 |
| 6 | `math.combinatorics` | 组合数学与离散枚举 | 3 | 有界离散枚举、模式禁避排列计数 (Pattern-Avoiding)、车多项式 (Rook Numbers) |
| 7 | `math.generating-functions` | 生成函数与级数展开 | 1 | 符号多项式与有理生成函数高阶展开、目标系数精准提取 |
| 8 | `math.diophantine` | 丢番图方程与不定方程 | 3 | 二元二次不定方程、符号化丢番图判定、二次判别式族求解 |
| 9 | `math.integration` | 积分变换与对称性 | 1 | 符号定积分求值与反常积分对称性化简 |
| 10 | `math.geometry` | 欧氏与解析几何 | 7 | 顶点夹角、面积平分线覆盖、交点分析、线段分离数与最差几何构型搜索 |
| 11 | `math.optimization` | 极值搜索与优化验证 | 3 | 凸规划证书验证、实数连续数值极值搜索、子集间隙最坏情况分析 |
| 12 | `math.linear-algebra` | 线性代数与矩阵分析 | 4 | GF(2) 秩与零空间基向量、线性方程组精确解集 (Q)、多项式矩阵最大子式 |
| 13 | `math.probability` | 概率测度与随机过程 | 4 | 概率密度一元归一化检验、完全图马尔可夫链覆盖时、吸收态期望步数、正态超额席位 |
| 14 | `math.limits` | 极限理论与级数收敛 | 1 | 极限精确计算、泰勒展开与渐近分析 |
| 15 | `math.differential` | 微分算子与拉普拉斯方程 | 3 | 单位圆周拉普拉斯算子、笛卡尔平面二维拉普拉斯、三角恒等式降阶 |
| 16 | `math.algebraic-structures` | 近世代数与代数结构 | 5 | 置换群结构与共轭类、分裂域扩张次数、数域因式分解、Wronskian 根无关性 |
| 17 | `math.topology` | 点集拓扑与同伦不变量 | 0 | 点集拓扑紧致性、连通性与代数拓扑不变量指导 |
| 18 | `math.statistics` | 数理统计与信息论 | 0 | 充分统计量判定、最大似然估计与信息熵度量指导 |
| 19 | `math.regression` | 线性回归与最小二乘 | 1 | 普通最小二乘法 (OLS) 拟合优度、回归斜率与截距核对 |
| 20 | `math.numerics` | 数值算法与函数拟合 | 6 | Lagrange 多项式插值拟合残差、有限差分数值导数、Richardson 外推、常数逆向识别 |
| 21 | `math.encoding` | 信息编码与压缩算法 | 5 | LZ78 序列字典编码、解码验证、短语元组结构分析与校验 |
| 22 | `math.graphs` | 图论结构与极值网络 | 6 | 完美匹配判定与构造、Tutte 条件违例检测、无三角形图二染色与完全二部子图计数 |
| 23 | `math.tiling` | 铺排几何与全息匹配 | 5 | 骨牌密铺证书核验、棋盘染色边界估计、精确铺排计数、最少多米诺覆盖与唯一铺排判定 |
| 24 | `math.games` | 组合博弈与极小化极大 | 6 | 组合翻牌博弈、子序列差异度、独立应答证书、博弈树 Minimax 价值与对策验证 |
| 25 | `math.lattices` | 格理论与几何离散点 | 3 | 六边形格点多边形计数、凸多边形内部整格点精确普查 (Pick 定理) |
| 26 | `math.integer-structure` | 整数结构与乘法群 | 3 | 弗罗贝尼乌斯半群钱币问题、奇部因数分解与模乘奇部因数分布表 |

---

## 3. 双端生成视图与代码同步

为了在跨语言架构中消灭人工维护的副本漂移，Astra 构建系统通过 `scripts/build_math_assets.py` 实现确定性单向视图派生：
- **TypeScript 视图**: `packages/protocol/src/generated/math-assets.ts`
  - 导出资产 ID 枚举常量 `MATH_ASSET_IDS`
  - 导出各资产强类型配置接口与 behavior 签名
  - 导出唯一摘要校验和 `MATH_ASSETS_CATALOG_DIGEST`
- **Python 视图**: `python/astra_bridge/generated/math_assets.py`
  - 导出 `CANONICAL_MATH_ASSETS_DIGEST`
  - 导出 `MATH_ASSET_BEHAVIORS` 映射表及行为元数据字典
- **防篡改与同步门禁**:
  - `python scripts/build_math_assets.py --check` 会在 CI/本地构建时验证双端生成的哈希与权威 JSON 100% 保持一致，任何手工修改生成的代码均被拦截。

---

## 4. 晚到观察与答案闭合机制 (§5.5)

在复杂的数学推理流中，常常出现“先生成受保护的答案候选，后续异步或多任务的精确数学观察才返回”的时序倒置现象。
Unified Math Assets 彻底移除了原先会导致证据死锁的 `answerClosureAttempted` 全局布尔开关，引入了**受保护候选 → 观察到达 → 有界缺陷复核 → 候选更新**机制：
1. **未消费观察判定**: 遍历当前会话所有未被 `consumedObservationHashes` 记录的新观察。
2. **矛盾检测**: 若发现精确观察（如 `gf2_rank = 2`）与受保护候选（如 `rank = 3`）冲突，触发 `stage: "LATE_OBSERVATION_DEFECT"`。
3. **有界修正**: 限制至多触发 1 次针对该缺陷的闭合修正 Turn，若模型提出的新候选使得缺陷减少，立即采用新候选更新 `target` 与 `finalResponse`。
4. **诚实记录**: 若预算耗尽或无法解决矛盾，保留事实并在 `sessionLog` 中标记 `unresolvedContradiction: true`，绝不凭空覆盖答案或谎称验证通过。

---

## 5. 发布包与默认调用方式

在正式发布环境中（Protocol v1.4），系统默认且唯一推荐使用 TS 统一资产运行时：
```python
from user_agent import ReasoningAgent

# 默认启动：无实验参数，直接使用统一数学资产与 release bundle
agent = ReasoningAgent(client)
result = agent.solve(problem)
```
- 发布包 `release/stdio-runtime.bundle.mjs` 具备完全内聚性，无需本地 `node_modules` 即可在隔离环境下直接运行。
- 历史引擎（legacy、lite）降级为显式参数调用，顶层导入不再触发任何旧资产文件的读取。
