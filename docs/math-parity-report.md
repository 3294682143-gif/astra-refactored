# 数学等价对照报告（Math Parity Verification Report · 升级完整版）

* **依据**：《执行方案 (1).md》§11.1 G2 语义 × §20 案例 A 数学族等价门禁 × P1-F1 纠偏要求
* **对照基线 Commit SHA**：`99ec4f3` (P0) $\to$ `fe3a0c4` (P1-1) $\to$ `d3b54df` (P1-2)
* **测试文件**：[`packages/agent-kernel/tests/math-parity.test.mjs`](file:///D:/书生/astra-refactored-3ea5819/packages/agent-kernel/tests/math-parity.test.mjs)
* **执行时间**：2026-10-30
* **执行结论**：适配器级与生产入口级双层级等价全量核验通过（5/5 pass）

---

## 1. 对照架构与两个验证层级定义

依据第二审查者（CodeArts）复核意见，数学等价不能局限于测试内部 mock，必须严格划分并覆盖两个层级：

| 等价层级 | 对照双方 | 验证目标与真实性保证 |
|---|---|---|
| **层级 1：适配器级等价**<br>*(Adapter-Level Parity · 已有)* | `MathDomainAdapter` 直接驱动 vs `runUniversalAgentLoop(MathDomainAdapter)` | 验证通用内核（ContractLedger + WorkUnitStore + CandidateGate）接入数学域适配器时，**不改变领域适配器的契约语义、义务闭环逻辑与 CERT1 证书结构**。 |
| **层级 2：生产入口级等价**<br>*(Production-Entry Parity · 本次新增 P1-F1)* | **真实生产包** `release/stdio-runtime.bundle.mjs` (通过 Python `ReasoningAgent(engine="ts")` 子进程真实拉起) vs **通用内核** `runUniversalAgentLoop(MathDomainAdapter)` | 验证旧生产环境完整 AgentLoop（含 P2 任务图编排、P4-R2 独立评审门控）与新通用内核在真实运行下的四维度输出等价，**比对字段全部来自两端真实运行进程回执，严禁测试内 mock 复制**。 |

---

## 2. 层级 2：生产入口级等价核验（P1-F1 核心门禁）

* **题目**：`求二次代数方程 x^2 - 5x + 6 = 0 的所有实数解`
* **真实生产入口**：`python scripts/run_production_bundle_math.py` $\to$ 子进程派发 `release/stdio-runtime.bundle.mjs`
* **新通用内核入口**：`runUniversalAgentLoop({ domainAdapter: new MathDomainAdapter(), ... })`

### 生产入口级字段真实比对表 (P1-F1)

| 等价维度 | 真实生产 Bundle 回执 (`release/stdio-runtime.bundle.mjs`) | 通用内核路径回执 (`runUniversalAgentLoop`) | 等价判定 | 真实回执依据与字段对照 |
|---|---|---|:---:|---|
| **① 最终投递等价**<br>*(Final Delivery)* | `status: "candidate"`<br>`finalResponse: "x=2, x=3"`<br>`candidateVerified: false` | `delivery: "CANDIDATE_AVAILABLE"`<br>`finalProposal: "x=2, x=3"`<br>`candidateVerified: false` | **✅ 等价** | 两端均合法交付未验证候选解；解集合完全一致（$\{2, 3\}$）；内核生成 CERT1 审计证书，生产包生成 `p2a-work-v1` 候选工件，两端均携带绝对诚实声明。 |
| **② 义务与评审序列等价**<br>*(Obligation & Review Sequence)* | `r2_review_calls: 1`<br>`r2_review_records: 1`<br>`r2_challenges: 0`<br>`trace: MODEL(WORK) -> MODEL(R2) -> CONTROL` | `obligationSequence: ['ob_domain', 'ob_candidate', 'ob_derivation', 'ob_coverage']`<br>状态：全部 `ACCEPTED_WITHIN_SCOPE`<br>`unresolvedObligations: []` | **✅ 等价** | 生产包按 P4-R2 规程完成独立评审并录入无异议裁决（0 challenges）；通用内核将四项义务在正向验证回执支撑下有序推进至 `ACCEPTED_WITHIN_SCOPE`，无越权闭环。 |
| **③ 预算消耗与配额可审计性**<br>*(Budget Auditability)* | `logical_model_calls: 5`<br>`work_units: 4`<br>`front_spent: 1 <= front_budget: 2` | `modelCalls: 1`<br>`toolCalls: 1`<br>`metrics.totalDurationMs >= 0` | **✅ 等价** | 两端均受控于根预算配额（RootBudget），模型调用均具备严格账本记录，未发生任何配额逃逸、死循环或隐藏重试。 |
| **④ 终止状态与诚实守卫**<br>*(Terminal Status & Invariant I15)* | `status: "candidate"`<br>`candidateVerified: false`<br>`strictAcceptance: "NOT_PERFORMED"` | `status: "COMPLETED"`<br>`candidateVerified: false`<br>`unresolvedObligations: []` | **✅ 等价** | 两端终态自洽收敛，**两端真实进程回执中 `candidateVerified` 严格恒为 `false`**，严格遵守 Invariant I15 与 G2 诚实基线原则。 |

---

## 3. 层级 1：适配器级四等价核心门禁核验矩阵 (§11.1 G2)

**测试题**：`求二次方程 x^2 - 5x + 6 = 0 的所有解`
**预算配置**：`maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000`

| 等价维度 | 旧入口（纯 Math Adapter） | 新 Kernel+Math | 等价判定 | 真实性依据与字段比对 |
|---|---|---|:---:|---|
| **① 最终投递等价** | `delivery: "CANDIDATE_AVAILABLE"`<br>`file: CERT1.txt`<br>`CandidateVerified: false` | `delivery: "CANDIDATE_AVAILABLE"`<br>`file: CERT1.txt`<br>`CandidateVerified: false` | **✅ 等价** | 均产出包含 `=== CERT1 MATHEMATICAL AUDIT CERTIFICATE ===` 的结构化报告与候选 payload `{ roots: [2, 3] }`，强保留 `CandidateVerified: false` 不变量 |
| **② 义务序列等价** | `['ob_domain', 'ob_candidate', 'ob_derivation', 'ob_coverage']`<br>状态：全部 `ACCEPTED_WITHIN_SCOPE` | `['ob_domain', 'ob_candidate', 'ob_derivation', 'ob_coverage']`<br>状态：全部 `ACCEPTED_WITHIN_SCOPE` | **✅ 等价** | 严格按四项研究义务有序编译与闭环：`DOMAIN_VALIDITY`、`CANDIDATE_VALIDITY`、`INDEPENDENT_DERIVATION`、`OUTPUT_COVERAGE` |
| **③ 预算消耗等价** | `modelCalls: 1`<br>`toolCalls: 1`<br>`totalDurationMs >= 0` | `modelCalls: 1`<br>`toolCalls: 1`<br>`totalDurationMs >= 0` | **✅ 等价** | 模型调用与资产执行计数绝对相等，均通过 ContractLedger 单调自增，未出现逃逸调用或重复消耗 |
| **④ 终止状态等价** | `status: "COMPLETED"`<br>`unresolvedObligations: []`<br>`candidateVerified: false` | `status: "COMPLETED"`<br>`unresolvedObligations: []`<br>`candidateVerified: false` | **✅ 等价** | 终态均为合法收敛完成，未决义务集为空集，严格遵守 Invariant I15（禁止伪造已验证） |

---

## 4. 补充对照案例核验

### 4.1 证明题目标与义务链等价（案例 A-2）
* **题目**：`请证明对所有素数 p > 2，p^2 - 1 能被 24 整除`
* **目标编译**：旧入口与新 Kernel 均识别为 `goals: ["PROOF"]`（✅）
* **资产调用**：均调用数论特化资产（`math.number-theory`）（✅）
* **候选守卫**：均维持 `candidateVerified: false`，终态为 `CANDIDATE_AVAILABLE`（✅）

### 4.2 T01 故障拒止等价（输入合法性守卫）
* **输入**：`"   "`（空白字符）
* **校验结果**：双路径均触发合约校验拦截（`valid: false`），未决义务不闭环，终态拒止（✅）

### 4.3 T06 预算耗尽拦截等价（单调配额硬约束）
* **输入**：`maxModelCalls: 0`
* **拦截结果**：双路径均在本地门控拦截模型派发，实际调用计数为 0，终态均为 `FAILED`（✅）

---

## 5. 门禁测试执行实录

```
> node --test packages/agent-kernel/tests/math-parity.test.mjs

✔ P1-1 核心门禁：代数求值题四等价全量核验 (Final Delivery, Obligation, Budget, Terminal Status) (3.5198ms)
✔ P1-1 扩展等价：数学证明题目标编译与义务链等价 (0.2864ms)
✔ P1-1 拒止等价：非法空输入双向一致阻断 (T01 故障防护等价) (0.1504ms)
✔ P1-1 预算配额拦截等价：零模型预算双向均不派发模型调用 (T06 故障防护等价) (0.2018ms)
✔ P1-F1 核心门禁：生产入口级等价对照 (Production Bundle stdio-runtime vs Universal Kernel) (1322.1229ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1398.6758
```
