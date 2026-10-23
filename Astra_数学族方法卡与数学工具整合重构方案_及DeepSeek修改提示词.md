# Astra MathAgent：数学族方法卡（Method/Skill Cards）与数学工具（Math Tools）整合重构方案及 DeepSeek v4.1 1017 执行提示词

> **文档定位**：针对 `astra-refactored`（`feat/v4-dynamic-workflows` 分支，HANDOFF v5.14）当前最核心的架构痛点——**20 张通用方法卡（`general_v11`）、22 个数学族技能卡（`math_families`）与 76 个已实现数学工具之间的割裂、错配与连环丢包调用流**，提供完整的全景对齐矩阵、三阶段重构蓝图，以及可直接复制给 **DeepSeek v4.1 1017** 执行的工程级修改提示词。

---

## 第一部分：现状诊断——工具调用与方法卡体系的 5 重混乱

通过对仓库 TypeScript 运行时（`apps/stdio-runtime`、`packages/*`）与 Python 桥接/数学族层（`python/astra_bridge`、`mathagent`、`math_families`）的逐模块代码审计，当前方法卡与工具调用存在以下 **5 个结构性症结**：

### 1. 两套卡片体系“双轨割裂”，TS 主引擎丢掉了数学族技能卡与工具参数契约
仓库内并存着两套互不连通的卡片资产：
- **20 张通用方法卡（`mathagent/resources/general_v11/data/methods.json` + `references/*.md`）**：
  - 仅包含概念性推理步骤与 `tasks` / `objects` / `structures` 标签，**没有任何 `tools` 字段，也不包含任何工具的参数 Schema**。
  - 通过 `python/astra_bridge/p2_methods.py` 暴露给 TS `AgentLoop`。
- **22 个数学族技能卡（`math_families/catalog.json` + `mathagent/resources/skill-mapping-manifest.json` + `mathagent/resources/skills/*.md`）**：
  - 每个数学族均有领域建模规范、`tool_role`（`full_solve` / `assist` / `assist_partial` / `none`），且在旧版 Python 引擎的 `SkillCatalog.load_for()`（`mathagent/skills.py:195-232`）中会自动将绑定的工具名、必填/选填参数（`tool-registry.json`）、输入类型（`input_contracts.py:SCHEMAS`）、独立输出校验属性（`tool_contracts.py:CONTRACTS`）及整数边界（`INTEGER_RULES`）动态拼接到卡片末尾。
  - 在旧版 Python `GeneralMethodCatalog.load_for()`（`mathagent/method_layer.py:140-145`）中，加载方法卡会**同时返回 `general_v11` 方法卡 + `SkillCatalog` 数学族技能与工具契约**；但在迁移至 TS `AgentLoop` 时，`SkillCatalog` 被完全切断，22 张数学族技能卡虽被锁在 `host_assets_registry.py` 的 `skills` 资产组中，却在 TS 运行时中**从未被加载**。

### 2. “写完答案 $\to$ 丢弃逼选卡 $\to$ 再写完答案 $\to$ 丢弃逼调工具”的瀑布式事后拦截流
在 `apps/stdio-runtime/src/agent-loop.ts:2195-2282` 中，方法卡加载与工具调用并非前置协同，而是等模型已经生成完整 `WorkPacket` 后事后拦截并丢弃：
1. **Turn 1（首次解题）**：模型生成完整 `WorkPacket`（`prepared`）。
2. **拦截 1（强迫选方法卡，`agent-loop.ts:2198-2229`）**：发现尚未加载方法卡，直接 `continue` **丢弃 Turn 1 的 `WorkPacket`**，置 `forcedMethodSelection = true`，强迫模型在 **Turn 2** 输出 `{"action":"method","id":"..."}`。
3. **Turn 3（读卡后第二次解题）**：模型拿到不含任何工具说明的 `general_v11` 方法卡正文，重新解题并生成第二个完整 `WorkPacket`。
4. **拦截 2（强迫调工具，`agent-loop.ts:2236-2282`）**：调用 `semanticToolRoute(problemText)`，发现尚未调用工具，**再次 `continue` 丢弃 Turn 3 的 `WorkPacket`**，置 `forcedSemanticToolSelection / forcedExactCheckSelection / forcedEnumerationSelection = true`，强迫模型在 **Turn 4** 输出 `{"action":"tool",...}`。
5. **Turn 5（第三次解题）**：拿到工具观察后第三次生成 `WorkPacket`，随后还要进入 `INDEPENDENT RECHECK`（Turn 6）和 `CERTIFICATE SELF-CHECK`（Turn 7）。

### 3. 方法路由与工具路由各自维护一套互不相干的正则表
在 `apps/stdio-runtime/src/agent-semantics.ts` 中：
- `semanticMethodRoute`（`1406-1431` 行）用 `METHOD_ROUTING_TRIGGERS` 对 `general_v11` 的 `objects` / `structures` 打分选出 Top-3 方法卡；
- `semanticToolRoute`（`1171-1206` 行）用另一套硬编码的 15 分支 `if-else` 正则链去匹配单个工具；
- 两者不共享统一的“数学族画像”，导致方法卡与工具路由脱节。

### 4. 工具注册表（73）、独立审计层（76）、P3 白名单（11）与系统提示词（6）四处脱节
| 层级 | 代码位置 | 数量 | 核心问题 |
| :--- | :--- | :---: | :--- |
| **Python 独立审计与实现层** | `mathagent/tool_contracts.py` (19) + `mathagent/output_checks/*` (55) + `exact_checks.py` / `bounded_enumeration.py` (2) | **76 个** | 全部具备完整 Python 实现、输入 Schema 校验与独立输出验证器 |
| **工具注册表** | `mathagent/resources/tool-registry.json` | **73 个** | 声明了 `required_params` / `optional_params` / `input_schema` |
| **P3 协议白名单** | `packages/protocol/src/p3.ts` (`P3_TOOL_NAMES`) & `python/astra_bridge/p3_effect_contract.py` | **仅 11 个** | **65 个已实现且带独立审计的数学族工具被协议硬编码挡在门外** |
| **基础 `SYSTEM_PROMPT`** | `apps/stdio-runtime/src/agent-loop-context.ts:231-249` | **仅描述 6 个** | `P3_TOOL_NAMES` 中的 `polynomial_expand_coefficients`、`linear_system_solution_set`、`interpolation_fit_check`、`stats_ols_check`、`finite_group_structure` **共 5 个工具在基础 `SYSTEM_PROMPT` 中连参数说明都没写**，模型首轮无法主动正确调用 |

### 5. 算子粒度胖瘦失衡 & 路由残缺
- `exact_check_expr` 一个工具塞入了 **7 种跨领域操作**（`SIMPLIFY`、`TRIG_REDUCE`、`MAXIMAL_MINORS`、`FACTOR_OVER_EXTENSION`、`DEFINITE_INTEGRAL`、`LIMIT`、`DENSITY_CHECK`），而 `semanticToolRoute` 只路由了其中 5 个（**`DEFINITE_INTEGRAL` 和 `SIMPLIFY` 在 `semanticToolRoute` 中无路由分支**）。
- 反过来，`circle_laplacian_expr`、`planar_laplacian_expr` 又是极窄的单点函数。
- 在 `skill-mapping-manifest.json` 中，`stats_ols_check` 被错塞进 `probabilistic_model`（而非对应 `regression-diagnostics`），`interpolation_fit_check` 和 `finite_group_structure` 被错塞进 `symbolic_algebra`（导致 `symbolic_algebra` 膨胀为横跨 5 张方法卡的大杂烩），通用枚举器 `bounded_enumeration` 被错塞进 LZ78 编码所在的 `algorithm_simulation`。

---

## 第二部分：全景对齐矩阵（20 张通用方法卡 × 22 个数学族 × 76 个数学工具）

### A. 代数、方程与数论板块（5 张方法卡 ↔ 5 个数学族）

| # | `general_v11` 方法卡 (`id` / 角色) | 归口 `math_families` 技能卡 (`tool_role`) | 归口数学工具 (共 18 个，均已实现且带独立审计) | 当前 TS `P3_TOOL_NAMES` 暴露与路由状态 |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **`domain-equivalence`**<br>定义域、等价变换与参数分类 (`method`) | • `symbolic_algebra` (方程/实根子集, `full_solve`)<br>• `functional_equation` (`assist`) | • `real_root_count_expr`<br>• `solve_system_guarded_expr`<br>• `polynomial_function_check`<br>• `constraint_propagation_2coloring`<br>• `exact_check_expr[SIMPLIFY]` | ⚠️ `real_root_count_expr` 已暴露；`exact_check_expr[SIMPLIFY]` 缺路由；其余 3 个未暴露 |
| 2 | **`algebraic-structures`**<br>代数结构归约决策 (`decision`) | • `symbolic_algebra` (域扩张/群结构/不变量子集, `full_solve`) | • `splitting_field_degree_expr`<br>• `finite_group_structure`<br>• `exact_check_expr[FACTOR_OVER_EXTENSION]`<br>• `algebraic_polynomial_check`<br>• `polynomial_invariant_check`<br>• `wronskian_root_identity_expr` | ⚠️ 前 3 个已暴露（`finite_group_structure` 在 `SYSTEM_PROMPT` 缺参数文档）；后 3 个未暴露 |
| 3 | **`linearization-spectral`**<br>线性化、秩与谱结构 (`method`) | • `symbolic_algebra` (线性方程组子集)<br>• `linear_algebra_game` (`full_solve`) | • `linear_system_solution_set`<br>• `exact_check_expr[MAXIMAL_MINORS]`<br>• `gf2_rank`<br>• `gf2_nullspace`<br>• `deck_game_outcome` | ⚠️ 前 2 个已暴露（`linear_system_solution_set` 在 `SYSTEM_PROMPT` 缺参数文档）；`gf2_*` 等 3 个未暴露 |
| 4 | **`modular-crt`**<br>同余、素数幂分解与广义CRT (`method`) | • `diophantine` (`full_solve`)<br>• `number_theory_structure` (`assist_partial`) | • `solve_quadratic_diophantine`<br>• `solve_quadratic_discriminant_family`<br>• `symbolic_diophantine_with_timeout`<br>• `frobenius_semigroup`<br>• `odd_part`<br>• `odd_part_table` | ❌ **0 暴露（有卡无枪）**：6 个已实现独立审计的数论/丢番图算子全部未进 `P3_TOOL_NAMES` |
| 5 | **`generating-functions`**<br>生成函数、系数提取与卷积 (`method`) | • `symbolic_algebra` (多项式展开子集) | • `polynomial_expand_coefficients` | ⚠️ 已暴露且有路由，但 `SYSTEM_PROMPT` 漏写参数文档 |

### B. 组合、自动机、博弈与离散构造板块（5 张方法卡 ↔ 9 个数学族）

| # | `general_v11` 方法卡 (`id` / 角色) | 归口 `math_families` 技能卡 (`tool_role`) | 归口数学工具 (共 32 个，均已实现且带独立审计) | 当前 TS `P3_TOOL_NAMES` 暴露与路由状态 |
| :-: | :--- | :--- | :--- | :--- |
| 6 | **`counting-bijections`**<br>双射、双计数与容斥 (`method`) | • `inclusion_exclusion_counting` (`full_solve`)<br>• `algorithm_simulation` (`full_solve`) | • `bounded_enumeration`<br>• `rook_numbers`<br>• `count_avoiding_permutations`<br>• `lz78_encode` / `lz78_decode` / `verify_phrases` / `lz78_bit_string` / `format_phrases` | ⚠️ 仅 `bounded_enumeration` 暴露（且错挂在 `algorithm_simulation` 下）；其余 7 个精确算子未暴露 |
| 7 | **`finite-state-dp`**<br>有限状态、动态规划与模状态组合 (`method`) | • `digit_dp` (`full_solve`)<br>• `transfer_matrix` (`full_solve`)<br>• `minimax_dp` (`full_solve`) | • `count_by_digit_property` / `digit_sum_window_search` / `deletion_divisible_largest`<br>• `transition_count` / `independence_polynomial_chain` / `hamiltonian_paths_grid`<br>• `win_draw_loss_graph` / `minimax_value_graph` / `gap_subsequence_discrepancy` | ❌ **0 暴露（有卡无枪）**：9 个 `full_solve` 精确 DP/转移矩阵算子全部未暴露 |
| 8 | **`invariants-extremal`**<br>不变量、势函数与极端原理 (`method`) | • `game_strategy_proof` (`assist`)<br>• `extremal_construction` (`assist`)<br>• `graph_extremal` (`assist`)<br>• `constrained_tiling` (`assist_partial`) | • `pairing_strategy_verify` / `independent_reply_certificate`<br>• `double_counting_bound`<br>• `count_complete_bipartite_subgraphs` / `has_perfect_matching` / `verify_perfect_matching` / `triangle_free_check` / `tutte_violation`<br>• `count_tilings` / `unique_tiling_check` / `check_tiling_certificate` / `min_tiles_cover` / `coloring_bound` | ❌ **0 暴露（有卡无枪）**：13 个图极值/铺砖/博弈配对核验算子全部未暴露 |
| 9 | **`induction-recurrence`**<br>归纳、递推与良基结构 (`method`) | • 共享 `transfer_matrix` / `number_theory_structure` | • 复用 `transition_count`、`independence_polynomial_chain`、`odd_part_table` 进行基例与小规模递推核验 | ❌ **0 绑定** |
| 10 | **`proof-counterexamples`**<br>量词、证明义务与反例 (`method`) | • `concept_recall` (`none`) | • 复用 `bounded_enumeration`（有限反例搜索）、`certificate_check_expr`（连续表达式反例采样） | ⚠️ 仅靠 `forcedVerdictClosure` 处理判断词矛盾 |

### C. 分析、微积分、微分方程与几何板块（5 张方法卡 ↔ 4 个数学族）

| # | `general_v11` 方法卡 (`id` / 角色) | 归口 `math_families` 技能卡 (`tool_role`) | 归口数学工具 (共 18 个，均已实现且带独立审计) | 当前 TS `P3_TOOL_NAMES` 暴露与路由状态 |
| :-: | :--- | :--- | :--- | :--- |
| 11 | **`integral-symmetry`**<br>对称、换元与积分存在性 (`method`) | • `symbolic_calculus` (积分子集, `full_solve`) | • `exact_check_expr[DEFINITE_INTEGRAL]`<br>• `exact_check_expr[TRIG_REDUCE]` | ⚠️ `DEFINITE_INTEGRAL` 在 `semanticToolRoute` 中**漏写路由分支** |
| 12 | **`convergence-limits`**<br>极限交换、可积性与分布收敛 (`method`) | • `symbolic_calculus` (极限子集, `full_solve`) | • `exact_check_expr[LIMIT]` | ✅ 已暴露且有路由 |
| 13 | **`differential-equations`**<br>微分方程的建模、归约与条件核验 (`decision`) | • `symbolic_calculus` (微分算子子集, `full_solve`) | • `circle_laplacian_expr`<br>• `planar_laplacian_expr`<br>• `exact_check_expr[TRIG_REDUCE]` | ✅ 已暴露且有路由 |
| 14 | **`coordinates-geometry`**<br>坐标、向量与几何约束 (`method`) | • `classical_geometry_compute` (`full_solve`)<br>• `combinatorial_geometry` (`assist`)<br>• `lattice_counting` (`full_solve`) | • `line_through` / `angle_at_vertex` / `count_angle_ratio_locus` / `identify_constant`<br>• `line_cover_number` / `line_separation_number` / `area_bisection_coverage` / `worst_configuration_search`<br>• `hexagon_lattice_points` / `count_lattice_hexagons` / `lattice_points_in_polygon` | ❌ **0 暴露（有卡无枪）**：11 个解析几何/组合几何/格点算子全部未暴露 |
| 15 | **`inequalities-optimization`**<br>界、凸性与全局最优性 (`method`) | • `inequality_extremum` (`assist_partial`) | • `numeric_extremum_search_expr`<br>• `certificate_check_expr`<br>• `closed_form_conjecture`<br>• `subset_gap_worst_case` | ❌ **0 暴露（有卡无枪）**：4 个不等式极值与采样核验算子全部未暴露 |

### D. 概率、统计、数值与拓扑板块（5 张方法卡 ↔ 2 个数学族 + 3 个空白区）

| # | `general_v11` 方法卡 (`id` / 角色) | 归口 `math_families` 技能卡 (`tool_role`) | 归口数学工具 (共 9 个，均已实现且带独立审计) | 当前 TS `P3_TOOL_NAMES` 暴露与路由状态 |
| :-: | :--- | :--- | :--- | :--- |
| 16 | **`conditioning-indicators`**<br>样本空间、条件化与概率耦合 (`method`) | • `probabilistic_model` (`full_solve`) | • `exact_check_expr[DENSITY_CHECK]`<br>• `bounded_enumeration`<br>• `cover_time_complete_graph`<br>• `markov_expected_steps`<br>• `normal_overflow_seats` | ⚠️ 前 2 个可路由；Markov 期望步数等 3 个专用概率算子未暴露 |
| 17 | **`statistical-inference`**<br>统计模型、似然与推断 (`decision`) | • 共享 `probabilistic_model` | • 复用 `exact_check_expr[DENSITY_CHECK]`、`normal_overflow_seats` | ⚠️ 缺推断专属算子 |
| 18 | **`regression-diagnostics`**<br>回归、选模与误差结构 (`decision`) | • 独立归口 `stats_ols_check` (原错挂于 `probabilistic_model`) | • `stats_ols_check` | ⚠️ 已暴露且可路由，但在 `SYSTEM_PROMPT` 中漏写参数文档 |
| 19 | **`numerical-approximation`**<br>近似、误差传播与稳定性 (`decision`) | • `numerical_methods` (`full_solve`) | • `interpolation_fit_check` (原错挂于 `symbolic_algebra`)<br>• `finite_difference_derivative`<br>• `richardson_extrapolate`<br>• `verify_fd_certificate` | ⚠️ 仅 `interpolation_fit_check` 暴露（且 `SYSTEM_PROMPT` 漏写参数文档）；其余 3 个差分/外推算子未暴露 |
| 20 | **`topology-local-global`**<br>拓扑性质判别决策 (`decision`) | • `concept_recall` (`none`) | *(纯概念与反例推理，无绑定算子)* | ⚪ 纯推理卡 |

---

## 第三部分：给 DeepSeek v4.1 1017 的完整修改提示词（可直接复制）

> **使用说明**：将下方代码块中的内容完整复制并发送给 **DeepSeek v4.1 1017**。该提示词已包含仓库内所有隐藏的 SHA-256 完整性校验锁（`SOURCE.json`、`asset_baseline.json`）与 P2/P3 协议严格键名白名单约束，确保修改不会意外破坏现有测试门禁。

````markdown
你现在是 `astra-refactored` 仓库（分支 `feat/v4-dynamic-workflows`）的核心架构重构工程师。请严格按照以下工程规范，执行「数学族方法卡（Method/Skill Cards）与数学工具（Math Tools）统一整合重构」。

---

### 一、 必须死守的红线与哈希/Schema 锁（极其重要，改前必读！）

本仓库有极严格的 Fail-Closed 协议校验与 SHA-256 资产完整性检查，修改任何文件时必须遵守以下 5 条铁律：

1. **禁止触碰冻结目录**：
   - 严禁修改 `math_families/` 下的算子实现源码与 `math_families/catalog.json`（测试门禁锁定了 `catalogSha256`）。
2. **`general_v11` 的 `SOURCE.json` 与 `asset_baseline.json` 双重 SHA-256 锁**：
   - `mathagent/lite/methods.py:183-190, 320-330` 会校验 `mathagent/resources/general_v11/SOURCE.json` 中记录的 `data/methods.json` 及所有 `references/{id}.md` 的 SHA-256！
   - `python/astra_bridge/host_assets_registry.py:38-47, 130-165` 会校验 `python/astra_bridge/asset_baseline.json` 中所有注册资产的 SHA-256！
   - **因此**：只要你修改了 `mathagent/resources/general_v11/data/methods.json` 或任何 `references/*.md` 或 `mathagent/resources/skills/*.md`，**必须在最后运行 Python 脚本同步重算并更新 `mathagent/resources/general_v11/SOURCE.json` 和 `python/astra_bridge/asset_baseline.json` 中的对应 SHA-256 值**！
3. **`P2MethodCatalog` 与 `P2MethodAsset` 的严格键白名单与长度上限**：
   - `packages/runtime-core/src/p2-methods.ts:77-94` 中 `readCatalog` 强制校验 `entries.length === 20`，且每个 entry 的键只能属于 `["id", "title", "tasks", "objects", "structures", "role"]`（且 `tasks`/`objects`/`structures` 每项最多 6 个符合 `/^[a-z0-9_]{1,24}$/` 的 token）。
   - `packages/runtime-core/src/p2-methods.ts:111-125` 中 `readAsset` 强制校验 `asset` 只含 `["id", "title", "version", "body", "bodySha256", "bodyChars"]`，且 `bodyChars === [...body].length <= 24000`，同时 `packages/runtime-core/src/p3-methods.ts:31,118` 强制校验 `Buffer.byteLength(receipt.observation, "utf8") <= 16000`！
   - **因此**：在向方法卡注入数学族技能要点与绑定工具参数契约时，合成后的 `body` UTF-8 字节数必须控制在 **12,000 bytes 以内**（留出 JSON 包装余量，绝不超过 16,000 bytes 上限），并重新计算 `bodySha256`（UTF-8 编码的 hex sha256）和 `bodyChars`（Unicode 码点数 `len(body)`）。
4. **保持已有测试 100% 绿灯**：
   - 任何默认行为的增强必须兼容 `npm test`（443+ TS 测试）与 `pytest`（Python 桥接与方法卡测试）。对于专门锁死 `MethodCatalog` 原始字节返回的单测，需区分“原始文件读取校验”与“桥接层 `fixture_load` / 方法卡内嵌工具契约”。
5. **非作弊（Non-cheating）红线**：
   - 严禁在任何路由、提示词或工具中包含题号、题目哈希或参考答案。所有路由必须 100% 基于通用数学术语、对象与结构特征。

---

### 二、 分步修改任务清单（4 个核心任务）

#### 任务 1：将 20 张 `general_v11` 方法卡与数学族绑定工具的精确参数契约融合（消除“有卡无工具说明”的割裂）

**背景问题**：
目前 `mathagent/resources/general_v11/references/*.md` 的 20 张卡片只有纯文字推理建议，完全没有写出当前卡片对应哪些注册工具、每个工具的必填参数名（`required_params`）、JSON 调用模板（`argsTemplate`）以及独立输出校验范围。而且 `apps/stdio-runtime/src/agent-loop-context.ts:231-249` 的 `SYSTEM_PROMPT` 漏掉了 `polynomial_expand_coefficients`、`linear_system_solution_set`、`interpolation_fit_check`、`stats_ols_check`、`finite_group_structure` 5 个工具的参数说明。

**具体修改动作**：
1. **在 `mathagent/resources/general_v11/references/*.md` 每张卡片末尾追加标准化的 `## 绑定计算工具与精确调用契约 (Bound Registered Tools)` 章节**（控制每张卡片总长度在 4,000 字符 / 10,000 UTF-8 字节以内）：
   - 按以下归口映射表，在对应卡片 `.md` 末尾写明该卡绑定的 P3 注册工具、适用条件、精确 JSON `args` 模板及输入约束：
     - `domain-equivalence.md`：
       - `real_root_count_expr`: `{"expression":"<有理系数单变量多项式字符串>","variable":"x"}`（统计实根个数，勿先约去含变量分母）
       - `exact_check_expr` (`SIMPLIFY`): `{"operation":"SIMPLIFY","expression":"<代数式>","variable":"x"}`
     - `algebraic-structures.md`：
       - `splitting_field_degree_expr`: `{"expression":"<单变量多项式>","variable":"x"}`
       - `exact_check_expr` (`FACTOR_OVER_EXTENSION`): `{"operation":"FACTOR_OVER_EXTENSION","expression":"<多项式>","variable":"x","minimal_polynomials":["<生成元极小多项式>"]}`
       - `finite_group_structure`: `{"generators":["(12)","(123)"],"degree":3}` 或 `{"named_group":"A4"}`（仅限显式不相交轮换生成元 `degree` 2..8，或闭集命名群 `S3/S4/A4/A5/D8/D10/Z2..Z12/C2..C12`）
     - `linearization-spectral.md`：
       - `linear_system_solution_set`: `{"matrix":[["1","2"],["3","4"]],"rhs":["5","6"],"variables":["x","y"],"domain":"RATIONAL"}`（`domain` 为 `"RATIONAL"` 或 `"REAL"`）
       - `exact_check_expr` (`MAXIMAL_MINORS`): `{"operation":"MAXIMAL_MINORS","matrix":[["t","-1"],["1","t"]],"variable":"t"}`（矩阵元素必须全部为 JSON 字符串）
     - `generating-functions.md`：
       - `polynomial_expand_coefficients`: `{"expression":"<多项式表达式>","variables":["x"],"parameters":[]}`
     - `counting-bijections.md` & `finite-state-dp.md` & `invariants-extremal.md` & `proof-counterexamples.md`：
       - `bounded_enumeration`: `{"ranges":[<单个物理对象的各属性取值数>],"choose":<选取对象个数k>,"predicate":"<基于 distinct(i), count(i,v), size(), sum(i), min(i), max(i), contains(i,v) 的谓词>"}` 或 `{"objects":[[...]],"choose":<k>,"predicate":"..."}`
     - `integral-symmetry.md`：
       - `exact_check_expr` (`DEFINITE_INTEGRAL`): `{"operation":"DEFINITE_INTEGRAL","expression":"<被积表达式>","variable":"x","lower":"<下限字符串>","upper":"<上限字符串>"}`
       - `exact_check_expr` (`TRIG_REDUCE`): `{"operation":"TRIG_REDUCE","expression":"<三角/多项式表达式>","variable":"x"}`
     - `convergence-limits.md`：
       - `exact_check_expr` (`LIMIT`): `{"operation":"LIMIT","expression":"<表达式>","variable":"x","point":"<极限点字符串，如 0 或 oo>"}`
     - `differential-equations.md`：
       - `circle_laplacian_expr`: `{"expression":"<关于 theta 的表达式>"}`
       - `planar_laplacian_expr`: `{"expression":"<多元表达式>","variables":["x","y"]}`
       - `exact_check_expr` (`TRIG_REDUCE`): `{"operation":"TRIG_REDUCE","expression":"<分离变量模态或三角表达式>","variable":"x"}`
     - `conditioning-indicators.md` & `statistical-inference.md`：
       - `exact_check_expr` (`DENSITY_CHECK`): `{"operation":"DENSITY_CHECK","density":"<支撑集上的密度表达式，支持 Phi(x)/phi(x)>","variable":"x","lower":"0","upper":"oo"}`
       - `bounded_enumeration`: 用于离散有限样本空间古典概型分子/分母精确计数
     - `regression-diagnostics.md`：
       - `stats_ols_check`: `{"data":[{"x":"<精确有理数字符串>","y":"<精确有理数字符串>"}],"claimed":{"slope":"<斜率有理数>","intercept":"<截距有理数>"}}`（3..12 个精确有理数点对）
     - `numerical-approximation.md`：
       - `interpolation_fit_check`: `{"points":[{"x":"<精确有理数>","y":"<精确有理数>"}],"expression":"<待核验单变量插值多项式>","variable":"x"}`（2..8 个互异精确节点）
2. **修正 `mathagent/resources/skill-mapping-manifest.json` 中的工具归属错配**：
   - 确保 `skill-mapping-manifest.json` 中的工具映射注释与方法卡对齐（注意检查是否有测试断言固定了 `skill-mapping-manifest.json` 的特定字段，若有测试断言 `probabilistic_model` 或 `symbolic_algebra` 包含某工具，保留向后兼容并在注释或扩展字段 `general_method_id` 中标明精确归口的 `general_v11` 卡片 ID）。
3. **补齐 `apps/stdio-runtime/src/agent-loop-context.ts:231-250` 基础 `SYSTEM_PROMPT` 中缺失的 5 个 P3 工具简明签名**：
   - 在 `SYSTEM_PROMPT` 的工具介绍段落（231-249 行）中，补齐 `polynomial_expand_coefficients (expression, variables, parameters)`、`linear_system_solution_set (matrix, rhs, variables, domain)`、`interpolation_fit_check (points, expression, variable)`、`stats_ols_check (data, claimed)`、`finite_group_structure (generators+degree or named_group)` 的一行式简明参数说明（注意检查 `apps/stdio-runtime` 下是否有测试硬编码断言了 `SYSTEM_PROMPT` 全文哈希或固定字节长度，若有对应测试，同步更新该测试中的预期快照或检查 `MAX_CONTEXT_BYTES = 65536` 边界）。

---

#### 任务 2：打通并补齐 `apps/stdio-runtime/src/agent-semantics.ts` 的方法与工具统一语义路由

**背景问题**：
1. `semanticToolRoute`（`agent-semantics.ts:1171-1206`）漏掉了 `exact_check_expr` 的 `DEFINITE_INTEGRAL`（定积分计算/对称区间定积分核验）和 `SIMPLIFY`（分式/根式/代数恒等化简）路由。
2. `semanticMethodRoute`（`agent-semantics.ts:1406-1431`）与 `semanticToolRoute` 完全独立：当 `semanticToolRoute` 命中明确的工具路由（如 `finiteGroupStructureWording`、`interpolationFitWording`、`statsOlsWording`、`circleLaplacianWording`、`planarLaplacianWording`、`splittingFieldDegreeWording`、`realRootCountWording`、`linearSystemWording`）时，`semanticMethodRoute` 可能因为普通词汇计分平局而把真正匹配的领域方法卡排到后面。

**具体修改动作**：
1. **在 `apps/stdio-runtime/src/agent-semantics.ts` 中补齐定积分精确核验路由 `EXACT_DEFINITE_INTEGRAL_ROUTE`**：
   - 定义 `EXACT_DEFINITE_INTEGRAL_ROUTE = exactRoute("DEFINITE_INTEGRAL", '{"operation":"DEFINITE_INTEGRAL","expression":"<integrand>","variable":"x","lower":"<lower bound>","upper":"<upper bound>"}')`。
   - 新增 `exactDefiniteIntegralWording(problemText: string): boolean`：当题目包含明确的定积分求解/计算结构（如 `/(定积分|definite\s+integral|\\int_|\bint\s*_)/iu` 或同时出现积分号 `/(?:∫|\\int)/u` 与上下限/求值词 `/(?:求|计算|evaluate|compute)/iu`），且不属于抽象存在性证明或反常积分收敛性定性判断时，路由到 `EXACT_DEFINITE_INTEGRAL_ROUTE`（注意置于 `exactLimitWording` 之后或与 `exactLimitWording` 互斥判别，避免改变已有极限题测试行为）。
2. **在 `apps/stdio-runtime/src/agent-semantics.ts` 中建立 `SemanticToolRoute` 到 `general_v11` 方法卡 ID 的强协同映射 `preferredMethodForToolRoute(route: SemanticToolRoute | null): string | null`**：
   - `GROUP_STRUCTURE` / `SPLITTING_FIELD_DEGREE` / `EXACT_FACTOR_OVER_EXTENSION` $\to$ `"algebraic-structures"`
   - `REAL_ROOT_COUNT` $\to$ `"domain-equivalence"`
   - `LINEAR_SYSTEM_SOLUTION_SET` / `EXACT_MAXIMAL_MINORS` $\to$ `"linearization-spectral"`
   - `POLYNOMIAL_EXPAND_COEFFICIENTS` $\to$ `"generating-functions"`
   - `CIRCLE_LAPLACIAN` / `PLANAR_LAPLACIAN` / `EXACT_TRIG_REDUCE` $\to$ `"differential-equations"`
   - `EXACT_DEFINITE_INTEGRAL` $\to$ `"integral-symmetry"`
   - `EXACT_LIMIT` $\to$ `"convergence-limits"`
   - `EXACT_DENSITY_CHECK` $\to$ `"conditioning-indicators"`
   - `FINITE_ENUMERATION` $\to$ `"counting-bijections"`
   - `INTERPOLATION_FIT` $\to$ `"numerical-approximation"`
   - `OLS_CHECK` $\to$ `"regression-diagnostics"`
3. **在 `semanticMethodRoute(problemText, entries)` 中融合该协同信号**：
   - 当 `semanticToolRoute(problemText)` 命中某个 `route` 且其对应的 `preferredMethodId` 存在于 `entries` 中时，为该 `preferredMethodId` 提供协同加分（或确保其进入返回的 Top-3 候选列表首位/前列），从而保证**方法卡路由与工具路由指向同一个数学族**！
   - **注意**：检查 `apps/stdio-runtime` 中针对 `semanticMethodRoute` 的单元测试，确保已有纯触发词测试用例依然全部通过。

---

#### 任务 3：优化 `apps/stdio-runtime/src/agent-loop.ts` 的方法卡与工具协同提示，消除盲目猜参

**背景问题**：
在 `apps/stdio-runtime/src/agent-loop.ts:1408-1452`（`forcedMethodSelection`）与 `1848-1896`（方法卡加载完成后的下一个 WORK 轮次）中，模型加载完方法卡后，虽然拿到了方法卡正文，但系统没有在方法卡加载后的 WORK 轮次提示其顺势调用与该题/该卡匹配的注册工具，导致模型在 Turn 3 先盲写一遍完整 `WorkPacket`，然后在 `2236-2282` 行被 `forcedSemanticToolSelection` 拦截并把 Turn 3 的 `WorkPacket` 整个丢弃重来！

**具体修改动作**：
1. 在 `apps/stdio-runtime/src/agent-loop.ts` 中，当某张方法卡刚刚加载成功（`methodAssets.length >= 1`）、且当前题目命中了 `semanticToolRoute(problemText)`、且当前任务尚未产生 `PROGRAM_OBSERVATION`（即 `!observations.some((item) => item.source === "PROGRAM_OBSERVATION")`）、且预算允许调用工具（`allowTools && toolEffects < opts.maxEffects && root.effectCalls() < totalEffectCapacity && callsLeft() >= 2 + opts.maxReviews`）时：
   - 可直接在方法卡加载完成后的紧邻下一轮（或通过轻量提示），引导模型优先执行该 `toolRoute` 对应的 `{"action":"tool",...}`，或者保留 `2236-2282` 行的兜底强制拦截以确保即使模型直接交卷也能 100% 触发工具校验。
   - **关键约束**：必须仔细核对 `apps/stdio-runtime/test/` 下的现有集成测试（这些测试使用了固定的假模型响应队列 `scripted receipts`）。如果现有测试脚本预期在 `METHOD_LOAD` 之后先收到一个 `WorkPacket` 再进入 `TOOL_ROUTE`，**请仅在 `forcedMethodSelection` / `forcedSemanticToolSelection` 的构造上保持与现有脚本化测试的向后兼容**，即：
     - 不破坏任何已有 scripted test 的模型请求序号（`model-1`, `model-2`, ...）与 `sessionLog` 事件序列（`METHOD_ROUTE` -> `METHOD_LOAD` -> `TOOL_ROUTE` -> `TOOL_OBSERVATION`）；
     - 但在方法卡正文（任务 1）和 `SEMANTIC TOOL TURN` / `EXACT CHECK TURN` 提示中提供完整的工具契约，使真实大模型在加载方法卡后就能看到精确的 `argsTemplate` 和建模规范。

---

#### 任务 4：同步更新 SHA-256 完整性基线并运行全量验证门禁

在完成上述文件修改后，**必须**执行以下完整性同步与测试步骤：

1. **编写并运行一次性 Python 脚本更新 `mathagent/resources/general_v11/SOURCE.json`**：
   - 遍历 `mathagent/resources/general_v11/SOURCE.json` 中的 `files` 字典（含 `data/methods.json` 和 20 个 `references/*.md`），用 `hashlib.sha256(path.read_bytes()).hexdigest()` 重新计算最新 SHA-256 并写回 `SOURCE.json`。
2. **同步更新 `python/astra_bridge/asset_baseline.json`**：
   - 调用 `from python.astra_bridge.host_assets_registry import registry_snapshot, verify_integrity`，将更新后的 `methodCards`（及任何修改过的注册资产）的最新 SHA-256 同步写入 `python/astra_bridge/asset_baseline.json`，并断言 `verify_integrity(Path("."))["ok"] is True`。
3. **运行全量 Python 与 TypeScript 测试套件**：
   - 运行 Python 测试：`pytest`（重点检查 `MethodCatalog`、`p2_methods`、`host_assets_registry`、`tool_contracts`、`output_checks` 相关测试）。
   - 运行 TypeScript 构建与测试：`npm run build && npm test`（重点检查 `@astra/runtime-core`、`@astra/stdio-runtime` 下的所有 `agent-loop`、`agent-semantics`、`p2-methods`、`p3-methods` 测试）。
   - 若有任何测试因文本快照或字节计数断言失败，逐一定位并修复，确保 Python + TS 全量测试 100% 通过（0 failure）。
````

---

## 第四部分：后续进阶路线（Phase 2：唤醒 65 个沉睡算子）

在 DeepSeek v4.1 1017 完成上述 **Phase 1（20 张方法卡 × 现有 11 个 P3 工具的契约融合与路由统一）** 并确保全量测试绿灯后，下一步（**Phase 2**）即可按数学族分批将 Python 侧已经写好独立输出审计（`output_checks`）的 **高价值 `full_solve` 算子** 选入 `packages/protocol/src/p3.ts`（`P3_TOOL_NAMES`）与 `python/astra_bridge/p3_effect_contract.py`：

1. **第一批优先开放（精确代数、数论与线性空间，共 6 个）**：
   - `solve_quadratic_diophantine` / `symbolic_diophantine_with_timeout`（归口 `modular-crt`）
   - `solve_system_guarded_expr` / `polynomial_function_check`（归口 `domain-equivalence`）
   - `gf2_rank` / `gf2_nullspace`（归口 `linearization-spectral`）
2. **第二批优先开放（有限状态 DP、转移矩阵与容斥计数，共 5 个）**：
   - `transition_count` / `independence_polynomial_chain`（归口 `finite-state-dp`）
   - `count_by_digit_property`（归口 `finite-state-dp`）
   - `rook_numbers` / `count_avoiding_permutations`（归口 `counting-bijections`）
3. **第三批优先开放（随机过程与数值差分，共 4 个）**：
   - `markov_expected_steps` / `cover_time_complete_graph`（归口 `conditioning-indicators`）
   - `finite_difference_derivative` / `richardson_extrapolate`（归口 `numerical-approximation`）
