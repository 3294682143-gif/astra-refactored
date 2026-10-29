# CONTROL_REJECTED / BUDGET 全量修复记录（2026-10-26）

## 1. 基线与目标

- 起点：`feat/web-unified-math-integration` 的 `3b123a6`，§25 的真实 100 题结果
  为 **70/100 候选**、22 题 `CONTROL_REJECTED`、8 题 `ERROR`。
- 本轮目标：消除控制层误杀、统一数学资产失败反馈、修正 effect 配额和路由状态生命周期，
  再用同一输入、同一 emulator、同一真实 Intern-S2 客户端复跑。
- 真实模型输入仍是 `/home/ma-user/work/input/test0.txt`（sha256
  `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`）。
- 22 题定向子集：原 0-based 下标
  `[1,3,4,6,9,10,11,12,15,18,19,20,22,23,25,26,32,39,41,42,49,56]`，
  文件 `/tmp/astra-control22-20261026.jsonl`（sha256
  `4a1b5332dfb02a329434a2f45e305421de503da7cd2a1909b205e0099c6d0a2f`）。

## 2. 本轮修复（代码）

| # | 缺陷 | 修复 | 回归 |
|---|---|---|---|
| F1 | `P3EffectGate` 的 effect ordinal 与 math-asset 直接 reserve 不一致；method/tool 在 asset 后拿到已花掉的 effect-id，硬停 `CONTROL_REJECTED` | `df98cb2`：`nextEffectOrdinal` 重定基、拒绝派发时 `rollbackAdmitted`、Host/Node 权威失败回执 | `apps/stdio-runtime/tests/agent-effect-ordinal.test.ts` |
| F2 | Host `on_math_asset` 用 `effect_calls >= max_effects` 判断总容量；一个 method + 一个 asset 后，第二个 asset 被误判 `BUDGET` | 改为 `_effect_admission("tool")`：共享 id 容量 + tool 子配额分开 | `tests/bridge/test_p3_host_effect_budget.py`、`tests/e2e/test_ts_methods.py::test_method_asset_and_tool_fit_the_three_shared_effect_slots` |
| F3 | `forcedMathAssetSelection` 在 math-asset 执行后没有清除，后续轮次继续伪造 `MATH ASSET TURN`，耗尽额度后硬停 | 在解析到 `math_asset` 动作或模型拒绝该强制轮后立即清除 forced 状态 | `tests/e2e/test_ts_forced_protocol.py::test_forced_math_asset_turn_is_cleared_after_one_execution` |
| F4 | 强制 method 选择把任何 `action == "method"` 都当作服从，未知 id 随后在 catalog guard 中硬停 | obedience 现在要求 id 属于真实 `methodCatalog`；失败走一次重试，再走一次最终 WorkPacket 轮 | `tests/e2e/test_ts_forced_protocol.py::test_unknown_forced_method_id_fails_open_to_a_candidate` |
| F5 | 语义 route 的 attempt 标志原先每个 work unit 重置，同一 problem 级 route 被反复强制 | attempt 标志改为 run-scoped；observations 仍保持 task-local | `test_persistent_exact_check_refusal_stops_after_one_retry` 断言 `routed == 1` |
| F6 | Host 权威失败回执缺少 `inputContract`；Node 虽有 fallback，但总是优先 Host 回执，模型仍看不到 required/optional 参数 | Host 从 `MATH_ASSET_BY_ID` 生成同一 `inputContract`，保持权威回执可用 | `tests/e2e/test_ts_math_asset_failure.py` |
| P1 | 开发入口 `ASTRA_STDIO_RUNTIME=dev` 无法解析 v1.4 schema，回退 v1.3 后 `runtime.initialize` EOF | `packages/protocol/package.json` 导出 v1.4 schema；`agent-host-main.ts` 只允许 v1.4，缺失时 fail-closed | `tests/release/test_release_manifest.py`、`tests/release/test_release_bundle.py` |
| P2 | 发布 manifest 把 v1.3 作为 primary schema，且未跟踪动态导入的 `agent-host-main.js` | primary 改为 v1.4，v1.3/v1.2 显式标记 legacy；manifest 校验 schema 文件真实 `protocolVersion` 并跟踪 `agent-host-main.js` | `tests/release/test_release_manifest.py` |
| P3 | wheel 内缺少 1.2 legacy schema；`math-assets.schema.json` 未从包导出 | `release/schema/agent-host.schema.json` 随包发布；补 `math-assets` export | `tests/release/test_release_manifest.py` |

## 3. 离线门禁（本轮实测）

- `tsc -b`：0 errors
- Node protocol + stdio-runtime：**543/543 passed**
- Python 全量：**1561 passed, 24 skipped, 0 failed**（448s）
- `release/BUILD_MANIFEST.json`：`VERIFY_OK`（4 个 JS artifact、11 个 assets、6 个 bundle entry）
- `sync_web_release_manifest.py`：`WEB_MANIFEST_OK`
- 发布 bundle 的主动 Host profile：100/100 合成完整 WorkPacket 端到端出候选（仅离线压力探针，不是数学成绩）
- 22 题控制层离线探针：22/22 在失败回执/route 失败路径下仍能产出候选

## 4. 22 题真实模型复跑

- 证据目录：`/tmp/astra-control22-final2-20261026`
- 同一 22 题、同一 emulator、同一 factory（`real_client_factory_retry2:build_client`）、
  `item_concurrency=4`、真实 Intern-S2、`max_effects=2`、`max_method_loads=2`。
- 结果：**20/22 候选**（16 REVIEWS_COMPLETE、4 REVIEW_STOP），
  **2 题未交付**：原题 #6 `BUDGET`、#15 `FIELD_VALUE`（均为模型/配额路径的残余失败，不再是全局 22 题 CONTROL_REJECTED 潮）。
- 调用：374 次；token：3,279,716；`remote_outcome_unknown=0`、`unknown_usage_requests=0`。
- 同 22 题的独立语义复核（`/tmp/astra-control22-final2-semantic.jsonl`）：
  **15 CORRECT / 7 INCORRECT**。其中原题 #1 的参考答案本身有误（HANDOFF §10.3 已记录
  “参考 Q(5^{1/4},ζ8)/16 也不是最小分裂域”），这一题的 INCORRECT 不能直接归因于模型；
  其余 INCORRECT 包含 2 题未交付和若干真实数学错误。语义复核不是官方成绩。

## 5. 全量 100 题真实模型复跑

- 证据目录：`/tmp/astra-full100-final2-20261026`；输入为原 100 题；真实 Intern-S2；
  factory `real_client_factory_fast_20261026:build_client`（只把进程间 4s 限速改成 3s，
  profile 不变：`max_effects=2`、`max_method_loads=2`、`max_reviews=2`、
  `max_consensus=8`、`max_r0=1`、`max_model_calls=256`）。
- 机器口径：**94/100 交付候选**（88 `REVIEWS_COMPLETE`、6 `REVIEW_STOP`）；
  6 题未交付（1 超时、3 FIELD_VALUE、1 BUDGET、1 PACKET_REJECTED）。
- 1594 次调用；13,003,477 token；`retry_count=0`、`remote_outcome_unknown=0`、
  `unknown_usage_requests=0`、`runner_status=completed`。
- 本地 `ReferenceJudge`：22/100（严格格式匹配，不是数学准确率）。
- 独立语义判分：**74/100 CORRECT**（非官方；完整逐题见
  `docs/WEB_100_ITEM_SEMANTIC_REVIEW_20261026.md`）。
- 定向补跑 6 题（`/tmp/astra-fail6-final-20261026`）：4 题恢复候选、2 题仍失败；
  **并集 98/100 候选**，语义并集 **76/100 CORRECT**。这是“全量 + 失败题定向补跑”
  口径，不能把它冒充单轮盲跑。

## 6. 残余与边界

- 全量单轮仍有 6 题未交付；其中 #15 是受保护候选投影与 Host `project_artifacts`
  在 CONSENSUS 多包选择上的跨端不一致（Host 记录 `model-13` 无 artifact row），
  #48 是模型包被 `PACKET_REJECTED`，其余是固定预算/字段错误。定向补跑只恢复其中 4 题。
- #15 的根因已由诊断 factory 定位到 `agent_context._check_work` 的
  `protectedCandidate` 校验：Node 选中的 consensus 来源在 Host 投影中没有
  `bySourceRef` row；本轮没有用放宽校验的方式掩盖它。
- `candidate_verified` 仍恒为 `false`；所有 observation 仍为 provisional。
- 离线合成 100/100 只证明控制路径不自杀，不是数学正确率。
