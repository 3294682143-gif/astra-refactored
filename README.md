# 进化外脑智能体

**面向 Intern-S1 的可审计数学推理智能体运行时**

> 赛题：**XH-202627 基于 Intern-S1 的数学智能体设计与推理创新**
> 发榜单位：上海人工智能实验室 ｜ 赛道：2026 年度中国青年科技创新「揭榜挂帅」擂台赛 · 学生赛道
> 推报学校：湖北工业大学 ｜ 报名表登记作品名称：进化外脑数学智能体

进化外脑智能体把**题目目标、工作任务、候选答案、评审依据、调用预算**放进同一条可追踪的执行链：
问题被拆成带来源的义务与任务，产物带版本与依赖，工具与方法卡的每次调用都留回执，
候选答案在明确门控下才能替换或交付。求解过程因此可回放、可审计、可复现。

[赛题理解](#赛题理解与我们的应答) · [系统架构](#系统架构) · [关键机制](#关键机制) ·
[快速开始](#快速开始) · [输出契约](#输出契约) · [仓库结构](#仓库结构) · [合规与提交材料](#合规与提交材料) · [已知限制与路线图](#已知限制与路线图)

> **状态**：开发预览版。默认引擎为统一 TypeScript AgentLoop，已通过本地全部回归；
> 真实模型下的正确率与稳定性仍在推进，当前不发布成绩口径。
> 本文所有数字均标注协议与出处，未标注出处的数字不作为成绩。

---

## 赛题理解与我们的应答

赛题要求智能体具备五项能力，我们的实现位置如下：

| 赛题要求 | 我们的应答 | 落点 |
| --- | --- | --- |
| 理解自然语言数学问题 | 题目文本 → 目标契约：识别目标类型、参数分支、待完成义务，保留原题不改写 | `packages/math-contract` |
| 自主规划思路、求解并输出结果 | 有界任务图 + 依赖产物：按义务生成任务，允许动态派生子任务与重做，按预算调度 | `apps/stdio-runtime/src/agent-loop.ts`、`packages/math-contract` |
| 以启发式方式解释推理过程 | 每个工作产物都携带 claim / derivation / 机制声明 / 依赖，评审与最终输出可回溯到具体产物 | `packages/math-workunit`、`packages/math-review` |
| 在多类型数学问题中表现稳健 | 通用方法卡 + 精确工具 + 语义路由；失败走有界修复而不是静默重试 | `mathagent/resources/general_v11`、`mathagent/resources/tool-registry.json` |
| 结构化 JSON 输出 | 单条 `solve()` 返回固定字段的结果对象，含状态、停止原因、指标与事件轨迹 | `user_agent.ReasoningAgent.solve` |

**初赛**（单智能体）：组委会提供 112 道覆盖偏微分方程、复分析、拓扑学、运筹学等 18 个子领域的题目，
要求完成全部推理并输出结构化 JSON 与日志。

**总决赛**（多智能体协作与场景创新）：在初赛方案上扩展可交互 Demo，并可选
「超长程推理 / 自动识别题型并路由到不同 solver agent / 引入过程校验智能体」等方向。

**评分构成**：答案正确性 60%（线性计分）、推理策略与系统设计 10%、展示质量 20%、创新性与可扩展性 10%。
其中"答案正确性"按 `正确率 × 60` 计；**因接口异常、格式错误、未按要求输出 JSON 导致无法判分的题目视为未通过**——
这条规则直接决定了本项目的设计重心：先保证**稳定可判分**，再谈正确率。

## 设计原则

- **目标契约驱动**：显式记录目标、范围、假设与待完成义务，所有调度围绕同一个原题展开，不让某一轮的自由发挥改写题目。
- **证据约束**：产物、检查、挑战都绑定具体任务、范围与版本；局部检查只在其支持范围内被引用，工具回执是"观察"而不是"证明"。
- **有界调度**：模型请求、工具效果、方法卡加载、评审与修复共享同一份根预算与截止时间，新增任务不会凭空产生配额。
- **可逆修复**：保留父候选与历史产物，候选替换经过门控，依赖变更时使下游产物失效，便于回退与审计。
- **不伪造**：无法归类或无法完成的调用来回 `unsolved` 并留下原因码，不用猜测填空。

## 系统架构

官方调用接口保持不变：

```python
from user_agent import ReasoningAgent

result = ReasoningAgent(client=client).solve(problem, metadata)   # 默认 engine="ts"
```

Python Host 启动一个 Node stdio 运行时，由统一的 `runAgentLoop` 调度 M1—M5；
模型访问始终经过调用方注入的公共 client，不内置任何凭据。

```
┌──────────────────────────────────────────────────────────────┐
│ 调用方（评测平台 / Notebook / 未来的 Web Demo）               │
│   注入 client  ·  传入 problem  ·  读取结构化 result          │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Python Host  python/astra_bridge                              │
│  公共 client 适配 · 协议校验 · 子进程生命周期 · 工具与资产准入  │
└───────────────────────────┬──────────────────────────────────┘
                            │ JSON-RPC over stdio
┌───────────────────────────▼──────────────────────────────────┐
│ TS AgentLoop  apps/stdio-runtime/src/agent-loop.ts            │
│  M1 目标契约 → M2 调用准入 → M3 工作单元 → M4 评审 → M5 审计   │
│  WORK / CONSENSUS / R0 / R2 / R4 / REPAIR 共用一条根会话      │
└───────────────────────────┬──────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
  精确工具（exact_check_expr、         方法卡（20 张通用数学方法卡，
  bounded_enumeration、矩阵/线代/      按需加载正文到后续 WORK 上下文）
  多项式族工具）
```

| 层 / 模块 | 代码位置 | 主要职责 |
| --- | --- | --- |
| 官方入口 | [`user_agent.py`](user_agent.py) | 保持 `ReasoningAgent` / `solve` 接口，显式选择引擎 |
| Python Host | [`python/astra_bridge`](python/astra_bridge) | client 适配、协议校验、子进程生命周期、工具与资产准入 |
| TS 组合根 | [`apps/stdio-runtime/src/agent-loop.ts`](apps/stdio-runtime/src/agent-loop.ts) | 在同一根会话中组织任务、WORK、评审、修复与最终选择 |
| M1 目标契约 | [`packages/math-contract`](packages/math-contract) | 题目身份、目标、义务、任务与依赖账本 |
| M2 调用准入 | [`packages/math-gateway`](packages/math-gateway) | 请求绑定、调用状态与调度准入 |
| M3 工作单元 | [`packages/math-workunit`](packages/math-workunit) | 构建上下文，接收版本化工作产物与依赖 |
| M4 过程评审 | [`packages/math-review`](packages/math-review) | 计划与候选评审、问题与挑战记录 |
| M5 数学审计 | [`packages/math-audit`](packages/math-audit) | 检查依据适用范围、修复替换条件与最终输出策略 |
| 运行时核心 | [`packages/runtime-core`](packages/runtime-core) | 根预算、事件、上下文投影与运行生命周期 |
| 协议与 schema | [`packages/protocol`](packages/protocol) | 跨模块类型、Host 协议、JSON Schema |
| 数学资产 | [`mathagent`](mathagent)、[`math_families`](math_families) | 方法卡、受信算法、检查器、工具注册表 |

## 关键机制

### 1. 结构化输出与可判分性（对应 60% 客观分的前置条件）

一次 `solve()` 返回固定字段：

| 字段 | 含义 |
| --- | --- |
| `status` | `candidate` / `unsolved` |
| `final_response` | 候选答案原文（`unsolved` 时为 `Unsolved.`） |
| `stopReason` / `reason` | 停止原因与归因（如 `REVIEWS_COMPLETE`、`NO_CANDIDATE`、`BUDGET_EXHAUSTED`） |
| `code` | 失败码（仅在出错时出现，如 `FIELD_VALUE`、`CHILD_FAILED`） |
| `candidate_verified` | 恒为 `false`：候选**从不**被声称已完成数学验证 |
| `trace` | 有界事件轨迹（`MODEL` / `EFFECT` / `CONTROL` 三类，附状态码） |
| `metrics` | 调用、效果、评审、方法卡、工作单元、token 等计数 |
| `childReaped` | 子进程是否被回收（用于判定是否存在僵尸运行） |
| `elapsedMs` / `sessionId` / `engine` / `mode` | 运行标识与耗时 |

字段集合由 Host 侧严格校验，格式不符会被拒绝而不是被静默修复——这与赛题"格式错误判为未通过"的规则一致。

### 2. 工具与方法卡：两条互补的能力来源

- **精确工具**（`mathagent/resources/tool-registry.json`，73 项注册）：符号化简、三角归约、极大子式、
  扩域因式分解、定积分、极限、密度归一化、有限对象穷举、线性方程组解集等。
  TS 侧当前可调用的白名单为 4 项，其余仍在接线中（见[已知限制](#已知限制与路线图)）。
- **通用方法卡**（`mathagent/resources/general_v11`，20 张）：定义域与等价变换、证明与反例、
  不变量与极端原理、生成函数、代数结构归约、拓扑局部—整体、统计推断、回归诊断、数值近似等。
  卡是"决策表 + 必产出对象"的格式，按需加载正文到后续工作上下文，加载有完整性校验与次数上限。

### 3. 过程校验与有界修复

- **R0**：计划阶段的有界评审（默认关闭）；**R2/R4**：面向候选的评审与再评审；
- **CERT1 证书**：模型可输出 `CERT1|CHECK/OPTIONS/VERDICT/FINAL` 机器可读行，
  证书候选优先于相关审计的多数票；
- **修复**：评审提出有据挑战后，允许有界修复子候选，父候选保留可回退；依赖变更时下游产物失效；
- **截断屏障**：非 `COMPLETE` 的模型回复不产生工具动作、不产生产物、不产生候选。

### 4. 预算与安全边界

- 模型请求、工具效果、方法卡加载、评审、修复共享同一根预算与截止时间，超限即收口；
- 一切身份字段（会话、题面哈希、契约版本、任务、目标、范围、路由、请求号）由 Host 侧**可信绑定**覆盖，
  模型写错这些字段不会导致整题作废，也不会获得越权；
- 数学字段（claim、derivation、依赖、候选）严格校验，未声明的假设、外来依赖、空论证一律拒绝；
- 运行在进程组隔离中，超时后有界回收子进程，`childReaped` 参与结果判定。

## 快速开始

### 环境要求

| 依赖 | 要求 |
| --- | --- |
| Python | `>=3.10`（见 [pyproject.toml](pyproject.toml)） |
| Node.js | 开发配置锁定 `24.7.0`；运行 TS 引擎需要 Node |
| Python 依赖 | SymPy、NumPy、SciPy、Requests（见 [requirements.txt](requirements.txt)） |
| 构建工具 | pnpm / TypeScript（仅修改 TS 时需要） |
| 模型 client | 由调用方注入；本仓库不内置凭据 |

仓库自带预编译 Node bundle，求解时不需要运行 npm / pnpm / tsc。

### 获取并校验

```bash
git clone --branch feat/v4-dynamic-workflows https://github.com/3294682143-gif/astra-refactored.git
cd astra-refactored

python -m venv .venv && . .venv/bin/activate
python -m pip install -r requirements.txt

node --version
python scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json   # 期望输出 VERIFY_OK
```

`VERIFY_OK` 只证明发布清单中的文件哈希与源码祖先关系一致，**不**证明数学能力。

### 离线入口冒烟（不访问模型服务）

```bash
python - <<'PY'
import json
from user_agent import ReasoningAgent

class OfflineClient:
    def chat(self, messages, temperature=0.2, max_tokens=8192):
        return {"choices": [{"index": 0, "finish_reason": "stop",
                "message": {"role": "assistant",
                            "content": json.dumps({"action": "unsolved", "reason": "offline smoke test"})}}]}

result = ReasoningAgent(client=OfflineClient()).solve("Compute 2+2", {})
assert result["engine"] == "ts" and result["status"] == "unsolved" and result["childReaped"] is True
print(json.dumps(result, ensure_ascii=False, indent=2))
PY
```

### 接入真实模型

```python
from user_agent import ReasoningAgent

class MyClient:
    """实现同步 chat(messages, temperature, max_tokens)，返回 OpenAI 兼容信封。"""
    def chat(self, messages, temperature=0.2, max_tokens=8192):
        ...  # 调用 Intern-S1 API，返回 {"choices":[...]}，含 finish_reason

agent = ReasoningAgent(client=MyClient())      # 默认 engine="ts"
result = agent.solve(problem_text, {"source": "evaluation"})
print(result["status"], result["final_response"])
```

`engine` 可选 `ts`（默认，统一 AgentLoop）、`lite`（实验性轻量 typed-action）、`legacy`（保留的 Python Controller）。
未知引擎与不支持的参数会被拒绝，TS 路径失败时不会静默降级。

## 输出契约

- **只输出结构化结果**：`solve()` 返回字典，评测脚本按 `status` / `final_response` / `metrics` / `trace` 判分与复核。
- **不泄露题目与凭据**：结果中不包含原题文本、标准答案或 API 凭据；`trace` 只含受控的 id 与状态码。
- **未解有明确原因**：`unsolved` 必须带 `stopReason`（如 `NO_CANDIDATE`、`DEADLINE_EXCEEDED`、`TRANSPORT_STOP`），
  便于区分"数学不会"与"系统故障"。
- **可回放**：同一题目 + 同一 client 行为可用 `resume_checkpoint` 复盘。

## 仓库结构

```
astra-refactored/
├── user_agent.py                 # 官方入口：ReasoningAgent.solve
├── python/astra_bridge/          # Python Host：client 适配、协议、子进程、准入
├── apps/stdio-runtime/           # TS 组合根：runAgentLoop 与 Host 协议实现
├── packages/
│   ├── protocol/                 # 跨模块类型、Host 协议、JSON Schema、工具白名单
│   ├── runtime-core/             # 根预算、事件、上下文投影、计划目录
│   ├── math-contract/            # M1 目标契约与任务/义务账本
│   ├── math-gateway/             # M2 调用准入
│   ├── math-workunit/            # M3 工作单元与产物接收
│   ├── math-review/              # M4 评审
│   └── math-audit/               # M5 审计与最终输出策略
├── mathagent/                    # 数学资产：方法卡、工具注册表、算法与检查器
├── math_families/                # 数学族实现（精确检查、有限枚举等）
├── release/                      # 预编译 bundle、schema、构建清单
├── scripts/                      # 构建与校验脚本
├── docs/                         # 设计、门禁、评测与审计文档
└── tests/                        # Python 回归与端到端用例
```

### 开发与验证

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/esbuild/bin/esbuild apps/stdio-runtime/dist/src/main.js \
  --bundle --platform=node --format=esm --outfile=release/stdio-runtime.bundle.mjs --log-level=warning
python3 scripts/build_release_manifest.py
python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
python3 -m pytest -q
git diff --check
```

当前基线（提交 `59e8aca`）：`tsc -b` 通过、Node **334/334**、Python **718 passed / 24 skipped**、
manifest `VERIFY_OK`、`git diff --check` 干净、仓库内无凭据。

## 合规与提交材料

- **提交清单**：技术方案文档（PDF）、日志与结果文件（JSON）、展示视频（≤10 分钟，决赛）、
  系统介绍 PPT（决赛）、源代码或 Notebook（建议开源）；
  打包为 `.zip`，命名为 **推报单位-申报人姓名-作品名称-联系电话**。
- **禁止项**：严禁人工逐题干预作答、赛后补填结果、伪造日志、使用未经允许的外部闭源服务代答。
  本项目所有结果均由智能体自动产生，日志与事件轨迹可复核；不接收、不内置标准答案或针对题目的专用题卡。
- **凭据**：仓库不包含任何 API 密钥；真实评测时由环境变量注入（`INTERN_API_KEY` / `INTERN_ENDPOINT`），
  日志与结果中不写入密钥。
- **团队**：湖北工业大学推报，学生团队（含跨学院成员）与指导教师按报名表登记信息为准；
  联系方式通过赛事官方渠道，不在仓库中公开个人信息。

## 已知限制与路线图

**已知限制（均有实测数据支撑）**

| 限制 | 现状 | 影响 |
| --- | --- | --- |
| TS 侧工具白名单只有 4 项 | 注册 73 项、Python 侧实现 11 项 | 圆周 Laplacian、分裂域次数、根的个数等题目**无工具可调** |
| 工具命中率低 | 100 题中仅 17 题真正调用工具 | 绝大多数题目靠模型心算，边界题结果不稳定 |
| 语义路由只覆盖 6 类题型 | 行列式 / 扩域 / 密度 / PDE / 极限 / 有限计数 | 大量题型完全没有触发路由 |
| 强制轮是提示而非门禁 | 模型可直接提交工作包跳过工具 | 路由命中后仍可能不调工具 |
| 方法卡与工具共享 effect 预算 | `max_effects=2`，其中 1 个常被方法卡占用 | 工具机会只剩 1 次 |
| 共识投票按原文比对 | `1/2` 与 `\frac12` 视为不同候选 | 多次采样都对也无法形成多数 |
| 单次抽样波动大 | 三次盲跑极差 14 分 | 单次成绩不可作为结论 |

**路线图**

1. **可观测性**：在 `metrics` 中记录方法卡 id、工具名与 operation、路由漏斗（命中→强制→服从→结果被消费）。
2. **路由与门禁**：语义路由表扩容；强制轮改为协议门禁（未按要求调用则再发一轮，有界一次）；
   方法卡加载不再计入 effect 预算；所有工具结果进入闭合检查。
3. **闭合检查**：选项覆盖（多选逐项）、次数守恒、密度归一化、解集完备性四类确定性诊断强制生效。
4. **稳定性验收**：同协议 3 次盲跑，目标单次 ≥88、三次极差 ≤3、稳定正确率 ≥92%。
5. **决赛能力**：可交互 Demo（Notebook/Web）、题型自动识别与 solver 路由、过程校验智能体的协作编排。

## 文档索引

| 阅读目的 | 文档 |
| --- | --- |
| 当前门槛与阻断项 | [GATEBOARD](docs/GATEBOARD.md)、[RELEASE_BLOCKERS](docs/RELEASE_BLOCKERS.md) |
| 交接与执行记录 | [HANDOFF](HANDOFF.md)、[DEEP_LOOP_STATUS](docs/DEEP_LOOP_STATUS.md) |
| 逐题评测与审计 | [ITEM_REVIEW_V3_20261021](docs/ITEM_REVIEW_V3_20261021.md)、[ITEM_AUDIT_20261022](docs/ITEM_AUDIT_20261022.md)、[MATH_AB_REPORT](docs/MATH_AB_REPORT.md) |
| 主循环设计与 Host 接入 | [UNIFIED_TS_AGENT_LOOP](docs/UNIFIED_TS_AGENT_LOOP.md)、[TS_ENGINE_ENTRY](docs/TS_ENGINE_ENTRY.md)、[P2_HOST_BRIDGE](docs/P2_HOST_BRIDGE.md) |
| 动态任务、依赖与产物版本 | [G2_DYNAMIC_ROUTES](docs/G2_DYNAMIC_ROUTES.md)、[G2_DEPENDENT_CHAIN](docs/G2_DEPENDENT_CHAIN.md)、[G2_ARTIFACT_REDO](docs/G2_ARTIFACT_REDO.md) |
| 方法卡与有据修复 | [G2_METHOD_BRIDGE](docs/G2_METHOD_BRIDGE.md)、[P4_EVIDENCE_REVISION](docs/P4_EVIDENCE_REVISION.md) |
| 运行时加固 | [G4_RUNTIME_HARDENING](docs/G4_RUNTIME_HARDENING.md) |
| 安装 | [INSTALL](INSTALL.md) |
| 贡献约定 | [AGENTS.md](AGENTS.md) |

## 致谢

- **Intern-S1**：上海人工智能实验室的科学多模态大模型，本项目的求解能力来自其 API。
- **lagent**：官方数学智能体基线框架，本项目早期实现参考了其组织方式。
- 赛事组织方与指导老师提供的题目集、评测口径与技术支持。

本仓库当前未提供项目级 `LICENSE` 文件，公开源码本身不构成额外许可声明；
第三方依赖与来源材料按各自许可与署名要求处理。
