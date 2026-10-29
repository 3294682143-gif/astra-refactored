# math_families

按**求解结构**组织的算法族工具库。每个工具只返回 `core.evidence.Evidence`
（值 + 证书 + 自检 + 可行性 + 复杂度上界），从不返回最终答案；答案责任在调用方。

## 结构

- `core/evidence.py` — Evidence 契约；`core/feasibility.py` — 可行性预检；
  `core/guard.py` — 子进程硬超时（防 SymPy 级挂起）
- `families/` — 22 个按求解结构组织的族模块（18 implemented / 3 partial /
  1 none_by_design）
- `catalog.json` — 机器可读目录：族名、结构标签、参数 schema、复杂度、工具角色和验证状态
- `tests/` — Evidence 契约、性质测试、catalog schema、可行性护栏和禁用痕迹静态扫描

## 工具角色三档

- `full_solve`：可产候选 + 证书（13 族）
- `assist` / `assist_partial`：只产证据——小情形猜想、不变量验证（8 族）
- `none`：概念题，无算法结构（1 族，工具无解，不挂答案形查表）

## 验证证据

- 性质测试：600 项，全部参数无关（随机实例 + 暴力参照 + 已知外部序列）
- 留出法实验：`runs/families_plan/F4/holdout_report.md`
  （留出半结构覆盖 34.0% vs 种子半 28.8%；未污染留出题干净执行 3/3 命中）
- 外部锚点：`runs/families_plan/F5/`（28/28，全部取自经典文献或独立方法）

设计蓝图与逐族判据见 `runs/families_plan/F1/family_clusters.md`。

## 测试

```bash
PYTHONPATH=. python -m pytest math_families/tests -q
```
