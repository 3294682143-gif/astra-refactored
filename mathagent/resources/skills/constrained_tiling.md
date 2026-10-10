# constrained_tiling — 族指导（模型可见输入）

当前运行边界（优先于历史库示例）：注册边界：只有当前请求列出的注册名称可调用；历史库层函数名不是 TOOL 名称。若当前运行明确提供 generated_python，可按独立协议在已接受 WASI 中探索，仅标准库、SymPy 1.12、mpmath 1.3.0；无宿主代码、网络、安装或跨题数据。提案不是执行，退出码0/PASS/NO_ISSUE不是数学证据；只有绑定回执后的结果才能消费，独立核验仍只授予指定输入/性质。缺少映射或范围依据不得改用 Python 绕过。

## 适用结构

铺砌存在性/计数/极值，叠结构化约束：恰好 k 块的半铺、局部 2×2 条件、
染色界、覆盖重数、唯一标记。约束是结构化数据，不是代码。

## 需要提取的参数

- `count_tilings`：rows/cols + tile_shape_spec（cells + 旋转/反射标志）
  + constraint_spec（exact_tiles / min_uncovered_per_2x2 /
  two_uncovered_aligned_per_2x2 / forbid_full_2x2 / blocked_cells /
  marked_cells 等结构化键）；
- `coloring_bound`：board + tile spec + 染色规则（checkerboard 或
  product_mod 目标类）；
- `min_tiles_cover` / `unique_tiling_check`：小板精确。

## 推荐工具

见上。大板会自动 infeasible（这是信息，不是失败）。

## 禁止使用的情况

- 把旧话题标签当结构：满铺 ≠ 约束半铺，铺法计数 ≠ 染色下界——
  先确认题问的到底是哪个量（历史上四处语义错位全在这里）；
- 大面积枚举（护栏会拒绝；改用 coloring_bound 得下界）。

## 证据完备性要求

小板精确值带分支分解证书；染色界只是下界。公式级结论
（如参数化闭式）需小板多点确认 + 独立证明。

## 需要模型自行证明的部分

题面约束到 constraint_spec 的翻译；闭式公式的一般性证明。
