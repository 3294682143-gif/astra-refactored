# 07 工程变更范围与隔离白名单 (G-04)

> **交付性质**：G-04 阶段产物（代码变更边界、白名单控制与零侵入保障）。
> **编制角色**：G (`gemini-3.8-flash-high`)
> **实施角色**：D (`deepseek-v4.1-flash`, 待 D-01 至 D-12 落地)
> **代码基线**：`eb36a5acadc5de53d1c436b63faefca193b7d3f4`

---

## 1. 纯新增目录（自主完全控制，零冲突风险）

| 路径 | 说明 | 所有者 |
| :--- | :--- | :--- |
| `docs/web/` | Web 方案文档、设计系统、API 契约、审计与交接说明 | G / D / H |
| `packages/web-contract/` | 纯 Web DTO 类型、导出的 JSON Schema、浏览器安全常量 | D-01 |
| `apps/web-demo/` | React 19 + Vite 6/8 + Tailwind v4 + shadcn/ui 前端控制台源码 | D-02 ~ D-11 |
| `python/astra_web/` | FastAPI BFF 服务、任务队列、SQLite 存档索引、只读资产路由 | D-03, D-06 |
| `design/web-prototype/` | G 的隔离设计原型、公开测试样例与截图资产 | G-03 |

---

## 2. 既有文件修改白名单（严格受限）

为保证**比赛官方求解内核绝对不受污染**，既有文件修改实行白名单审批制：

| 文件 | 允许修改的范围与目的 | 禁用行为 | 风险级别 |
| :--- | :--- | :--- | :--- |
| `pnpm-workspace.yaml` | 确认包含 `apps/*` 与 `packages/*`（当前已包含） | 不得随意删除既有 workspace 路径 | 低 |
| `packages/protocol/package.json` | 仅允许增加 `exports` 的 `browser` 条件导出路径 | 严禁改动既有 `node` / `default` 导出 | 中 |
| `pyproject.toml` 或 `setup.py` | 若 Python 打包自动扫描包，需在 package 发现规则中排除 `python.astra_web` | 严禁增加对正式求解环境的任何强制依赖 | 中 |
| `package.json` (根目录) | 新增 `pnpm web:dev`、`pnpm web:build` 顶层运行脚本 | 严禁降级根目录已锁定的 Node (24.7.0)、TypeScript (6.0.3) 版本 | 低 |

### 绝对禁止修改的禁区文件 (Forbidden Zone)
- ❌ `user_agent.py`（官方参赛统一入口，签名与返回格式绝对不变）
- ❌ `python/astra_bridge/*`（内核桥接代码，评测基线逻辑不得改动）
- ❌ `apps/stdio-runtime/*`（TS AgentLoop 运行内核，不得混入前端特定逻辑）
- ❌ `release/BUILD_MANIFEST.json`（发布清单，未经正式发布流程不得手动串改）
- ❌ `mathagent/resources/*`（方法卡与工具注册表标准资产）
