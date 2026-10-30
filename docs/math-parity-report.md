# 数学等价对照报告（Math Parity Verification Report）

* **依据**：《执行方案 (1).md》§11.1 G2 语义 × §20 案例 A 数学族等价门禁
* **对照基线 Commit SHA**：`99ec4f3` (`chore(release): update BUILD_MANIFEST to P0 commit`)
* **测试文件**：[`packages/agent-kernel/tests/math-parity.test.mjs`](file:///D:/书生/astra-refactored-3ea5819/packages/agent-kernel/tests/math-parity.test.mjs)
* **执行时间**：2026-10-30
* **执行结论**：四等价全量核验通过（4/4 pass，15/15 kernel 全绿）

---

## 1. 对照架构与双路径定义

为消除数学特化调度与通用领域内核的割裂，系统提供双路径对同一标准数学题（§20 案例 A）进行同一 RunSpec 双跑对比：

| 路径标识 | 架构组成 | 职责边界 |
|---|---|---|
| **路径 1：旧入口（纯 Math Adapter）** | `@zygos/domain-math` (`MathDomainAdapter`) 直接驱动 | 保持数学资产特化的合约编译、观察归约与 CERT1 格式化 |
| **路径 2：新 Kernel+Math** | `@zygos/agent-kernel` (`runUniversalAgentLoop`) + `MathDomainAdapter` | 通用调度循环（ContractLedger + WorkUnitStore + CandidateGate），无任何领域硬编码 |

---

## 2. 案例 A 四等价核心门禁核验矩阵 (§11.1 G2)

**测试题**：`求二次方程 x^2 - 5x + 6 = 0 的所有解`
**预算配置**：`maxModelCalls: 5, maxToolCalls: 5, deadlineMonotonicMs: 60000`

| 等价维度 | 旧入口（纯 Math Adapter） | 新 Kernel+Math | 等价判定 | 真实性依据与字段比对 |
|---|---|---|:---:|---|
| **① 最终投递等价**<br>*(Final Delivery)* | `delivery: "CANDIDATE_AVAILABLE"`<br>`file: CERT1.txt`<br>`CandidateVerified: false` | `delivery: "CANDIDATE_AVAILABLE"`<br>`file: CERT1.txt`<br>`CandidateVerified: false` | **✅ 等价** | 均产出包含 `=== CERT1 MATHEMATICAL AUDIT CERTIFICATE ===` 的结构化报告与候选 payload `{ roots: [2, 3] }`，强保留 `CandidateVerified: false` 不变量 |
| **② 义务序列等价**<br>*(Obligation Sequence)* | `['ob_domain', 'ob_candidate', 'ob_derivation', 'ob_coverage']`<br>状态：全部 `ACCEPTED_WITHIN_SCOPE` | `['ob_domain', 'ob_candidate', 'ob_derivation', 'ob_coverage']`<br>状态：全部 `ACCEPTED_WITHIN_SCOPE` | **✅ 等价** | 严格按四项研究义务有序编译与闭环：`DOMAIN_VALIDITY`、`CANDIDATE_VALIDITY`、`INDEPENDENT_DERIVATION`、`OUTPUT_COVERAGE`，双向无义务遗漏或越权关闭 |
| **③ 预算消耗等价**<br>*(Budget Spend)* | `modelCalls: 1`<br>`toolCalls: 1`<br>`totalDurationMs >= 0` | `modelCalls: 1`<br>`toolCalls: 1`<br>`totalDurationMs >= 0` | **✅ 等价** | 模型调用与资产执行计数绝对相等，均通过 ContractLedger 单调自增，未出现逃逸调用或重复消耗 |
| **④ 终止状态等价**<br>*(Terminal Status)* | `status: "COMPLETED"`<br>`unresolvedObligations: []`<br>`candidateVerified: false` | `status: "COMPLETED"`<br>`unresolvedObligations: []`<br>`candidateVerified: false` | **✅ 等价** | 终态均为合法收敛完成，未决义务集为空集，严格遵守 Invariant I15（禁止伪造已验证） |

---

## 3. 补充对照案例核验

### 3.1 证明题目标与义务链等价（案例 A-2）
* **题目**：`请证明对所有素数 p > 2，p^2 - 1 能被 24 整除`
* **目标编译**：旧入口与新 Kernel 均识别为 `goals: ["PROOF"]`（✅）
* **资产调用**：均调用数论特化资产（`math.number-theory`）（✅）
* **候选守卫**：均维持 `candidateVerified: false`，终态为 `CANDIDATE_AVAILABLE`（✅）

### 3.2 T01 故障拒止等价（输入合法性守卫）
* **输入**：`"   "`（空白字符）
* **校验结果**：双路径均触发合约校验拦截（`valid: false`），未决义务不闭环，终态拒止（✅）

### 3.3 T06 预算耗尽拦截等价（单调配额硬约束）
* **输入**：`maxModelCalls: 0`
* **拦截结果**：双路径均在本地门控拦截模型派发，实际调用计数为 0，终态均为 `FAILED`（✅）

---

## 4. 差异与变异项说明

经比对，通用内核路径相比纯 Adapter 路径有以下**受控增强**（符合方案预期，不破坏四等价）：
1. **工作单元账本记录（WorkUnitStore）**：新内核路径完整落盘了中间推导过程的工件（`art_initial_derivation`），支持后续断点恢复与依赖 DAG 溯源；纯 Adapter 路径未持久化工件，但向外暴露的四项语义指标完全一致。
2. **候选门控版本追踪（CandidateGate）**：新内核路径建立了候选对象版本演进链，在替换与否决场景下具备 I04/I07/I10/I11 保障能力。
3. **无硬编码与数学语义回流**：新内核未引入任何 `math-*` 特化引用，纯净由 `DomainAdapter` 接口注入完成调度。

---

## 5. 门禁测试执行实录

```
> node --test packages/agent-kernel/tests/math-parity.test.mjs

✔ P1-1 核心门禁：代数求值题四等价全量核验 (Final Delivery, Obligation, Budget, Terminal Status) (3.948ms)
✔ P1-1 扩展等价：数学证明题目标编译与义务链等价 (0.3579ms)
✔ P1-1 拒止等价：非法空输入双向一致阻断 (T01 故障防护等价) (0.2693ms)
✔ P1-1 预算配额拦截等价：零模型预算双向均不派发模型调用 (T06 故障防护等价) (0.2397ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 90.1684
```
