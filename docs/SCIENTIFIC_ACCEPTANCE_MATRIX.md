# Track 160 AI4S 科学智能体科学验收矩阵

> **版本**：`1.1.0-current-source`
> **依据**：统一科研多智能体执行方案 §12.3（内部方案）与当前生产实现；不是 Track 160 官方评分表。
> **矩阵规则**：求解成功、正确拒绝、预算停止、远端未知与错误结论分别计数；带缺口交付按实际义务判定，不把工程执行退出码 0 冒充为科学已验证。

---

## 一、领域验收标准与判定阈值

| 场景标识 | 任务类型 | 科学前提 | 随附合成基准案例 | 独立评分器 | 科学通过阈值 | 预期终态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: |
| **math.research** | 符号恒等式与极值验证 | 处于 AST 白名单内，无未定除零奇点 | `math-assets.json#equations_simplify` | `mathagent.tools.audit_output` | `diff ≡ 0`；证据级别 `BOUNDED_OBSERVATION`；`candidateVerified=false` | `ACCEPTED_WITHIN_SCOPE` |
| **math.research** | 超范围输入安全拒绝 | 矩阵大于 8×8 或多项式度数大于 12 | 9×9 稠密矩阵 | `validate_inputs` | 拒绝码 `INPUT_INVALID`；零虚构输出；fail-closed | `CORRECT_REJECTION` |
| **control.identification** | 受迫振子参数辨识与留出预测 | 线性粘性阻尼振子，采样率满足抗混叠要求，80% 训练 / 20% 留出 | `data/benchmarks/control/oscillator_real_sample.csv` | 参数估计器、前向模拟和残差诊断 | `m>0, c>0, k>0`；`lag1Autocorrelation < 0.2`；留出 `RMSE ≤ 0.05`；无数据泄露 | `ACCEPTED_WITHIN_SCOPE` |
| **control.identification** | 欠采样混叠违规诊断 | 采样率低于十倍系统特征带宽 | 欠采样时序数据 | 采样守卫 | 触发抗混叠违背警告；对应义务不得关闭 | `REFUTED` |
| **scientific_computing.heat_transfer** | 一维瞬态热传导有限差分网格收敛 | Dirichlet 边界，`r = αΔt/Δx² ≤ 0.5` | `data/benchmarks/scientific_computing/heat_rod_experimental_sample.csv` | `HeatEquationSolver.verifyConvergence` 与实验末态对照 | CFL 满足；渐近收敛阶 `1.8 ≤ p ≤ 2.2`；实验末态 RMSE 不超过声明阈值 | `ACCEPTED_WITHIN_SCOPE` |
| **scientific_computing.heat_transfer** | CFL 或边界违规诊断 | 时间步长过大或边界义务缺失 | 故障注入配置 | CFL 与边界诊断 | 识别对应违规；不得将全部义务标为完成 | `REFUTED` |
| **data_analysis.statistical_inference** | 双独立组 Welch 推断与效应量评估 | 双独立组；正态性、方差齐性和残差诊断分别报告 | `data/benchmarks/data_analysis/clinical_trial_sample.csv` | `StatisticalAnalyzer.analyze` | Welch 方法与自由度、p 值、Cohen's d、95% 置信区间均由实际数据计算；义务按诊断结果关闭 | `ACCEPTED_WITHIN_SCOPE` |
| **data_analysis.statistical_inference** | 前提诊断与方法限制 | 正态性或方差假设不适配 | 含离群值的双组数据 | 正态性、Levene 与残差诊断 | 明确报告不适用前提；不自动声称已执行未实现的 Mann–Whitney 等非参数替代检验 | `REFUTED` |

当前随附 CSV 均为 `synthetic_generated`，不是公开真实实验或临床数据。文件名保留用于兼容，不证明数据来源属性。

---

## 二、终态分类统计原则

1. **求解成功 (`ACCEPTED_WITHIN_SCOPE`)**：候选经独立检查器核验，在声明前提与阈值内闭合义务。
2. **正确拒绝 (`CORRECT_REJECTION`)**：针对越界输入、超参数范围或非法请求，系统根据契约明确拒绝并保留依据，不计入求解成功率，单列为边界防护指标。
3. **假说被否决 (`REFUTED`)**：由于物理约束、抗混叠、CFL、残差或统计前提不满足，系统正确识破缺陷并拒绝伪阳性交付。
4. **证据不足 (`INCONCLUSIVE`)**：在可用预算内未能取得足够证据，明确报告不确定性。
5. **预算耗尽 (`BUDGET_EXHAUSTED`)**：超出调用次数或 monotonic 时间限制；是否保留候选仍由义务与交付门控决定，不自动交付未闭合候选。
6. **远端未知 (`REMOTE_UNKNOWN`)**：网络断连、超时或非确定状态，由责任记录追踪，不推断为完成。
