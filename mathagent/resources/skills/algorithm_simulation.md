# algorithm_simulation — 操作流程

## 1. 识别信号

有限字串编码、明确有界状态机模拟和DP。无限步过程或未定义状态转移须先推理。

## 2. 建模前提

明确LZ78/LZ77/LZW变体、字典起点、尾部约定、边界和所需产物，不以近似流程替换原规则。

## 3. 后端选择

lz78_encode(message)、lz78_decode(phrases)、verify_phrases(message,phrases)、lz78_bit_string和format_phrases覆盖对应接口时优先预置；有界多步组合可用generated_python标准库，不需要NumPy。参数名以当前完整接口为准。

## 4. 完整提案示例

TOOL: lz78_encode; INPUT: {"message":"ABABA"}; PURPOSE: 给出有限消息的LZ78短语序列; DOMAIN: 五字符显式字符串; MAPPING: 合成例使用当前注册接口的字典和末尾约定

## 5. 消费结果

回执后检查每步状态和短语，再核对原题变体；编解码往返通过不证明题面映射。有限DP值只用于已证明的状态模型。

## 6. 失败处理

索引/维数错误修输入，变体不明返回建模任务；同一失败提案不反复执行，资源失败保留未完成范围。注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。
