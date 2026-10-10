# numerical_methods — 族指导（模型可见输入）

当前运行边界（优先于历史库示例）：注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。

## 适用结构

数值微分/离散化的直接计算：给定解析函数、点和步长，求差分导数值或
Richardson 外推，带收敛阶自检。

## 需要提取的参数

- `f`：白名单表达式 DSL（仅 x 为变量；sin/cos/exp/log/sqrt 等）；
- `x`、`h`、method ∈ {central, forward, backward}；
- `richardson_extrapolate` 的 order 可选。

## 推荐工具

- `finite_difference_derivative`：证书 = 共享采样表 + 步长减半收敛比；
- `richardson_extrapolate`：证书 = 两级外推值与改进量；
- `verify_fd_certificate`：独立复验器（重采样重推）。

## 禁止使用的情况

- 要的是精确解析导数（本族是数值工具，证据压为 partial 级）；
- h 小于舍入抵消阈值（工具会 infeasible）。

## 证据完备性要求

数值微分值不是精确导数；收敛比（≈4 为二阶中心）支持方法的阶，但不
证明函数性态。解析答案仍需解析推导。

## 需要模型自行证明的部分

题目所求是差分值还是精确导数值；中心/向前/向后方法的约定差异
（历史上这正是冲突来源）。
