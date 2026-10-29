# 智衍·衡鉴 AI4S 跨领域科研案例包（K25）

* **编制日期**：2026-10-29
* **涵盖领域**：数学前沿推导、动力学参数辨识（控制）、数值传热模拟（科学计算）、生物统计推断（数据分析）、钙钛矿晶体性质（材料）

---

## 案例 1：数学前沿推导与反例审计（Math Domain）
* **任务输入**：求有限群 $G$ 的 Sylow $p$-子群共轭类与正规化子阶数。
* **执行轨迹**：
  1. `M1`: 编译为 `PROOF` 与 `VALUE` 目标契约，激活 `ob_domain` 与 `ob_candidate` 义务；
  2. `M2`: 准入许可，向 Host 请求调用 `math.number-theory` 与 `math.polynomials`；
  3. `M3`: 生成中间引理工作单元与版本化产物 `art_sylow_order`；
  4. `M4`: 模型首次试图弃权，触发 `ed55f74` 强制调用数学资产取证，独立选票（`077f608`）以 3 票多数决达成共识；
  5. `M5`: 生成结构化 CERT1 证书，`candidate_verified=false` 严格保持。

---

## 案例 2：受迫振子动力学参数辨识与防泄露验证（Control Domain）
* **任务输入**：激励 $u(t) = \sin(2t)$，采样步长 $\Delta t = 0.01\text{s}$，总时幅 $10\text{s}$（1000 点时序）。
* **执行轨迹**：
  1. 前 800 点划分为训练集，后 200 点登记为不可拟合验证集引用；
  2. 模型调用 `control.parameter_estimator` 拟合得：$m = 1.0\text{kg}, c = 0.2\text{N}\cdot\text{s/m}, k = 10.0\text{N/m}$；
  3. 检查器 `control_leak_detector` 扫描输入时间戳，确认拟合完全未触碰后 200 点（Pass）；
  4. 检查器 `control_eigenvalue_stability` 求解特征根 $\lambda_{1,2} = -0.1 \pm 3.16i$（负实部，系统稳定，Pass）；
  5. 检查器 `control_rmse_evaluator` 在后 200 点上前向积分，误差 $\text{RMSE} = 0.018 \le 0.05$（Pass）；
  6. 导出系统辨识与预测报告。

---

## 案例 3：二维非齐次热传导方程数值求解（Scientific Computing Domain）
* **任务输入**：$\frac{\partial T}{\partial t} = \alpha \nabla^2 T + Q(x,y)$，Dirichlet 边界 $T = 0$。
* **执行轨迹**：
  1. 模型选择 Crank-Nicolson 有限差分时间隐式格式；
  2. 空间网格剖分 $N = 50 \times 50$ 与 $N = 100 \times 100$；
  3. 检查器 `scicomp_richardson_extrapolation` 验证空间二阶渐进收敛阶（收敛比 $R \approx 3.98 \approx 2^2$）；
  4. 检查器 `scicomp_cfl_stability_check` 验证无条件数值稳定性；
  5. 产出温度场与守恒性校验报告。

---

## 案例 4：生物样本差异表达量统计假设检验（Data Analysis Domain）
* **任务输入**：癌症与对照组两批微阵列基因芯片表达矩阵（$N = 48$）。
* **执行轨迹**：
  1. 检查器 `data_shapiro_wilk_checker` 检验各基因表达分布正态性（$p = 0.12 > 0.05$，未违反正态假设）；
  2. 采用 Welch's $t$-test 计算原始 $p$-value；
  3. 检查器 `data_benjamini_hochberg_corrector` 进行假发现率（FDR）多重重采样校正，筛选出 FDR $q < 0.01$ 的 14 个显著差异基因；
  4. 产出防 $p$-hacking 规范统计报告。
