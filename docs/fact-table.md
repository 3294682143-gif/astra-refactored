# Track160 事实表（Fact Table）

* **生成时间**：2026-10-30
* **用途**：方案 §1.2 状态词汇表的事实锚点——所有"已实现/已验证/建设中"的声明以此表为准；与代码或运行记录冲突时以代码与运行记录为准并更新本表。
* **维护规则**（方案 §27.3）：每个 PR 更新其实现状态、源码版本与验证证据；测试通过数≠覆盖率；单次零错误≠全环境可靠。

## 1. 固定源码基线（真实 commit SHA）

| 仓库 | 角色 | 本地 HEAD | 远端状态 |
|---|---|---|---|
| astra-refactored（工作副本 `D:\书生\astra-refactored-3ea5819`） | 主仓 | `e484391` | **源自 GitHub `3ea5819` tarball（无 .git，本地 `git init` 于 `8330252` 起）；上游 `feat/web-unified-math-integration` 已推进至 `d767b7b`，本工作副本未含其后续提交——交付材料须如实标注** |
| inkstone-re-lab | 协议仓 | `c3e104c` | 远端 `re/windows-desktop-027` 已推送至 `decc62d`；`fb014b3`/`c3e104c` 待推送 |

## 2. 交付物与验证证据（已实现 / 已验证）

| 项 | 内容 | 证据（命令 → 真实结果） |
|---|---|---|
| Atria 连接器 | `mathagent/atria_client.py`（AtriaDawnClient + InkstoneDesktopBridgeClient） | `pytest tests/test_atria_client.py` → 26/26 通过（离线桩） |
| 真实 Atria 调用 | discovery-api 端点双模式冒烟 | `docs/atria-smoke-log.md`：usage 服务端非零（off 26/51/77、hybrid 26/55/81、选票关 57/35/92、推导关 46/1071/1117、solver 通道两组）；**实测现象：`reasoning:false` 不物理切断思维链（仍返回 reasoning_content ≈19 tokens）** |
| 桥接器 | inkstone `src/desktop/atria-bridge-runner.mjs` | `node --test tests/desktop/atria-bridge-runner.test.mjs` → 7/7（stub fetch，离线） |
| K13 恢复三矩阵 | T25 断线重连 / T21 429 节流 / 409 冲突恢复 | `node --test tests/desktop/` → 11/11；协议日志 4 份落盘 `var/astra/protocol/sess_k13_*.jsonl` |
| 通用内核 | `packages/agent-kernel`（ledger/workunit-store/candidate-gate/generic-loop） | 22/22 node 测试（含 I01-I15 不变量、math-parity 生产入口级对照 5/5） |
| 领域包 | domain-math / control / scientific_computing / data_analysis 四域注册 | `GET /api/v2/domains` 返回四域真实注册表；生产 bundle 含 domain-control×6 / domain-data-analysis×6 / domain-scientific-computing×6（grep 计数） |
| control 辨识 | 阻尼振子参数辨识四不妥协（训练/验证隔离 T36、混叠守卫、残差白性、无硬编码） | 端到端 L2：`var/astra/runs/p0_curl_idemp_1793336256/details.json`（m=1.4915 CI[1.4912,1.4919] 等真实数值） |
| 数学等价 | 新 Kernel+Math vs 生产 bundle 四等价（投递/义务/预算/终态） | math-parity 测试内拉起真实 bundle 子进程（execFileSync），5/5 |
| data_analysis | Welch t 检验 + 三诊断（正态/白性/方差齐性） | 端到端 L2：`p1_curl_da_idemp_20261030`（t=-8.6507, df=97.067, p=1.09e-13，手算可复算） |
| scicomp 案例 B | FDM vs 解析解 + Richardson 收敛阶 + 故障注入（MISSING_BOUNDARY/CFL_VIOLATION） | `tests/domains/scientific_computing/` 6/6；端到端 `golden_scicomp_20261030`（observedOrder=1.997） |
| 测试矩阵 | T01/T06/T08/T18（域共享）+ T19/T20/T21/T25/T26/T27/T28/T30/T33/T36/T37/T38 | kernel `f12-matrix.test.mjs` 6/6 + BFF `tests/runtime_v2/` 4/4 + 各域用例 |
| 前端 | web-demo 八页（home/solve/chat/runs/batch/protocol/domains/assets/settings）+ inkstone 导航深链 | typecheck=0；vite build 485KB；check-self-ui 通过 |
| 时间胶囊 | 四域 replay-package（manifest + SHA256 + 复跑指引） | `release/replay-packages/` 4/4 导出（EXPORTED 4/4） |
| 金样例 | `samples/` 四域（真实输入/期望输出/replay_package） | `tests/test_f04_golden_samples.py` 通过（control 1001 行时序真实数据） |
| 数据版本 | T37 数据集改版→下游 STALE、历史不可变 | `tests/test_f10_literature_and_versioning.py` 通过 |
| F-02 评审修复钩子 | P4-R2 评审回归套件 | `tests/test_web_review_regressions.py` 13/16 通过（3 例 R1 为 Windows /proc 平台差异，见 §4） |
| F-03 资产参数化 | 数学资产目录运行时视图同步 | `python scripts/build_math_assets.py --check` → OK byte-identical |
| F-06 T34 配额 | 并发上限原子语义：MAX_CONCURRENT_RUNS=1，超额排队不并发派发 | `tests/runtime_v2/test_f06_quota.py` 2/2 通过 |

## 3. 建设中（如实标注，不冒充完成）

| 项 | 现状 | 边界说明 |
|---|---|---|
| Inkstone 为唯一主工作台 | **导航级合体**（aiyan-ui 导航 → 8011 深链） | UI 级合体（数学页组件化迁入 Inkstone 单文件应用）未做，属方案 §22 16-24 周全量范围 |
| 科研链路 K16/K17 | Semantic Scholar 探测返回 **429 公网频控**（`docs/literature-versioning-report.md` 留档）；T37 数据版本已验证 | 文献检索真实接入未验证；PDF 解析未做 |
| 生信/地学领域包 | 不交付 | 接口可复制性已由案例 D（零核心改动接入）证明；专业包建设中超方案周期 |
| 部署形态 | 本地工作站形态可一键演示（`scripts/start_demo.bat/.py`） | 课题组服务器/机构环境形态未验收 |
| A/B 对照 | 底座已确认：`Intern-S2-Preview-397B` 已于 **2026-10-22 下线**（HTTP 404 model_disabled），改用 `intern-s2`（实测 200，1.8s） | 同题集真实对照跑批待完成 |

## 4. 已知环境性失败基线（非代码回归，评审环境不复现）

| 现象 | 根因 | 影响面 |
|---|---|---|
| `test_web_bff.py` 9 failed | 开发沙箱拦截 asyncio/TestClient loopback socketpair（WinError 10051） | 仅本机沙箱；正常环境退出码 0（施工方环境已验证） |
| `test_web_review_regressions.py` R1 进程身份 3 例 failed | **Windows 无 /proc**：`_read_process_identity` 的 boot_id/start_ticks 恒 None（queue.py:55-85），Linux 专属断言不成立；基线 commit `8330252` 复跑同样 3 failed，非回归 | 仅 Windows 开发机；Linux/CI 通过 |
| vite build 偶发失败 | esbuild 子进程 TEMP 写入被拦 | `TEMP=<repo>/.tmp` 重定向后通过 |
| pnpm install 失败 | 沙箱禁 D 盘根建 store | `--store-dir <repo>/.pnpm-store` 绕过 |
| Semantic Scholar 429 | 公网免费 IP 频控 | 协议层就绪，真实检索待申请 API key |

## 5. 测试计数真实来源（防止文档漂移）

| 计数 | 来源命令 | 最近验证时间 |
|---|---|---|
| kernel 22/22 | `node --test "packages/agent-kernel/tests/*.test.mjs"` | 2026-10-30 |
| domains 21/21 | `node --test "tests/domains/*/*.test.mjs"`（control 7 + data_analysis 8 + scicomp 6） | 2026-10-30 |
| atria_client 26/26 | `python -m pytest tests/test_atria_client.py -q` | 2026-10-28 |
| BFF F-12 4/4 | `python -m pytest tests/runtime_v2/test_f12_bff_matrix.py -q` | 2026-10-30 |
| inkstone bridge 7/7 + K13 11/11 | `node --test tests/desktop/` | 2026-10-30 |
| BUILD_MANIFEST | `python scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json` → VERIFY_OK | 2026-10-30（c47203d） |
