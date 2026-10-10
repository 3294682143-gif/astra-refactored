# 方法索引：先看结构与缺口

这里是方法选择导航，不是题目白名单。一个题目可以组合多张卡；元数据标签不能证明定理前提。

| 方法 | 适用对象/结构 | 先检查 |
|---|---|---|
| [定义域、等价变换与参数分类](domain-equivalence.md) | equation / rational_expression / radical / parameter；domain / equivalence / degeneracy | domain_specified |
| [量词、证明义务与反例](proof-counterexamples.md) | statement / set / function / sequence；quantifier / necessity / sufficiency / counterexample | quantifiers_identified |
| [不变量、势函数与极端原理](invariants-extremal.md) | configuration / game / integer / graph；invariant / parity / potential / extremal | legal_moves_defined |
| [归纳、递推与良基结构](induction-recurrence.md) | sequence / integer / recursive_object；induction / recurrence / well_founded | base_cases_defined |
| [有限状态、动态规划与模状态组合](finite-state-dp.md) | sequence / graph / finite_state；dynamic_programming / automaton / residue_tracking | state_sufficient、finite_domain |
| [双射、双计数与容斥](counting-bijections.md) | set / combinatorial_object / sample_space；bijection / double_counting / inclusion_exclusion | counted_objects_defined |
| [生成函数、系数提取与卷积](generating-functions.md) | sequence / polynomial / formal_series；generating_function / convolution / recurrence | coefficient_meaning_defined |
| [同余、素数幂分解与广义CRT](modular-crt.md) | integer / congruence；modular_constraints / prime_power / residue_tracking | integer_domain、modulus_positive |
| [对称、换元与积分存在性](integral-symmetry.md) | integral / function / region；symmetry / substitution / improper_integral | integration_definition、domain_preserved |
| [坐标、向量与几何约束](coordinates-geometry.md) | point / line / plane / curve / geometric_configuration；coordinates / metric / incidence / symmetry | given_relations、nondegeneracy |
| [界、凸性与全局最优性](inequalities-optimization.md) | function / inequality / feasible_set；convexity / monotonicity / bound / equality_case | feasible_domain、extremum_type |
| [线性化、秩与谱结构](linearization-spectral.md) | matrix / linear_system / linear_map / quadratic_form；rank / nullspace / eigenvalue / change_of_basis | scalar_field、dimensions |
| [样本空间、条件化与概率耦合](conditioning-indicators.md) | random_variable / sample_space / event / distribution；conditional_probability / indicator / coupling / independence | probability_model、support |
| [极限交换、可积性与分布收敛](convergence-limits.md) | sequence / function / integral / random_variable；convergence / domination / uniform_integrability / limit_distribution | convergence_mode、measure_space |
| [微分方程的建模、归约与条件核验（决策卡）](differential-equations.md) | differential_equation / operator / series / physical_model；initial_value / boundary_value / separation / linearization | domain、regularity、initial_boundary_data |
| [代数结构归约决策（决策卡）](algebraic-structures.md) | group / ring / field / polynomial；homomorphism / quotient / factorization / extension | algebraic_conventions |
| [拓扑性质判别决策（决策卡）](topology-local-global.md) | metric_space / topological_space / map / set；compactness / completeness / basis / local_global | ambient_space、topology |
| [统计模型、似然与推断（决策卡）](statistical-inference.md) | sample / parameter / likelihood / distribution；confidence_interval / hypothesis_test / sufficiency / fisher_information | sampling_model、support、estimand |
| [回归、选模与误差结构（决策卡）](regression-diagnostics.md) | regression / design_matrix / response / error；least_squares / regularization / collinearity / heteroskedasticity | model_specification、exogeneity、design_rank |
| [近似、误差传播与稳定性（决策卡）](numerical-approximation.md) | function / algorithm / matrix / differential_equation；error_bound / conditioning / discretization / interpolation | error_metric、tolerance、precision |

## 选择与组合

- 先提取目标、对象、结构、限制四轴；简单问题无需选卡。
- 初始读1–2张，后续只为当前未完成义务增加新卡。不要将“无匹配”当成无解。
- 例：有限状态+余数跟踪；坐标化+全局界；似然+收敛/Delta方法；生成函数+双计数；域条件+消元。
- 不变量、数值实验或工具残差只完成相应局部义务，不能替代存在性、完整性或最优性证明。
- 脚本 select_methods.py 仅按结构化标签推荐候选并控制读取量，不是自动数学理解器；无需先运行它才能使用本索引。

控制文件：[通用换路](general-search.md)、[验证规则](verification.md)、[工具契约](tool-contracts.md)。


选卡依据和前提记录见 [画像与选路](problem-profile.md)，关键计算的原题对应见 [工具建模](tool-mapping.md)。目录未列出的方法仍可使用；不虚构已加载卡或扩大权限。
