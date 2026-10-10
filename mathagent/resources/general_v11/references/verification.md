# 检查、证据与完成状态

在线只依赖原题、数学推导和真实工具观察。离线金标准/评分文件不得读入求解循环，也不能用评分结果指导同一测试题重试。

## 分开检查

- validity：候选满足原约束、原定义域和解释。
- completeness：没有遗漏解、情况或所需构造。代回几个候选只证明成立性。
- count：映射覆盖对象且无重计，边界/空对象已处理。
- boundaries：奇点、端点、零分母、退化参数、定理前提。
- optimality：可行性、上下界与达到；驻点不是全局极值证书。
- approximation：误差度量、容差、舍入与数值稳定性。
- proof：引理、量词与依赖链有效。形式化仅指真正经过内核检查的已编码命题。

## 三态检查记录

每项写 obligation、status（仅 pass/fail/unknown）、evidence（deductive/formal/exhaustive/symbolic/numeric/review）、scope、依据及未覆盖部分。有实际回执才写 evidence_ref。

例如工具完整枚举[0,n)可支持这个有限集合的计数；是否忠实表达原题仍需单独检查。抽样可找到反例，但不能消除无限域完整性义务。符号化简还需检查原始分母和假设。

对关键计算还需 [建模对应记录](tool-mapping.md)：计算的子问题、原题约束逐项对应、全部情况/重数、剩余证明义务。v1.1宿主辅助接口不再只凭 original_mapping_checked 布尔值接受计算证据；需引用经实际审核的画像和映射记录。

审查者先从原文独立提取约束，再比较记录。引文存在、记录字段齐全或审查引用绑定正确，都不等于代码已证明画像和映射在数学上正确。

不要按“数值优于符号优于模型”的固定顺序评分。证据与目标的匹配比工具名重要。超时、解析失败、条件集和范围外都属于 unknown，不是数学反证。

## 交付

solved：必要义务有依据并提交所求解答，说明验证范围；不等于形式化保证。
provisional：有候选但仍有未完成义务。
needs_clarification：缺少会改变结果的条件。
unsolved：当前预算内未能完成。

机器交付可使用以下字段：problem_id、candidate_id、solution_status、interpretation、answer（kind/value）、checks、open_obligations、limitations。外层必须核对枚举、回执归属和范围，不能接受模型自行写 solved 作为认证。

正例：根式方程的候选全部代回原式，并证明变形给出了所有候选。

负例：读到“incorrect”就因含有“correct”而通过；或用几个数值点支持 proof=pass。
