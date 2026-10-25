# Astra 前端与统一数学资产整合执行方案

版本：1.0
核对日期：2026-10-25
工作方式：保留两条原分支，全部合并与后续开发在新整合分支完成。
建议整合分支：`feat/web-unified-math-integration`。

目标是让网页、BFF、正式求解入口和数学运行时使用同一套数学资产：唯一规范文件 `mathagent/resources/math-assets.json`，统一实体名称“数学资产”，统一稳定标识 `assetId`，统一计算行为 `target`，统一运行入口 `use_math_asset`。原来的方法卡、方法族和算子仅作为迁移来源或内部兼容信息，不再成为三套面向用户的资产体系。

当前底层统一成果位于统一资产分支；前端分支尚未接入。下一阶段的交付物是一个完成前后端整合、可复现验收的新分支。本方案中标记“新增”的文件、接口和命令均为待实现项，不表示仓库已经具备。

## 1 两条源码分支与固定审查版本

| 用途 | 随推送更新的分支源码 | 本方案固定审查快照 |
|---|---|---|
| 前端、BFF、队列、SSE、回放 | [前端设计分支][web-branch] | [67f306a 源码快照][web-snapshot] |
| 统一数学资产、Host、Protocol v1.4、82 项入口测试 | [feat/unified-math-assets 分支][math-branch] | [263923a 源码快照][math-snapshot] |

完整提交号：

- 前端：`67f306a6e20d802f9d9f20de87748ac729c9228b`。
- 统一数学资产：`263923a70849a3cd028c2f347f76ee5cf8873ad0`。
- 共同祖先：`eb36a5acadc5de53d1c436b63faefca193b7d3f4`。

截至本次核对，统一资产分支有 20 个独有提交，前端分支有 10 个独有提交。两者是分叉关系。合并预检检测到三个冲突文件：`.gitignore`、`README.md`、`tests/conftest.py`。开始执行时必须重新核对 HEAD；如远端更新，应先审查新增差异并更新基线记录。

### 1.1 原分支保持不动的操作约束

1. 不在 `前端设计` 或 `feat/unified-math-assets` 上提交、合并、rebase 或 reset。
2. 不向这两条远端分支推送；不执行 force push。
3. 新建独立 worktree 和 `feat/web-unified-math-integration`，以数学统一快照为起点，将前端快照合入。
4. 所有冲突解决、接线、页面修改、测试、构建产物和文档更新都提交到整合分支。
5. 原工作区中的未提交文件保持原状，不通过 stash、clean 或强制 checkout 整理它们。
6. 最终只交付新分支。是否将新分支再合入其他长期分支属于后续发布决策，本方案不预设该动作。

### 1.2 必读源码

| 核对目的 | 前端源码或统一资产源码 |
|---|---|
| 仓库执行规则 | [AGENTS.md][agents] |
| 当前交接记录 | [统一资产 HANDOFF.md][handoff] |
| 资产规范及验收说明 | [MATH_ASSETS_UNIFIED.md][unified-doc]、[MATH_ASSETS_ACCEPTANCE.md][math-acceptance] |
| 唯一资产规范 | [math-assets.json][catalog] |
| 历史迁移覆盖 | [math-assets-migration-ledger.json][ledger] |
| Python 统一执行 | [math_assets_runtime.py][math-runtime] |
| 正式入口及运行参数 | [user_agent.py][public-entry]、[agent_runtime.py][agent-runtime] |
| TS 调度与结果消费 | [agent-loop.ts][agent-loop]、[agent-answer-closure.ts][answer-closure] |
| 统一动作协议 | [agent-host-v14.schema.json][protocol-v14] |
| 正式入口 82 项回归 | [test_ts_math_assets_82_e2e.py][core-e2e] |
| BFF 装配与 HTTP 路由 | [app.py][web-app] |
| 队列、结果转换与落盘 | [queue.py][web-queue] |
| Web 数据契约 | [Python DTO][web-dto]、[TypeScript DTO][web-types] |
| 资产页和求解页 | [AssetsPage.tsx][assets-page]、[SolvePage.tsx][solve-page] |
| 前端终态与回放 | [reduceRun.ts][reducer]、[terminalFrame.ts][terminal] |
| 现有 Web 测试 | [test_web_bff.py][web-tests]、[test_web_contract.py][contract-tests] |
| 构建和发布清单 | [build_release_manifest.py][manifest-script]、[前端静态清单][web-manifest] |

## 2 本阶段完成的准确含义

“统一文件”指所有数学资产的规范定义只有一个权威来源，不要求把 Python 算法实现、TypeScript 调度和页面代码塞进同一个源文件。算法仍可按模块实现，但名称、说明、输入契约、行为映射和证据边界由规范文件驱动。

“统一名称”指产品和公开资产目录只认识“数学资产”，以 `assetId` 标识资产、以该资产下的 `target` 区分计算行为。`target` 是资产内的能力，不再成为一套独立算子目录。已有 ID 保持稳定，不为美化名称改动协议标识。

完成后必须同时成立：

- 唯一权威目录仍为 `mathagent/resources/math-assets.json`。
- 当前目录 26 项资产、82 项计算行为完整保留；76 项历史实现映射不丢失。
- 四项无计算行为的资产仍可浏览并提供指导：`math.proof`、`math.recurrence`、`math.topology`、`math.statistics`。
- 浏览器通过 BFF 使用正式 `ReasoningAgent(client=...).solve(problem, metadata)`。
- 正式链路仍经过 TS 发布 bundle、Python Host 和 `use_math_asset`。
- 正常调用、失败、预算耗尽、未知远端结果和观测消费状态都能如实传到页面。
- `candidate_verified` 在本阶段始终为 `False`；计算行为成功不自动提升整题证明等级。
- 前端、BFF、Host、发布包展示的协议和目录摘要一致。
- 26/82 是当前基线，不在页面硬编码；后续规范增加资产时，目录及覆盖检查随规范更新。

历史冻结文件可以保留，冻结哈希门禁继续有效。完成标准是默认新调用链不依赖三套旧资产定义，不能用删除历史文件来制造“已经统一”的表象。

## 3 已发现的整合缺口及修复落点

| 编号 | 当前源码事实 | 本阶段处理 |
|---|---|---|
| G1 | 前端分支没有统一资产规范、v1.4 Schema 和 82 项入口测试 | I1 合入完整统一资产历史 |
| G2 | `create_app` 创建 `ExecutionManager(store)`，未注入 solver | I3 明确生产装配与测试注入方式 |
| G3 | `_coerce_outcome` 从字典构造结果时未复制 `metrics`；`_finalize` 把 `childReaped` 写成 True | I3 保留正式返回字段，移除无依据默认成功值 |
| G4 | HTTP 层、队列校验和 DTO 分别维护参数，默认值并不完全一致 | I2 建立单一路径校验并贯通参数 |
| G5 | `/api/assets` 查询运行产物；资产页仍显示方法卡、数学族、工具 | I4 新建规范目录接口；I6 统一页面 |
| G6 | 求解页仍提供 `max_method_loads` 方法卡开关 | I2、I6 改为统一效果预算；新 Web 默认方法加载额度为 0 |
| G7 | 前端静态 `BUILD_MANIFEST.json` 是 v1.3 旧快照 | I7 同步构建并校验前后端发布标识 |
| G8 | 现有 SSE 有队列与关闭帧机制，但尚未连接正式求解的实时事件源 | I5 接入真实事件和恢复机制 |
| G9 | 现有 82 项测试覆盖核心正式入口，不经过新 BFF 与浏览器 | I8 补充 BFF 全行为覆盖和浏览器整体验收 |

源码另有两个适合一起修正的契约问题：

- `schema_export.py` 当前导出到仓库根目录下的 `packages/web-contract/schema`，但没有命令行 `--out` 和只读 `--check`。I2 应保留正确输出位置并补齐漂移检查。
- `CapabilitiesDto` 的默认取消能力与实际 API 声明不一致。I2 必须使 DTO、实际响应和页面开关一致；当前不支持的取消能力继续明确为 False。

## 4 阶段总表

按依赖顺序完成 I0 至 I9。每个阶段的提交必须能说明改了什么、验证了什么、还缺什么。通过阶段门禁后继续下阶段，不以“合并成功”或“页面能打开”作为终验。

| 阶段 | 工作 | 出口条件 |
|---|---|---|
| I0 | 固定基线、记录环境、定义验收矩阵 | 两个完整 SHA 和环境状态可复现 |
| I1 | 新建整合分支并合并 | 只在新分支形成合并提交，三个冲突正确解决 |
| I2 | 统一 Web 请求与返回契约 | HTTP、队列、适配器和页面字段一致 |
| I3 | 接通正式求解入口 | 一个网页请求进入真实运行链并保真返回 |
| I4 | 提供统一数学资产目录 | 26 项资产、82 项行为来自唯一规范 |
| I5 | 接通事件、结果落盘和回放 | SSE 与回读结果一致，重连不重算 |
| I6 | 完成统一资产页面与求解交互 | 用户不再面对三套资产入口 |
| I7 | 同步 bundle、Schema 与前端发布信息 | 默认运行和展示信息均对应整合产物 |
| I8 | 全链路与异常验收 | 核心 82 项、BFF 82 项及 Web 验收通过 |
| I9 | 交接、证据归档和新分支交付 | 报告可复跑，原分支保持不动 |

## 5 I0 固定源码与执行环境

**交付物：新增 `docs/WEB_MATH_INTEGRATION_PLAN.md`，记录本方案、两条来源 SHA、整合分支名和阶段状态。**

先读取两条分支的交接记录与仓库规则。实施分工沿用 `AGENTS.md`；本方案不更改其中的实施者、审查者及授权边界。

在已有本地克隆根目录执行以下 PowerShell 命令。此处只获取引用和读取状态：

```powershell
git status --short
git fetch origin
git ls-remote --heads origin "refs/heads/前端设计" "refs/heads/feat/unified-math-assets"

$mathSha = "263923a70849a3cd028c2f347f76ee5cf8873ad0"
$webSha = "67f306a6e20d802f9d9f20de87748ac729c9228b"

$actualMath = (git rev-parse "origin/feat/unified-math-assets").Trim()
$actualWeb = (git rev-parse "origin/前端设计").Trim()
if ($actualMath -ne $mathSha -or $actualWeb -ne $webSha) {
    throw "远端分支已更新：先审查新提交，再更新执行基线。"
}

git merge-base $mathSha $webSha
git rev-list --left-right --count "$mathSha...$webSha"
git worktree list
```

记录 Node、Python、pnpm 版本与依赖就绪情况。工具链以合并后的 `package.json`、锁文件和 Python 依赖声明为准，不能根据本方案凭空升级。现有仓库声明 Node 24.7.0、pnpm 11.7.0；82 项脚本会导入依赖 pytest 的测试模块，因此不能宣传为“无第三方依赖”。

检查 Python 数学依赖以及 Web 的 Starlette、Pydantic、Uvicorn、HTTP 测试依赖是否可导入。若 Web 依赖未被可复现声明覆盖，新增明确的 Web／测试依赖组，固定兼容范围。按仓库规则完成依赖安装授权后再安装；当前会话仅编写方案，不执行安装或付费模型评测。

验收：

- 两条来源 HEAD 已固定，动态链接与固定源码链接同时记录。
- 原工作区未提交内容没有被移动或清除。
- 缺失依赖记作 `ENVIRONMENT_BLOCKED`，不能把未执行测试写成 PASS。
- 已列出每一个终验命令及其依赖，避免最后才发现环境不足。

## 6 I1 在新分支合并

**交付物：新分支上的合并提交；两条原分支保持原样。**

以上一阶段固定的数学统一提交为基底，在独立目录中合入前端提交：

```powershell
$integrationBranch = "feat/web-unified-math-integration"
$integrationPath = Join-Path (Split-Path -Parent (Get-Location).Path) "astra-refactored-web-unified"

git worktree add -b $integrationBranch $integrationPath $mathSha
if ($LASTEXITCODE -ne 0) { throw "创建整合 worktree 失败；不要覆盖已有目录或分支。" }

Set-Location $integrationPath
git branch --show-current
git merge --no-ff --no-commit $webSha
git diff --name-only --diff-filter=U
```

合并命令因冲突返回非零属预期，应逐个解决；若出现额外冲突，按本次实际源码重新评估，不套用旧结果。

| 冲突文件 | 解决要求 |
|---|---|
| `.gitignore` | 合并两边规则，保留前端运行数据、测试临时文件与敏感本地配置的忽略项；确保正式 Schema、bundle 和规范 JSON 没有被误忽略 |
| `README.md` | 以统一资产、默认 TS 和 Protocol v1.4 的现状为主线，纳入前端真实启动方式；删除“默认已经接通 solver”“自动演示回退”等与源码冲突的旧说明 |
| `tests/conftest.py` | 兼容前端临时目录隔离与数学测试的 Windows 设置；不得把测试专用 monkeypatch 移进生产模块；必须有单独、不加载这些测试替身的正式入口验证 |

尤其注意：数学分支的 Windows conftest 使用线程替身处理部分超时测试。线程超时不能证明子进程已经回收。最终生命周期测试必须验证真实生产隔离路径，不能仅依据该 conftest 下的结果宣称生产安全边界通过。

冲突解决后检查：

```powershell
git diff --name-only --diff-filter=U
git diff --check
git status --short
git add .gitignore README.md tests/conftest.py
git diff --cached --stat
git commit -m "merge: integrate frontend into unified math branch"
```

只有未解决冲突列表为空、合并内容检查正确时才能提交。不要用整树 `--ours` 或 `--theirs` 替代语义合并。

验收：

- 整合分支同时包含两个固定来源提交。
- 统一资产的源码、生成视图、v1.4 Schema、发布包和测试都在。
- 前端页面、BFF、Web 契约、回放和原有 Web 测试都在。
- 此时仅记录“源码合并完成”，不记录“正式入口已经接通”。

## 7 I2 统一 Web 请求与返回契约

**建议改动：`python/astra_web/contracts/dto.py`、`schema_export.py`、`packages/web-contract/src/types.ts`、`app.py`、`queue.py`；新增统一 Web 运行配置模块。**

### 7.1 单一请求校验路径

`POST /api/runs` 使用同一个 DTO 完成字段校验，队列只接受已规范化的数据对象。移除 HTTP、队列和前端各自不一致的默认值。

正式 Web 页面本阶段只声明 `engine="ts"`。底层 `lite`／`legacy` 兼容入口可以保留，但不作为统一资产页面的默认或静默回退路径。

建议 Web 默认配置与当前正式 AgentRuntime 默认对齐：

| 字段 | 默认值 | 约束来源或说明 |
|---|---:|---|
| `max_model_calls` | 8 | 整数，范围遵循正式运行时 0 至 256；布尔值不能冒充整数 |
| `max_work_units` | 4 | 1 至 64 |
| `max_effects` | 1 | 0 至 2；涵盖统一资产效果调用 |
| `max_reviews` | 1 | 0 至 3 |
| `max_method_loads` | 0 | 新 Web 入口固定为 0；兼容字段不作为独立页面功能 |
| `max_repairs` | 0 | 0 至 3 |
| `max_consensus` | 0 | 0 至 8 |
| `max_r0` | 0 | 0 或 1 |
| `problem_seconds` | 600 | 正有限值；Web 可采用比核心更窄的已记录范围 |
| `policy` | `BEST_EFFORT` | 保留正式运行时支持的枚举 |

这些默认值统一存放并由 capabilities 返回。前端读取后初始化；实际请求保存生效值，刷新或重连不得改变预算。

`metadata`、`idempotency_key` 和必要的请求标识要进入同一契约，不可出现“TS 类型允许，HTTP 接口忽略”的情况。浏览器不能提交任意 provider 地址、模型密钥、Host 绑定字段、发布包路径或可执行文件路径。

### 7.2 返回值和指标不能丢失

扩展 Web DTO 和适配结果，使其保留正式返回的：

- `status`、`stopReason`、`reason`、`code`、`final_response`。
- `candidate_verified`、`strictAcceptance`、`targetEnvironment`、`unresolvedObligations`。
- `sessionId`、`trace`、`metrics`、`finishReason`、`elapsedMs`、`childReaped`。
- 本次配置、发布标识、目录版本及摘要。
- BFF 自己产生的 `runId`、排队状态和“是否进入求解链”事实。

`metrics` 特别覆盖 `tool_effect_calls`、`tool_names`、`effect_calls`、`client_method_calls`、`logical_model_calls`、`remote_outcome_unknown` 和 usage 未知项。禁止把未知的 token 消耗、HTTP 尝试次数、逻辑调用数默认转为 0。

优先给 SolveOutcome 增加有明确类型的正式结果字段，修正 `_coerce_outcome` 的丢字段问题。不能通过默认 `childReaped=True` 掩盖回收失败；未启动子进程也要在结果中明确区分“不适用”和“已确认回收”。

### 7.3 契约生成与能力声明

- 保持 Schema 导出到仓库根目录；新增显式 `--out` 和只检查不写入的 `--check`。
- Python DTO、JSON Schema、TS 类型和实际 HTTP 响应建立一致性检查。
- Web 契约版本与 Host Protocol v1.4、资产 catalogVersion 分开表达，不能把三个版本混成一个。
- capabilities 只声明实际支持的引擎、预算、事件等级和取消能力。
- 当前没有真实取消闭环时继续返回取消不支持；不为本阶段额外实现未经验证的远端取消。

验收：同一请求通过 HTTP、队列和适配器后，生效字段完全一致；非法字段、未知资产控制字段和越界预算被明确拒绝；旧历史记录仍可只读展示。

## 8 I3 接通正式求解入口

**新增：`python/astra_web/solver_adapter.py`。修改：`app.py`、`queue.py`。**

生产路径从浏览器的 `POST /api/runs` 进入 BFF 校验和队列。适配器调用 `ReasoningAgent(client=...).solve(...)`，由默认 `release/stdio-runtime.bundle.mjs` 调度，再通过 Python Host 的 `math_asset.execute` 调用 `use_math_asset`。真实观测进入后续模型上下文，正式结果最终返回 BFF、存储和页面。

`create_app` 提供明确的 client／solver factory 注入点；生产启动使用服务端配置装配真实 public client，测试注入脚本化 client。不得依靠测试代码偷偷赋值 `manager._solver`，再声称生产入口接通。

适配器职责限定为校验后的参数映射、调用、结果保真转换和事件转发。它不重新实现数学路由，不读取旧工具注册表，不生成替代答案，不调用另一套算子执行器。

应落实以下行为：

1. 一个被准入的 run 对应一次正式 solve；幂等回放、SSE 重连和详情查询不重新发起求解。
2. 传入用户选择的全部有效预算，默认 `max_method_loads=0`。
3. solver 未配置时继续明确返回 `SOLVER_NOT_CONFIGURED`、`executed=false`，不得伪装 candidate。
4. Node 启动失败、协议错误和观测拒绝保留错误码及已发生的消耗。
5. `OUTCOME_UNKNOWN` 等未知远端结果不得自动换 client 重试。同一任务的责任状态不能因页面刷新或重新装配而被清空。
6. 不在适配层将 `unsolved` 猜测为成功；正式结果和终态分类不一致时记录诊断并保守处理。
7. 对进程回收状态使用正式入口的真实结果，保留 False 和未知值。
8. “进入了求解链”“调用了计算行为”“得到候选”分别记录，不用单一 success 布尔值替代。
9. 返回标准结果时保留 `candidate_verified=False`；若异常来源试图提升该值，应拒绝或明确降级并记录原因。

最小贯通用例：通过真实 HTTP 路由提交 GF(2) 秩任务，脚本化 client 产生 `math_asset` 动作；真实 Node 与 Host 执行后，断言第二轮上下文收到正确观测、最终 candidate 正常落盘、`tool_effect_calls=1`。

验收：普通启动路径可装配 solver；使用测试启动路径也必须经过同一个 app factory 和适配器。脚本化 client 只替代远端模型响应，不能替代 Node、Host、统一数学执行器或 BFF。


## 9 I4 提供唯一规范驱动的资产目录

**新增：`python/astra_web/math_assets_catalog.py`。修改：BFF 路由、Web DTO 和 TS 类型。**

新增只读接口：

| 接口 | 作用 |
|---|---|
| `GET /api/math-assets` | 返回资产摘要列表、总数、计算行为总数、catalogVersion 和 catalogDigest |
| `GET /api/math-assets/{assetId}` | 返回单项资产详情、指导、行为契约、示例及证据边界 |
| `GET /api/runtime-info` | 返回当前服务的协议、发布来源、目录摘要和就绪状态 |

现有 `GET /api/assets` 继续表示“运行产物”，不偷偷改变原有接口含义；前端将其显示为“运行产物”，不再计入数学资产数量。

### 9.1 数据来源与返回内容

BFF 从同一份规范 JSON 或它的确定性生成视图读取目录。需要的示例或 inputSchema 不在当前生成视图中时，读取规范文件或扩展同一个生成器，不能在 Web 新建手写 assets.json。

摘要响应至少包含：

- `schemaVersion`、`catalogVersion`、`catalogDigest`。
- `assetCount`、`computationBehaviorCount`、`guidanceOnlyCount`。
- 每项的 `assetId`、`name`、`version`、`summary`、`behaviorCount`、`targets`。

详情响应展示：

- `instructions.conditions`、`procedure`、`misuse`、`verificationBoundary`。
- 每个行为的 `target`、`declaredScope`、`requiredParams`、`optionalParams`、`resultType`、`evidenceCeiling`。
- 从规范提取的输入结构、正例和不适用示例。
- “仅指导”资产的指导能力；零个计算行为不是缺失或未完成。

目录摘要沿用现有 `build_math_assets.py` 对规范文件原始字节计算 SHA256 的方式，并与生成视图常量比对。不能前端对 JSON 重新排序后另算一个“看起来相同”的摘要。

对未知 ID 返回明确 404；规范缺失或摘要不一致时返回目录不可用及具体原因，不回退读取方法族目录或旧工具表。

### 9.2 调用边界

本阶段不新增绕开正式 solve 的浏览器“直接执行算子”接口。资产目录负责发现与说明，求解由正式模型动作调用：

```json
{
  "action": "math_asset",
  "assetId": "math.linear-algebra",
  "target": "gf2_rank",
  "input": {
    "matrix": [[1, 0], [0, 1]]
  }
}
```

上述是运行时动作格式，不是直接发给 `POST /api/runs` 的请求体。网页发出的求解请求仍是题目和受控运行配置；模型通过统一动作选择资产。

如果以后要增加显式点选某一资产执行的产品能力，应先定义受控请求契约和预算绑定，再复用同一 Host 通道。本阶段不以新增第二条执行通道完成该功能。

### 9.3 目录验收

- API 返回的 assetId 集合与规范完全一致。
- 所有 `(assetId, target)` 计算行为对集合与规范一致，当前恰好 82 对；既检查数量，也检查漏项、重复项和多余项。
- 26 项资产全部有详情，四项仅指导资产正常展示。
- 正常运行时不打开旧方法卡目录和旧注册表来构造目录。
- 增加一个规范资产的受控测试中，目录会随生成更新，不需修改页面计数或路由表。
- `analyze` 等指导入口不混入“82 项计算行为”的统计；指导与计算使用同一资产实体。

## 10 I5 实时事件与结果落盘

**建议新增：`python/astra_web/event_adapter.py`。修改：队列、存储、运行时的只读事件出口及前端 reducer。**

当前 `solve` 是同步返回接口，公开返回值也不等于完整 SSE 事件数组。不能在 solve 结束后按答案拼出一串“实时过程”，也不能因当前对象有 `last_session_log` 就声称浏览器已获得运行中的事件。

### 10.1 真实事件出口

优先复用已有 Host 进度投影，增加可选、默认关闭的只读 observer／event sink：

1. 保留 `ReasoningAgent(client=...).solve(problem, metadata)` 的现有调用兼容性。
2. 如需新增参数，通过现有构造参数转发机制接收受控回调，默认 None，不改变数学调度。
3. 在模型调用准入、响应落定、数学资产请求／回执通过校验、运行终止等真实节点发出可公开事件。
4. 观测事件必须在 task、contract、goal、scope、catalogDigest、inputHash 和回执绑定校验之后发出。
5. Observer 不授予额度、不发起重试、不改变候选选择、不延长根 deadline。
6. 未采集到的中间阶段显示为未观测，不能补造。
7. 对只有最终 trace 的数据按回放或摘要标记，不冒充逐时实时轨迹。

### 10.2 线程、序列与恢复

正式 solve 在工作线程运行时，通过事件循环的线程安全投递机制交给 SSE 发布器；不能从工作线程直接操作 asyncio.Queue。

- 每个 run 使用单调递增的传输序号，保留 runtime 自有序号作为来源字段，避免两个序号体系混用。
- 事件先可靠写入受控运行存储，再用于重连回放；恢复游标不能靠仅存活于内存的数组解释。
- SSE 重连使用 Last-Event-ID，仅补发缺失事件，不重新启动 solve。
- reducer 对重复、乱序、迟到事件有确定处理；最终结果通过 run 详情接口校对。
- 队列生命周期事件与数学观察事件区别标注。排队、心跳、连接关闭均不能作为数学证据。
- Observer 或订阅者失败不能触发第二次数学计算；如事件不完整，记录 partial_observed 并保留最终结果。
- 浏览器断开只影响订阅。没有真实取消闭环时，UI 不宣称已取消远端模型请求。
- 进程重启后，对未落定 run 按实际已保存证据标记中断或结果未知，不自动重跑。

### 10.3 落盘保真

以正式结果为权威写入 summary，保留已发生的调用消耗与真实回收状态。终态记录不可被迟到回调覆盖，summary、事件关闭帧、详情 API 和刷新后的页面必须一致。

幂等键还要绑定请求指纹：同一个键与相同规范化题目、预算、引擎返回已有 run；同键但不同请求内容应返回冲突，不能把另一道题的旧答案当成本次结果。

验收至少覆盖：

- 一个正常运行中，浏览器在最终结果前收到真实阶段事件。
- 断线重连、重复订阅、重复提交均不增加模型或数学效果调用次数。
- 未配置 solver、启动失败、超时、异常结束与候选终态都能正确收口。
- 事件记录缺失时页面显示不完整，不填充猜测步骤。
- `childReaped=False` 和 `remote_outcome_unknown=True` 能完整到达前端。
- 刷新和离线回放不提高证据等级。

## 11 I6 完成统一资产页面和求解交互

**主要文件：`AssetsPage.tsx`、`SolvePage.tsx`、`SettingsPage.tsx`、`RunDetailPage.tsx`、`ResultCard.tsx`、API client、domain types 与 reducer。**

### 11.1 资产页面

页面主标题统一为“数学资产”。首屏数据从 `/api/math-assets` 读取，显示真实数量、目录版本和更新时间／发布标识。

目录提供名称和 ID 搜索、能力说明、计算行为列表及详情。资产详情内展示适用条件、步骤、不适用情况、输入参数和证据边界。可以显示领域标签，但不建立独立的“方法族”实体或第二张可手写维护的分类表。

删除现有“方法卡总数／数学族分类／计算工具数量”三块并列未知指标。历史的 20／22／76 仅可在迁移说明文档中出现。

### 11.2 求解页面

- 默认引擎为 TS，能力与默认预算来自服务端。
- 移除方法卡准入开关，统一呈现“数学资产调用额度”，后端对应 `max_effects`，明确其真实计数含义。
- 显示本次运行实际生效的配置，不能只有未传到后端的滑块。
- 未配置 solver 时展示明确未就绪状态；不自动切换 fixture。
- 请求期间区分已排队、运行中和已结束；不把请求创建成功显示为求解成功。
- 资产选择或“用于求解”按钮若保留，只能使用已经定义的真实接口语义，不能把未消费的 metadata 包装成“已强制调用该资产”。
- 用户正常流程只看到数学资产名称及必要的计算行为说明；旧 legacyToolName、implementationRef 和内部协议调试信息留在开发诊断视图。

### 11.3 结果、详情与回放

| 后端事实 | 页面表达 |
|---|---|
| candidate 且 candidate_verified=False | 候选答案，尚未证明整题正确 |
| executed=false | 本次未执行，显示原因 |
| 数学计算完成 | 显示资产、行为、结果及其证据范围 |
| 未得到候选 | 未完成求解，保留原因和已花费调用 |
| usage 未知 | 未知，不能显示 0 token |
| 协议／绑定校验失败 | 失败及固定错误码，不能显示普通数学无解 |
| 当前目录与服务器运行目录不一致 | 版本不一致，避免按旧目录解释新结果 |
| 仅有摘要或部分事件 | 明确标注轨迹完整程度 |

保留已有页面布局与可用交互，改动集中在事实来源、名称、请求参数和状态表达。页面可正常加载、目录 API 失败、运行服务未就绪、SSE 中断这四种状态分别验收。

## 12 I7 构建产物和发布信息统一

**新增：`scripts/sync_web_release_manifest.py`，支持写入与 `--check`。修改：发布信息 API、前端静态清单同步及构建文档。**

整合验收必须验证默认 bundle。只运行 `tsc -b` 不会自动刷新 `release/stdio-runtime.bundle.mjs`，不能用开发 dist 的测试结果替代默认发布包测试。

### 12.1 生成和打包顺序

在实现源码已经形成可追溯提交后执行；下列命令假定依赖已按仓库规则准备：

```powershell
python scripts/build_math_assets.py
python packages/protocol/scripts/build_agent_host_v14_schema.py

node node_modules/typescript/bin/tsc -b
pnpm exec esbuild apps/stdio-runtime/dist/src/main.js --bundle --platform=node --format=esm --outfile=release/stdio-runtime.bundle.mjs --log-level=warning

python scripts/build_release_manifest.py
python scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json

python scripts/sync_web_release_manifest.py
python scripts/sync_web_release_manifest.py --check

pnpm --filter @astra/web-demo typecheck
pnpm --filter @astra/web-demo build
```

`sync_web_release_manifest.py` 是本阶段新增命令，先实现再执行。它从本次 release 清单生成前端静态清单，不再手写另一份版本数据。

如果构建修改了源码、生成器或契约，应先提交对应源码并重建；不要让清单指向不包含实际源码修改的旧提交。允许源码提交 C 后再产生构建提交 A，报告同时记录 C 和 A，并说明对应关系。

### 12.2 严格一致性检查

- Host、bundle 和握手响应使用 `1.4-unified-math-assets`。
- `canonicalMathAssets` 及两端生成视图被纳入 release 清单。
- 规范文件实际 SHA256、生成视图常量、BFF 目录 API 和 Web 显示一致。
- 静态清单的来源提交与本次构建一致；在线运行状态以服务器实际信息为准。
- 所有生成的协议 JSON 使用 LF；发布清单路径使用正斜杠。
- 对发布包执行真正的初始化和 solve 探针，不只检查文件存在。
- `build_release_manifest.py --verify` 目前允许 v1.3 和 v1.4，整合验收必须额外断言本次是 v1.4，不能只检查 VERIFY_OK 字样。
- 清单中的旧 `lockedRunProfile` 不能冒充新 Web 的生效配置。统一其配置来源，或明确分开记录 profileId 和用途；新 Web 的方法加载额度为 0，页面显示实际生效值。
- 只保留明确标注的离线构建快照用途，不在在线 API 故障时静默用静态旧清单填充当前状态。

验收：在干净目录使用实际 release bundle 与本次 Web dist 启动，完成一个包含数学观测的请求；无需在求解时编译或重新安装 Node 依赖。


## 13 I8 全链路验收矩阵

**新增建议：**

- `tests/test_web_math_assets.py`：目录与版本接口。
- `tests/test_web_solver_adapter.py`：参数、结果和异常映射。
- `tests/e2e/test_web_math_assets_82_e2e.py`：BFF 正式入口全行为覆盖。
- `tests/e2e/test_web_math_failure_paths.py`：跨层错误与预算。
- `tests/e2e/test_web_math_streaming.py`：真实事件、重连和终态。
- `scripts/report_web_math_integration.py`：严格汇总门禁与验收报告。

这些文件在方案基线中尚不存在，实施时创建。测试名字可以按项目约定调整，但验收项不能删减。

### 13.1 三层证明各自负责什么

| 层次 | 入口 | 覆盖与结论 |
|---|---|---|
| 核心正式入口 | `ReasoningAgent.solve` | 保留现有 82 项，证明 release bundle、Host、数学执行和模型上下文贯通 |
| Web 服务入口 | HTTP `POST /api/runs` | 新增全部 82 项，证明请求、队列、适配器、真实核心、结果落盘和回读贯通 |
| 浏览器入口 | 页面提交、事件展示、刷新与回放 | 覆盖代表性类型和失败状态，证明真实页面正确调用和消费 Web 服务 |

现有 82 项测试仅替代远端模型响应，不代表数学能力综合评测。新测试也采用这个边界：脚本化 client 输出合法动作和工作产物，Node、Host、计算实现与 BFF 都使用正式代码。

BFF 的 82 项用例复用现有 W0 至 W5 输入集。必要时把公共输入抽到独立测试数据模块，避免复制维护第二份 82 项列表。覆盖门禁从规范生成期望 `(assetId, target)` 集合，再与实际执行集合比较；预期数学输出不能直接从被测输出反向生成。

### 13.2 每个 BFF 计算行为必须断言

1. 请求经真实 app factory 和 HTTP 路由进入队列。
2. 使用默认 release bundle，不设置开发 dist 替代入口。
3. 脚本化 client 第一轮发出对应 `assetId` 与 `target`。
4. 数学执行未被 mock；真实回执通过 Host 校验。
5. 后续模型上下文收到对应结构化观测，校验身份和结果字段，不能只检查字符串包含 target。
6. 预期的正常候选用例最终为 candidate，`candidate_verified is False`。
7. 这类单次计算用例的 `tool_effect_calls == 1`，且参数和调用归属正确。
8. HTTP 详情、落盘 summary、SSE 关闭帧与最终页面消费字段一致。
9. 若该用例有既有数学输出基准，继续核对；集成测试通过不能代替数学结果正确性的专门回归。
10. 测试返回非零、超时或缺失结果均计为失败，不作为跳过后成功。

### 13.3 必须覆盖的场景

| 编号 | 场景 | 核心判据 |
|---|---|---|
| T01 | 目录完整性 | 当前 26 项资产、82 对行为集合一致；仅指导资产不遗漏 |
| T02 | 全量计算行为 | 核心 82 项及 BFF 82 项分别全部通过 |
| T03 | 指导行为 | 对规范支持 analyze 的资产验证指导返回，无计算行为的四项也能使用 |
| T04 | 整数结果 | GF(2) rank 正常消费，效果次数为 1 |
| T05 | 浮点输入 | finite_difference 的 x=1.0、h=0.001 跨协议、快照、存储正常 |
| T06 | 浮点输出 | markov_expected_steps 的 2.0 正常回传与展示 |
| T07 | 字典结果 | 图二着色包含数字字符串键，Host／TS 回执和摘要一致 |
| T08 | 非法输入 | 非对象请求、bool 冒充整数、未知字段、NaN／Infinity、越界预算明确拒绝 |
| T09 | 行为归属 | 错误 assetId／target 组合不能匹配到其他资产行为 |
| T10 | 预算 | max_effects=0 不执行；额度为 1 时第二次效果请求被拒绝且消耗不归零 |
| T11 | 绑定污染 | 跨 task、contract、goal、scope、catalogDigest、inputHash 观测被拒绝，不进入页面有效证据 |
| T12 | 结果消费 | 同资产不同行为不串用；大小写兼容不漏掉既有合法观测 |
| T13 | 晚到观测 | 保留候选保护后收到精确观测的诊断和有界修正回归 |
| T14 | 未配置 solver | executed=false，错误原因可见，不伪造 candidate |
| T15 | 子进程问题 | Node 不可用、异常退出、回收失败保留真实错误与 childReaped |
| T16 | 未知远端结果 | 不自动重试，不清空调用责任；UI 显示未知而非零消耗 |
| T17 | 幂等 | 同键同请求只执行一次；同键不同请求冲突 |
| T18 | SSE 恢复 | 断线、重复、乱序、Last-Event-ID 不触发重算，终态一致 |
| T19 | 刷新与回放 | 运行列表、详情、刷新和回放得到同一真实结果，证据等级不提升 |
| T20 | 版本不一致 | 故意制造目录／Schema／静态清单漂移时门禁失败或明确拒绝使用 |
| T21 | 正式环境边界 | 干净目录默认 bundle 可启动；Windows 生产隔离验证不借助 conftest 线程替身 |
| T22 | 原分支保护 | 两个原分支未被本次操作写入；交付只包含新整合分支 |

T11 至 T13 可以复用已有核心回归并补 Web 投影断言，不必重写一套计算器。T20 的变更在测试临时目录或隔离副本中进行，不能污染规范源和冻结历史。

### 13.4 浏览器验收最小集合

浏览器自动化选择项目现有工具；若需要引入 Playwright 等依赖，应把依赖变更列入执行环境准备，不在验收时临时下载未记录版本。

至少完成以下可重复操作：

- 打开数学资产目录，核对数量、搜索和至少一项仅指导资产详情。
- 提交 GF(2) 秩任务，观察真实事件，正常交付候选。
- 提交数值计算任务，浮点观测不会导致接口或页面解析失败。
- 提交结构化结果任务，结果、运行详情和回放一致。
- 断开并重连 SSE，刷新页面后继续读取同一 run。
- 未配置 solver、目录 API 失败和预算拒绝均显示对应状态。
- 页面没有方法卡／方法族／工具三个并列入口，也没有演示数据静默回退。
- 网络请求中不出现浏览器直接连接模型 provider 或绕开正式 Host 的计算接口。

截图用于展示页面状态，自动断言及请求日志用于证明链路。不能把截图里的 PASS 文本当作程序通过的证据。

### 13.5 可复用命令与最终门禁

开发各阶段按改动运行相应检查。最终新增的 `report_web_math_integration.py --strict` 至少执行或严谨汇总以下检查；每份结果绑定源码提交、工作树状态和构建摘要：

```powershell
python scripts/build_math_assets.py --check
python packages/protocol/scripts/build_agent_host_v14_schema.py --check
python scripts/check_math_assets_frozen.py
python scripts/check_math_assets_migration.py --strict
python scripts/audit_math_assets_usage.py --strict
python scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json

python -m python.astra_web.contracts.schema_export --check --out packages/web-contract/schema
python scripts/sync_web_release_manifest.py --check

node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
node --test apps/web-demo/src/domain/__tests__/*.test.ts

pnpm --filter @astra/web-demo typecheck
pnpm --filter @astra/web-demo build

python -m pytest tests/bridge tests/math_assets tests/release -q
python -m pytest tests/test_web_bff.py tests/test_web_contract.py tests/test_web_math_assets.py tests/test_web_solver_adapter.py -q
python -m pytest tests/e2e/test_web_math_assets_82_e2e.py tests/e2e/test_web_math_failure_paths.py tests/e2e/test_web_math_streaming.py -q

python tests/e2e/test_ts_math_assets_82_e2e.py
python scripts/report_math_assets_acceptance.py --strict

git diff --check
```

其中 schema_export 的新参数、sync 脚本和新增测试需先实现。浏览器自动化命令由实际测试框架固化进项目脚本与整合报告，不用占位的“手工已通过”替代。

已有数学验收脚本内部会再调用部分测试。最终汇总可以去重同一版本的等价检查，但必须保留真实执行输出及严格指纹；不得把旧报告中的 PASS 当作本次测试结果。源码、配置、输入或构建摘要变化后，相关结果需要重新执行。

最终统一命令：

```powershell
python scripts/report_web_math_integration.py --strict
```

### 13.6 严格报告脚本的要求

报告生成 `docs/WEB_MATH_INTEGRATION_ACCEPTANCE.md`；机器结果放在运行证据目录，内容至少包含：

- 来源分支及 SHA、整合提交 SHA、是否存在未提交源码。
- 实际 Python／Node／pnpm 版本、平台和使用的 bundle 路径。
- 规范文件摘要、两端生成视图摘要、协议版本和 release 清单摘要。
- 每项门禁命令、退出码、耗时、实际测试数量和证据文件位置。
- 核心行为、BFF 行为的期望集合、实际集合、失败／缺失／重复项。
- 页面集成结果、数据完整程度以及是否使用真实外部模型。
- 两条原分支的起止引用记录。

不得把通过数、失败数、漂移数或缺失数写成默认常量；不能捕获异常后继续输出“全部通过”。依赖缺失、超时、未执行和失败分别标记，严格模式下均不能给出整体验收 PASS。

## 14 I9 交接与新分支交付

**需要交付的文件与结果：**

| 交付物 | 内容 |
|---|---|
| `docs/WEB_MATH_INTEGRATION_PLAN.md` | 本方案、两条源码链接、固定基线、阶段状态 |
| `docs/WEB_MATH_INTEGRATION_ACCEPTANCE.md` | 本次整合的真实验收报告 |
| `HANDOFF.md` | 最新整合 HEAD、完成项、剩余环境约束、复跑入口 |
| `README.md` 与 Web README | 正式启动、client 注入、目录接口、构建步骤及真实功能边界 |
| 新增或扩展的测试 | 核心覆盖保留，BFF 全行为与网页链路可复现 |
| bundle、Schema、前端清单 | 来自同一轮整合构建 |
| 新整合分支 | 含来源合并、实现、测试和交接提交 |

建议提交顺序：

1. `merge: integrate frontend into unified math branch`
2. `feat(web): align unified run contracts and budgets`
3. `feat(web): connect official reasoning runtime`
4. `feat(web): expose canonical math asset catalog`
5. `feat(web): stream authoritative runtime events`
6. `feat(web): unify math asset pages and result states`
7. `build(web): synchronize runtime and frontend manifests`
8. `test(web): verify all math behaviors through BFF`
9. `docs(web): record integration acceptance and handoff`

提交粒度可以调整，但不能把没有完成的接线或失败测试写成最终验收完成。

### 14.1 最终引用核对

在整合 worktree 执行：

```powershell
git branch --show-current
git status --short

git merge-base --is-ancestor $mathSha HEAD
if ($LASTEXITCODE -ne 0) { throw "整合历史缺少数学统一基线。" }

git merge-base --is-ancestor $webSha HEAD
if ($LASTEXITCODE -ne 0) { throw "整合历史缺少前端基线。" }

git ls-remote --heads origin "refs/heads/前端设计" "refs/heads/feat/unified-math-assets"
```

对比开始时的引用记录。若原分支被其他参与者更新，应记录外部变化并重新审查相关差异，不把它 reset 回旧提交。本次执行自身必须没有向两条原分支写入。

需要远端交付且已具备对应推送授权时，只推送新分支：

```powershell
git push -u origin HEAD:refs/heads/feat/web-unified-math-integration
```

若远端同名分支已经存在，不覆盖、不强推；先读取它的历史，决定续接或使用另一个新的整合分支名。最终报告给出实际创建成功的新分支 URL 和完整 HEAD，不预先把不存在的分支链接写成已交付。

## 15 回退与异常处理

| 所在阶段 | 操作 |
|---|---|
| 合并尚未提交 | 在新 worktree 中执行 `git merge --abort`；保留原分支和原工作区 |
| 某个实现提交出现回归 | 在整合分支修复或 revert 对应提交，重新运行受影响门禁 |
| 构建或清单不一致 | 从已记录的实现提交重新生成产物；不通过手填哈希让校验通过 |
| 新旧协议不匹配 | 阻止该整合版本进入完成状态，修复真实 Schema／bundle／Host 组合 |
| 真实远端调用结果未知 | 保留请求责任与消耗，不自动重放；从已保存状态继续诊断 |
| 依赖或平台不足 | 标记具体阻塞，继续完成不依赖该条件的工作，不能宣称终验通过 |
| 执行中断后继续 | 复用整合 worktree 和当前阶段记录，先检查状态，不重置、不重复创建合并 |

不得为了修复整合分支而回写两条来源分支；不得关闭绑定校验、冻结校验、预算限制或候选证据限制换取绿灯。

## 16 最终完成判定

以下条件全部成立才可写“前端与数学资产统一完成”：

- [ ] 原两条分支没有被本次操作修改，所有交付都位于新整合分支。
- [ ] 新分支同时包含两条来源完整历史。
- [ ] 唯一规范源、统一名称、稳定 ID 与统一调用链全部成立。
- [ ] 26 项资产和 82 项计算行为覆盖集合准确，四项仅指导资产正常使用。
- [ ] 默认 BFF 生产装配能调用正式 ReasoningAgent，未配置状态如实呈现。
- [ ] 默认 release bundle、Host 与 v1.4 协议一致。
- [ ] 输入、输出、指标、绑定、deadline、回收状态经过 Web 后保持真实语义。
- [ ] 正常运行、异常、幂等、重连、详情和回放均不会触发额外计算或提升证明等级。
- [ ] 前端不再以方法卡、方法族和算子作为三套独立资产入口。
- [ ] 目录 API、运行时目录摘要、静态清单和页面版本一致。
- [ ] 核心入口 82 项、BFF 82 项、相关回归和浏览器验收实际通过。
- [ ] 构建可复现，验收报告记录实际结果与完整提交号。
- [ ] HANDOFF、README、启动说明和新分支交付链接均已更新。

不把“某页可打开”“HTTP 返回 200”“工具完成”“候选返回”或“测试脚本生成了报告”单独等同于上述完成状态。

## 17 可交给实施者的执行任务

> 基于前端分支 67f306a6e20d802f9d9f20de87748ac729c9228b 与数学统一分支 263923a70849a3cd028c2f347f76ee5cf8873ad0，完成本方案 I0 至 I9。
>
> 保留“前端设计”和“feat/unified-math-assets”不动。以数学统一提交为基底，在独立 worktree 新建“feat/web-unified-math-integration”，合入前端提交。所有改动、构建产物、测试与交接只进入新分支。
>
> 完成源码合并后继续实施 Web 契约统一、正式求解器适配、规范目录 API、真实事件接入、资产与求解页面更新、发布清单同步，以及核心入口与 BFF 的全行为覆盖。不要停在合并成功或页面可打开。
>
> 唯一数学规范仍是 mathagent/resources/math-assets.json，公开实体统一称为数学资产；资产内使用 target 选择行为。禁止维护另一套 Web 数学目录，禁止通过旧注册表或直接算子调用绕过正式 Host。
>
> 保持真实指标、未知远端结果责任、根预算、原始 deadline、进程回收及绑定校验；candidate_verified 始终为 False。测试只可替代远端模型响应，不能替代正式 Node、Host 和计算执行链。
>
> 每阶段完成后记录实际验证结果并继续下一阶段。遵循仓库 AGENTS.md 的实施与授权规则；如遇真实环境阻塞，完成可独立推进的工作并明确剩余项，不能将未执行写成通过。最终按本方案的完成判定交付新分支及可复跑报告。

## 附录 A 当前统一资产覆盖表

以下表格直接按固定数学分支的规范 JSON 提取，用于核对本轮迁移和测试覆盖。实现和测试仍应读取规范，不应复制本表作为新的运行时注册表。




| 数学资产 ID | 名称 | 计算行为数 | 计算行为 target |
|---|---|---:|---|
| `math.equations` | 定义域与方程 | 4 | `real_roots`、`simplify`、`solve_system`、`function_identity` |
| `math.proof` | 证明与反例 | 0 | 仅指导 |
| `math.invariants` | 不变量与极值构造 | 2 | `polynomial_invariant`、`double_counting` |
| `math.recurrence` | 归纳与递推 | 0 | 仅指导 |
| `math.finite-states` | 有限状态计数 | 6 | `transition_count`、`independence_polynomial`、`digit_property_count`、`deletion_divisible_largest`、`digit_sum_window`、`hamiltonian_paths_grid` |
| `math.combinatorics` | 有限组合计数 | 3 | `enumerate`、`avoiding_permutations`、`rook_numbers` |
| `math.generating-functions` | 生成函数与系数 | 1 | `expand_coefficients` |
| `math.diophantine` | 整数方程 | 3 | `quadratic_diophantine`、`symbolic_diophantine`、`quadratic_discriminant_family` |
| `math.integration` | 积分与对称 | 1 | `definite_integral` |
| `math.geometry` | 坐标与有限几何 | 7 | `angle_at_vertex`、`area_bisection_coverage`、`count_angle_ratio_locus`、`line_cover_number`、`line_separation_number`、`line_through`、`worst_configuration_search` |
| `math.optimization` | 不等式与优化 | 3 | `certificate_check`、`numeric_extremum_search`、`subset_gap_worst_case` |
| `math.linear-algebra` | 线性代数 | 4 | `gf2_rank`、`gf2_nullspace`、`solution_set`、`maximal_minors` |
| `math.probability` | 概率与随机过程 | 4 | `density_check`、`cover_time`、`markov_expected_steps`、`normal_overflow_seats` |
| `math.limits` | 极限与收敛 | 1 | `limit` |
| `math.differential` | 微分与微分方程 | 3 | `circle_laplacian`、`planar_laplacian`、`trig_reduce` |
| `math.algebraic-structures` | 群环域与代数结构 | 5 | `group_structure`、`splitting_field_degree`、`factor_over_extension`、`algebraic_polynomial_check`、`wronskian_root_identity` |
| `math.topology` | 拓扑与局部整体 | 0 | 仅指导 |
| `math.statistics` | 统计推断 | 0 | 仅指导 |
| `math.regression` | 回归诊断 | 1 | `ols_check` |
| `math.numerics` | 数值计算与误差 | 6 | `interpolation_fit`、`finite_difference`、`richardson_extrapolate`、`verify_fd_certificate`、`closed_form_conjecture`、`identify_constant` |
| `math.encoding` | 编码与序列 | 5 | `lz78_encode`、`lz78_decode`、`lz78_bit_string`、`format_phrases`、`verify_phrases` |
| `math.graphs` | 有限图 | 6 | `has_perfect_matching`、`verify_perfect_matching`、`tutte_violation`、`triangle_free_check`、`count_complete_bipartite_subgraphs`、`constraint_propagation_2coloring` |
| `math.tiling` | 铺砌与覆盖 | 5 | `check_tiling_certificate`、`coloring_bound`、`count_tilings`、`min_tiles_cover`、`unique_tiling_check` |
| `math.games` | 有限博弈 | 6 | `deck_game_outcome`、`gap_subsequence_discrepancy`、`independent_reply_certificate`、`minimax_value_graph`、`pairing_strategy_verify`、`win_draw_loss_graph` |
| `math.lattices` | 格点几何 | 3 | `count_lattice_hexagons`、`hexagon_lattice_points`、`lattice_points_in_polygon` |
| `math.integer-structure` | 整数结构 | 3 | `frobenius_semigroup`、`odd_part`、`odd_part_table` |

合计：26 项数学资产，82 项计算行为；其中 4 项资产仅提供指导。历史 76 项实现与这些行为的对应关系见迁移账本。

## 附录 B 源码链接索引

下列文件链接固定在已核对提交，方便复查本方案依据。分支链接会随之后的推送更新。

- [前端设计最新源码][web-branch]
- [统一数学资产最新源码][math-branch]
- [前端固定快照 67f306a][web-snapshot]
- [数学统一固定快照 263923a][math-snapshot]

[web-branch]: https://github.com/3294682143-gif/astra-refactored/tree/%E5%89%8D%E7%AB%AF%E8%AE%BE%E8%AE%A1
[math-branch]: https://github.com/3294682143-gif/astra-refactored/tree/feat/unified-math-assets
[web-snapshot]: https://github.com/3294682143-gif/astra-refactored/tree/67f306a6e20d802f9d9f20de87748ac729c9228b
[math-snapshot]: https://github.com/3294682143-gif/astra-refactored/tree/263923a70849a3cd028c2f347f76ee5cf8873ad0
[agents]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/AGENTS.md
[handoff]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/HANDOFF.md
[unified-doc]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/docs/MATH_ASSETS_UNIFIED.md
[math-acceptance]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/docs/MATH_ASSETS_ACCEPTANCE.md
[catalog]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/mathagent/resources/math-assets.json
[ledger]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/docs/math-assets-migration-ledger.json
[math-runtime]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/python/astra_bridge/math_assets_runtime.py
[public-entry]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/user_agent.py
[agent-runtime]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/python/astra_bridge/agent_runtime.py
[agent-loop]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/apps/stdio-runtime/src/agent-loop.ts
[answer-closure]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/apps/stdio-runtime/src/agent-answer-closure.ts
[protocol-v14]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/packages/protocol/schema/agent-host-v14.schema.json
[core-e2e]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/tests/e2e/test_ts_math_assets_82_e2e.py
[web-app]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/python/astra_web/app.py
[web-queue]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/python/astra_web/queue.py
[web-dto]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/python/astra_web/contracts/dto.py
[web-types]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/packages/web-contract/src/types.ts
[assets-page]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/apps/web-demo/src/pages/assets/AssetsPage.tsx
[solve-page]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/apps/web-demo/src/pages/solve/SolvePage.tsx
[reducer]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/apps/web-demo/src/domain/reduceRun.ts
[terminal]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/apps/web-demo/src/domain/terminalFrame.ts
[web-tests]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/tests/test_web_bff.py
[contract-tests]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/tests/test_web_contract.py
[manifest-script]: https://github.com/3294682143-gif/astra-refactored/blob/263923a70849a3cd028c2f347f76ee5cf8873ad0/scripts/build_release_manifest.py
[web-manifest]: https://github.com/3294682143-gif/astra-refactored/blob/67f306a6e20d802f9d9f20de87748ac729c9228b/apps/web-demo/public/BUILD_MANIFEST.json

---

## 18 本轮执行基线（I0）

- 前端来源：`67f306a6e20d802f9d9f20de87748ac729c9228b`（`origin/前端设计`）。
- 数学统一来源：`263923a70849a3cd028c2f347f76ee5cf8873ad0`（`origin/feat/unified-math-assets`）。
- 共同祖先：`eb36a5acadc5de53d1c436b63faefca193b7d3f4`。
- 关系：`20` 个数学独有提交、`10` 个前端独有提交（`git rev-list --left-right --count`）。
- 整合分支：`feat/web-unified-math-integration`。
- 独立 worktree：`/home/ma-user/work/Astra /astra-refactored-web-unified`。
- 基线原分支均未在本轮写入；所有改动只进入整合 worktree。
- 环境：Node `v24.7.0`、pnpm `11.7.0`、Python `3.10.6`；Starlette/Pydantic/Uvicorn/HTTPX/Pytest/SymPy 可导入。
- 合并冲突：`.gitignore`、`README.md`、`tests/conftest.py`，按本方案语义合并；未使用整树 ours/theirs。

## 19 执行状态（I1–I9）

| 阶段 | 状态 | 证据 |
|---|---|---|
| I1 合并 | 完成 | 合并提交 `923f619`；两个来源均可用 `merge-base --is-ancestor` 验证。 |
| I2 Web 契约 | 完成 | `RunRequestDto` 单一路径；默认预算 8/4/1/1/0/0/0/0；schema `--out/--check`。 |
| I3 正式求解入口 | 完成 | `SolverAdapter` 注入 `ReasoningAgent`；真实 Node/Host/`use_math_asset` BFF 用例通过。 |
| I4 资产目录 | 完成 | `/api/math-assets`、单项详情、`/api/runtime-info`；26 项 / 82 行为 / 4 仅指导。 |
| I5 事件与回放 | 完成 | 真实 Host observer 事件、SSE Last-Event-ID、L2 落盘与去重测试。 |
| I6 页面 | 完成 | 资产页统一为数学资产；求解页改为 `max_effects`，方法卡开关移除。 |
| I7 发布清单 | 完成 | schema 生成检查、release manifest、Web 静态清单同步检查。 |
| I8 验收 | 完成 | 核心 82/82、BFF 82/82、Web 单元/BFF/失败/流式 49 项、headless Chrome smoke 通过。 |
| I9 交付 | 完成 | 验收报告 `docs/WEB_MATH_INTEGRATION_ACCEPTANCE.md`、HANDOFF、新分支提交并推送；原分支未改动。 |

> 说明：82 项测试只替代远端模型响应；Node、Host、统一数学资产执行器与 BFF 均为正式代码。`candidate_verified` 始终为 `False`。

## 20 独立复核修复轮（V2）

2026-10-25 对 `841f357` 的独立复核（远端核对 + 8 项资产/协议/清单检查 + 38 项前端逻辑测试）
判定「分支合并正确，但不能判定整合全部完成」，并给出 5 项缺陷。本轮在同一条整合分支逐项修复，
原分支 `前端设计`（`67f306a`）与 `feat/unified-math-assets`（`263923a`）继续保持不动。

| 缺陷 | 级别 | 根因 | 修复 | 证据 |
|---|---|---|---|---|
| 生产客户端与正式调用接口不兼容 | P0 | `build_solver_from_env` 直接把 `UserSuppliedS2Client` 交给 `AgentClient`，而后者只传 `messages/temperature/max_tokens`，连接器还需要 `thinking_mode/stream/timeout/cancellation` → `TypeError` → `transportStatus=UNKNOWN` → 客户端被封锁 | 新增 `python/astra_bridge/public_chat_port.py`：`PublicChatPort` 绑定正式三参契约，代供冻结 S2 设置与按运行剩余预算收窄的传输超时；预算耗尽时在发送前抛 `RequestNotDispatched`；`SolverAdapter` 支持「工厂接收每运行预算」 | `tests/test_web_public_chat_port.py`（6 项）：裸连接器仍拒绝三参调用；**仅替换 `requests.post`** 的整链求解 `client_method_calls == POST 次数`、`remote_outcome_unknown=False`、`tool_effect_calls=1` |
| 真实事件未接入前端消费 | P1 | 页面只监听 `MODEL_REQUEST/TOOL_OBSERVATION`，reducer 不认识 `model_dispatched/model_returned/effect_returned`，全部落入 `unknownEvents`；`onerror` 直接关闭 EventSource 破坏自动重连 | `web-contract` 新增 `ObserverEventKind` 与载荷类型；`reduceRun` 三个真实事件分支（步骤、effect 观测、日志）；`SolvePage` 监听真实事件名、新增实时活动面板；`onerror` 仅在 `readyState===CLOSED` 时收口，否则保留 Last-Event-ID 重连并显示重连横幅与可审计重连次数 | `apps/web-demo/src/domain/__tests__/observerEvents.test.ts`（8 项）；浏览器验收 23 项含 `reconnect_counter` / `reconnect_no_duplicate_events` |
| 已完成候选无法正确回放 | P1 | 终态只写进 `summary`，存档事件里没有终态事件，回放控制器只加载 `events` → 回放停在 `idle` | 终态收口时落一条真实 `RESULT` 事件（`sourceKind=official_result`，字段与运行记录逐字段一致）；回放页在旧存档无终态事件时用权威 summary 收口 | `tests/web_math_helpers` 相关 BFF/流式用例；`observerEvents.test.ts` 的「旧存档只有 summary 终态」用例；浏览器验收 `replay_terminal_answer` / `replay_shows_candidate` |
| 运行中事件与状态缺少重启恢复 | P1 | 事件只追加到内存，终态才写盘；新 manager 认为遗留运行不活跃 → 事件丢失、状态永远 `running` | 事件产生即追加 `runs/{id}/events.jsonl`；`get_history_events` 增加 JSONL 回落；启动时 `recover_orphan_runs()` 把遗留运行收口为 `TRANSPORT_STOP / HOST_RESTARTED`，并按「是否真的派发过」记录 `remote_outcome_unknown`；归属判定 `ownerPid + ownerToken + 进程启动时间`，活着的属主永不被收口 | `tests/test_web_restart_recovery.py`（7 项，含「活着的属主不被收口」「无派发不谎称远端未知」） |
| 验收范围不足以支持「全部完成」 | P1 | 浏览器冒烟只渲染两页、检查标题与 `26/82` 文本，没有提交求解、消费真实事件、断线重连或验证回放 | 重写 `scripts/web_browser_smoke.py`：CDP 真实交互（点击求解 → 真实 Host 事件出现在页面 → 运行中注入 SSE 掉线 → 自动重连 → 交付候选 → 事件不重复 → 打开回放页还原答案）；新增 `scripts/web_cdp.py`、`scripts/web_demo_server.py`（真实 `PublicChatPort` + 脚本模型 + 掉线注入） | 浏览器验收 `23/23 PASS` + `BROWSER_SMOKE_PASS`；reporter 新增 `web-logic-tests` 门禁（46 项 Node 逻辑测试） |

> 新增的恢复路径不改变红线：`candidate_verified` 恒为 `False`；遗留运行一律收口为系统级失败，
> 既不冒充 candidate，也不把「未派发的调用」说成远端未知。多进程（Node Host 派生的 spawn 子进程）
> 会重新 import BFF 模块，因此归属判定是必需的——否则子进程会把父进程正在跑的运行误收口。

## 21 独立复核第二轮修复（V3）

第二轮复核确认 P0 生产客户端、真实事件、正常回放、JSONL 增量落盘与浏览器验收范围均已修复，
但指出重启恢复仍有 4 处可复现缺口。本轮继续在同一条整合分支修复，原分支保持不动。

| 缺陷 | 级别 | 根因 | 修复 | 证据 |
|---|---|---|---|---|
| PID 复用后无法恢复旧运行 | P1 | `_owner_is_gone` 只判断 `os.kill(pid, 0)`：内核把死进程的 pid 分配给新进程后，遗留运行被永久认作「属主还活着」 | 记录进程**实例身份** `ownerBootId`（`/proc/sys/kernel/random/boot_id`）+ `ownerStartTicks`（`/proc/<pid>/stat` 第 22 字段）；恢复时要求实例身份一致才认为属主存活，boot 变化或 starttime 不等即判定原属主已死 | `tests/test_web_restart_recovery.py::test_recycled_pid_does_not_block_recovery` |
| 终态落盘中途退出把候选降级 | P1 | `_finalize` 先写 RESULT 事件与 `details.json`，最后提交数据库；在该窗口崩溃后，恢复逻辑只按「遗留运行」收口为 `TRANSPORT_STOP / Unsolved.`，与存档里的 `REVIEWS_COMPLETE / rank = 2` 矛盾 | 恢复先核对已持久化终态（`details.json` 的 summary 或事件里的 RESULT）；存在终态证据时按存档**补齐数据库提交**（`committedFromArchive`），不再改写为系统级失败；反之才按遗留运行收口 | `test_crash_between_archive_and_database_keeps_the_candidate`（数据库最终为 `candidate`、`REVIEWS_COMPLETE`、`rank = 2`） |
| 已完成请求仍被标成远端未知 | P2 | 恢复时只要出现过 `model_dispatched` 就把 `remote_outcome_unknown` 置真，忽略了同请求的 `model_returned` | `ExecutionManager.remote_outcome_unknown()` 按 `requestId` 配对：`COMPLETE/TRUNCATED/ERROR` 视为已知结局并从待决集合移除，`UNKNOWN` 与从未返回的保持待决 | `test_completed_requests_are_not_relabelled_as_unknown`、`test_unknown_returns_and_dangling_dispatches_stay_unknown` |
| 「未发送」异常未贯通到调用层 | P2 | 端口在预算耗尽时抛 `RequestNotDispatched`，但 `AgentClient` 把所有异常统一记为 `DISPATCHED → OUTCOME_UNKNOWN` 并封锁客户端 | `PublicChatPort.may_dispatch()` 提供无副作用的派发前准入；`AgentClient` 在写任何派发记录前调用它，并在 worker 内区分「证明未发送」与「发送后未知」；返回契约新增 `dispatchState`，Host 仅对真正发出的请求置 `blocked`，未派发请求计入 `not_dispatched_requests`，`client_method_calls/unknown_usage_requests` 均不计入 | `test_exhausted_budget_is_reported_as_not_dispatched`（HTTP 调用 0 次、`remote_outcome_unknown=False`）、`test_not_dispatched_is_journalled_but_never_blocks_the_client` |

> 预算语义未被擅自放宽：端口只回答「是否已经在发送前被拒绝」，逻辑预算仍由 Host 记账；
> 恢复路径同样不改红线，`candidate_verified` 恒为 `False`。

## 22 四类边界回归测试（V4）

复核要求「补齐这四类回归测试后再更新终验结论」。本轮把 R1–R4 抽成**独立、可单跑、最小依赖**
的回归资产，并给出不依赖 Node / 浏览器 / Starlette 的复跑方式：

| 类别 | 回归用例 | pytest-free 探针 |
|---|---|---|
| R1 PID 复用 | `tests/test_web_review_regressions.py::TestR1ProcessIdentity`（回收 pid、重启换 boot、同实例受保护、兄弟 manager 非属主） | `tests/web_review/probe_restart_recovery.py` → `R1` |
| R2 终态落盘窗口 | `TestR2TerminalCommitWindow`（崩溃窗口补提交、事件/存档/数据库三方一致、无证据时 fail-closed） | 同上 → `R2` |
| R3 请求配对 | `TestR3RequestPairing`（已配对不算未知、`UNKNOWN`/悬空保持未知、混合请求只标未决那条） | 同上 → `R3` |
| R4 未发送贯通 | `TestR4NotDispatched`（准入拒绝、`NOT_DISPATCHED` 不封锁、Host 视角不置未知、发送后失败仍为未知） | 同上 → `R4` |

复跑方式（均不需要 Node / 浏览器）：

```bash
python3 -m pytest -q tests/test_web_review_regressions.py          # 14 项
python3 -m pytest -q -k "R2 or R4" tests/test_web_review_regressions.py
python3 tests/web_review/probe_restart_recovery.py .               # JSON，all_passed 即结论
```

> 探针与被测树隔离：只在私有临时数据根内构造运行记录，不写实现文件、不触碰运行中的 BFF。
> 验收报告 `docs/WEB_MATH_INTEGRATION_ACCEPTANCE.md` 同步新增「可离线复跑的最小门禁子集」一节。

## 23 第二轮收口修复（V5）

复核确认 R1–R3 已修复、R4 即时结果正确，但指出改动引入了一处计数回归，以及 R4 在重启恢复链上丢失状态。

| 缺陷 | 级别 | 根因 | 修复 | 证据 |
|---|---|---|---|---|
| 超时调用的计数回归 | P1 | 为区分「未发送」把 `self.calls += 1` 挪到客户端返回之后；请求已进入客户端但超过截止时间时，正式入口给出 `client_method_calls=0 / logical_model_calls=1 / remote_outcome_unknown=true`，迟到线程返回后才补记 | 恢复**派发即计数**：worker 在进入客户端前登记 `calls`；只有 `RequestNotDispatched`（唯一能证明未发送的信号）回滚这一次登记；迟到结果永远不改写已交付计数 | `tests/e2e/test_ts_entry_safety.py::test_model_timeout_is_unknown_and_not_retried`（要求 `client_method_calls == 1`）已纳入 `web-unit-bff` 门禁；新增 `TestR4NotDispatched::test_r4_timed_out_call_is_still_counted_as_dispatched` |
| 未发送状态未贯穿重启恢复 | P2 | Host 的 `model_returned` 事件不带派发状态；恢复按 `transportStatus=UNKNOWN` 判定，未发送请求重启后又变成远端未知 | `dispatchState` 从 `AgentClient` 返回 → Host 事件 payload → 事件持久化 → `remote_outcome_unknown()` 判定：`dispatchState=NOT_DISPATCHED` 视为已结清；不带该字段的旧存档仍按未决处理（不擅自放宽） | 真实 `ReasoningAgent → Host → Node` 链路：`test_host_events_of_an_unsent_request_stay_resolved_after_restart`（断言 HTTP 调用 0 次、事件带 `dispatchState=NOT_DISPATCHED`、恢复后 `remote_outcome_unknown=False`）；探针 `probe_restart_recovery.py` 的 `R4.after_restart_unknown=false` |

验收门禁随之更新：`web-unit-bff` 纳入 `tests/e2e/test_ts_entry_safety.py`（超时安全），
`tests/test_web_public_chat_port.py` 现覆盖「Host 真实事件 → 重启恢复」整链，
`tests/test_web_review_regressions.py` 扩到 16 项（含派发即计数与 `dispatchState` 恢复）。
