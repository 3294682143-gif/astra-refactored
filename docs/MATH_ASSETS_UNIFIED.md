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
| 1 | `math.polynomial` | 多项式代数与代数方程 | 5 | 符号因式分解、根判定、判别式、结式、多项式除法 |
| 2 | `math.symbolic-calculus` | 符号微积分与极限分析 | 4 | 定积分/不定积分、高阶导数、泰勒级数展开、多变量极限 |
| 3 | `math.linear-algebra` | 线性代数与矩阵分析 | 5 | 特征值/特征向量、Jordan 标准型、GF(2) 秩与零空间、最大子式 |
| 4 | `math.number-theory` | 初等数论与同余方程 | 6 | 扩展欧几里得、模逆元、中国剩余定理、素性检验、原根、离散对数 |
| 5 | `math.diophantine` | 丢番图方程与整系数系统 | 3 | 线性不定方程、Pell 方程、Thue 方程、椭圆曲线整点 |
| 6 | `math.combinatorics` | 组合数学与计数体系 | 4 | 排列组合数、斯特林数、贝尔数、划分数、容斥原理计算 |
| 7 | `math.graph-extremal` | 图论极值与图谱性质 | 3 | Tutte 多项式、色多项式、最大团与独立数、拉普拉斯谱 |
| 8 | `math.probability-discrete` | 离散概率与马尔可夫链 | 4 | 吸收态转移概率、平稳分布、马尔可夫链命中时、鞅停时计算 |
| 9 | `math.recurrence-algebra` | 递推序列与差分方程 | 3 | 齐次/非齐次常系数线性递推通项、生成函数有理式封闭形式 |
| 10 | `math.group-finite` | 有限群结构与置换群 | 4 | 群阶分解、Sylow 子群分析、特征标表、群元素共轭类普查 |
| 11 | `math.real-analysis` | 实分析与实根计数 | 3 | Sturm 序列实根严格计数、柯西序列检验、区间算术验证 |
| 12 | `math.complex-geometry` | 复分析与共形几何 | 2 | 留数计算、辐角原理、施瓦茨-克里斯托费尔映射 |
| 13 | `math.optimization-discrete` | 离散优化与整数规划 | 3 | Branch-and-Bound 混合整数规划、单纯形法线性规划松弛 |
| 14 | `math.lattice-geometry` | 点阵与几何数论 | 3 | LLL 点阵基规约、Minkowski 极值凸体体积、格点计数 |
| 15 | `math.special-functions` | 特殊函数与解析数论 | 3 | Gamma/Beta 函数值、Riemann Zeta 临界区检验、超几何函数展开 |
| 16 | `math.finite-fields` | 有限域与伽罗瓦群 | 4 | 极小多项式构造、有限域本原元、有限扩域伽罗瓦群分析 |
| 17 | `math.differential-equations` | 常微分方程符号解 | 3 | 一阶线性/变系数 ODE、常系数线性 ODE 基础解系、Wronskian 检验 |
| 18 | `math.numerical-integration` | 高精度数值分析与容错验证 | 2 | Gauss-Kronrod 自适应数值积分、有界误差估计 |
| 19 | `math.game-theory` | 博弈策略与组合游戏 | 2 | Sprague-Grundy 尼姆数计算、二人零和博弈纳什均衡 |
| 20 | `math.tiling-geometry` | 离散铺排与组合几何 | 2 | 骨牌平铺匹配多项式、Kasteleyn 铺排计数矩阵 |
| 21 | `math.asymptotics` | 渐近展开与微扰分析 | 3 | 鞍点法渐近、Laplace 方法、Bender 奇点分析 |
| 22 | `math.rational-approximation` | 有理逼近与连分数 | 3 | 连分数收敛展开、最佳有理逼近、无理数度量界 |
| 23 | `math.topology-invariants` | 代数拓扑与纽结不变量 | 2 | 亚历山大多项式、Jones 多项式、同调群秩 |
| 24 | `math.matrix-lie` | 李群与矩阵李代数 | 2 | 矩阵指数封闭形式、Baker-Campbell-Hausdorff 展开 |
| 25 | `math.inequality-prover` | 代数不等式与实代数几何 | 2 | SOS 广义平方和实非负分解、CAD 柱形代数分解 |
| 26 | `math.symbolic-verifier` | 综合多步骤符号化定理校核 | 2 | 恒等式简化判定、反例生成与前提约束满意度验证 |

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
