# 全套架构能力实际调用：修复与验收记录（2026-10-27）

> 依据：`docs/ARCHITECTURE_CAPABILITY_RUN_AUDIT_20261027.md` 与
> `/home/ma-user/work/input/最终架构_最新实装版_20261027.md`。
>
> 本记录只说明“能力是否被真实派发、计数是否可核对”，不说明数学答案正确，
> 也不把 `candidate` 交付提升为 `candidate_verified` 或严格验收。

## 1. 这轮修复的十一个真实断点

### 1.1 R0 在真实评测 profile 下必被静默跳过

`packages/math-review/src/p4-r0-input.ts` 与 `p4-r0-recheck-input.ts` 把
`remainingMs` 上限固定为 `5000`。评测 profile 的单题预算是 `1800s`，所以
`P4R0ReviewSession` 的构造在第一个角色调用之前就抛 `PACKET_BINDING`；
`runBoundedR0` 捕获后回退到 WORK，trace 中自然只剩 `R0=0`。

同时 `prepareP4R0` 在没有 `riskCodes` 时返回 `SKIPPED_BY_POLICY`。VALUE /
PARAMETER 等模板本来就没有内建风险码，因此即使 `maxR0=1` 也不会进入 R0。

修复：

- `P4R0Options` 增加显式 `force`；`maxR0=1` 时由 Node 传入 `force: true`，
  没有内建风险码时补 `EXPLICIT_RISK_HINT`，不改变 R0 的固定五调用上限。
- R0 review/recheck 的输入上限统一到 `3_600_000ms`，与根会话截止时间一致。
- R0 回退现在写入 `R0_REVIEW role=STAGE` 的固定原因行，不再静默消失。

### 1.2 G2 只有模型主动给 `NEW_ROUTE` 才可能发生

原 Host 的 `check_route_provenance` 只接受 v2 WorkPacket 中的模型
`workflowProposal`。因此即使 Node 有 G2 代码，真实运行没有模型提案时也永远
是 `REJECT` 或根本不进入分支。

修复：

- 新增控制侧 `admitControlSecondRoute`：从真实 ACTIVE 产物、真实 OPEN
  obligation 和固定机制
  (`independent-recomputation / second-derivation /
  empty-dependency-independent-route`) 追加一条空依赖的第二路线。
- 新增独立字段 `controlRouteProvenance`，与模型 `routeProvenance` 互斥；
  Node 和 Python Host 都独立校验固定机制、route signature、来源产物、
  obligation、scope、空依赖和 `route-task-<sourceRequestId>` 身份。
- `PROVENANCE_ORDINAL` 从只允许 `model-1..3` 改为 `model-1..256`；此前
  在长对话后段生成的第二路线会被该正则直接拒绝。
- `g2_route_attempts / admitted / rejected / picks / context_rejected /
  workunits / candidates / agreements` 进入公开 `metrics`。
- 路线任务结果被记录为 `G2_ROUTE_RESULT`，只比较候选是否出现、是否与受保护
  候选一致，不把路线一致当作证明。

### 1.3 R2 Challenge 存在，但没有 checker 就永远进不了 REPAIR

原 `attemptRevision` 在没有 `PROGRAM_OBSERVATION` checker 时直接返回，导致
`REPAIR=0`、`R4=0`。这与架构文档的
“R2 Challenge → REPAIR → R4”不一致。

修复：

- 在显式 full-capability profile 下，有具体 R2 challenge 即派发一次有界
  `REPAIR`；没有真实 checker/basis 时仍派发 `R4` 复核，但最终
  `reviseCandidate` 必然 fail-closed：不替换父候选，记录
  `REVISE_REJECTED` 与 `basis=MISSING_GROUNDED_BASIS`。
- full profile 不再因为此前发生过一次 schema 修复就拒绝 evidence REPAIR；
  schema 修复是 WORK 形状修复，不占用 `maxRepairs` 的候选修复额度。
- REPAIR 的 system prompt 补齐 `p2a-work-v1` 的精确字段、绑定值和
  `candidateProposal` 字符串约束，避免真实模型返回散文/错误 schema 后
  直接 `CONTROL_REJECTED`。
- 默认/非 full profile 保持原来的严格门槛，不因为本修复放宽有据修复。
- `r2_review_calls / repair_model_calls / repair_decisions / repair_accepted /
  repair_rejected / r4_review_calls` 进入公开 `metrics`。

### 1.4 方法目录注入晚于 R0

Host 在方法能力开启时要求第一个模型调用前完成 `method.catalog`。原 Node
先跑 R0、后读 catalog，因此 `maxR0=1 + maxMethodLoads>0` 的 full profile
会在第一帧 R0 被 Host 拒绝（`agent_host.py` 的 catalog 前置检查）。

修复：把只读 catalog 注入移到 R0 之前；R0 仍使用同一根预算，catalog 不产生
数学证据。

### 1.5 帧上限 64 不足以承载 full profile

一次 full profile 的模型调用、catalog、effect、R0、G2、R2 各占两帧；真实
100 题复跑已出现 `FRAME_LIMIT_EXCEEDED`（第 11 项在 65 帧处失败）。
活动协议（p0/p1/p2/p3、v1.3、v1.4）的 `maxFramesPerSession` 提升到 1024。
冻结的 v1.2 只读 manifest 仍保持其被 pin 的 64 帧值；旧版校验器单独接受
该值，活动 Host 不接受旧 manifest。

### 1.6 WORK 恢复被记成 CONSENSUS，耗掉 Host 的最后一个 ballot 槽

真实 100 题里 `11`、`34` 再次以 `BUDGET` 结束。复跑调用序列显示：

```text
3 × R0
4–9 × WORK（其中 6 是一次 same-task recovery）
10–14 × INDEPENDENT（5）
15–16 × AUDIT（2）
17 × CERTIFICATE  → Host agent_host.py:1020 拒绝
```

即恢复调用使用 `phase=CONSENSUS`，占用了 8 个 consensus 槽中的一个，
后面的 5+2+1 实际变成 1+5+2+1=9，Host 在 certificate 前 fail-closed。
修复：

- 该调用是对同一未交付 WORK 任务的重解，不是独立 ballot；改为
  `phase="WORK"`；
- 删除仅在本地 iteration 内有效的 `recoveryUsed` 跳过条件，使 5+2+1
  仍能完整执行；
- 新增 Node 测试
  `a bounded WORK recovery does not consume a consensus slot`，验证恢复后
  consensus 请求恰好为 8 个，stage 为 5 INDEPENDENT + 2 AUDIT + 1 CERTIFICATE。

### 1.7 畸形 REPAIR 包被误报为 CONTROL_REJECTED

`attemptRevision` 的 `catch` 把“维修子包不可解析”的 `P2Error` 统一写成
`CONTROL_REJECTED`。父候选仍由 candidate gate 保护并交付，但公开
`stopReason=CONTROL_REJECTED` 不在 Web `StopReason` 枚举中，BFF 会把
candidate 误归为 error。

修复：该分支改为 `REVISE_REJECTED`，即“修复未通过、保留父候选”的语义；
新增 `test_malformed_repair_packet_keeps_the_parent_candidate`，验证：
candidate 保留、`stopReason=REVISE_REJECTED`、`repair_packet_rejected=1`、
`repair_accepted=0`。

### 1.8 六个原未交付题的修复后定向复跑

用同一输入、同一 full profile、同一 Intern-S2 重新跑原 100 题中 6 个未交付题：

| 题 | 修复后状态 | stopReason | 关键能力 |
|---:|---|---|---|
| 2 | candidate | REVIEWS_COMPLETE | R0 3、5+2+1、G2 pick/work |
| 3 | candidate | REVIEWS_COMPLETE | R0 3、5+2+1、G2 pick/work |
| 11 | candidate | REVIEW_STOP | R0 3、5+2+1、G2 admit |
| 15 | candidate | REVISE_REJECTED | R0 3、5+2+1、R2→REPAIR→R4、G2 pick/work |
| 34 | candidate | REVIEW_STOP | R0 3、5+2+1、G2 admit |
| 61 | candidate | REVIEWS_COMPLETE | R0 3、5+2+1、G2 pick/work |

六个都到达 `candidate`，且都满足 5 INDEPENDENT + 2 AUDIT + 1 CERTIFICATE；
`15` 也真实进入 R2→REPAIR→R4（REPAIR 拒绝、父候选保留）。这不是把原
100 题 run 改写成 100/100：原 run 仍是 94/100，这 6 次是修复后的独立
定向复跑。

证据目录：
`/home/ma-user/work/astra-evidence-targeted6-postfix-20261027/`

说明：题 `2` 的定向复跑发生在 1.7 的停止码修复之前；该题没有进入
REPAIR 分支，后续修复不影响它的路径。其余五题使用最终 bundle。

### 1.9 每一题强制启动 REPAIR/R4 的 capability probe

真实 R2 可能返回 `NO_ISSUE`；这时按架构语义不能伪造数学 challenge，
REPAIR/R4 就不会发生。为满足“每一题启动每一处架构能力”，在 full-capability
profile 下增加一个 **control-owned capability probe**：

- 仅当真实 R2 没有任何 challenge、且 `repairCalls=0` 时触发；
- 用真实 `attemptRevision` 路径派发一次 REPAIR，再派发一次 R4；
- probe challenge 明确标注 `CAPABILITY_PROBE`，不是数学发现；
- 父候选始终受 `P4CandidateGate` 保护，probe 不得替换父候选，也不得产生
  revision basis；
- probe 的 REPAIR/R4 结果写入 SessionLog，并进入独立
  `capability_probe_calls/accepted` 指标；真实 R2 challenge 的 REPAIR/R4
  仍按原语义计数，二者不混写。

如果 probe 的 REPAIR 包本身不可解析，probe 仍会显式补发一次 R4，保证 R4
不会因为维修包格式失败而缺失。

因此每个 full-profile candidate 现在都会实际启动：

```text
R0 3 roles + aggregate
G2 control second route
5 independent + 2 audit + 1 certificate
deterministic closure
R2 review
REPAIR + R4 (real challenge or labelled capability probe)
M5 candidate gate
```

probe 是“能力启动证据”，不是“有据修复证据”；报告和指标必须同时保留这两层
含义。

### 1.10 BFF 缺少 `REVIEW_STOP` 映射，候选会被误判为 error

真实 BFF probe run 出现 `final_response="(A)"` 但 `status=error`。原因是
AgentLoop 在 review 报告无效/中止时可以保留受保护候选并以 `REVIEW_STOP`
收口，而 Web `StopReason` 枚举没有这个值，`ExecutionManager` 回落到
`ERROR`。

修复：

- `python/astra_web/contracts/enums.py` 增加 `REVIEW_STOP`；
- `mapping.py` 将其映射为 `StatusCode.CANDIDATE` 和中文标签；
- 回归测试断言 `classify_stop_reason(REVIEW_STOP) == candidate`，
  `classify_terminal_kind(REVIEW_STOP) is None`。

### 1.11 BFF 之前把 `max_method_loads` 固定为 0

Web 层原来只允许方法卡额度 0，因此即使 AgentLoop 支持方法卡，经过 BFF
的真实运行也无法启动方法 effect。现在：

- `RunRequestDto.max_method_loads` 允许 `0..4`；
- `/api/capabilities.max_method_loads_allowed = [0,1,2,3,4]`；
- Web 驾驶舱增加方法卡额度选择，并把它纳入幂等键；
- BFF live run 使用 `max_method_loads=1` 时实际出现
  `method_effect_calls=1`、`method_ids=["algebraic-structures"]`、asset calls 2。

### 1.12 预算边界：不因小预算跳过，但不是无界资源

full-profile 使用协议允许的最大有限包络：
`maxModelCalls=256, maxWorkUnits=64, maxEffects=2, maxReviews=3,
maxMethodLoads=4, maxRepairs=3, maxConsensus=8, maxR0=1, problem_seconds=3600`。
所有能力分支都按这个包络进入，不再因为 8/24 次调试预算而提前停止。

仍保留有限的协议、子进程、deadline 和工具边界：这是仓库 `AGENTS.md` 和
Host 的 fail-closed 约束，不能把“无限”解释成主机上的无界执行。若未来需要
真正无界资源，必须另立协议/安全设计；本轮没有这样做。

## 2. 公开可核对指标

每次 `solve` 的 `metrics` 新增以下字段（全部来自真实 SessionLog / Host
计数，不从配置或模型文本推断）：

```text
capability_profile
r0_model_calls
r0_role_reviews
r0_aggregates
r0_recheck_calls
r0_plan_revisions
consensus_independent_calls / consensus_independent_ballots
consensus_audit_calls / consensus_audit_ballots
consensus_certificate_calls / consensus_certificate_ballots
consensus_closure_calls
r2_review_calls / r2_review_records / r2_challenges
r4_review_calls / r4_challenges
repair_model_calls / repair_packet_rejected
repair_decisions / repair_accepted / repair_rejected
capability_probe_calls / capability_probe_accepted
g2_route_attempts / g2_routes_admitted / g2_routes_rejected
g2_route_picks / g2_route_workunits
g2_route_candidates / g2_route_agreements
```

原有 `tool_effect_calls`、`method_effect_calls`、`tool_names`、`method_ids`、
`closure_evaluations`、`closure_defects`、`catalog_calls`、`asset_calls`、
`front_budget/tail_reserve/front_spent` 继续保留。

`capability_profile=FULL` 的判定是显式组合：

```text
maxR0 >= 1
maxRepairs >= 1
maxReviews >= 2
maxConsensus >= 2
```

它只表示这些能力被授权并进入 full 代码路径，不表示每一题都会触发每一个
条件分支。

## 3. 验收证据

### 3.1 组合 full-capability E2E

`tests/e2e/test_ts_full_capability.py` 使用真实 `ReasoningAgent` / Python Host /
Node `--agent-loop` 子进程，仅替换公共 client：

1. `test_full_profile_dispatches_r0_g2_consensus_r2`
   - R0：3 个独立角色 + 1 个聚合；
   - G2：1 次 admit、1 次 pick、1 个 route WORKUNIT、1 个 route candidate；
   - CONSENSUS：5 independent + 2 audit + 1 certificate；
   - R2：1 次真实评审；
   - R2 无 challenge 时：1 次 control-owned capability probe 的 REPAIR+R4，
     父候选保持保护，`capability_probe_calls=1`。
2. `test_full_profile_dispatches_r2_repair_r4_fail_closed`
   - R2 提出具体 challenge；
   - REPAIR 真实派发 1 次；
   - R4 真实复核 1 次；
   - 无 grounded basis，父候选保留，`stopReason=REVISE_REJECTED`。
3. `test_malformed_repair_packet_keeps_the_parent_candidate`
   - REPAIR 返回不可解析包；
   - 父候选保留，`stopReason=REVISE_REJECTED`，`repair_packet_rejected=1`。

### 3.2 定向回归

- `tests/e2e/test_ts_g3_r0.py`：保留三角色、修订、复核测试；新增 VALUE
  模板 + 10 秒真实剩余时间的 `maxR0=1` 强制测试。
- `tests/e2e/test_ts_workflow.py`：模型 `NEW_ROUTE` 第二路线仍通过。
- `tests/e2e/test_ts_g3_multi_round.py`：有 checker 的 REPAIR 接受路径仍通过。
- `tests/bridge/test_p3_host_effect_budget.py`：新增 capability metrics 纯函数
  用例，验证“计数只来自真实调用行”。

### 3.3 构建门禁

```text
node node_modules/typescript/bin/tsc -b
npm run test:ts                    # 565/565
node node_modules/esbuild/bin/esbuild apps/stdio-runtime/dist/src/main.js \
  --bundle --platform=node --format=esm \
  --outfile=release/stdio-runtime.bundle.mjs --log-level=warning
python scripts/build_release_manifest.py
python scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json
python packages/protocol/scripts/build_agent_host_v14_schema.py --check
python -m pytest -q                # 1573 passed, 24 skipped
python -m pytest -q <web/bff 聚焦集>  # 72 passed
cd apps/web-demo && npm run typecheck && npm run build
```

上述原始日志和校验和保存在
`/home/ma-user/work/astra-evidence-gates-20261027/`；另有 M5 gate / REPAIR /
closure 三个 Node 测试文件的 35 个通过记录。

### 3.4 100 题逐题能力接线扫描

为了验证“每一题都启动每一处架构能力”，用真实的 `ReasoningAgent` +
Python Host + Node `--agent-loop` 对同一份 100 题输入逐题运行；只把公共
client 替换为脚本化测试 client（不是实时模型答案）。结果：

```text
100 / 100 items: all capability checks true
elapsed: 166 seconds
```

每题断言：

```text
candidate
R0 role reviews = 3, aggregate = 1
consensus independent/audit/certificate = 5/2/1
closure evaluation >= 1
R2 review = 1
REPAIR model calls >= 1
R4 review calls >= 1
G2 admitted/picked/workunit >= 1
capability probe or real challenge repair present
```

证据：
`/home/ma-user/work/astra-evidence-capability-sweep100-20261027/`

这证明的是**能力接线/激活覆盖**，不是 100 道题的数学正确性。实时模型证据
仍是原 100 题 run、6 题定向复跑和 BFF live run。

### 3.5 100 题 BFF/HTTP/SSE 能力扫描

用真实 BFF 进程、真实 HTTP `POST /api/runs`、真实执行队列、真实 Python
Host、真实 Node AgentLoop 和真实 L2 replay/SSE，对同一份 100 题输入逐题
调用；公共 client 用脚本化测试 client。结果：

```text
100 / 100 candidate
100 / 100 all checks true
R0 100/100, 5+2+1 100/100, closure 100/100, R2 100/100
REPAIR/R4 100/100, G2 admit/pick/workunit 100/100
method effect 100/100, capability probe 100/100
```

证据：
`/home/ma-user/work/astra-evidence-bff100-synthetic-20261027/`

这是 BFF/Web 层逐题接线证据；client 是脚本化的，不是 100 题实时模型答案。
实时 BFF 单题证据仍是
`astra-evidence-bff-live-finalall-20261027/`。

另外，尝试过用 10/6 个 BFF 进程并发跑 100 题实时模型批次；首批请求在
provider 侧返回 `UNKNOWN`（共享 API 并发限制），该批次不作为证据，已停止。

随后做了 2 个 BFF 进程的对照：两个运行都只发出 1 个 R0 请求就
`transportStatus=UNKNOWN`、`remote_outcome_unknown=true`；单个 BFF 进程则
可以跑完整 22 次调用并 candidate。结论是本 key 的 BFF 并发实际为 1，
100 题实时 BFF 只能串行，约需数小时；本轮没有把它伪装成已完成。对照证据：
`/home/ma-user/work/astra-evidence-bff-concurrency-blocker-20261027/`。

## 4. 尚未由“离线组合测试”证明的东西

- 不是所有 100 题都会产生 R2 challenge，因此 REPAIR/R4 的真实触发率仍需
  全量 run 的 `repair_model_calls / r4_review_calls` 统计。
- 控制侧 G2 固定机制路线是“真实第二推导”，但不是模型自主提出的
  `NEW_ROUTE`；模型提出路径仍由原 `check_route_provenance` 单独验证。
- 本记录不改变 `candidate_verified=false`、`strictAcceptance=NOT_PERFORMED`、
  `targetEnvironment=TARGET_UNVERIFIED` 的诚实边界。
- 100 题 runner 直接调用官方 emulator，不经过 BFF/SSE/React 或崩溃恢复；
  这些层由第 6 节的独立 BFF live run、真实进程强杀重启和 Web/recovery
  聚焦测试证明，不能把 100 题记录说成跨层验收。

## 5. 2026-10-27 最终 100 题真实模型复跑

运行目录（非正式官方成绩）：

```text
/tmp/astra-fullcap100-final3-20261027/
持久化副本: /home/ma-user/work/astra-evidence-fullcap100-final3-20261027/
input: /tmp/astra-rerun-ab-10000-20261021-TrfJBe/input.test0.jsonl
input sha256: d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c
client: Intern-S2, full profile (maxR0=1, maxRepairs=2, maxReviews=2,
        maxConsensus=8, maxMethodLoads=1, maxEffects=2, maxWorkUnits=64,
        maxModelCalls=256, problem_seconds=1800)
```

持久化副本中的 `outputs/run_summary.json`、`judgements/summary.json`、
`cap-summary.txt`、复跑脚本和 client factory 均有 `SHA256SUMS.txt` 可核对；
`EVIDENCE.md` 记录运行身份、计数和边界。API key 不在证据目录或仓库中。

emulator 汇总：

| 指标 | 数值 |
|---|---:|
| 题数 | 100 |
| `runner_status` | `completed` |
| childReaped | **100 / 100** |
| logical requests | **2,015** |
| total tokens | **14,731,361** |
| retry / truncated | 0 / 0 |
| 候选交付 | **94 / 100** |
| 未交付 | 6（2 `BUDGET`, 4 `FIELD_VALUE`） |

真实能力计数（来自 94 份有候选的逐题 `metrics`，不是配置推断）。6 个
未交付题在 `session.solve` 失败时返回体不含完整 `sessionLog`，因此下表是
**可核对的下界**，不是把失败题的内部行估算进来：

| 能力 | 实际计数 |
|---|---:|
| R0 三角色审查 | **282 次 = 94 题 × 3** |
| R0 聚合 | 94 |
| R0 plan revision / target recheck | 0 / 0（本批 R0 全为 NO_ISSUE） |
| 5 独立 ballot | **470 次调用 / 460 个有效候选 ballot** |
| 2 锚定 audit | **188 次调用 / 186 个有效候选** |
| 1 certificate | **94 次调用 / 92 个有效候选** |
| answer closure | 94 |
| R2 评审 | **94 次，33 个 challenge，覆盖 16 题** |
| REPAIR | **16 次真实调用** |
| R4 复核 | **16 次真实调用** |
| REPAIR accepted / rejected | 0 / **16**（本批均无 grounded checker basis，父候选保留） |
| G2 route admitted / picked / workunit | **94 / 94 / 94** |
| G2 route candidate / agreement | 94 / 87 |
| 方法卡 effect | 100 |
| 确定性 tool/asset effect | 46 次，覆盖 31 题 |
| asset catalog 注入 | 100 |
| closure defects | 6 题各 1 次 |

6 个未交付题的边界：

- `11`, `34`：`BUDGET` at `session.solve`，出现在多次共识/恢复路径的 Host 配额交叉处；
- `2`, `3`, `15`, `61`：`FIELD_VALUE` at `session.solve`；其中 `15` 的 Host
  guard 明确是“已 yield 的 task 被再次调度”，其余是既有边界，尚未归因为
  本轮能力接线；
- 这些不属于“能力未调用”：其已发生的模型/效果调用仍计入 Host 用量，且
  `childReaped` 仍为 100/100。

本地 emulator 的 reference judge 只用于粗回归，不是官方语义成绩：

```text
reference judge: 26/100 correct, 74 incorrect, 0 invalid
```

该数字不可与审计中的 78/100 语义复核或正式平台成绩混用。

## 6. BFF/Web 与 crash-recovery 独立实测

### 6.1 真实 BFF + Intern-S2 全程

用一个真实 `uvicorn` BFF 进程、真实 Python Host/Node `--agent-loop` 子进程、
真实 Intern-S2 endpoint 和 item 0 题面完成一次 HTTP 运行；只注入公共
client connector。

```text
runId: bff-live-fullcap-finalall-20261027-item0
result: candidate / REVIEWS_COMPLETE / final_response=A
candidate_verified=false, executed=true, childReaped=true, detail_level=L2
logical_model_calls=22
R0: 3 role reviews + 1 aggregate
consensus: 5 independent + 2 audit + 1 certificate + 1 closure
R2: 1 review
REPAIR/R4: 1/1 (labelled capability probe, parent preserved)
G2: 1 admit / 1 pick / 1 workunit / 1 candidate / 1 agreement
method effect: 1 (algebraic-structures); asset calls: 2
closure_evaluations=1, closure_defects=0
```

通过 HTTP 观察到的链路：

- `/api/runs` 返回 201 并启动运行；
- `/api/runs/{id}/events` 实际推送 47 个 SSE 帧：22 `model_dispatched`、
  22 `model_returned`、1 `effect_returned`、1 `RESULT`、1 `close`；
- `/api/runs/{id}` 返回同一份 `summary.metrics`（因此能力计数在 Web API 可观测）；
- run trace 包含 3 `R0`、8 `CONSENSUS`、1 `R2`、1 `REPAIR`、1 `R4`、
  WORK/G2 阶段与 22 个模型 `COMPLETE` 返回、1 个 effect `COMPLETE`；
- `/api/replays/{id}` 返回 46 条落盘事件，`detail_level=L2`；
- `/api/math-assets` 返回 26 个资产 / 82 个 behavior；
- `/`、`/assets/index-*.js`（445,008 bytes）、CSS 和 SPA fallback 均由 BFF
  静态挂载成功返回；
- 同 idempotency key 再次 POST 返回 HTTP 200、`started=false`、
  `idempotent_replay=true`，模型调用不增加；
- SSE `after=44` 重连只补发 id 45/46 并发送 `close`，没有重算。

证据目录：

```text
/home/ma-user/work/astra-evidence-bff-live-finalall-20261027/
```

### 6.2 真实进程崩溃与重启恢复

BFF 接受一次运行并落盘 `model_dispatched` 后，用 SIGKILL 杀掉整个进程组；
随后用同一 data root 启动第二个 BFF 进程，由启动恢复逻辑收口：

```text
before kill: running
after restart: error / TRANSPORT_STOP / HOST_RESTARTED / system_failure
executed=false, candidate_verified=false, remote_outcome_unknown=true
recovered_runs=1
SSE after restart: RESULT + close
replay: 3 persisted events
```

该 probe 使用了故意阻塞的 crash solver，验证的是 BFF 所有权、事件落盘、
重启恢复和诚实终态，不是模型行为。证据目录：

```text
/home/ma-user/work/astra-evidence-bff-crash-20261027/
```

### 6.3 聚焦门禁

```text
BFF/Web/recovery 7 个测试文件     72 passed
M5 gate + REPAIR + closure 3 个 Node 测试文件  35 passed
```

BFF/Web 证据的边界：

- 这是一次本地 BFF live run，不是官方成绩；当前 Web DTO 已允许
  `max_method_loads=0..4`，本轮 live run 使用 1，并实际出现
  `method_effect_calls=1`；
- 没有浏览器自动化；已实际验证 BFF HTTP API、SSE、replay、资产目录和构建后
  UI 静态资源，不能把它说成浏览器端到端点击测试；
- `candidate_verified` 仍为 false，candidate 不等于数学正确。

## 7. 当前结论

- 这轮实跑第一次同时出现：R0 三角色、G2 第二路线、5+2+1 consensus、
  closure、R2 challenge、REPAIR、R4、工具/方法 effect。
- R4 在本批 16 次真实触发，均因缺少 grounded checker basis 而 fail-closed；
  有 checker 的 REPAIR 接受路径由离线
  `test_ts_g3_multi_round.py` 覆盖，不冒充真实 run。
- M5 candidate gate 是主 AgentLoop 的终态裁决出口：100 题 94 个 candidate 和本轮
  BFF live run 的 candidate 都经过 `P4CandidateGate.finalize`；35 个
  M5/REPAIR/closure 聚焦 Node 测试覆盖“保护首候选、不替换、STRICT 不升级”。
- BFF/Web 层已用真实 HTTP+SSE 运行验证；Web 全能力配置已允许方法卡，
  BFF live run 实际出现 `method_effect_calls=1`；崩溃恢复已用真实进程
  SIGKILL + 重启验证，均不再只是“代码存在/单测通过”。
- full-profile 在 R2 无真实 challenge 时使用明确标注的 capability probe
  启动 REPAIR/R4；probe 不替换父候选，不作为有据修复证据。
- 100 题逐题接线扫描（真实 Host/Node + 脚本化 client）为 **100/100**
  全部能力检查通过；这证明每一题会进入各分支，但不是实时模型答案。
- 100 题 BFF/HTTP/SSE 扫描（真实 BFF + Host/Node + 脚本化 client）也是
  **100/100 candidate / 100/100 all checks**，包括方法 effect、REPAIR/R4、
  G2、R0、5+2+1 和 closure；实时 BFF 单题证据另列，不能把脚本化扫描写成
  100 题实时模型成绩。
- 原 100 题 run 的 6 个未交付题在修复后定向复跑中全部到达 candidate：
  `2/3/11/15/34/61`，均出现 R0 三角色与 5+2+1 consensus；`15` 还真实走到
  R2→REPAIR→R4。原 100 题记录仍保持 94/100，不追写成 100/100。
- 后续还修复了：WORK 恢复不再占用 consensus ballot 槽（11/34 的 BUDGET
  根因）、畸形 REPAIR 包返回 `REVISE_REJECTED`、BFF 补上 `REVIEW_STOP`
  候选映射、Web 允许方法卡额度，并加入逐题 capability probe。
