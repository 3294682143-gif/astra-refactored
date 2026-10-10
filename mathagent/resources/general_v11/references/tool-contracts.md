# 可选确定性工具

使用前核对操作是否回答当前子目标。输入是JSON数据，不是Python代码；不把原题文本拼进shell命令。接口接受文件或标准输入。

关键调用先写 [原题—模型对应](tool-mapping.md) 的四项记录。回执绑定不是建模证明，子问题算对也不自动支持原题结论。

    python3 scripts/math_tools.py --input request.json

请求必须恰有 op、args 两个顶层字段。例如：

    {"op":"mod_pow","args":{"base":2,"exponent":100,"modulus":13}}

省略 --input 时从标准输入读取一个JSON请求。不要把返回的 pass 当作原题所有证明义务已通过。

相对路径以本skill目录为基准，调用时可使用 ${CLAUDE_SKILL_DIR} 定位。工具从一开始即可用；不需要先进行几轮失败推理。

## 已实现操作

| op | args | 数学范围 |
|---|---|---|
| exact | expression | 有界整数/有理数的 + - * / **；不接受变量、函数调用或浮点字面量 |
| mod_pow | base, exponent, modulus | 非负指数模幂，modulus≥2 |
| crt | residues, moduli | 包含非互素情况的相容同余合并，返回模lcm的类或无解 |
| roots_unity | modulus | 完整枚举0≤x<n中 x²≡1 mod n，2≤n≤100000 |
| binary_strings | length, ones_modulus, residue | 不含相邻1且1数量模m为r的二进制串计数，含长度0 |
| linear_solve | matrix, rhs | 小型有理线性系统的空解/唯一解/仿射解集 |

类型和实际资源上限以脚本校验为准；超范围返回 unknown，不缩小数学问题重试。精确分数用整数或"a/b"字符串，不把输入浮点数暗中视为精确有理数。

## 回执含义

status=pass 只表示固定操作在给定范围完成并产出证据；无解和计数0也可能是正确完成的结果。结果包含scope、evidence、result及限制，不授予整题 solved。

脚本仅执行受信的固定实现；前台设置墙钟限制，Linux worker限制CPU/地址空间并检查输出大小。这不是任意代码沙箱，不声称禁网、隔离业务密钥或容器级安全。本包不提供 run_math_code，也不联网安装依赖。

其他CAS/数值工具只有当前环境真实提供时才可用。避免对不可信字符串直接 eval、exec、sympify 或 parse_expr；通用CAS必须保留定义域与未解决状态。没有工具时继续合法的解析推导，不捏造运行结果。
