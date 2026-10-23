# 06 设计交接与组件实现指引 (G-04)

> **交付性质**：G-04 阶段产物（前端组件树、交互状态与降级实现指引）。  
> **编制角色**：G (`gemini-3.8-flash-high`)  
> **实施角色**：D (`deepseek-v4.1-flash`, 待 D-02/D-05 落地)  
> **设计系统**：方向 B（现代赛事智能体驾驶舱）

---

## 1. 前端组件层级树 (Component Hierarchy)

```text
apps/web-demo/src/
├── app/
│   ├── AppLayout.tsx           # 顶部全局导航栏 + 侧边栏折叠 + 全屏演示模式切换
│   ├── GlobalHeader.tsx        # 品牌标识 (Zygos · 天轭) + 引擎状态 + 服务端健康指示灯
│   └── Router.tsx              # React Router 7 Data Router 配置
├── pages/
│   ├── solve/
│   │   ├── SolvePage.tsx       # ① 求解工作台（左右双分栏网格）
│   │   ├── ProblemEditor.tsx   # Markdown + KaTeX 双栏实时公式编辑器
│   │   ├── BudgetControl.tsx   # 预算配置面板（单选开关、档位预设）
│   │   ├── StageStepper.tsx    # M1-M5 胶囊高亮阶段流条
│   │   ├── LiveEventFeed.tsx   # 虚拟滚动实时事件窗（最新 50 条）
│   │   └── CandidateCard.tsx   # 候选答案结果卡（未经形式化验证警示徽章）
│   ├── run-inspector/
│   │   ├── RunInspectorPage.tsx# ② 运行详情页（常驻摘要条 + 7 标签页）
│   │   ├── SummaryBar.tsx      # 状态、耗时、调用数、进程回收指示
│   │   ├── tabs/
│   │   │   ├── ContractTab.tsx # 2.1 目标契约（义务认领与局部假设）
│   │   │   ├── TaskGraphTab.tsx# 2.2 任务图（React Flow 增量 DAG / L1 降级流）
│   │   │   ├── TimelineTab.tsx # 2.3 事件时间线（双轨：逻辑序号 vs 毫秒甘特图）
│   │   │   ├── ToolsTab.tsx    # 2.4 工具与方法卡（观察回执、SHA-256）
│   │   │   ├── ReviewTab.tsx   # 2.5 评审与修复（CERT1 自检、父子 Diff 对比）
│   │   │   ├── MetricsTab.tsx  # 2.6 预算与指标（Token 覆盖率堆叠条）
│   │   │   └── RawDataTab.tsx  # 2.7 原始数据（CodeMirror 只读查看与导出）
│   ├── replay/
│   │   ├── ReplayPage.tsx      # ③ 回放模式（离线演示、游标时钟）
│   │   ├── PlaybackBar.tsx     # 播放/暂停、倍速、单步前进后退、关键帧书签
│   │   └── SubtitleBar.tsx     # 演示讲解旁白字幕条
│   ├── agents/
│   │   └── AgentOrchestrationPage.tsx # ④ 逻辑角色泳道编排视图
│   ├── batch/
│   │   ├── BatchDashboardPage.tsx     # ⑤ 批量评测看板
│   │   ├── BatchUploadModal.tsx       # JSONL / 判分文件导入弹窗
│   │   ├── BatchTable.tsx             # 虚拟滚动逐题表格
│   │   └── BatchComparison.tsx        # 多批次盲跑极差比对图表
│   ├── assets/
│   │   ├── AssetBrowserPage.tsx       # ⑥ 能力资产浏览器（方法卡/数学族/工具表）
│   │   └── AlignmentMatrix.tsx        # 四大板块对齐缺口矩阵
│   └── settings/
│       └── SettingsPage.tsx           # ⑦ 系统健康、端点配置指示、主题设置
```

---

## 2. 核心交互状态与异常降级表

| 界面模块 | 正常完全态 (L3) | 摘要数据降级态 (L1) | 极端/异常态表现 |
| :--- | :--- | :--- | :--- |
| **任务图 (TaskGraph)** | 展示 React Flow 拓扑有向边，支持 STALE 变灰连带动画与点击抽屉。 | 自动隐藏图画布，切换为「活动卡片列表」并标注：`ℹ️ 当前为摘要数据，未包含拓扑依赖边`。 | 发生环路或未知引用时，孤立节点展示在「未归属动作区」。 |
| **时间线 (Timeline)** | 横轴为真实毫秒时间戳（甘特图）。 | 禁用毫秒轴，横轴切换为 `seq` 整数步数轴。 | 出现时间逆序或跨进程丢包时，按单调 seq 强行排序并给出警告标。 |
| **候选答案卡** | 完整呈现 KaTeX 渲染公式与父子版本演变。 | 呈现当前最终候选答案字符串。 | `unsolved` 时答案区置空，突出显示大红/黄标签与未解原因。 |
| **评审与修复** | 左右并列 Diff 对比父候选与子候选文本。 | 仅展示最终交付结果。 | 门控拒绝修复时，高亮黄色「保留原候选，修复被门控驳回」。 |
| **预算面板** | 动态进度条实时扣减。 | 静态展示终态消耗配额。 | 超限时进度条变红，并在顶部弹窗注明 `BUDGET_EXHAUSTED`。 |

---

## 3. 设计验收 Checklist (D-02 / D-05 实施前必读)

- [ ] **文案合规**：全局搜索绝无「已验证 / 证明成功 / 正确答案 / ✅」等字眼；
- [ ] **参数合法**：`max_method_loads` 为单选开关（0/1），非数值输入；
- [ ] **视觉对比度**：在 1920×1080 投影分辨率下，文字对比度 ≥ 4.5:1；
- [ ] **错误边界**：每个 Tab 面板均包裹独立的 React ErrorBoundary，局部报错不整屏白屏；
- [ ] **离线运行**：KaTeX 字体本地打包，不向外网 CDN 发起任何请求。
