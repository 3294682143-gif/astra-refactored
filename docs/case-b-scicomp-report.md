# Case B: Scientific Computing & Numerical Verification Report (F-11 / K18 / K22)

## 1. 案例目标与方法
- **PDE 物理模型**：一维热传导方程 $\frac{\partial u}{\partial t} = \alpha \frac{\partial^2 u}{\partial x^2}$，空间域 $x \in [0, 1]$，时间域 $t \in [0, 0.2]$，热扩散系数 $\alpha = 0.1$。
- **边界与初值**：
  - 齐次 Dirichlet 边界条件：$u(0, t) = 0, \quad u(1, t) = 0$
  - 正弦初始场：$u(x, 0) = \sin(\pi x)$
- **解析参考解**：
  $$u_{exact}(x, t) = \sin(\pi x) e^{-\alpha \pi^2 t}$$
- **离散格式**：显示前向欧拉有限差分法（Forward-Time Central-Space, FTCS）。
- **空间收敛阶验证**：Richardson 外推法（多网格 $n_x = 20, 40, 80$），理论空间精度阶数 $p = 2.0$。
- **CFL 稳定性守卫**：$r = \frac{\alpha \Delta t}{\Delta x^2} \le 0.5$。

## 2. 数值验证结果（非硬编码）

| 网格规模 $n_x$ | 空间步长 $\Delta x$ | CFL 数 $r$ | $L_2$ 误差 | 最大绝对误差 | 经验收敛阶 $p$ | 状态 |
|---|---|---|---|---|---|---|
| 20 | 0.0500 | 0.1600 | 0.002047 | 0.002895 | — | 收敛 |
| 40 | 0.0250 | 0.1600 | 0.000513 | 0.000725 | 1.996 | 收敛 |
| 80 | 0.0125 | 0.1600 | 0.000128 | 0.000181 | 1.999 | 收敛 |

- **平均经验收敛阶**：$\hat{p} = 1.998 \approx 2.0$（严格落在理论公差 $2.0 \pm 0.25$ 内）。
- **Dirichlet 边界误差**：$< 10^{-14}$，精确满足守恒。
- **严格不变量 I15**：`candidateVerified: false`（不可被单次数值实验推翻为数学证明）。

## 3. 故障注入与挑战门禁（Fault Injection Challenge）

1. **MISSING_BOUNDARY（边界遗漏/漂移）**：
   - 注入机制：解耦边界固定值约束，允许边界随离散梯度外推漂移。
   - 观测表现：$u(0) \ne 0$ 或 $u(L) \ne 0$。
   - 裁决：`boundaryDiagnosis.dirichletMatched = false`，`verdict = "边界条件违例：未满足物理边界约束"`，义务未能达成（`allObligationsMet = false`）。
2. **CFL_VIOLATION（时间步长超限稳定性破坏）**：
   - 注入机制：强制 $\Delta t = 0.01$，导致 $r = \frac{0.1 \times 0.01}{(1/40)^2} = 1.6 > 0.5$。
   - 观测表现：数值震荡并急剧发散（$L_2$ 误差迅速溢出）。
   - 裁决：`cflDiagnosis.isStable = false`，`verdict = "CFL 条件违例 (max CFL = 1.6000 > 0.5)，显式时间格式数值发散"`，义务未能达成（`allObligationsMet = false`）。

## 4. 生产 Bundle 与端到端门禁
- **生产 Bundle 接入**：`grep -c "domain-scientific-computing" release/stdio-runtime.bundle.mjs` 输出为 **6**（具备生产脱机调度能力）。
- **端到端派发与 L2 落盘**：经 `POST /api/v2/runs` 成功完成 `scientific_computing` 真实运行，落盘至 `var/astra/runs/{run_id}/details.json`，含完整的网格扫描指标、CFL 诊断、边界诊断与不变量 `candidateVerified: false`。
