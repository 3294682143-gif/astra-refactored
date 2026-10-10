# symbolic_algebra — 操作流程

## 1. 识别信号

显式展开/系数提取、有理线性系统、已知多项式恒等式和数域关系可计算。一般非线性参数解集或完整分类不自动属于现有认证范围。

## 2. 建模前提

保留变量顺序、参数条件和精确有理数。polynomial_expand_coefficients: expression/variables/parameters；至多6符号、3主变量、总次数8、256 AST节点、2000字符、512项、256位有理数。linear_system_solution_set: matrix/rhs/variables/domain；至多6变量12方程，RATIONAL或REAL，输入分子分母至多10^6。

## 3. 后端选择

需要完整系数表用 polynomial_expand_coefficients；需要唯一/参数/空解集用 linear_system_solution_set。solve_system_guarded_expr 返回孤立实解数量及证书，不能替代参数解集。组合通式构造与有限候选求解可用 generated_python。保留 real_root_count_expr、splitting_field_degree_expr、polynomial_invariant_check、algebraic_polynomial_check、wronskian_root_identity_expr 的既有独立范围。

## 4. 完整提案示例

TOOL: polynomial_expand_coefficients; INPUT: {"expression":"(a*u+v)^2/2","variables":["u","v"],"parameters":["a"]}; PURPOSE: 返回按u,v指数分组的完整系数表; DOMAIN: 有理系数多项式环Q[a,u,v]; MAPPING: 对合成显式表达式直接展开，a作为参数而非固定数

## 5. 消费结果

读取有序指数与参数系数多项式；线性解集读取特解、零空间基、自由变量和参数域。空集必须有独立核验的不相容行组合。执行输出不证明题面转写；独立输出检查只证明该输入运算。

## 6. 失败处理

超次数/项数/位数返回OUT_OF_SCOPE，不截取部分项声称完整。缺少变量/映射先补证，程序失败不作为无解。注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。
