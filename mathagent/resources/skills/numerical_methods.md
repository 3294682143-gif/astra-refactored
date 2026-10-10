# numerical_methods — 操作流程

## 1. 识别信号

显式表达式求值、有限差分、Richardson外推。精确导数或无限极限证明不能由数值近似代替。

## 2. 建模前提

明确域、采样点、步长、central/forward/backward约定和误差需求。采样点应在定义域内。

## 3. 后端选择

finite_difference_derivative(f,x,h,method)、richardson_extrapolate和verify_fd_certificate覆盖所需产物时优先；明确数值表达式或多步组合可用generated_python的mpmath 1.3.0，SymPy 1.12可辅助符号操作。

## 4. 完整提案示例

TOOL: finite_difference_derivative; INPUT: {"f":"sin(x)","x":0,"h":0.01,"method":"central"}; PURPOSE: 计算指定中心差分; DOMAIN: 实数点-0.01和0.01; MAPPING: 合成例求差分值而非精确导数，步长和方法是给定输入

## 5. 消费结果

标注近似数值、步长、误差未证明范围；收敛比不自动建立严格误差界，NaN/Infinity和任意stdout末尾数字不能变成答案。

## 6. 失败处理

域错误修采样，抵消/超限明确失败，不将输出截断当完整；精确结论需求交回解析证明。注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。
