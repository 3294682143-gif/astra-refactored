# ADR-012: 通用领域契约（domain-contract）与 Zygos 内核解耦设计

* **状态**：ACCEPTED (针对 PR K03)
* **日期**：2026-10-29
* **责任人**：Zygos Kernel Architecture Team
* **遵循**：《智衍·衡鉴 AI4S 科学智能体平台：全量执行方案》（第 2 章、第 5 章、第 6 章）

---

## 1. 背景与上下文

在原 Astra 运行时中，控制机制与数学语义深度耦合：
- `packages/protocol/src/p2.ts` 中直接硬编码了数学专属的 `P2GoalKind`（`VALUE`、`ALL_SOLUTIONS`、`PROOF` 等）与数学答案闭合规则。
- `apps/stdio-runtime/src/agent-loop.ts` 中直接 `import` 了数学题目标记、数学候选规范化（`canonicalAnswerKey`）与 CERT1 证书生成逻辑。
- 这导致整个智能体无法直接迁移到物理控制、科学计算、材料分析等非数学科学场景。

## 2. 决策

建立独立的 `@zygos/domain-contract`（位于 `packages/domain-contract`），作为所有科学领域与 Zygos Kernel 之间的唯一契约边界：

1. **分离机制与领域语义**：
   - **Kernel 职责**：目标版本演进、义务账本（Ledger）、版本化工作单元树、STALE 失效传播、挑战与修复门控、根预算树管理、受信宿主 I/O 隔离。
   - **DomainAdapter 职责**：将领域原始输入编译为目标契约、提供专业工作上下文、审查路线实质差异、提出领域检查器（CheckSpec）、解释工具回执（Evidence）、比较领域候选等价性、最终交付物专业投影。
2. **正交的三维状态模型**：
   - **运行状态（RunState）**：`QUEUED | RUNNING | WAITING | COMPLETED | FAILED | CANCELLED | RECOVERY_REQUIRED`（表示进程与执行生命周期）。
   - **交付状态（DeliveryState）**：`CANDIDATE_AVAILABLE | DELIVERABLE | NO_DELIVERABLE`（表示产物可交付性）。
   - **结论验收状态（ObligationState）**：`OPEN | SUPPORTED | ACCEPTED_WITHIN_SCOPE | REFUTED | INCONCLUSIVE | STALE`（表示针对科学目标的证据完备度）。
3. **安全与控制边界红线**：
   - 领域适配器（DomainAdapter）为纯状态转换与语义映射函数集，严禁直接持有 API Key、底层网络 Client、Shell 或可任意访问的文件句柄。
   - 领域检查（CheckSpec）必须经由 Host 受信端口异步调度并生成受信回执，严禁在状态转换内隐式执行长耗时计算。

## 3. 后果与兼容性影响

- **对已有数学资产的影响**：现有数学能力完全保留在 `@zygos/domain-math`（PR K04）中，原有的 26 项资产 / 82 项行为无任何删减，外部调用入口 `ReasoningAgent.solve()` 签名与 `candidate_verified=false` 诚实红线严格不变。
- **对新领域接入的收益**：动力学参数辨识（K11）、科学计算复现（K12）、数据分析（K13）只需实现 `DomainAdapter` 接口，无需改动 Kernel 核心调度一行代码。
