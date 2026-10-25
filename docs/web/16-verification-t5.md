# t5 + t7 全量修复 · 独立验证报告（任务 t6）

- 验证者：`verify`（独立验证；非 t5/t7 实现者）
- 被测：`astra-refactored` 工作树（`HEAD` = `db33c29`，t1/t2/t5/t7 全部为未提交改动）
- 指纹：验证开始与结束两次抓取 7 个变更集文件 SHA-256 **完全一致**（`tests/web_review/evidence/t6-fingerprint*.txt`），验证期间实现方未再改动。
- 方法：只读复现 + 自建探针 + 真实浏览器端到端（另起隔离数据根的 BFF，不影响既有 :8000）。
- 最终判定：**pass**（门禁全绿；t5 三项与 t7 charset 均在端到端 UI/HTTP 上如实闭合；t4 所报 V1/V2 已闭合；无未通过项）。

## 结论摘要

| 项 | 结果 |
|---|---|
| 门禁：typecheck / build / node 两文件 26 pass / terminalFrame 12 pass | ✅ 全绿（逐条退出码见 §1.1） |
| 门禁：pytest（含 t7 charset 断言） | ✅ 30 passed / 0 errors |
| t5-① SolvePage 真实终态显式未执行态 | ✅ 端到端通过 |
| t5-② RunDetailPage / RunReplayPage 与后端 detail_level 一致 | ✅ 端到端通过（L1/L2/L3） |
| t5-③ 幂等重放不冒充首次执行 | ✅ 端到端通过（201 → 200） |
| t7 charset=utf-8（含 404、中文完整性） | ✅ 通过（A/B 头对照） |
| t4 V1/V2 集成缺口 | ✅ 已闭合 |
| 修复前对照 | ✅ 已给出（冻结 db33c29 + t4 既有存档） |
| 未通过项 | 无 |
| 测试文件改动 | 无（未修改被验证实现文件） |

## 一、通过项

### 1.1 门禁（实跑，原始输出见 evidence/t6-gate-*.txt）

| 命令（仓库根） | 退出码 | 实测 |
|---|---|---|
| `pnpm --filter @astra/web-demo typecheck` | **0** | stdout 空 |
| `pnpm --filter @astra/web-demo build` | **0** | vite v6.4.5，1608 modules，✓ built in 2.19s |
| `node --test apps/web-demo/src/domain/__tests__/reduceRun.test.ts apps/web-demo/src/domain/__tests__/statusSemantics.test.ts` | **0** | tests 26 / **pass 26** / fail 0（基线 26，无回退） |
| `node --test apps/web-demo/src/domain/__tests__/terminalFrame.test.ts`（t5 新增） | **0** | tests 12 / **pass 12** / fail 0 |
| `C:\Python314\python.exe -m pytest tests/test_web_bff.py tests/test_web_contract.py -q` | **0** | **30 passed** / 0 errors |
| `... -m pytest tests/test_web_bff.py -q -k charset -v` | **0** | 1 passed / 24 deselected（t7 新增断言存在且通过） |

### 1.2 t5-① SolvePage 呈现真实终态为「显式未执行态」

- 端到端（真实浏览器，post-fix BFF :8898，无 solver）：在 `/solve` 填入题目并点击「开始单循环求解」后，页面渲染：
  - 「**本运行未执行（executed = false）**」
  - `status: error · stopReason: ERROR · terminalKind: system_failure`
  - `code: SOLVER_NOT_CONFIGURED（BFF 尚未接线真实求解入口）`
  - `final_response: Unsolved.（官方契约的未执行占位文本，不是候选答案）· 数据级别: L1`
  - 「本次运行未执行任何求解，因此不存在候选产物：**界面不显示为 candidate**，也不回落演示数据。红线：candidate_verified = false。」
- DOM 断言（浏览器内取值）：`has_unknown_terminal=false`（未出现「运行结果未知」）、未把候选当结果展示。
- 这证明 t4-V2 的缺口已闭合：SSE 关闭帧的终态事实被消费，且**不显示为 candidate、不显示为「待运行」**（提交前状态为「尚未提交求解请求」，提交后进入专门的未执行卡片，两者不混）。

### 1.3 t5-② detail_level 权威一致（RunDetailPage / RunReplayPage / 后端）

| 记录 | 后端 `GET /api/runs/<id>.detail_level` | RunDetailPage `/runs/<id>` | RunReplayPage `/runs/<id>/replay` |
|---|---|---|---|
| `T6-RUN-1`（真实存在、无 L2） | **L1** | **L1 · 公开摘要** | （无 L2，不适用） |
| `run-l2`（有真实 L2 存档） | **L2** | **L2 · 历史日志** | **L2 · 历史日志** |
| `run-l3`（有真实 L3 附件） | **L3** | **L3 · 完整观察** | — |

- 同一条 `run-l2` 在两个页面上均为 **L2**，与后端权威值一致；`run-l3` 为 **L3**；无存档的记录为 **L1**。三处均无硬编码 L3。
- 附注：回放页的真实路由是 `/runs/:id/replay`（`/replay/:id` 不是路由，会落到 `/solve`），我的第一次导航即因此被重定向，特此记录以免误判。

### 1.4 t5-③ 幂等重放不冒充首次执行

- 真实浏览器，同一题目连续两次提交（`stableIdempotencyKey` 确定性生成，两次得到同一键 `solve-91a1b5721e06fea4`）：
  - 首次：**「本次为首次执行（HTTP 201）」** `started: true · terminal: false`
  - 重放：**「本次为幂等重放（HTTP 200，idempotent_replay=true）：未新起执行，返回既有运行 solve-91a1b5721e06fea4 的终态。」** `started: false · terminal: true`
- 与后端 `POST /api/runs`（201→200，同 runId）一致；未把重放冒充为首次执行。

### 1.5 t7 charset=utf-8

- 头对照（`/api/health`）：修复前 db33c29 = `application/json`；修复后 = **`application/json; charset=utf-8`**。
- 端到端：修复后 BFF 返回的中文 `reason` 经 UTF-8 直读为可读文本 ——「BFF 未接线真实求解入口，本次运行未执行任何求解；无真实结果，故返回显式未执行态（不提供演示数据冒充）」，无替换字符。
- 404 响应体亦为 `charset=utf-8` JSON；t7 新增断言 `test_json_responses_declare_utf8_charset` 通过。
- 语义未变：`status=error / final_response="Unsolved." / code=SOLVER_NOT_CONFIGURED / detail_level=L1`。

### 1.6 （任务附加 a）t4 所报 V1/V2 在端到端 UI 上已闭合

- `/runs/T6-RUN-1`（运行真实存在、无 L2 存档）post-fix 渲染实测：
  - `has_record_missing = false`（**未出现「运行记录不存在」**）
  - 「**回放存档不可用（该运行没有 L2 存档）：HTTP 404 - replay not found。运行记录本身存在，下方展示其真实终态与级别 L1**…」
  - 「本运行未执行（executed = false）…`status: error … code: SOLVER_NOT_CONFIGURED` … `final_response: Unsolved.` … 数据级别: L1」
- SolvePage 的 close 帧终态**不再**被「运行结果未知」掩盖（§1.2，`has_unknown_terminal=false`）。

### 1.7 修复前对照（可重跑）

- 冻结 db33c29 UI（`tests/web_review/baseline/`，另起 :8897，同一无 L2 记录 `T6-RUN-1`）实测渲染：
  - 显示 **`demo-session` / `候选答案` / `L3 · 完整观察` / 事件总数 11 帧 / 候选提案 4** —— 真实运行的终态**未被上屏**（被演示数据 + 硬编码 L3 掩盖）。
  - db33c29 的 `GET /api/runs/T6-RUN-1` 无 `detail_level` 字段（pre-t1）。
  - db33c29 的 `SolvePage.tsx` 对 `parseTerminalFrame|final_response|terminalKind` **grep 无命中**（pre-fix 不解析关闭帧）。
  - db33c29 `/api/health` content-type = `application/json`（无 charset）。
- t5 之前的 t1+t2 工作树状态（已不存在，但 t4 已存档）：RunDetailPage 曾显示「运行记录不存在」、SolvePage 曾在无 FINAL/RESULT 时显示「运行结果未知」——见 `tests/web_review/evidence/` 与 `docs/web/15-verification-report.md` 第二节 V1/V2。
- 对照结论：同一无 L2 运行，修复前→演示数据/记录缺失/无级别字段/无 charset；修复后→真实终态 + L1 + charset。**修复前能复现、修复后不复现。**

## 二、未通过项（FAIL）

无。所有验收判据均通过，未发现阻塞性缺陷。

## 三、无法验证项（NOT VERIFIED）与原因

1. **像素级视觉/样式回归**：未做截图 diff（超出本次缺陷范围；仅做 DOM 文本与语义断言）。
2. **既有 :8000 uvicorn 的行为**：验证前既存进程（可能加载修复前代码），我未重启/未改动；所有端到端证据来自我另起的 :8898（修复后）与 :8897（冻结 db33c29）。
3. **`/replay/:id` 语义**：该路径非路由（会重定向 /solve）；回放页的真实入口是 `/runs/:id/replay`，已按正确入口验证。
4. **pytest 基线的“假绿”陷阱**：按 t4 教训，任何 pre-fix pytest 复现均须用冻结副本；本次门禁只对修复后工作树实跑（30 passed / 0 errors），未对工作树做 pre-fix pytest。

## 四、复现命令

```powershell
$root = "C:\Users\y\OneDrive\Desktop\挑战杯\复赛\astra-refactored"
# 门禁（仓库根）
pnpm --filter @astra/web-demo typecheck
pnpm --filter @astra/web-demo build
node --test apps/web-demo/src/domain/__tests__/reduceRun.test.ts apps/web-demo/src/domain/__tests__/statusSemantics.test.ts
node --test apps/web-demo/src/domain/__tests__/terminalFrame.test.ts
C:\Python314\python.exe -m pytest tests/test_web_bff.py tests/test_web_contract.py -q
# 端到端：造 L1/L2/L3 数据 → 起修复后 BFF → 浏览器核对；起冻结基线 BFF 做对照
C:\Python314\python.exe tests/web_review/probe_t6_data.py $root "C:\Users\y\AppData\Local\Temp\astra_verify_t6_root"
#  修复后：$env:ASTRA_DATA_ROOT=<root>; python -m uvicorn python.astra_web.app:app --port 8898   (仓库根)
#  修复前：同上但 WorkingDirectory=$root\tests\web_review\baseline --port 8897
```

## 五、边界与证据

- 指纹：`tests/web_review/evidence/t6-fingerprint.txt` / `t6-fingerprint-final.txt`（一致）。
- 原始输出：`t6-gate-typecheck.txt`、`t6-gate-build.txt`、`t6-gate-node-2files.txt`、`t6-gate-node-terminalFrame.txt`、`t6-gate-pytest.txt`、`t6-prefix-contrast.txt`。
- 探针：`tests/web_review/probe_t6_data.py`（造 L1/L2/L3 记录）。
- 声明：未修改任何被验证实现文件；未 commit、未 push；本次新增仅 `tests/web_review/**` 与 `docs/web/16-verification-t5.md`。另起的 :8897/:8898 BFF 均已关闭，既有 :8000 未动。
