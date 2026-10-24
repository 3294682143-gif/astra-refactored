# Web Demo 全量修复 · 独立验证报告（任务 t4）

- 验证者：`verify`（independent verifier；非实现者，未参与 t1/t2/t3 任一修复）
- 被测对象：`astra-refactored` 分支 `前端设计`；修复前基线提交 `db33c29`
- 关键事实：验证期间 `HEAD` 始终为 `db33c29`，全部修复均为**工作树未提交改动**；开始与结束两次抓取的 8 个关键文件 SHA-256 完全一致（见 `tests/web_review/evidence/fingerprint-final.txt`），说明验证期间实现方未再改动，证据有效。
- 方法：只读复现 + 自建独立探针（不修改任何被验证实现文件）。探针与原始输出见 `tests/web_review/`。
- 最终判定：**needs_revision**（四道门禁全绿、6+2 项缺陷逐条复现/回归通过；但新发现 2 处集成缺口，见第二节）。

## 结论摘要

| 维度 | 结果 |
|---|---|
| 门禁一 `pnpm --filter @astra/web-demo typecheck` | ✅ exit 0（修复前 exit 2 / TS5103） |
| 门禁二 `pnpm --filter @astra/web-demo build` | ✅ exit 0 |
| 门禁三 `node --test .../reduceRun.test.ts` | ✅ 12 pass / 0 fail（无回退） |
| 门禁四 `pytest tests/test_web_bff.py tests/test_web_contract.py -q` | ✅ 29 passed / 0 errors / exit 0（修复前 9 passed / 9 errors） |
| 用户所报 6 项缺陷 | ✅ 修复前全部复现，修复后全部不复现（逐条可重跑） |
| 本次新增 2 项（⑦TS5103 / ⑧pytest PermissionError） | ✅ 同上 |
| 诚实性抽查（文案红线） | ✅ 源码与构建产物均 0 命中 |
| 凭据（`scripts/secret_scan.py`） | ✅ 工作树 0 命中 gate PASS；注入假样本可检出 |
| 新发现集成缺口 | ❌ 2 处（V1 / V2），判 needs_revision |

## 一、通过项（PASS）

### 1.1 四道门禁（实跑，原始输出见 evidence/）

| # | 命令（在仓库根执行） | 修复前（db33c29 冻结副本） | 修复后（工作树） |
|---|---|---|---|
| 一 | `pnpm --filter @astra/web-demo typecheck` | exit 2，`tsconfig.json(19,27): error TS5103: Invalid value for '--ignoreDeprecations'`（`evidence/prefix-gate1-typecheck.txt`） | **exit 0**（`evidence/postfix-gate1-typecheck.txt`） |
| 二 | `pnpm --filter @astra/web-demo build` | exit 0（`evidence/prefix-gate2-build.txt`） | **exit 0**，1607 modules（`evidence/postfix-gate2-build.txt`） |
| 三 | `node --test apps/web-demo/src/domain/__tests__/reduceRun.test.ts` | 12 pass / 0 fail（`evidence/prefix-gate3-reduceRun.txt`） | **12 pass / 0 fail**（`evidence/postfix-gate3-reduceRun.txt`） |
| 四 | `C:\Python314\python.exe -m pytest tests/test_web_bff.py tests/test_web_contract.py -q` | 9 passed / **9 errors**，全 `PermissionError [WinError 5]`（`evidence/prefix-gate4-pytest.txt`） | **29 passed / 0 errors / exit 0**（`evidence/postfix-gate4-pytest.txt`） |

> 修复前副本获取方式（可重跑）：`git -C astra-refactored archive --format=zip -o tests/web_review/baseline_db33c29.zip db33c29` 后解压到 `tests/web_review/baseline/`，并把各 `node_modules` 以 junction 链入（仅为让门禁一/二在冻结副本内可跑）。若需在真实仓内复跑门禁一，请在仓库根运行门禁命令本身。

### 1.2 缺陷 ①——演示数据冒充 official_result，不同题同答案

- 探针：`C:\Python314\python.exe tests/web_review/probe_backend.py <tree>` 的 `defect1_fabrication`。
- 修复前（`evidence/probe-backend-prefix.txt`）：BFF 自行生成 **10** 条事件且**全部**盖 `sourceKind="official_result"`；两个**不同**题目的 `final_response` **逐字节相同**；运行 `status=candidate`。
- 修复后（`evidence/probe-backend-postfix.txt`）：BFF **0** 条自产事件、**0** 条 official_result；两运行 `status=error`、`final_response="Unsolved."`、`executed=false`、`code=SOLVER_NOT_CONFIGURED`。
- 精度说明：修复后两个不同题目同样得到 `"Unsolved."` 同一字符串——但这是官方契约的**未执行态**（非伪造候选），判据是「自产事件数=0 且非 candidate」，而非「答案字符串不同」。原缺陷的实质（把合成固定候选冒充 official_result）已消除。

### 1.3 缺陷 ②——失败/缺记录回落演示数据、详情标 L3

- 源码探针：`tests/web_review/probe_static.py`。
  - 修复前：`demo_fixture`×2、`offline fallback`×2、`DEMO_SAMPLE_LOG|DEMO_RUN_ID` 引用×7、硬编码 `level="L3"`×2。
  - 修复后：`offline fallback`=0、`level="L3"`=0；仅余 `sourceKind` 类型联合定义 1 处与 `fixtures.ts` 模块自身定义（该模块已**无任何 import**，为死代码，非回落路径）。
- 后端：`probe_backend.py` 的 `defect2_detail_level_404`。缺记录 `get_run` → 修复前后均 404；`detail_level` 字段修复前**不存在**，修复后为 **L1**（无任何真实存档时）。SSE 关闭帧亦如实携带终态事实（见 §1.5）。
- 端到端（真实浏览器，post-fix BFF :8898）：`/runs/<不存在的带 L2 的运行>` 与列表页均显示**真实错误态**、级别 **UNKNOWN**、文案「未回落演示数据」，未出现 L3 或演示数据。

### 1.4 缺陷 ③——timeout/启动失败/cancelled 显示为 candidate

- 探针：`node tests/web_review/probe_reducer.mjs <tree>`（前端口径）。
  - 修复前（`evidence/probe-reducer-prefix.txt`）：`TIMEOUT / SPAWN_FAILED / CANCELLED / ERROR` 四项 `status` **全部 = "candidate"**。
  - 修复后（`evidence/probe-reducer-postfix.txt`）：分别为 `timeout / failed / cancelled / error`，**无一为 candidate**；红线 `candidateVerified` 两版均恒为 `false`。
- 后端口径：`probe_sse_terminals.py`（`evidence/probe-sse-terminals-postfix.txt`）验证权威四类映射：`TIMEOUT→unsolved/budget_timeout`、`SPAWN_FAILED→error/system_failure`、`CANCELLED→aborted/cancelled`、`ERROR→error/system_failure`；候选型 `REVIEWS_COMPLETE→candidate/None`。

### 1.5 缺陷 ④——final_response 丢失

- 探针同上（reducer）。修复前：仅带 `final_response` 的 RESULT/FINAL 事件经归约后 `candidateProposal = null`（字段被丢弃）。修复后：`candidateProposal = "x = 42" / "proof-ish text"`，且新 `finalResponseMissing` 标记为 `false`。
- 后端：`POST /api/runs` 后 `GET /api/runs/<id>` 返回 `summary.final_response="Unsolved."`（未解按官方契约），`stopReason`、`terminalKind`、`executed`、`code` 齐备。

### 1.6 缺陷 ⑤——同幂等键重复启动、完成记录可覆盖、无串行

- 探针：`probe_backend.py` 的 `defect5_idempotency` 与 `defect5_terminal_overwrite`。
  - 重复提交启动两次：修复前「单次提交历史事件=10、同键重复提交后=**20**」→ 确认第二次执行被启动；修复后 `started_total=1`，第二次调用返回 `{started:false, idempotent_replay:true, terminal:true}`。
  - 完成记录可被覆盖：修复前 `save_run(terminal, overwrite=True)` 成功把终态 `final_response` 改成 `"OVERWRITTEN"`；修复后抛 `DuplicateRunError`，保留原值 `"A"`。
- 端到端（真实 BFF）：同 `Idempotency-Key` 首提 `201 {started:true}`、再提 **`200 {idempotent_replay:true, terminal:true}` 且 run_id 相同**。
- 串行：`/api/health`、`/api/capabilities` 的 `execution` 块暴露 `max_concurrent_runs=1`（可观测）；`probe_sse_terminals.py` 无并发越界观测。

### 1.7 缺陷 ⑥——批量导入未接功能；成绩/资产校验/服务就绪写死

- 源码探针 `probe_static.py`（修复前 → 修复后）：`100 / 112` 1→**0**；`100%` 1→**0**；`VERIFY_OK` 1→**0**；`已配置就绪|端点状态` 1→**0**。
- 真实浏览器（post-fix BFF）：
  - `/batch`：数字全部来自 `GET /api/runs`（本次实测 2 条：候选交付 0、失败或取消 2）；无接口支撑的指标显式列在「接口未提供的评测指标（显式未知）」；导入按钮 `disabled=true` 且标题为「未实现：BFF 当前未提供评测批次导入接口（无 POST /api/batches）」、旁注「已显式禁用，不做假导入」。
  - `/settings`：全部状态来自 `/api/health` 与 `/api/capabilities`（`status=ok`、`execution_queue=true`、并发上限 1），并明确「模型凭据是否已配置：未知 —— 前端不可见……不做任何『已配置/已就绪』断言」。

### 1.8 缺陷 ⑦——tsconfig TS5103

见 §1.1 门禁一：`db33c29` 的 `"ignoreDeprecations":"6.0"` 在 tsc 5.7.2 下报 `TS5103`（exit 2）；修复后 exit 0。

### 1.9 缺陷 ⑧——pytest 9 处 PermissionError

- 修复前复现（冻结副本，`evidence/prefix-gate4-pytest.txt`）：**9 passed / 9 errors**，全部 `PermissionError: [WinError 5]`，抛点 `os.scandir('C:\Users\y\AppData\Local\Temp\pytest-of-y')`（即机器级 basetemp 目录不可列）。9 个 error 恰为使用 `tmp_path` 的 9 个用例。
- 根因确认：与运行中的 uvicorn **无因果关系**（测试不触网）；是全局 basetemp 的 ACL 拒绝列目录。
- 修复后：新增 `tests/conftest.py` 让会话自持私有 basetemp；`29 passed / 0 errors`。
- 独立复核：我在**同时存在**运行中 uvicorn（:8000）的环境下重跑，仍 0 error，佐证根因判定。

### 1.10 诚实性抽查

- 源码与**构建产物** `dist/assets/index-*.js` 对 `已验证/验证通过/形式化通过/证明完成/正确性保证/VERIFY_OK/VERIFIED_VALID/校验通过/已配置就绪` 全部 **0 命中**。
- 「证明」在产物中仅 1 处，经定位为 SolvePage 例题**题干原文**（数学题面），非结论声明，不计为红线违规（与 t2 说明一致）。
- 候选恒标「候选 · 未经形式化验证」，`candidate_verified` 全链路为 `false`。

### 1.11 凭据卫生（`scripts/secret_scan.py`）

- 工作树：`1497 files scanned, 1 skipped`，`working-tree hits: 0`，`gate: PASS`，`exit 0`（`evidence/secret-scan-worktree.txt`）。
- 检出能力（**注入假样本**，非只测空集）：注入 `ghp_…`、`sk-…`、`AKIA…`、`Bearer …` 四类 → 4 命中、`gate: FAIL`、`exit 1`；再注入 `API_KEY="…"`、`client_secret: …` → 2 命中、`exit 1`。清理后回到 0 命中、exit 0（`evidence/secret-scan-injected*.txt`）。
- 内置 `--self-test` 亦 PASS。

## 二、未通过项（FAIL → needs_revision）

> 说明：以下 2 项**不属于**用户所报 6 项，也非 t1/t2 各自合同的违例；它们是 t1（后端新增 `terminalKind`/`detail_level`/SSE 关闭帧事实）与 t2（前端）**时序错位**造成的**集成缺口**——真实终态事实在后端已具备，但两个页面未消费，导致「失败/终态正确」「失败不得被掩盖」在**端到端 UI** 上未完全达成。

### V1（severity: medium）RunDetailPage 把「无 L2 存档的真实运行」误示为「运行记录不存在」，并隐藏其真实终态

- 位置：`apps/web-demo/src/pages/runs/RunDetailPage.tsx:104-141`（`if (!replay.ok) return <PanelEmptyState title="运行记录不存在或详情存档不可读…">`）。该分支未使用已同时取回的 `runRecord`（`/api/runs/<id>`）。
- 复现（真实 BFF，无 solver）：
  1. 起 BFF：`$env:ASTRA_DATA_ROOT=<tmp>; python -m uvicorn python.astra_web.app:app --port 8898`（在仓库根）。
  2. `POST /api/runs {"problem":"e2e probe","max_method_loads":0}` → 得 `run_id`。
  3. `GET /api/runs/<run_id>` → **存在**：`status=error, final_response="Unsolved.", executed=false, detail_level=L1, l2_path=null`。
  4. 浏览器打开 `/runs/<run_id>` → 页面显示 **「运行记录不存在或详情存档不可读（真实错误态）」** 与 `HTTP 404 - replay not found`（因 `/api/replays/<id>` 对无 L2 的运行返回 404）。
- 影响：真实存在的失败运行被显示为「记录不存在」，其真实终态（error / Unsolved. / executed=false）与真实级别（L1）均未呈现，与团队目标「终态与 final_response 正确」「失败不得被样例掩盖」相悖。
- requiredFix：该页应以 `runRecord.ok` 为「运行是否存在」的判据；当运行存在但无 L2 时，展示 `runMeta.summary`（status/stopReason/terminalKind/final_response/executed）与 `detail_level`，仅把「回放存档」标为不可用，而非把整个运行标为不存在。

### V2（severity: medium）SolvePage 不消费 SSE `close` 帧的终态事实与 `detail_level`

- 位置：`apps/web-demo/src/pages/solve/SolvePage.tsx:173-176`（`es.addEventListener("close", () => { cleanupStreams(); setIsRunning(false); })` 只关流，不解析 `data`）；全文件未出现 `detail_level`，未消费 `terminalKind/final_response/executed/code`。而 `python/astra_web/app.py:56-69` 的 `_terminal_payload` 已把这些事实放进关闭帧。
- 复现：
  1. 同上起 BFF，进 `/`（求解工作台）提交任一题目。
  2. 该运行无 FINAL/RESULT 事件（无 solver → 0 事件），SSE 仅发关闭帧：`event: close\ndata: {"status":"error","stopReason":"ERROR","terminalKind":"system_failure","final_response":"Unsolved.","executed":false,"code":"SOLVER_NOT_CONFIGURED"}`（已实测，`evidence/probe-sse-terminals-postfix.txt`）。
  3. 页面 `statusDetail` 落到 `state.resultSeen ? … : failure ?? "未收到终态事件，运行结果未知。"` → 显示 **「运行结果未知」**，而非真实的 `error / Unsolved.`。
- 影响：失败/未执行的运行在求解页被表述为「结果未知」，真实终态被掩盖；与目标「终态与 final_response 正确」相悖。
- requiredFix：`close` 监听器解析关闭帧 payload，把 `status/stopReason/terminalKind/final_response/executed/code` 注入归约状态（并沿用后端 `detail_level` 显示级别），使无 FINAL/RESULT 的运行也显示真实终态。
- 备注：此缺口 fix-frontend 已主动申报为「契约外新缺口」（其 t2 通过时 t1 的关闭帧事实尚不存在），与我的独立复核一致。

## 三、无法验证项（NOT VERIFIED）与原因

1. **求解工作台「点击提交」的全交互流程**：我未在浏览器中真实填写并点击提交（表单交互 + 逐帧流式渲染）。V2 由源码 + 后端关闭帧实测 + 页面逻辑推导确认，未做端到端点击复核。原因：避免在验证中对被测系统产生长时交互；已有证据足以判定缺口。
2. **既有 :8000 uvicorn 的运行行为**：其为验证前既存进程（可能加载修复前代码），我**未重启也未改动**它；所有端到端证据均来自我另起的 :8898 实例（隔离 `ASTRA_DATA_ROOT`）。既有 :8000 的行为不在本次判定内。
3. **`secret_scan.py` 覆盖边界**（诚实披露，非缺陷）：`named-assignment` 变量名清单为 `api[_-]?key|apikey|access[_-]?key[_-]?id|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|password|passwd` 且带前导 `\b`，因此**下划线前缀名**（如 `MODELARTS_API_KEY=`）不被命中（我实测注入该名未报）；`>5 MiB` 文件跳过（含本报告附带的 `tests/web_review/baseline_db33c29.zip` 9.78 MB）、归档容器成员与 vendored 目录默认不扫。这些均在脚本 `--help`/文档中可见。
4. **页面视觉/样式回归**：未做像素级对比（超出本次缺陷范围）。

## 四、复现命令汇总（可重跑）

```powershell
$root = "C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored"
# 四道门禁（仓库根）
pnpm --filter @astra/web-demo typecheck
pnpm --filter @astra/web-demo build
node --test apps/web-demo/src/domain/__tests__/reduceRun.test.ts
C:\Python314\python.exe -m pytest tests/test_web_bff.py tests/test_web_contract.py -q
# 独立探针（任意树：修复后 = $root；修复前 = $root\tests\web_review\baseline）
node tests/web_review/probe_reducer.mjs <tree>
C:\Python314\python.exe tests/web_review/probe_backend.py <tree> <label>
C:\Python314\python.exe tests/web_review/probe_static.py <tree>
C:\Python314\python.exe tests/web_review/probe_sse_terminals.py <tree>
# 凭据门禁与检出能力
C:\Python314\python.exe scripts/secret_scan.py
C:\Python314\python.exe scripts/secret_scan.py --self-test
```

## 五、证据与边界

- 被测工作树指纹（SHA-256，验证期间未变）：见 `tests/web_review/evidence/fingerprint-final.txt`。
- 原始输出：`tests/web_review/evidence/`（prefix-*、postfix-*、probe-*、secret-scan-*、fingerprint-final.txt）。
- 探针脚本：`tests/web_review/probe_reducer.mjs`、`probe_backend.py`、`probe_static.py`、`probe_sse_terminals.py`。
- 冻结修复前副本：`tests/web_review/baseline/`（含指向真实 `node_modules` 的 junction）与 `tests/web_review/baseline_db33c29.zip`。**警告**：不要对该目录做朴素递归删除（junction 可能被跟随）；如确需清理，先逐个删除 junction 再删目录。
- 声明：本次验证未 commit、未 push、未修改任何被验证实现文件（`git status` 中 `python/**`、`apps/**`、`tsconfig.json`、`scripts/secret_scan.py`、`tests/conftest.py`、`tests/test_web_bff.py` 的改动均非 `verify` 所为；`verify` 的新增全部位于 `tests/web_review/**` 与 `docs/web/15-verification-report.md`）。