# functional_equation — 操作流程

## 1. 识别信号

显式候选的代入残差、有限多项式子类的系数约束、已建模有限图的颜色传播适合计算。证明函数必须为多项式、无限域分类不属于有限计算。

## 2. 建模前提

保留原式的域、全称量词、函数名和自由变量。探索次数界须明确，未经证明的界只限定搜索，不缩小原题。有限图需说明数学对象到顶点ID的映射。

## 3. 后端选择

已知有理多项式候选优先 polynomial_function_check（equation/function/argument/variables/expression）；有限图使用 constraint_propagation_2coloring（points/edges/fixed）。构造通式、组合展开并求有限系数候选可用 generated_python，无须先让不适配工具失败。finite_domain_solve/substitution_probe 是未开放库接口。

## 4. 完整提案示例

TOOL: polynomial_function_check; INPUT: {"equation":"F(p+q)=F(p)+F(q)","function":"F","argument":"x","variables":["p","q"],"expression":"3*x"}; PURPOSE: 核验一个显式候选; DOMAIN: p,q为实数; MAPPING: 合成加法方程的原式和候选，检查成员身份而非所有函数

## 5. 消费结果

实际回执后逐个独立核验候选，合法成员、被反证成员、UNKNOWN分开保存。显式重组 ANSWER 才进入提交集合；正文成员不自动补全答案。次数界外探索和必要性证明仍开放。

## 6. 失败处理

语法错误修参数，映射未建立先推理，库不可用改用已安装等价操作，反例只修对应命题；有限搜索无结果不等于无解。注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。
