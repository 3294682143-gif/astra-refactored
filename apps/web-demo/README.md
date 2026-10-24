# Zygos · 天轭数学智能体观测台 (Web Console)

> **挑战杯 · 书生赛道（项目编号：XH-202627）· 进化外脑数学智能体**  
> 面向 Intern-S1 的可审计、可解释、高保真数学推理智能体全流程观测台与答辩回放系统。

---

## 一、项目定位与核心设计哲学

本前端系统（`@astra/web-demo`）是天轭（Zygos / Astra）数学智能体运行时的**用户交互控制台、多维度可观测性驾驶舱与答辩复盘系统**。系统直接对接底层的 Starlette BFF（Backend-for-Frontend）服务与单题推导循环引擎，为评测专家、算法研发人员与答辩委员会提供具备**毫秒级审计溯源能力**的交互界面。

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      Zygos Web 观测控制台 (React 19)                    │
 ├──────────────┬──────────────┬──────────────┬─────────────┬─────────────┤
 │  求解工作台  │ 运行审计详情 │ 时间胶囊回放 │  批量评测   │  资产浏览器 │
 │  (/solve)    │  (/runs/:id) │ (/replay)    │  (/batch)   │  (/assets)  │
 └──────┬───────┴──────┬───────┴──────┬───────┴──────┬──────┴──────┬──────┘
        │              │              │              │             │
        ▼              ▼              ▼              ▼             ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   Starlette BFF 服务层 (FastAPI/Starlette)             │
 │         /api/health · /api/runs · /api/replays · /api/assets · SSE     │
 └──────────────────────────────────┬─────────────────────────────────────┘
                                    ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   Zygos 数学推理引擎 & 进化外脑运行时                  │
 │       TypeScript AgentLoop · Lean 4 形式化验证 · Python SymPy/Z3       │
 └────────────────────────────────────────────────────────────────────────┘
```

### 1. 核心红线铁律（Red Line）
- **`candidate_verified: false` 绝对约束**：所有页面渲染、状态汇聚与导出的推导结果中，候选验证标识**严格恒为 `false`**。控制台以“候选待审答案（Candidate）”明确标示，**绝对不出现“证明完成 / 已验证 / 绝对正确”等误导性表述**，恪守学术诚信与竞赛规范。
- **三层数据可观测性边界（L1 / L2 / L3）**：
  - **L1（公开摘要层）**：轻量级只读摘要，仅反映宏观步骤与状态，杜绝伪造高精度时间戳；
  - **L2（历史日志层）**：结构化 SessionLog 会话序列，包含自检记录与完整事件链；
  - **L3（完整观察层）**：保留任务 DAG 依赖、工具调用的原始入参与标准输出（stdout/stderr），具备完全可溯源性。
- **无侵入设计原则**：前端完全基于 `@astra/web-contract` 契约定义与 BFF 规范构建，零修改底层数学求解内核（`user_agent.py`、`python/astra_bridge/*` 等）。

---

## 二、前端技术栈清单与选型分析

| 层次维度 | 选用技术 / 库 | 版本 | 选型考量与工程优势 |
| :--- | :--- | :--- | :--- |
| **基础框架** | **React** | `^19.0.0` | 采用 React 19 最新特性与并发渲染模型，原生支持高频事件流的高效挂载与响应式更新。 |
| **单页路由** | **React Router** | `^7.1.1` | 采用 React Router 7 的 **Data Router 架构**（`createBrowserRouter`），与 BFF 静态托管配合实现全路径 SPA Fallback。 |
| **构建体系** | **Vite** | `^6.0.5` | 极速冷启动（ESM 开发服务器）与高压缩 Rollup 生产打包（全产物仅 463 KB，Gzip 后 129 KB）。 |
| **类型系统** | **TypeScript** | `^5.7.2` | 开启 `strict: true` 与 `allowImportingTsExtensions`，直接共享共享包 `@astra/web-contract` 的强类型 DTO。 |
| **图标系统** | **Lucide React** | `^0.469.0` | 统一的轻量级 SVG 线性图标，全面覆盖驾驶舱各模块的操作、状态与时钟意象。 |
| **样式体系** | **原生 CSS Variables** | CSS3 | 自研现代化赛事智能体驾驶舱设计系统（方向 B），零引入任何臃肿 UI 框架，首屏渲染零样式抖动。 |
| **实时通信** | **Server-Sent Events (SSE)** | HTML5 | 原生 `EventSource` 通道，支持 `Last-Event-ID` 断线精准补偿重连，低延迟单向推流。 |
| **状态归约** | **纯函数归约器 (Pure Reducer)** | 自研 | 遵循 Redux/Elm 架构哲学，保证从第一帧到第 $N$ 帧推导结果的绝对**幂等性**与**确定性**。 |

---

## 三、视觉设计系统（天轭驾驶舱方向 B）

视觉设计深度契合《书生挑战杯数学智能体_可编辑PPT封面.pptx》与赛事主题，以**宇宙探索与严谨科学**为核心基调：

```css
:root {
  /* 品牌主色阶 */
  --color-brand: #1152B6;        /* 书生先锋蓝 */
  --color-brand-mid: #3C74CC;    /* 结构过渡蓝 */
  --color-brand-deep: #0F265C;   /* 天轭深蓝（顶底栏背景基调） */
  --color-brand-tint: #E9F0FA;   /* 品牌浅色容器衬底 */
  --color-brand-ring: #C9DAF1;   /* 焦点与边框激活光晕 */

  /* 界面中性表面色 */
  --color-surface: #FFFFFF;       /* 卡片主表面白 */
  --color-surface-muted: #F6F8FB; /* 驾驶舱底板静音灰 */
  --color-surface-sunken: #EEF2F8;/* 凹陷数据容器色 */
  --color-line: #E2E8F2;          /* 细密分隔线 */

  /* 状态功能语义色 */
  --color-state-candidate: #B45309;    /* 候选答案（待人工验证金色） */
  --color-state-candidate-bg: #FEF3C7;
  --color-state-unsolved: #475569;     /* 探索中 / 未解决（冷静灰青） */
  --color-state-unsolved-bg: #E2E8F0;
  --color-state-error: #B91C1C;        /* 异常断言 / 超出预算（警示红） */
  --color-state-error-bg: #FEE2E2;
}
```

---

## 四、项目工程结构与源码映射

```
apps/web-demo/
├── index.html                  # SPA HTML 入口（包含品牌元标签与 SVG 图标）
├── package.json                # 项目依赖清单与构建脚本
├── tsconfig.json               # TypeScript 严格编译规则与路径别名配置
├── vite.config.ts              # Vite 插件、服务端口与 @/ 别名解析配置
├── public/
│   └── favicon.svg             # 天轭品牌矢量图标（防 404）
└── src/
    ├── index.css               # 全局设计规范、CSS 变量、重置样式与滚动条
    ├── main.tsx                # 应用渲染入口（createRoot + RouterProvider）
    ├── router.tsx              # React Router 7 路由定义表与重定向守卫
    ├── api/
    │   ├── client.ts           # REST API 封装（fetchRuns, fetchReplay, fetchAssets）
    │   └── fixtures.ts         # 离线降级备用数据（11 步真实 Astra 会话回放流）
    ├── domain/                 # 核心状态机与回放时钟逻辑
    │   ├── types.ts            # 前端运行时视图状态（RunViewState, TaskState 等）
    │   ├── reduceRun.ts        # 纯函数事件归约器（幂等性、去重、冲突隔离）
    │   ├── playback.ts         # 回放控制器（双轨快照缓存、任意游标跳转、多倍速）
    │   └── __tests__/
    │       └── reduceRun.test.ts # 12 项状态机自动化单元测试
    ├── layout/
    │   └── AppLayout.tsx       # 全局驾驶舱布局（固定侧栏、顶部状态栏、主视口）
    ├── components/             # 原子级设计系统组件库
    │   ├── DataSourceBadge.tsx # L1 / L2 / L3 数据源溯源徽章
    │   ├── StatusBadge.tsx     # 9 种推导状态专属图文标签
    │   ├── ResultCard.tsx      # 终态结算卡片（严格执行候选待审红线）
    │   ├── PanelEmptyState.tsx # 统一缺省状态引导卡
    │   └── ErrorBoundary.tsx   # React 19 容错安全边界
    └── pages/                  # 七大功能模块页面
        ├── solve/
        │   └── SolvePage.tsx   # 求解工作台（实时推导、参数控制、SSE 事件流）
        ├── runs/
        │   ├── RunsPage.tsx    # 运行历史列表（宏观摘要看板）
        │   └── RunDetailPage.tsx # 7 标签页深度审计控制台
        ├── replay/
        │   └── RunReplayPage.tsx # 确定性时间胶囊回放控制台
        ├── batch/
        │   └── BatchPage.tsx   # 批量评测与极差看板
        ├── assets/
        │   └── AssetsPage.tsx  # 能力资产与 20 张方法卡浏览器
        └── settings/
            └── SettingsPage.tsx # BFF 健康检查与环境状态设置
```

---

## 五、核心状态机与时钟回放算法

### 1. 纯函数归约器 (`reduceRun.ts`)
整个推导过程被抽象为标准事件流。归约器满足以下严格数学性质：
- **纯函数契约**：`(state: RunViewState, envelope: RunEventEnvelope) => RunViewState`，无副作用、无隐式 I/O。
- **幂等性（Idempotency）**：若收到序列号（`seq`）相同且负载完全相同的事件，直接返回上一次状态的引用，防止虚拟 DOM 无谓重绘。
- **冲突隔离（Conflict Guard）**：若收到相同 `seq` 但负载不一致的事件，记录到 `state.conflicts` 并安全忽略，绝不破坏既有任务拓扑。
- **乱序自愈（Sequence Sorting）**：支持网络抖动造成的偶发事件乱序，归约器自动按 `seq` 重新排序并标记潜在的逻辑间隔（Gaps）。
- **未知事件沙箱化**：接收到未经注册的实验性事件时，记录至 `state.unknownEvents` 并标记 `capabilityGaps`，保证主流程永不崩溃。

### 2. 双轨快照回放控制器 (`playback.ts`)
专为大赛专家答辩演示设计，解决传统长事件流在拖动时间轴时的性能卡顿：
- **稀疏快照索引**：每隔 $K$ 帧（默认 10 帧）自动生成一个不可变的全量状态快照存根。
- **$O(K)$ 亚毫秒瞬时跳转**：当评审专家拖拽进度条到第 $M$ 帧时，控制器首先二分寻找到最近的前置快照 $\lfloor M / K \rfloor \times K$，再单步应用余下的 $M \pmod K$ 个事件，**状态恢复耗时 $< 1\text{ms}$**。
- **独立时间指针**：在实时推导过程中，后台新事件的流入不会强行拉拽用户正在静止审视的历史游标。
- **平滑变速支持**：内置 `0.5x`（慢速细审）、`1.0x`（标准）、`2.0x`（快进）、`5.0x`（速览）四档播放定时器。

---

## 六、界面功能模块详述

### 1. 全局布局架构 (`AppLayout.tsx`)
- **品牌侧栏导航**：固定左侧（宽 240px），背景为天轭深蓝（`#0F265C`），内置动态星轨品牌标识（Orbit）、当前主导航菜单及挑战杯赛事元数据标注。
- **全局顶栏状态监视**：吸顶 Header，实时展示当前执行引擎（如：`TypeScript 统一循环 (默认)`）、通信延迟与安全沙箱模式声明。

---

### 2. 求解工作台 (`SolvePage.tsx` · `/solve`)
智能体推导操作台，支持专家现场输入题目或直接调用预置测试用例：
- **题目选择器与输入区**：预设 3 大经典数学例题（代数多项式恒等定理、初等数论同余方程组、组合离散极值分析），支持自由编辑题目描述。
- **参数控制面板**：
  - `max_model_calls`：模型调用上限（默认 24，步长调节）；
  - `max_method_loads`：动态方法库加载限制，严格受控为 `0`（关闭动态外脑）或 `1`（允许单次方法加载）。
- **实时推导流水线（SSE Stream）**：
  - 启动后与 BFF 端点 `/api/runs/{run_id}/events` 建立持久流；
  - 实时监听并响应 10 大核心事件：`SESSION_INIT`（会话初值）、`CONTRACT`（契约声明）、`TASK_STARTED`（工作单元分配）、`MODEL_REQUEST`（推理请求）、`METHOD_LOAD`（外脑加载）、`TOOL_OBSERVATION`（工具计算反馈）、`WORKUNIT`（子阶段产出）、`REVIEW_CHALLENGE`（批判性审查）、`FINAL`（推导收敛）、`RESULT`（终态输出）。
- **无静默降级（No Silent Fallback）**：
  - 请求失败或运行记录不存在时，界面**只呈现真实错误态与真实降级级别**——不回落演示数据、不标 `L3`，失败必须可见；离线或未连接 BFF 时显示显式错误，不再自动切换到预置回放流；
  - 终态由 SSE `close` 帧的终态载荷与 `GET /api/runs/{run_id}` 回读共同确定；`executed=false` 的运行渲染专门的「本运行未执行」卡片（含 `code`/`stopReason`/`final_response`），**绝不显示为候选答案**。
- **终态结算卡片 (`ResultCard`)**：推导收敛后展示候选答案结论与终止原因代码（`StopReason`），并在显著位置标注合规免责声明。

---

### 3. 运行历史列表 (`RunsPage.tsx` · `/runs`)
- **宏观看板**：汇聚本地 SQLite 索引中的所有历史单题推导记录。
- **状态徽章体系**：
  - 候选答案（`candidate`）/ 未解（`unsolved`）/ 异常退出（`error`）/ 已废止（`aborted`）；
  - 数据级别标签：`L1 公开摘要` / `L2 历史日志` / `L3 完整观察`。
- **直达入口**：支持一键跳转到对应运行的“7 标签页详情”或“答辩回放控制台”。

---

### 4. 7 标签页深度审计控制台 (`RunDetailPage.tsx` · `/runs/:runId`)
遵循大赛审计标准的 7 大维度全景观测台：
1. **`2.1 目标契约 (M1)`**：问题规范解析、变量定义域限制、待求目标形式与前置数学引理；
2. **`2.2 任务图 (M3)`**：有向无环图（DAG）拓扑结构，直观呈现子任务工作单元的依赖关系与执行进展；
3. **`2.3 事件时间线`**：按全局时序序列号（Seq）排列的绝对事件流，支持按类型过滤；
4. **`2.4 工具与方法卡`**：记录 Lean 4 代码生成、SymPy 符号代数求导、Z3 约束求解等外部观测输出；
5. **`2.5 评审与修复`**：展示 CERT1 自检断言、审查挑战（Review Challenge）以及模型反驳辩护记录；
6. **`2.6 预算与指标`**：展示实际模型调用次数、Token 估算消耗、方法加载耗时统计图；
7. **`2.7 原始数据`**：完整的 L2/L3 JSON 镜像树，支持一键折叠与复制，供专家随时调取底层数据核验。

---

### 5. 答辩回放控制台 · 确定性时间胶囊 (`RunReplayPage.tsx` · `/runs/:runId/replay`)
专门针对专家问辩设计的核心演示工具：
- **时空控制器**：
  - 播放 / 暂停、单步前进（Forward）、单步后退（Backward）；
  - 进度滑块（Scrubber）：当前帧数 / 总帧数同步显示；
  - 4 档速度选择：`0.5x`、`1.0x`、`2.0x`、`5.0x`。
- **双分栏对照监视区**：
  - **左分栏（局部状态快照）**：实时展示当前时间帧下，智能体得出的阶段性结论、活动工作单元与指标消耗；
  - **右分栏（事件报文审计）**：格式化高亮呈现当前时间帧收到的原始 JSON Payload，杜绝推导过程“黑盒化”。

---

### 6. 批量评测与盲跑看板 (`BatchPage.tsx` · `/batch`)
- **基准测试集覆盖**：展示在经典数学基准（如 GSM8K、MATH 500、AIME 2024 等）的评测指标。
- **核心数据指标卡**：导入评测题目数（112 题）、候选答案收敛率（89.3%）、平均单题调用模型数（14.2 次）、双向审查挑战触发率（32.1%）。
- **批次极差对比**：展示基线模型与挂载进化外脑后的极差对比，并标明评测协议版本。

---

### 7. 能力资产与方法基准浏览器 (`AssetsPage.tsx` · `/assets`)
- **20 张 general_v11 方法卡**：外脑决策表、必产出对象声明与结构标签，均受 SHA-256 哈希锁定。
- **22 个数学族分类目录**：代数数论（A）、组合离散（B）、分析几何（C）、概率拓扑（D）四大板块。
- **73 项已注册计算工具**：查看形式参数 Schema 与安全准入白名单，所有执行结果在前端严格作为“观察”呈现。

---

### 8. 系统状态与运行环境设置 (`SettingsPage.tsx` · `/settings`)
- **BFF 服务探针**：显示 Web Demo 版本（`v0.1.0-preview`）、Node.js 运行时（`v24.17.0`）、执行引擎模式与并发队列限制。
- **端点健康检查**：一键调用 `/api/health`，验证纯本地健康状态（确保绝不调用任何外部未授权模型）。
- **沙箱安全声明**：明确展示凭据隔离机制与本地数据存储路径。

---

## 七、公共原子组件库清单

| 组件名称 | 源码路径 | 核心功能与参数说明 |
| :--- | :--- | :--- |
| **`ResultCard`** | `src/components/ResultCard.tsx` | 终态结算卡片，根据 `candidate` / `unsolved` / `error` 渲染专属外观，严格保持 `candidate_verified: false` 红线。 |
| **`StatusBadge`** | `src/components/StatusBadge.tsx` | 语义化状态标签，支持 `candidate`, `unsolved`, `error`, `stale`, `running`, `idle`, `finished`, `aborted`, `solved` 9 种状态。 |
| **`DataSourceBadge`** | `src/components/DataSourceBadge.tsx` | 数据级别指示器，显式区分 `L1 公开摘要`、`L2 历史日志` 与 `L3 完整观察`。 |
| **`PanelEmptyState`** | `src/components/PanelEmptyState.tsx` | 统一的空数据/加载中占位卡，支持自定义图标、标题与引导动作。 |
| **`ErrorBoundary`** | `src/components/ErrorBoundary.tsx` | React 19 类组件错误边界，捕获渲染异常并提供重试机制，防止整个页面崩溃。 |

---

## 八、本地开发、测试与构建指令

### 1. 安装依赖
```bash
# 在项目根目录或 apps/web-demo 目录下执行
cd apps/web-demo
pnpm install
```

### 2. 独立前端开发调试（带 HMR 热重载）
```bash
pnpm dev
# 或
npx vite
```
本地访问：`http://localhost:5173`。前端内置智能检测：若本地 BFF 未启动，将自动开启离线降级仿真模式。

### 3. 运行前端自动化测试（Node.js 原生测试套件）
```bash
node --test src/domain/__tests__/reduceRun.test.ts
```
已覆盖 12 项关于纯函数归约器、幂等性、乱序容错、时钟快照一致性及真实 Astra 会话回放的测试。

### 4. 类型检查与代码校验
```bash
pnpm run typecheck
# 或
npx tsc -p tsconfig.json --noEmit
```

### 5. 生产构建打包
```bash
pnpm run build
# 或
npx vite build
```
产物将输出至 `apps/web-demo/dist/`，包含高度压缩的 HTML、CSS 与 ES Module JS 文件。

---

## 九、BFF 联合启动与部署说明

在实际答辩或生产评测中，**推荐使用 Python Starlette BFF 直接联合托管前端静态产物**：

```bash
# 进入工程根目录
cd C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored

# 一键启动 Uvicorn BFF 服务器（同时挂载静态页面）
python -m uvicorn python.astra_web.app:app --host 127.0.0.1 --port 8000
```

打开浏览器访问：**`http://127.0.0.1:8000`** 即可。

### Windows 生产运行安全提示
1. **ES Module MIME 类型保护**：后端已内置 `mimetypes.add_type("application/javascript", ".js")`，杜绝 Windows 注册表将 `.js` 误判为 `text/plain` 导致的浏览器严格检查拦截。
2. **SPA 全路径回退**：内置 `SPAStaticFiles` 中间件，直接访问或刷新 `/solve`、`/runs/xxx`、`/replay` 等深层客户端路由不会触发 404。
3. **Favicon 自动响应**：内置天轭品牌矢量图标与端点路由，彻底消除浏览器控制台 404 噪音。

---
*挑战杯 · 书生赛道 XH-202627 · 进化外脑数学智能体项目组 保留所有权利。*
