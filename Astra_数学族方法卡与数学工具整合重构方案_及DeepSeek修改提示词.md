# Astra (`feat/v4-dynamic-workflows`) 数学族方法卡 × 预注册数学工具 × WASI 沙箱全链路长阶段整合方案（含 DeepSeek v4.1 1017 一次性完整执行提示词）

> **最新仓库基线状态（截至 2026-10-24 最新提交 `c422ddb`）**：
> - **已完成 Phase 1（Commit `fba7766`）**：20 张 `general_v11` 方法卡已内嵌 `## 绑定计算工具与精确调用契约`（31/31 模板实跑通过）；`skill-mapping-manifest.json` 已增加 `general_method_ids` / `tool_ownership` / `relocations`；`agent-semantics.ts` 已新增 `EXACT_DEFINITE_INTEGRAL`、`EXACT_SIMPLIFY` 与 `preferredMethodForToolRoute`（`+1024` 协同加分）；`agent-loop.ts` 已落地方法卡加载后紧邻 WORK 轮次的 `methodToolCoPrompt`（`≤600` 字符协同提示）。
> - **已完成 Phase 2 第一批（Commit `c422ddb`）**：P3 工具白名单已从 **11 扩充至 17**（新增 `solve_quadratic_diophantine`、`symbolic_diophantine_with_timeout`、`solve_system_guarded_expr`、`polynomial_function_check`、`gf2_rank`、`gf2_nullspace`），打通了 `modular-crt.md`、`domain-equivalence.md`、`linearization-spectral.md` 三张卡片的算子契约与路由。
> - **当前门禁实绩**：`tsc -b` 0，Node **464/464**，pytest **998 passed / 24 skipped**，bridge **582 passed**，`release/BUILD_MANIFEST.json` `VERIFY_OK`。
> - **本文档定位**：不再零碎拆分，**一次性给出从当前 `c422ddb` 基线直至最终完成态的四阶段（Stage A ~ Stage D）全链路终局架构方案与 DeepSeek v4.1 1017 完整提示词**（覆盖：`c422ddb` 遗留断层修复 $\to$ P3 算子白名单扩容 `17 → 26` $\to$ 答案闭环 `agent-answer-closure.ts` 全量接入 $\to$ WASI 生成式 Python 沙箱在 `engine="ts"` 下的端到端受控激活）。

---

## 第一部分：最新分支（`c422ddb`）深度代码复审与 WASI 真实定位

### 1. 对最新提交 `c422ddb` 的穿透审查：抓出 6 个待收口的关键断层

#### 断层 1（高危 Bug）：`agent-loop.ts` 的 `methodToolInputConstraint` 漏写 Phase 2 新算子，正在误导模型给整数参数加引号！
- **位置**：`apps/stdio-runtime/src/agent-loop.ts:140-169`（`methodToolInputConstraint`）与 `1455-1467`（`SEMANTIC TOOL TURN`）
- **根因**：`fba7766` 编写的 `methodToolInputConstraint(route)` 只对前 11 个工具写了 `switch (route.toolName)` 分支。`c422ddb` 开放了 6 个新算子后未更新该函数，导致 `solve_quadratic_diophantine`、`gf2_rank`、`gf2_nullspace` 全部掉进 `default` 分支，向模型输出：
  > `"Every expression and matrix entry must be a quoted JSON string; copy it exactly."`
- **后果**：`solve_quadratic_diophantine` 的 `a..f`、`gf2_rank` 的 `rows`、`gf2_nullspace` 的 `rows`/`width` 在 Python `tool_contracts.py` 中强制要求 `type(value) is int`（传字符串直接抛 `InvalidToolInput` 拒绝！）。该 `default` 提示会直接诱导大模型把整数加引号而导致工具调用 100% 失败。

#### 断层 2：基础 `SYSTEM_PROMPT` 与 `skill-mapping-manifest.json` 漏同步 Phase 2 新算子
- **位置**：`apps/stdio-runtime/src/agent-loop-context.ts:231-255`、`mathagent/resources/skill-mapping-manifest.json:7-60`
- **根因**：`c422ddb` 将白名单扩到 17 个，但 `SYSTEM_PROMPT` 仍只描述了前 11 个工具；`skill-mapping-manifest.json` 的 `tool_ownership.tools` 也仍停留在 11 个工具。

#### 断层 3：Phase 2 第二批 + 第三批共 9 个高价值已审计算子仍在门外
- **位置**：`packages/protocol/src/p3.ts`、`python/astra_bridge/p3_effect_contract.py`
- **根因**：`finite-state-dp`、`induction-recurrence`、`counting-bijections`、`conditioning-indicators`、`numerical-approximation` 5 张方法卡对应的 9 个专用核心算子（`transition_count`、`independence_polynomial_chain`、`count_by_digit_property`、`rook_numbers`、`count_avoiding_permutations`、`markov_expected_steps`、`cover_time_complete_graph`、`finite_difference_derivative`、`richardson_extrapolate`）在 Python 端已有完整的独立输出审计（`mathagent/tool_contracts.py` 与 `mathagent/output_checks/numerical.py`），但尚未进入 P3 白名单。

#### 断层 4：答案闭环审计（`agent-answer-closure.ts`）尚未覆盖新老计数/代数/判定算子
- **位置**：`apps/stdio-runtime/src/agent-answer-closure.ts:1447-1515`
- **根因**：目前只有 7 类观测（`DENSITY_CHECK`、`MAXIMAL_MINORS`、`real_root_count_expr`、`splitting_field_degree_expr`、`interpolation_fit_check`、`stats_ols_check`、`finite_group_structure`）能产生 `AnswerClosureDefect`。而 `bounded_enumeration`（精确计数 `count`）、`gf2_rank`（精确秩）、`gf2_nullspace`（精确核维数 `nullspace.length`）、`polynomial_function_check`（精确布尔判定 `identity_holds`）、`transition_count`、`count_by_digit_property`、`count_avoiding_permutations`、`cover_time_complete_graph` 尚未接入闭环诊断（含直接终答与选择题选项级比对 `OPTION_NUMERIC_CONTRADICTION` / `OPTION_VERDICT_CONTRADICTION`）。

#### 断层 5：`agent-loop.ts` 的 `checkerSupportsObligation` 与 `totalEffectCapacity` 边界漏洞
- **位置**：`apps/stdio-runtime/src/agent-loop.ts:457-467, 862-868`
- **根因**：`checkerSupportsObligation` 硬性要求 `typeof action.args.expression === "string"`，导致 `linear_system_solution_set`（参数为 `matrix`/`rhs`，无 `expression`）永远返回 `false`。

#### 断层 6：WASI 生成式 Python 沙箱在 `engine="ts"` 架构下完全断联（0% 参与）
- **位置**：
  - `mathagent/sandbox_wasi.py`（`WasiPythonSandbox`：基于 Wasmtime 48.0.0 + `python-3.12.0.wasm` + 只读 `SymPy 1.12` / `mpmath 1.3.0`，已通过本地 24/24 实机验收 `LOCAL_T27_T28_PASSED`）
  - `mathagent/tools.py:317-347`（`PythonSandbox`）
  - `python/astra_bridge/generated_execution_gate.py`（`GenerativeExecutionGate`）
  - `python/astra_bridge/agent_runtime.py` & `python/astra_bridge/agent_host.py` & `python/astra_bridge/p3_effects.py`
- **真相与定位**：
  - **两套计算通道职责不同**：
    1. **预注册数学工具（`RegisteredExecutor`，26 个白名单算子）**：跑在宿主机原生 Python `multiprocessing` 子进程中，执行固定算法并产出带独立审计的观测/证书，用于**精确核验与闭环纠错**。
    2. **WASI 生成式 Python 沙箱（`WasiPythonSandbox`）**：用于当题目没有现成预注册算子匹配时，允许模型编写一段 ≤64KB 的 Python 探索代码（如小规模打表、递推前几项、构造反例、用 SymPy 辅助化简），在完全无网络、无宿主机文件系统访问的 WebAssembly 沙箱内运行，产出 `BOUNDED_OBSERVATION`。
  - **为什么前几次测评完全没发挥作用**：
    - 从旧版 Python `Controller`（`engine="legacy"`）切换到 TypeScript `AgentLoop`（`engine="ts"`）时，P0 协议规定 Node 进程自身不直接运行 WASI（`nodeCapabilities.wasi: "DISABLED"`），而 Python 宿主侧的 `AgentRuntime` / `AgentHost` / `perform_effect` **根本没有把 `python_sandbox_profile` 和 `WasiPythonSandbox` 接进来**！
  - **怎么在不破坏任何现有 P0/P3 冻结契约的前提下在 `engine="ts"` 中激活 WASI**：
    - 保持 Node 侧 `nodeCapabilities.wasi: "DISABLED"` 100% 不变（因为 WASI 本来就由 Python Host 执行，绝不由 Node 执行）；
    - 在 Python Host 侧（`AgentRuntime` $\to$ `AgentHost` $\to$ `perform_effect`）接入可选的 `python_sandbox_profile`（及环境变量 `ASTRA_WASI_PROFILE`）与 `GenerativeExecutionGate`；
    - 当未配置已验收的 WASI profile 时，保持 100% Fail-Closed（`REFUSED_NO_PROFILE` / 默认现有行为零变化，所有旧单测 100% 通过）；
    - 当显式传入已验收的 WASI profile 时，允许通过受控 P3 探索动作或 Host 侧受控通道调用 `PythonSandbox(profile).execute(code, deadline=deadline, problem_id=session_id, scope=scope)`，将沙箱标准输出封装为 `PROGRAM_OBSERVATION`（带 `"interpretation": "BOUNDED_OBSERVATION_NOT_PROOF"`）返回给 TS `AgentLoop`！

---

## 第二部分：20 张通用方法卡 × 22 个数学族 × 26 个核心算子 × WASI 沙箱全景终局矩阵

| 序号 | `general_v11` 方法卡 ID (20张) | 对应 `math_families` 技能族 (22个) | Stage A+B 完成后的 26 个 P3 白名单算子 | 答案闭环 (`agent-answer-closure.ts`) 覆盖 | WASI 沙箱 (`WasiPythonSandbox`) 协同角色 |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **`domain-equivalence`** | `symbolic_algebra`, `functional_equation` | • ✅ `real_root_count_expr`<br>• ✅ `exact_check_expr[SIMPLIFY]`<br>• ✅ `solve_system_guarded_expr`<br>• ✅ `polynomial_function_check` | • `real_root_count_expr` (数值/选项)<br>• 🎯 `polynomial_function_check` (`identity_holds` 判定闭环) | 非多项式超越方程/复杂函数方程小样本打表探路 |
| 2 | **`modular-crt`** | `diophantine` | • ✅ `solve_quadratic_diophantine`<br>• ✅ `symbolic_diophantine_with_timeout` | • 整数解存在性/解数核对 | 高次同余方程、大模数剩余类小范围穷举验证 |
| 3 | **`linearization-spectral`** | `linear_algebra_gf2`, `symbolic_algebra` | • ✅ `linear_system_solution_set`<br>• ✅ `exact_check_expr[MAXIMAL_MINORS]`<br>• ✅ `gf2_rank`<br>• ✅ `gf2_nullspace` | • `MAXIMAL_MINORS` (次数守恒)<br>• 🎯 `gf2_rank` (秩数值/选项)<br>• 🎯 `gf2_nullspace` (核维数数值/选项) | 一般数域矩阵特征多项式/Jordan 块 SymPy 辅助验算 |
| 4 | **`algebraic-structures`** | `symbolic_algebra`, `polynomial_gcd_crt` | • ✅ `splitting_field_degree_expr`<br>• ✅ `exact_check_expr[FACTOR_OVER_EXTENSION]`<br>• ✅ `finite_group_structure` | • `splitting_field_degree_expr` (次数/选项)<br>• `finite_group_structure` (群阶/共轭类/交换性/循环性) | 8 阶以上群或环/域同态个数的有限构造探索 |
| 5 | **`generating-functions`** | `symbolic_algebra` | • ✅ `polynomial_expand_coefficients` | • 系数提取核对 | 形式幂级数截断展开（SymPy `series`）提取高阶系数 |
| 6 | **`counting-bijections`** | `inclusion_exclusion`, `permutation_comb`, `algorithm_simulation` | • ✅ `bounded_enumeration`<br>• 🎯 **`rook_numbers`**<br>• 🎯 **`count_avoiding_permutations`** | • 🎯 `bounded_enumeration` (精确计数值/选项)<br>• 🎯 `count_avoiding_permutations` (计数值/选项)<br>• 🎯 `rook_numbers` (车多项式系数) | 复杂组合结构的 $n=1..6$ 打表找规律与 OEIS 式序列猜想验证 |
| 7 | **`finite-state-dp`** | `digit_dp`, `transfer_matrix` | • ✅ `bounded_enumeration`<br>• 🎯 **`transition_count`**<br>• 🎯 **`independence_polynomial_chain`**<br>• 🎯 **`count_by_digit_property`** | • 🎯 `transition_count` (路径/状态序列计数)<br>• 🎯 `count_by_digit_property` (数位计数) | 多维状态 DP 转移方程的快速脚本求解 |
| 8 | **`induction-recurrence`** | `transfer_matrix`, `invariant_monovariant` | • ✅ `bounded_enumeration`<br>• 🎯 **`transition_count`**<br>• 🎯 **`independence_polynomial_chain`** | • 共享 `transition_count` 闭环 | 递推数列前 $N$ 项精确有理数打表与归纳假设小样本检验 |
| 9 | **`invariants-extremal`** | `invariant_monovariant`, `extremal_construction`, `game_strategy_proof`, `graph_extremal`, `constrained_tiling` | • ✅ `bounded_enumeration` | • 共享 `bounded_enumeration` 闭环 | 小规模博弈胜负态回溯、极值构型搜索 |
| 10 | **`proof-counterexamples`** | `concept_recall`, `logic_puzzle` | • ✅ `bounded_enumeration` | • 共享 `bounded_enumeration` 闭环 | 全称命题的有限域/小参数反例暴力搜寻 |
| 11 | **`integral-symmetry`** | `symbolic_calculus` | • ✅ `exact_check_expr[DEFINITE_INTEGRAL]`<br>• ✅ `exact_check_expr[TRIG_REDUCE]` | • 🎯 `DEFINITE_INTEGRAL` (精确积分值/选项) | `mpmath.quad` 高精度数值积分交叉核对符号积分结果 |
| 12 | **`convergence-limits`** | `symbolic_calculus` | • ✅ `exact_check_expr[LIMIT]` | • 🎯 `LIMIT` (精确极限值/选项) | 级数部分和与渐近展开（SymPy `limit`/`series`）数值探路 |
| 13 | **`differential-equations`** | `symbolic_calculus` | • ✅ `circle_laplacian_expr`<br>• ✅ `planar_laplacian_expr`<br>• ✅ `exact_check_expr[TRIG_REDUCE]` | • Laplacian 表达式零残差核对 | 常微分方程 SymPy `dsolve` 符号特解探索 |
| 14 | **`conditioning-indicators`** | `probabilistic_model` | • ✅ `exact_check_expr[DENSITY_CHECK]`<br>• ✅ `bounded_enumeration`<br>• 🎯 **`markov_expected_steps`**<br>• 🎯 **`cover_time_complete_graph`** | • `DENSITY_CHECK` (密度积分为 1)<br>• 🎯 `cover_time_complete_graph` (精确有理数覆盖时间) | 超过 6 状态的随机游走/条件期望精确有理数线性方程求解 |
| 15 | **`statistical-inference`** | `probabilistic_model` | • ✅ `exact_check_expr[DENSITY_CHECK]`<br>• ✅ `bounded_enumeration` | • `DENSITY_CHECK` 闭环 | 对数似然导数与 Fisher 信息矩阵符号计算 |
| 16 | **`regression-diagnostics`** | `probabilistic_model` (`stats_ols_check`) | • ✅ `stats_ols_check` | • `OLS_MISMATCH` (斜率/截距/选项) | 多元回归矩阵 $(X^T X)^{-1} X^T y$ 精确有理数验算 |
| 17 | **`numerical-approximation`** | `numerical_methods`, `symbolic_algebra` | • ✅ `interpolation_fit_check`<br>• 🎯 **`finite_difference_derivative`**<br>• 🎯 **`richardson_extrapolate`** | • `INTERPOLATION_RESIDUAL` (插值残差) | 数值迭代格式收敛阶、截断误差首项系数的符号泰勒展开 |
| 18 | **`coordinates-geometry`** | `classical_geometry_compute`, `combinatorial_geometry` | *(通用算子按需调用)* | - | 解析几何建系后交点、距离、面积、轨迹方程的 SymPy 代数消元 |
| 19 | **`inequalities-optimization`** | `inequality_extremum` | *(通用算子按需调用)* | - | 拉格朗日乘子驻点求解与 `mpmath` 约束极值多起点数值探路 |
| 20 | **`topology-local-global`** | `concept_recall` | *(纯概念与反例推理)* | - | 无需计算 |

---

## 第三部分：给 DeepSeek v4.1 1017 的一次性长阶段完整执行提示词（直接复制）

> **使用说明**：以下提示词一次性包含 **Stage A（修复 `c422ddb` 遗留断层）$\to$ Stage B（开放 9 个核心算子 `17 → 26` 及路由/卡片融合）$\to$ Stage C（答案闭环 `agent-answer-closure.ts` 扩容）$\to$ Stage D（WASI 沙箱在 `engine="ts"` 的受控桥接激活）$\to$ Stage E（全量打包与三重哈希门禁）**。无需再分批拆写，直接完整发给 DeepSeek v4.1 1017 执行。

````markdown
你现在是 `astra-refactored` 仓库（分支 `feat/v4-dynamic-workflows`，当前 HEAD `c422ddb`）的首席架构重构工程师。
请一次性完整执行以下 **Stage A ~ Stage E 全链路工程实施计划**，把「数学族方法卡 × 26 个预注册数学工具 × 答案闭环诊断 × WASI 生成式 Python 沙箱」彻底打通并收口。

---

### 零、 必须死守的 6 条红线与哈希/Schema 锁（改前必读！）

1. **严禁触碰冻结基线**：
   - 严禁修改 `math_families/**` 下的任何源码或 `catalog.json`。
   - 严禁修改冻结的 1.2 版 `packages/protocol/schema/agent-host.schema.json`（必须保持 8 个工具名和固定 SHA `d21953e2…`）。
   - 严禁修改 `packages/protocol/schema/p0.schema.json` 中 Node 进程的 `nodeCapabilities.wasi: "DISABLED"`（在 P0/P3 信任边界中，Node 子进程永远不直接跑 WASI，WASI 100% 由 Python Host 侧的 `WasiPythonSandbox` 隔离执行）。
2. **P3 工具白名单的 5 份 Live 副本必须逐字同步、顺序完全一致**：
   - `packages/protocol/src/p3.ts`（`P3_TOOL_NAMES`）
   - `python/astra_bridge/p3_effect_contract.py`（`TOOL_NAMES`）
   - `packages/protocol/schema/agent-host-v13.schema.json`
   - `release/schema/agent-host-v13.schema.json`（必须与 `packages/protocol/schema/agent-host-v13.schema.json` 逐字节一致！）
   - `packages/protocol/schema/p3-host.schema.json`
3. **方法卡体积与三重 SHA-256 锁**：
   - 每张 `mathagent/resources/general_v11/references/*.md` 修改后必须控制在 **10,000 UTF-8 字节 / 4,000 Unicode 字符以内**（远低于 `p3-methods.ts` 的 16,000 字节上限）。
   - 修改任何卡片或 `skill-mapping-manifest.json` 后，必须在 Stage E 重算并更新：
     1. `mathagent/resources/general_v11/SOURCE.json`
     2. `packages/protocol/schema/a2-source-lock.json`（其中 `mathagent/resources/general_v11/SOURCE.json` 的单行 SHA pin）
     3. `python/astra_bridge/asset_baseline.json`（通过 `registry_snapshot` 更新并断言 `verify_integrity` 为 `ok=True`）
4. **生产 Bundle 与 `release/BUILD_MANIFEST.json` 锁**：
   - `tsc -b` 不会更新 `release/stdio-runtime.bundle.mjs`！修改 TS 后必须用 `esbuild` 重新生成 `release/stdio-runtime.bundle.mjs`，再运行 `python3 scripts/build_release_manifest.py` 并通过 `--verify release/BUILD_MANIFEST.json` 校验。
5. **契约模板必须 100% 实跑验证**：
   - 写进方法卡和路由 `argsTemplate` 的每一个 JSON 示例，都必须在真实 `RegisteredExecutor().execute(name, args)` 下实跑返回 `status == "ok"` 且 `audit.status` 通过校验（`VERIFIED_FOR_INPUT` 或 `CHECKED_*`）。
6. **非作弊（Non-cheating）红线**：
   - 严禁使用题号、题目哈希、参考答案或隐藏表；所有路由与闭环诊断 100% 基于通用数学措辞与工具观测结构。

---

### Stage A：修复 `c422ddb` 遗留的 4 处上下游断层（阻塞性 Bug 修复）

1. **修复 `apps/stdio-runtime/src/agent-loop.ts:140-169` 的 `methodToolInputConstraint(route)` 与 `1455-1467` 行的 `SEMANTIC TOOL TURN`**：
   - **当前 Bug**：`c422ddb` 新增了 6 个算子，但未在 `methodToolInputConstraint` 中添加 `case`，导致 `solve_quadratic_diophantine`、`gf2_rank`、`gf2_nullspace` 掉入 `default` 分支，错误提示模型 `"Every expression and matrix entry must be a quoted JSON string"`——而这三个工具在 `mathagent/tool_contracts.py` 中强制要求传 **JSON 整数**（传字符串直接报 `invalid_input` 拒绝）！
   - **修改动作**：
     - 在 `methodToolInputConstraint(route)` 中为所有 Phase 2 算子（含 `c422ddb` 的 6 个与 Stage B 的 9 个）补齐真实输入约束：
       - `solve_quadratic_diophantine`: `"Pass a, b, c, d, e, f (and optional y_bound) as JSON integers with |coeff|<=32 and a!=0; do not quote numbers."`
       - `symbolic_diophantine_with_timeout`: `"Pass lhs (and optional rhs) as polynomial strings using ** for powers, and optional two-variable list variables."`
       - `solve_system_guarded_expr`: `"Pass expressions as an array of <=6 polynomial strings (using **) and variables as an array of <=3 variable names."`
       - `polynomial_function_check`: `"Pass exactly the five fields equation, function, argument, variables and univariate rational polynomial expression."`
       - `gf2_rank`: `"Pass rows ONLY as an array of <=8 non-negative JSON integers encoding binary rows (<=8 bits); do not pass width or strings."`
       - `gf2_nullspace`: `"Pass rows (<=8 non-negative JSON integers) and integer width (1..8) only; do not quote integers."`
       - `transition_count`: `"Pass integer length (1..6), integer num_states (1..4), transitions as [u,v] integer pairs, and optional integer arrays starts/ends (omit if default, never null)."`
       - `independence_polynomial_chain`: `"Pass n as a non-negative JSON integer (0..16); do not quote n."`
       - `count_by_digit_property`: `"Pass digit_set (array of ints 0..9), max_digits (1..3), and optional modulus (1..64), residue (0..modulus-1), include_zero (boolean)."`
       - `rook_numbers`: `"Pass integer n (1..5) and forbidden as an array of <=10 [r,c] integer pairs with 0<=r,c<n."`
       - `count_avoiding_permutations`: `"Pass integer n (1..6) and forbidden as an array of [i, pi_i] integer pairs with 0<=i,pi_i<n."`
       - `cover_time_complete_graph`: `"Pass num_vertices as a JSON integer in 2..8."`
       - `markov_expected_steps`: `"Pass transition as a <=6x6 matrix of exact decimal numbers summing to 1 per row, integer start, and non-empty integer array targets."`
       - `finite_difference_derivative`: `"Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method (central/forward/backward)."`
       - `richardson_extrapolate`: `"Pass f as an expression string in x, numeric x (|x|<=100), numeric step h (1e-6..1), and optional method and integer order (1..8)."`
     - 在 `agent-loop.ts:1456-1467` 的 `SEMANTIC TOOL TURN` 中，将原来的固定句 `"Copy the explicit expression... never place raw arithmetic outside a quoted JSON string"` 替换为调用 `methodToolInputConstraint(route) + " Never substitute a different tool."`，避免对整数参数工具给出冲突指令。
2. **修复 `apps/stdio-runtime/src/agent-loop.ts:457-467` 的 `checkerSupportsObligation`**：
   - 当 `action.name === "linear_system_solution_set"` 时，检查 `Array.isArray(action.args.matrix) && Array.isArray(action.args.rhs)`，而不是要求 `typeof action.args.expression === "string"`。
3. **同步更新 `apps/stdio-runtime/src/agent-loop-context.ts:231-255` 的 `SYSTEM_PROMPT` 与 `mathagent/resources/skill-mapping-manifest.json` 的 `tool_ownership.tools`**：
   - 在 `SYSTEM_PROMPT` 中补齐 `c422ddb` 的 6 个算子与 Stage B 新增的 9 个算子的一行式参数说明（确保总上下文远低于 `65536` 字节，并检查是否有测试断言了 `SYSTEM_PROMPT` 固定字面量，如有则同步更新）。
   - 在 `skill-mapping-manifest.json` 的 `tool_ownership.tools` 中完整登记全部 26 个 P3 白名单算子的 `family_id` 与权威 `general_method_id`。

---

### Stage B：一次性开放 Phase 2 第二批 + 第三批共 9 个高价值算子（P3 白名单 `17 → 26`）

#### 1. 按固定顺序在 5 份 Live 白名单中追加以下 9 个算子（总数 17 -> 26）
必须严格依照 `mathagent/tool_contracts.py` 与 `mathagent/output_checks/numerical.py` 中已实现的真实契约：

| 序号 | 算子名称 (`P3ToolName`) | `mathagent` 真实参数契约与审计范围（已核实源码） | 实跑验证 JSON 模板 (`argsTemplate`) | 归属方法卡 ID |
| :-: | :--- | :--- | :--- | :--- |
| 18 | `transition_count` | `length`: int `1..6`（顶点数而非边数）；`num_states`: int `1..4`；`transitions`: `[[u,v],...]`（`0<=u,v<num_states`）；可选 `starts`/`ends` 整数列表（默认全集时必须省略字段，严禁传 `null`） | `{"length":3,"num_states":2,"transitions":[[0,1],[1,0],[1,1]]}` | `finite-state-dp` |
| 19 | `independence_polynomial_chain` | `n`: int `0..16`（返回路图 $P_n$ 独立集多项式系数列表，最高次项在前） | `{"n":5}` | `finite-state-dp` |
| 20 | `count_by_digit_property` | `digit_set`: `[0..9]` 非空整数列表；`max_digits`: int `1..3`；可选 `modulus`: int `1..64`（默认 1），`residue`: int `0..modulus-1`（默认 0），`include_zero`: bool（默认 `false`） | `{"digit_set":[1,2,3],"max_digits":3,"modulus":3,"residue":0,"include_zero":false}` | `finite-state-dp` |
| 21 | `rook_numbers` | `n`: int `1..5`；`forbidden`: `[[r,c],...]`（最多 10 个禁位格，`0<=r,c<n`），返回 `[r_0, r_1, ..., r_n]` | `{"n":3,"forbidden":[[0,0],[1,1],[2,2]]}` | `counting-bijections` |
| 22 | `count_avoiding_permutations` | `n`: int `1..6`；`forbidden`: `[[i, pi_i],...]`（`0<=i, pi_i<n`），返回满足 $\forall i, (i, \pi(i)) \notin \text{forbidden}$ 的排列总数 | `{"n":4,"forbidden":[[0,0],[1,1],[2,2],[3,3]]}` | `counting-bijections` |
| 23 | `markov_expected_steps` | `transition`: `<=6x6` 精确有限小数转移矩阵（每行和精确等于 1）；`start`: int；`targets`: 非空目标吸收态整数列表 | `{"transition":[[0.0,1.0],[0.5,0.0,0.5],[0.0,0.0,1.0]],"start":0,"targets":[2]}` *(注：确保为方阵如 `[[0.0,1.0,0.0],[0.5,0.0,0.5],[0.0,0.0,1.0]]`)* | `conditioning-indicators` |
| 24 | `cover_time_complete_graph` | `num_vertices`: int `2..8`（返回无自环完全图 $K_N$ 随机游走覆盖全部顶点的精确期望步数有理数） | `{"num_vertices":4}` | `conditioning-indicators` |
| 25 | `finite_difference_derivative` | `f`: 关于 `x` 的标量表达式字符串；`x`: 数值（`|x|<=100`）；`h`: 步长数值（`1e-6 <= h <= 1`）；可选 `method`: `"central"` \| `"forward"` \| `"backward"`，可选 `order`: `1..8` | `{"f":"x**3","x":1.0,"h":0.01,"method":"central"}` | `numerical-approximation` |
| 26 | `richardson_extrapolate` | `f`: 关于 `x` 的标量表达式字符串；`x`: 数值（`|x|<=100`）；`h`: 步长数值（`1e-6 <= h <= 1`）；可选 `method`: `"central"` \| `"forward"` \| `"backward"`；可选 `order`: int `1..8` | `{"f":"x**3","x":1.0,"h":0.01,"method":"central","order":2}` | `numerical-approximation` |

#### 2. 在 `apps/stdio-runtime/src/agent-semantics.ts` 中新增 9 条确定性措辞路由并绑定 `TOOL_ROUTE_PREFERRED_METHOD`
- 将 9 条新路由排在现有 17 条路由之后（确保现有 17 条路由优先级与行为零变化），并注意互斥边界：
  1. `TRANSITION_COUNT_ROUTE`：命中“状态转移 / 转移图 / 有向图上长为 $L$ 的顶点序列数 / transition graph / state transitions”且含状态数/步长计数的措辞 $\to$ `"finite-state-dp"`
  2. `INDEPENDENCE_POLYNOMIAL_CHAIN_ROUTE`：命中“独立集多项式 / 路图 $P_n$ 的独立集 / 不相邻顶点子集计数 / independence polynomial of path” $\to$ `"finite-state-dp"`
  3. `COUNT_BY_DIGIT_PROPERTY_ROUTE`：命中“十进制数位 / 数字集合组成 / 数位 DP / 各位数字属于集合且被 $m$ 整除 / digit property” $\to$ `"finite-state-dp"`
  4. `ROOK_NUMBERS_ROUTE`：命中“车多项式 / 禁位棋盘的车数 / rook polynomial / rook numbers” $\to$ `"counting-bijections"`
  5. `COUNT_AVOIDING_PERMUTATIONS_ROUTE`：命中“错排 / 禁位排列 / 禁止位置集合的排列数 / permutations avoiding forbidden cells / derangement” $\to$ `"counting-bijections"`
  6. `MARKOV_EXPECTED_STEPS_ROUTE`：命中“马尔可夫链 / Markov chain / 转移概率矩阵”且询问“期望步数 / 首次击中时间 / 吸收时间 / expected steps / hitting time” $\to$ `"conditioning-indicators"`
  7. `COVER_TIME_COMPLETE_GRAPH_ROUTE`：命中“完全图 $K_n$ / complete graph”且询问“覆盖时间 / 访问所有顶点的期望步数 / cover time” $\to$ `"conditioning-indicators"`
  8. `FINITE_DIFFERENCE_DERIVATIVE_ROUTE`：命中“有限差分 / 中心差分 / 向前差分 / 向后差分 / finite difference derivative”（排除显式要求 Richardson 外推的题目）$\to$ `"numerical-approximation"`
  9. `RICHARDSON_EXTRAPOLATE_ROUTE`：命中“Richardson 外推 / 理查森外推 / Richardson extrapolation” $\to$ `"numerical-approximation"`

#### 3. 更新对应的 5 张 `general_v11/references/*.md` 方法卡
- 在 `finite-state-dp.md`、`induction-recurrence.md`、`counting-bijections.md`、`conditioning-indicators.md`、`numerical-approximation.md` 的 `## 绑定计算工具与精确调用契约` 章节中，补充上述新算子的【何时用 / `args` 模板 / 输入约束 / 输出边界】，并编写测试从卡片反抽所有 JSON 模板送入 `RegisteredExecutor` 实跑验证 `status == "ok"`。

---

### Stage C：将高确定性算子接入答案闭环诊断（`apps/stdio-runtime/src/agent-answer-closure.ts`）

在 `apps/stdio-runtime/src/agent-answer-closure.ts` 中，严格遵循现有的 **Fail-Closed 零误报原则**（观测缺失、一句内含多个未归属数字、或含否定/模糊词 `不/非/未必/可能/not/may` 时绝不产生缺陷），扩展以下精确观测的闭环对齐检查：

1. **扩展 `OPTION_NUMERIC_CONTRADICTION`（`observedOptionQuantities`）与直接数值候选比对**：
   - **`gf2_rank`**：观测返回整数秩 $r$。当候选答案或选中选项文本在同一从句中明确断言“GF(2) 秩 / 二元矩阵的秩 / 模 2 秩 / rank over GF(2)”为另一个整数 $k \neq r$ 时，报告矛盾。
   - **`gf2_nullspace`**：观测返回核空间基数组 `nullspace`（维数 $d = \text{nullspace.length}$）。当候选答案或选中选项明确断言“零空间维数 / 核空间维数 / nullity / dimension of nullspace”为另一个整数 $k \neq d$ 时，报告矛盾。
   - **`bounded_enumeration` / `transition_count` / `count_by_digit_property` / `count_avoiding_permutations`**：当观测返回精确非负整数计数值（`bounded_enumeration` 的 `result.count`，或后三者的整数 `result`），且候选答案是一个纯整数字符串 $m$（或选中选项明确声明“共有 $m$ 种 / 个数为 $m$”）且 $m \neq \text{observed}$ 时（注意：若问题是求概率即答案是分数如 `223/8330`，而 `bounded_enumeration` 只算了分子或分母，则纯整数比对自动跳过，绝不误报分数概率题！），报告计数矛盾。
   - **`cover_time_complete_graph`**：观测返回精确期望覆盖时间（整数或精确分数 `p/q`）。当候选答案或选中选项断言的覆盖时间数值与之精确不等时，报告矛盾。
2. **扩展判定类闭环（`polynomial_function_check`）**：
   - 当 `polynomial_function_check` 观测返回 `identity_holds === false` 且带有反例 `witness`，但候选答案给出了纯肯定判定（`"真"` / `"成立"` / `"是"` / `"true"` / `"yes"`）时，报告判定矛盾缺陷。
3. **单测覆盖**：
   - 在 `apps/stdio-runtime/tests/agent-answer-closure.test.ts` 中为上述新增闭环诊断补充正例（矛盾时产出 defect）与反例（一致、概率分数、多数字歧义、否定句时返回 `[]` 零误报）。

---

### Stage D：在 `engine="ts"` 中受控激活 WASI 生成式 Python 沙箱（Host 侧桥接）

**架构原则**：
- P0 协议中 Node 侧 `nodeCapabilities.wasi` 保持 `"DISABLED"` 不变（Node 绝不碰 WASI）。
- WASI 沙箱位于 Python Host 侧（`mathagent/tools.py:PythonSandbox` $\to$ `mathagent/sandbox_wasi.py:WasiPythonSandbox`），受 `python/astra_bridge/generated_execution_gate.py:GenerativeExecutionGate` 门控。
- 默认无 profile 时 100% Fail-Closed（所有旧测试行为逐字节不变）；当调用方显式传入已验收的 `python_sandbox_profile`（或环境变量 `ASTRA_WASI_PROFILE`）时，在 Host 侧打通受控执行链路！

**具体修改动作**：
1. **在 `python/astra_bridge/p3_effects.py` 中支持可选的 `python_sandbox` 注入**：
   - `perform_effect(request, *, executor=None, catalog=None, python_sandbox=None, clock=time.monotonic, root_deadline=None)`：保持向后兼容，新增可选关键字参数 `python_sandbox=None`。
2. **在 `python/astra_bridge/generated_execution_gate.py` 中增加 `execute_with_gate(gate, sandbox, request, code, *, deadline, problem_id, scope="bounded generated exploration")` 辅助函数**：
   - 首先调用 `gate.decision(request)`：若不是 `"ADMITTED"`，直接返回拒绝决策 `{ "admitted": False, "reason": decision, "result": None }`（绝不执行代码）。
   - 若 `"ADMITTED"` 且 `sandbox is not None and getattr(sandbox, "available", False)`，调用 `sandbox.execute(code, deadline=deadline, problem_id=problem_id, scope=scope)`，将结果封装为 `BOUNDED_OBSERVATION`（明确标注 `"interpretation": "BOUNDED_OBSERVATION_NOT_PROOF"`）。
3. **在 `python/astra_bridge/agent_host.py` 与 `python/astra_bridge/agent_runtime.py` 中透传可选参数 `python_sandbox_profile=None`**：
   - `AgentRuntime.__init__` 与 `AgentHost.__init__` 新增可选参数 `python_sandbox_profile=None`（默认 `None`，若未传且环境变量 `ASTRA_WASI_PROFILE` 存在且非空，可读取该路径；若为 `None` 则 `self.python_sandbox = None`，完全不触发任何文件 I/O，确保现有 998 个 pytest 用例 100% 零感知通过）。
   - 当显式传入 `python_sandbox_profile` 时，通过 `from mathagent.tools import PythonSandbox; self.python_sandbox = PythonSandbox(profile=python_sandbox_profile)` 初始化实例并绑定 `self.python_sandbox_identity = self.python_sandbox.identity`。
   - 新增桥接单测 `tests/bridge/test_wasi_host_bridge.py`：测试（1）默认无 profile 时 `AgentRuntime` / `GenerativeExecutionGate` 严格 `REFUSED_NO_PROFILE`；（2）传入受控 mock/stub `PythonSandbox` 与匹配的 `GenerativeExecutionGate` 时，`execute_with_gate` 能够正确放行并返回 `BOUNDED_OBSERVATION` 且超界/SHA 不匹配时严格拒绝。

---

### Stage E：全量构建、三重 SHA-256 刷新与门禁验收（一步不漏）

完成 Stage A ~ Stage D 后，严格按顺序执行以下命令直至全部绿灯：

```bash
# 1. 验证所有卡片中的 JSON 模板都能在真实 RegisteredExecutor 下跑通 status == "ok"
python3 - <<'PY'
import json, re
from pathlib import Path
from mathagent.tools import RegisteredExecutor
from mathagent.tool_inventory import validate_inventory

assert validate_inventory() == {"families": 22, "tools": 76}
ex = RegisteredExecutor()
cards_dir = Path("mathagent/resources/general_v11/references")
count = 0
for card in sorted(cards_dir.glob("*.md")):
    text = card.read_text(encoding="utf-8")
    assert len(text.encode("utf-8")) <= 10000, f"{card.name} exceeds 10000 UTF-8 bytes"
    assert len(text) <= 4000, f"{card.name} exceeds 4000 chars"
    for m in re.finditer(r"### `([a-z0-9_]+)(?:.*?)`\s*\n(?:- [^\n]+\n)*?- `args` 模板：\s*\n```json\s*\n(\{.*?\})\s*\n```", text):
        tool_name, raw_json = m.group(1), m.group(2)
        args = json.loads(raw_json)
        res = ex.execute(tool_name, args)
        assert res.status == "ok", f"{card.name} -> {tool_name} failed: {res}"
        count += 1
print(f"Verified {count} card tool templates: ALL OK")
PY

# 2. 更新 general_v11/SOURCE.json、a2-source-lock.json 与 asset_baseline.json
python3 - <<'PY'
import hashlib, json
from pathlib import Path
from python.astra_bridge.host_assets_registry import registry_snapshot, verify_integrity

root = Path(".")
source_path = root / "mathagent/resources/general_v11/SOURCE.json"
source_data = json.loads(source_path.read_text(encoding="utf-8"))
for rel in list(source_data["files"].keys()):
    p = root / "mathagent/resources/general_v11" / rel
    source_data["files"][rel] = hashlib.sha256(p.read_bytes()).hexdigest()
source_path.write_text(json.dumps(source_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

source_sha = hashlib.sha256(source_path.read_bytes()).hexdigest()
a2_lock_path = root / "packages/protocol/schema/a2-source-lock.json"
a2_data = json.loads(a2_lock_path.read_text(encoding="utf-8"))
if "files" in a2_data and "mathagent/resources/general_v11/SOURCE.json" in a2_data["files"]:
    a2_data["files"]["mathagent/resources/general_v11/SOURCE.json"] = source_sha
    a2_lock_path.write_text(json.dumps(a2_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

baseline_path = root / "python/astra_bridge/asset_baseline.json"
snap = registry_snapshot(root)
baseline_path.write_text(json.dumps(snap, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
ver = verify_integrity(root)
assert ver["ok"] is True, f"Integrity failed: {ver}"
print("Integrity baselines updated and verified OK.")
PY

# 3. 编译 TypeScript 并重建 release/stdio-runtime.bundle.mjs 与 release/BUILD_MANIFEST.json
node node_modules/typescript/bin/tsc -b
node node_modules/esbuild/bin/esbuild apps/stdio-runtime/dist/src/main.js \
  --bundle --platform=node --format=esm \
  --outfile=release/stdio-runtime.bundle.mjs --log-level=warning
python3 scripts/build_release_manifest.py
python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json

# 4. 运行全量 Node 与 Python 门禁
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
python3 -m pytest -q
git diff --check
```

全部通过后，在 `HANDOFF.md`（新增 §16）和 `docs/GATEBOARD.md` 末尾如实记录本轮 Stage A ~ Stage E 的实施证据与最新测试通过数。
````
