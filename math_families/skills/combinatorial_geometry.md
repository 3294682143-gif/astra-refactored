# combinatorial_geometry — 族指导（模型可见输入）

当前运行边界（优先于历史库示例）：注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。

## 适用结构

点集/多边形覆盖与分隔的最坏构形极值：最小线覆盖数、双色点集分隔线数、
面积平分弦覆盖边数。assist 级：精确算小构形 + 启发式最坏构形搜索。

## 需要提取的参数

- `line_cover_number`：点集 + 线数上限；
- `line_separation_number`：点集 + 0/1 颜色列表（一般位置：无三点共线）；
- `verify_separation_certificate`：点集 + 颜色 + 分隔见证（有序点对）；
- `area_bisection_coverage`：严格凸多边形顶点；
- `worst_configuration_search`：objective（"covering_critical" /
  "separation"）+ 网格/样本参数。

## 推荐工具

见上。分隔数带迭代加深的最小性论证；最坏构形搜索是启发式下界。

## 禁止使用的情况

- 点集退化（共线三点）时 separation 工具会拒绝——先扰动或改判读；
- 把搜索到的最坏构形当成证明（它只是下界）。

## 证据完备性要求

小构形精确值是完备的；worst_configuration_search 的值是"找到的最好
构形的精确值"，不是真正最坏值。

## 需要模型自行证明的部分

最坏情形的构造 + 归纳界证明；"临界"定义与题面量词的一致性。
