# Zygos (天轭) / Astra 数学智能体 前端观测控制台 答辩演示指南

## 1. 架构总览与系统边界

本系统为“挑战杯”数学智能体比赛专设的**高保真、可观测性前端控制台**与 **BFF (Backend-For-Frontend)** 服务。设计严格遵循《落地执行方案》与 PPT 视觉规范（天轭深蓝 `#0F265C` + 书生先锋蓝 `#1152B6`）。

### 核心合规铁律 (Red Line)
- **`candidate_verified: false` 绝对约束**：所有界面渲染、状态折叠及落盘数据，其验证状态严格保持为 `false`。系统明确标示“待审候选答案 (Candidate)”，绝不出现“证明完成 / 已验证 / 绝对正确”等误导性表述。
- **三层数据可观测性边界**：
  - **L1 (摘要层)**：仅反映逻辑顺序与推理概要，绝不伪造或编造虚假时间戳。
  - **L2 (回放层)**：结构化 JSON/JSONL 归档，支持无损时间胶囊回放。
  - **L3 (全量层)**：完整任务 DAG 拓扑、工具观测输入输出与原始报文审计。
- **非侵入式零破坏原则**：核心数学推导内核、`user_agent.py`、`python/astra_bridge/*` 保持原样，零污染。

---

## 2. 快速启动与本地运行

### 前置环境
- Python 3.10+（推荐 Python 3.14 或现有 Python 环境，依赖已安装在环境中：`pydantic`, `starlette`, `uvicorn`）
- Node.js 20+（已在 Node 24 验证通过）

### 启动命令

#### 方式一：一键启动 BFF 服务（同时托管前端静态资源）
```bash
# 进入工作区
cd C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored

# 启动 Starlette BFF 服务（内置静态前端挂载）
python -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port 8000
```
启动后在浏览器打开：`http://127.0.0.1:8000` 即可进入完整交互界面。

#### 方式二：前端独立开发调试
```bash
cd apps/web-demo
pnpm dev
# 或 npx vite
```
在浏览器打开 Vite 开发服务器（如 `http://localhost:5173`）。前端已内置自动离线降级功能，即使不启动后端也可直接体验全部页面和回放。

---

## 3. 核心功能与演示页面导航

| 页面路由 | 核心功能 | 演示要点与看点 |
| :--- | :--- | :--- |
| **`/solve`**<br>(求解工作台) | 实时数学求解调度与观测 | 1. 提供 3 个经典数论/代数例题一键填入。<br>2. 支持受控配置：`max_model_calls` (8/24/48) 与 `max_method_loads` (0 或 1 开关切换)。<br>3. 点击「开始单循环求解」，通过实时 SSE 流展开推理过程，自动展示实时推进阶段与候选卡片。 |
| **`/runs`**<br>(运行历史列表) | 所有单题推导记录看板 | 1. 列表展示不同数据深度等级（L1/L2/L3）与终止码（`REVIEWS_COMPLETE`, `REVISE_REJECTED` 等）。<br>2. 直观卡片呈现模型调用次数、耗时与创建时间。 |
| **`/runs/:runId`**<br>(运行详情 7 标签页) | 深度审计与合规追溯 | 提供完整的 7 个维度深度审计标签：<br>• **2.1 目标契约 (M1)**: 契约版本、认领任务、局部已知假设。<br>• **2.2 任务图 (M3)**: DAG 拓扑节点链路。<br>• **2.3 事件时间线**: 按 seq 升序排列的完整 Trace 序列表。<br>• **2.4 工具与方法卡**: 记录模型调用的外部代数求解器观测结果。<br>• **2.5 评审与修复**: CERT1 门控自检记录与评审审计结论。<br>• **2.6 预算与指标**: 模型调用配额与工作单元消耗。<br>• **2.7 原始数据**: 符合 JSON Schema 标准的 SolveResultDto 原始数据。 |
| **`/runs/:runId/replay`**<br>(时间胶囊回放) | 答辩核心演示回放台 | 1. **全功能回放时钟**：支持播放/暂停、单步后退、单步前进、任意拖拽时间线滑动条、0.5x~5x 倍速切换。<br>2. **确定性状态快照**：每隔 10~20 帧维护快照，任意游标跳转瞬时响应（< 2ms）。<br>3. **游标独立性**：新事件到达时历史游标不被强推，便于评委暂停细看。<br>4. **双栏对照**：左栏推导候选与工具观测，右栏当前事件 Payload 与日志流水。 |
| **`/batch`**<br>(批量评测) | 百题级评测与极差对比 | 批量评测状态概览与评测协议版本声明。 |
| **`/assets`**<br>(资产与附件) | 外部求解产物与凭证 | 查看与下载推导过程产生的中间文件与附件。 |
| **`/settings`**<br>(环境状态) | 运行环境与健康检查 | 实时展示 BFF 状态、数据目录与免调用模型的健康检查结果。 |

---

## 4. 自动化测试验证矩阵

本项目实现双端（Python + TypeScript）自动化测试全面覆盖：

### 1. Python 后端测试 (18 项全通)
```bash
python -m pytest tests/test_web_contract.py tests/test_web_bff.py -v
```
- **契约测试**：`RunRequestDto` 强类型校验、`max_method_loads` 布尔型冒充防御、`SolveResultDto` 红线约束、`classify_stop_reason` 映射。
- **存储与安全**：`Store.safe_join` 防路径穿越与越界、SQLite WAL 模式原子性、`atomic_write_json` 事务完整性。
- **接口与流**：`/api/health` 纯本地执行（不调模型）、`/api/capabilities` 能力清单、`/api/runs` 分页与过滤、静态资源挂载、SSE 事件广播队列。

### 2. TypeScript / 前端纯函数与回放测试 (12 项全通)
```bash
node --experimental-strip-types --test apps/web-demo/src/domain/__tests__/reduceRun.test.ts
```
- **纯函数 Reducer (`reduceRun`)**：
  - 幂等去重（同 seq 同 payload 返回同一引用）
  - 冲突记录（同 seq 不同 payload 记录 conflict）
  - 乱序容错（按 seq 自动升序排序）
  - 未知事件安全降级（记录 capabilityGaps 与 degraded 标记）
  - 批量等价性（逐条折叠与全量折叠完全一致）
- **回放控制器 (`PlaybackController`)**：
  - 单步/拖拽/跳帧/倍速控制
  - 新事件到达时不强推历史游标
  - 分段快照恢复与全量归约完全等价
- **Astra 真实日志回放**：
  - 成功回放包含 11 个事件的真实 Astra 生产日志（`session-sample.json`），终态 candidate 且 `candidate_verified: false`。

### 3. 类型检查与生产构建
```bash
cd apps/web-demo
npx tsc --noEmit        # 0 error 严格通过
npx vite build          # 1605 个模块在 2.1s 内完成构建
```

---

## 5. 提交记录与代码分支
- **Git 仓库**：`3294682143-gif/astra-refactored`
- **工作分支**：`前端设计`
- **基线提交 (Base Commit)**：`eb36a5acadc5de53d1c436b63faefca193b7d3f4`
- **关键交付提交**：
  - `2cfe091`: 实现双端 Web 契约、Starlette BFF、纯函数 Reducer、详情 7 标签页与回放控制台。
  - `544cbae`: 实现异步执行队列、实时 SSE 事件流通道与求解工作台动态流式对接。
