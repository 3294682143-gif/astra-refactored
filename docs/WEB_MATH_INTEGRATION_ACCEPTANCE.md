# Web 与统一数学资产整合验收报告

- 生成时间（epoch）：`1792927717`
- Git HEAD：`35f343572afc87e3b6f15433e7b4e67f4f7c75d1`
- 工作树有未提交改动：`False`
- Python：`3.10.6`；平台：`Linux-5.10.0-182.0.0.95.r3450_282.hce2.x86_64-x86_64-with-glibc2.35`
- 规范目录：26 项资产 / 82 项行为 / 4 项仅指导
- catalogVersion：`1.0.0`
- catalogDigest：`f95ca322b2bdbe8791f3f35bd687e28a707de18f8411e819500215ca93baee9c`
- **总体判定：PASS**

| 门禁 | 状态 | 退出码 | 耗时(s) |
|---|---|---:|---:|
| `math-assets-generated-check` | PASS | 0 | 0.05 |
| `protocol-v14-check` | PASS | 0 | 0.04 |
| `release-manifest-verify` | PASS | 0 | 0.06 |
| `web-schema-check` | PASS | 0 | 0.2 |
| `web-manifest-check` | PASS | 0 | 0.04 |
| `tsc` | PASS | 0 | 0.13 |
| `node-tests` | PASS | 0 | 8.95 |
| `web-logic-tests` | PASS | 0 | 0.3 |
| `web-typecheck` | PASS | 0 | 3.18 |
| `web-build` | PASS | 0 | 3.26 |
| `browser-smoke` | PASS | 0 | 9.76 |
| `web-unit-bff` | PASS | 0 | 6.98 |
| `bff-82` | PASS | 0 | 79.9 |
| `core-82` | PASS | 0 | 80.91 |

## 命令与输出尾部

### math-assets-generated-check

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 scripts/build_math_assets.py --check`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
OK: Generated runtime views are synchronized and byte-identical.
```

### protocol-v14-check

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 packages/protocol/scripts/build_agent_host_v14_schema.py --check`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
CHECK_OK: agent-host-v14 schema matches committed files
```

### release-manifest-verify

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 scripts/build_release_manifest.py --verify release/BUILD_MANIFEST.json`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
VERIFY_OK {"js": 3, "assets": 9, "bundle": 4, "commit": "923f6191b0308c9fa92d981894e2af4bb226aee7"}
```

### web-schema-check

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 -m python.astra_web.contracts.schema_export --check --out packages/web-contract/schema`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
SCHEMA_OK /home/ma-user/work/Astra /astra-refactored-web-unified/packages/web-contract/schema
```

### web-manifest-check

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 scripts/sync_web_release_manifest.py --check`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
WEB_MANIFEST_OK /home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/public/BUILD_MANIFEST.json
```

### tsc

- 命令：`node /home/ma-user/work/Astra /astra-refactored-web-unified/node_modules/typescript/bin/tsc -b`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text

```

### node-tests

- 命令：`node --test /home/ma-user/work/Astra /astra-refactored-web-unified/packages/protocol/dist/tests/p0.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/packages/protocol/dist/tests/p1.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-answer-certificate.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-answer-closure-loop.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-answer-closure.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-answer-key.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-asset-port.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-dependency.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-effect-budget.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-exploration.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-final.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-forced-turn.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-guard.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-ipc-exact.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-late-observation.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-loop-boundaries.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-loop-g3.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-loop-r0.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-loop-session.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-loop.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-math-asset.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-method-tool-coprompt.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-method.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-progress.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-revision.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-route-method-fusion.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-semantics-solutions.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-session-log.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-stop-guard.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-tool-input-constraints.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-tool-routes.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/agent-workflow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p1-modules.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-a2.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-fixture.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-gateway.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-host-flow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-ledger.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-methods.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-multipart.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-parameter.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-scope-coverage.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-template-fallback.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-validation.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p2-workunit.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p3-fixture.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p3-host-flow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p3-host-methods.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-mapping-boundaries.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-mapping-flow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-mapping.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-aggregate.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-boundaries.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-flow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-gate.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-preflight.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-recheck-input.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-recheck-report.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-recheck-session.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-recheck.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-review.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-revision-boundaries.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-r0-revision.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-recheck-boundaries.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-recheck-flow.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-recheck-gate.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-recheck-input.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-recheck.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-repair.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-review-audit.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-revise.test.js /home/ma-user/work/Astra /astra-refactored-web-unified/apps/stdio-runtime/dist/tests/p4-s1.test.js`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
ock callback (30.297992ms)
✔ S2 non-COMPLETE, late and unknown outcomes keep the raw text and never refute (21.441672ms)
✔ P4 repair fixture composes M1..M5 under one root budget and keeps the parent protected (30.984758ms)
✔ P4 repair fixture caps, review outcomes and a rewound clock never retry or replace the parent (168.277543ms)
✔ p4Target guards reject malformed inputs without mutating the artifact (28.560127ms)
✔ p4Target rejects a self-added scope assumption and a boolean version (7.363499ms)
✔ a real multi-codepoint quote is accepted while malformed reports are rejected (63.839968ms)
✔ strict JSON guards reject duplicate keys, floats, unsafe numbers, lone surrogates and depth (20.516298ms)
✔ review session enforces the cap, the 26/25ms boundary and atomic replay rejection (10.877733ms)
✔ two reports with the same step and kind but different rationale merge into one challenge (7.484111ms)
✔ a duplicated issue inside one report is deduplicated and the context excludes private fields (6.05417ms)
✔ invalid, unknown, truncated, error, blank and late settlements keep the raw text and block new admits (14.087483ms)
✔ a legal UNKNOWN report stays PROVISIONAL and markStale never refutes (6.509254ms)
✔ the candidate gate protects the first candidate and never replaces it (11.724896ms)
✔ two NO_ISSUE reviews never verify, PASS or satisfy anything (8.862004ms)
✔ S3 strict, stale and forged review cannot upgrade (25.900777ms)
✔ P4 fixture composes five modules under one budget (59.504304ms)
✔ flagship: a grounded {1} -> {0,1} revision replaces the protected candidate (69.782999ms)
✔ refusal keeps the parent candidate and records REVISE_REJECTED (32.82311ms)
✔ a stale challenge or a forged child binding is refused (13.967752ms)
✔ the revision path is the only sanctioned replacement of a protected candidate (17.41523ms)
✔ multi-counterexample: a revision covering every challenged gap is accepted (14.793469ms)
✔ multi-counterexample: a partial repair that leaves a proven gap fails closed (14.122131ms)
✔ real registered operators produce diagnostic evidence that never supports an obligation (954.875413ms)
✔ error, unknown and late outcomes never produce evidence and never retry (12.849979ms)
✔ precheck accepts S1 evidence produced on a deep model ordinal (2.959143ms)
✔ precheck reports structural reasons without promoting anything (5.107189ms)
✔ admission enforces the cap, the 26/25ms boundary and single-flight (7.977967ms)
✔ forged receipts are rejected and leave the last record DISPATCHED (7.404671ms)
✔ shared corpus: envelope parseFrame (5.017509ms)
✔ null const is a legal scalar literal (0.279129ms)
✔ invalid utf8 bytes rejected (0.309273ms)
✔ frame byte boundary 65536 ok / 65537 too large (1.010824ms)
✔ depth 24 ok / 25 rejected inside a legal envelope (0.565721ms)
✔ astral id 128 ok / 129 rejected (1.266433ms)
✔ escaped duplicate key and prototype-named extra keys rejected (0.652392ms)
✔ unsupported schema keyword is a hard failure (0.246997ms)
✔ failure null id ok, request null id rejected (1.546643ms)
✔ manifest wrong direction and limits rejected (1.736018ms)
✔ maxTokens verified true rejected (0.510755ms)
✔ payload extra field and session binding (0.753838ms)
✔ classifyMethod allowlist and rejected set (0.411578ms)
✔ present-but-null schema keywords are rejected, not treated as absent (0.387172ms)
✔ invalid bounds and unsupported scalar forms are rejected (0.441301ms)
✔ integer type rejects unsafe value and bool never equals 0 (0.691485ms)
✔ the shipped P1 manifest validates (2.666417ms)
✔ manifest drift is rejected (1.049053ms)
✔ initialize params reject wrong mode, extra field and out-of-range budgets (1.599789ms)
✔ solve result rejects a verified candidate and a performed acceptance (1.124361ms)
✔ a zero remainingMs receipt is syntactically valid (3.822103ms)
✔ parseP1Frame reuses the strict envelope checks (2.028968ms)
ℹ tests 540
ℹ suites 0
ℹ pass 540
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8911.969302
```

### web-logic-tests

- 命令：`node --test /home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/src/domain/__tests__/observerEvents.test.ts /home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/src/domain/__tests__/reduceRun.test.ts /home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/src/domain/__tests__/statusSemantics.test.ts /home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/src/domain/__tests__/terminalFrame.test.ts`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
▶ 真实 Host 观测事件接入
  ✔ 三个真实事件名都是已知事件，不再落入 unknownEvents (5.423243ms)
  ✔ model_dispatched 把状态推进到 running 并登记步骤 (0.550402ms)
  ✔ model_returned 收口对应步骤并保留 transportStatus (0.406296ms)
  ✔ 非 COMPLETE 返回被记为错误，但仍由真实终态事件决定最终状态 (0.596808ms)
  ✔ effect_returned 登记真实 effect 观测 (0.46123ms)
  ✔ 同一条 effect 重复返回只更新，不重复追加 (0.4727ms)
  ✔ 完整真实序列给出候选与结论文本，且 candidateVerified 恒为 false (0.679395ms)
  ✔ 旧存档只有 summary 终态时也能收口回放（复核缺陷 #3） (0.827975ms)
✔ 真实 Host 观测事件接入 (11.405912ms)
▶ reduceRun 纯函数与核心契约
  ✔ 初始状态满足红线约束：candidateVerified 恒为 false (1.553224ms)
  ✔ 接收 FINAL/RESULT 事件后，candidateVerified 仍严格为 false (1.362092ms)
  ✔ 幂等性：同 seq 同 payload 自动去重并返回相同引用 (0.534061ms)
  ✔ 冲突检测：同 seq 不同 payload 记录 conflict 且不破坏原事件 (0.685243ms)
  ✔ 乱序容错：乱序到达的事件按 seq 自动升序排列 (1.502945ms)
  ✔ 未知事件安全隔离并标记 degraded 与 capabilityGaps (0.596286ms)
  ✔ 逐条归约结果严格等价于批量归约结果 (reduceRun vs reduceRunAll) (0.542887ms)
✔ reduceRun 纯函数与核心契约 (8.624761ms)
▶ PlaybackController 回放时钟与快照一致性
  ✔ 支持加载事件流并自动就绪末帧 (1.480238ms)
  ✔ 单步后退、单步前进与任意游标跳转 (0.935417ms)
  ✔ 新事件到达时，历史游标保持不变（不强跳末帧） (1.300421ms)
  ✔ 快照恢复状态与从头完整归约状态完全等价 (1.279042ms)
✔ PlaybackController 回放时钟与快照一致性 (5.764768ms)
▶ 实测验证：Astra 真实 session-sample.json 回放
  ✔ 回放 11 条真实 Astra 事件日志，达到 candidate 终态且验证标记为 false (1.358357ms)
✔ 实测验证：Astra 真实 session-sample.json 回放 (1.483417ms)
▶ 终态语义分类（与 candidate 严格可区分）
  ✔ REVIEWS_COMPLETE 才归为 candidate 交付 (2.719018ms)
  ✔ 超时类终止码归为 timeout (0.342066ms)
  ✔ 运行时启动 / 子进程失败归为 failed (0.220311ms)
  ✔ 取消归为 cancelled (0.20456ms)
  ✔ 传输与字段校验故障归为 error (0.296321ms)
  ✔ 数学未解与预算耗尽归为 unsolved（不得显示为 candidate） (0.294842ms)
  ✔ 未注册终止码与缺失终止码归为 unknown（不回落 candidate） (0.178825ms)
  ✔ FINAL 事件携带 TIMEOUT 时不产生 candidate 终态 (1.665937ms)
  ✔ run.finished 不冲淡已判定的失败 / 超时终态 (0.663205ms)
✔ 终态语义分类（与 candidate 严格可区分） (12.644482ms)
▶ final_response 诚实性
  ✔ 携带 final_response 时如实记录，且不声称形式化确认 (0.600312ms)
  ✔ 缺失 final_response 时标记缺失，不填充结论文本 (0.240053ms)
  ✔ 空白 final_response 视为缺失（不把空格当结论） (0.223729ms)
  ✔ 无 stopReason 且无声明 status 的 FINAL：终态为 unknown 而非 candidate (0.462597ms)
  ✔ 真实 Astra 信封（只有 status 字段）按其声明还原为候选终态 (0.204521ms)
✔ final_response 诚实性 (2.688126ms)
▶ SSE 关闭帧终态解析（V2 护栏）
  ✔ 解析后端真实关闭帧的全部终态字段 (1.552934ms)
  ✔ 非法 JSON / 空对象 / 非对象一律返回 null（不凭空造终态） (0.419473ms)
  ✔ 关闭帧经归约后落到 error 终态，绝不显示为 candidate (1.566308ms)
  ✔ 终态信封使用固定序号基址并保留字段名映射 (0.396336ms)
  ✔ 未执行态（executed=false）的 final_response 仍可读但不构成候选 (0.397771ms)
✔ SSE 关闭帧终态解析（V2 护栏） (6.217024ms)
▶ 数据级别判定（detail_level 权威优先）
  ✔ detail_level 权威值优先于存档路径推导 (4.706622ms)
  ✔ detail_level 缺失或非法时才回退到真实存档路径 (0.297412ms)
  ✔ 记录不存在时为 UNKNOWN，不冒充 L2 / L3 (0.277823ms)
  ✔ 真实无存档的运行（detail_level=L1、无 l2/l3）判为 L1 (0.367055ms)
✔ 数据级别判定（detail_level 权威优先） (6.19998ms)
▶ 幂等键稳定性（④ 护栏）
  ✔ 同题同配置产生相同键（可触发后端 200 重放） (0.488829ms)
  ✔ 题目或配置不同则键不同 (0.257066ms)
  ✔ 键为 ASCII 安全（可直接作为 HTTP 头值） (0.480005ms)
✔ 幂等键稳定性（④ 护栏） (1.493639ms)
ℹ tests 46
ℹ suites 9
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 254.373698
```

### web-typecheck

- 命令：`/home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/node_modules/.bin/tsc -p tsconfig.json --noEmit`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo`
- 状态：`PASS`，退出码：`0`

```text

```

### web-build

- 命令：`/home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo/node_modules/.bin/vite build`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified/apps/web-demo`
- 状态：`PASS`，退出码：`0`

```text
vite v6.4.5 building for production...
transforming...
✓ 1608 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.74 kB │ gzip:   0.48 kB
dist/assets/index-nBDfw1hw.css    1.17 kB │ gzip:   0.58 kB
dist/assets/index-BpXDXjnu.js   443.18 kB │ gzip: 132.43 kB │ map: 1,951.62 kB
✓ built in 3.00s
```

### browser-smoke

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 scripts/web_browser_smoke.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
PASS assets_page_loaded
PASS assets_count_26
PASS assets_behaviors_82
PASS assets_catalog_digest
PASS solve_page_loaded
PASS solve_no_method_switch
PASS solve_started
PASS live_effect_event
PASS live_model_step
PASS live_model_dispatched
PASS assets_used_in_effect
PASS reconnect_counter
PASS reconnect_recovered
PASS candidate_delivered
PASS no_failure_banner
PASS red_line_visible
PASS reconnect_no_duplicate_events
PASS replay_link_present
PASS replay_page_loaded
PASS replay_terminal_answer
PASS replay_no_idle_state
PASS replay_shows_candidate
PASS replay_red_line
BROWSER_SMOKE_PASS
```

### web-unit-bff

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 -m pytest -q -p no:cacheprovider tests/test_web_bff.py tests/test_web_contract.py tests/test_web_math_assets.py tests/test_web_solver_adapter.py tests/test_web_public_chat_port.py tests/test_web_restart_recovery.py tests/e2e/test_web_math_failure_paths.py tests/e2e/test_web_math_streaming.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
..............................................................                                                                                           [100%]
62 passed in 6.50s
```

### bff-82

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 -m pytest -q -p no:cacheprovider tests/e2e/test_web_math_assets_82_e2e.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
..................................................................................                                                                       [100%]
82 passed in 79.49s (0:01:19)
```

### core-82

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 tests/e2e/test_ts_math_assets_82_e2e.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
earch       | YES  | candidate | False | 0.93  | PASS |
| 51  | math.lattices              | count_lattice_hexagons           | YES  | candidate | False | 0.96  | PASS |
| 52  | math.lattices              | hexagon_lattice_points           | YES  | candidate | False | 0.92  | PASS |
| 53  | math.lattices              | lattice_points_in_polygon        | YES  | candidate | False | 0.97  | PASS |
| 54  | math.finite-states         | deletion_divisible_largest       | YES  | candidate | False | 0.96  | PASS |
| 55  | math.finite-states         | digit_sum_window                 | YES  | candidate | False | 0.97  | PASS |
| 56  | math.finite-states         | hamiltonian_paths_grid           | YES  | candidate | False | 0.93  | PASS |
| 57  | math.games                 | deck_game_outcome                | YES  | candidate | False | 0.96  | PASS |
| 58  | math.games                 | gap_subsequence_discrepancy      | YES  | candidate | False | 0.96  | PASS |
| 59  | math.games                 | independent_reply_certificate    | YES  | candidate | False | 0.94  | PASS |
| 60  | math.games                 | minimax_value_graph              | YES  | candidate | False | 0.99  | PASS |
| 61  | math.games                 | pairing_strategy_verify          | YES  | candidate | False | 0.95  | PASS |
| 62  | math.games                 | win_draw_loss_graph              | YES  | candidate | False | 0.94  | PASS |
| 63  | math.tiling                | check_tiling_certificate         | YES  | candidate | False | 0.94  | PASS |
| 64  | math.tiling                | coloring_bound                   | YES  | candidate | False | 0.97  | PASS |
| 65  | math.tiling                | count_tilings                    | YES  | candidate | False | 0.95  | PASS |
| 66  | math.tiling                | min_tiles_cover                  | YES  | candidate | False | 0.95  | PASS |
| 67  | math.tiling                | unique_tiling_check              | YES  | candidate | False | 0.94  | PASS |
| 68  | math.algebraic-structures  | algebraic_polynomial_check       | YES  | candidate | False | 1.01  | PASS |
| 69  | math.algebraic-structures  | wronskian_root_identity          | YES  | candidate | False | 1.24  | PASS |
| 70  | math.diophantine           | quadratic_discriminant_family    | YES  | candidate | False | 0.96  | PASS |
| 71  | math.integer-structure     | frobenius_semigroup              | YES  | candidate | False | 0.95  | PASS |
| 72  | math.integer-structure     | odd_part                         | YES  | candidate | False | 0.93  | PASS |
| 73  | math.integer-structure     | odd_part_table                   | YES  | candidate | False | 0.92  | PASS |
| 74  | math.invariants            | double_counting                  | YES  | candidate | False | 0.93  | PASS |
| 75  | math.invariants            | polynomial_invariant             | YES  | candidate | False | 1.07  | PASS |
| 76  | math.numerics              | closed_form_conjecture           | YES  | candidate | False | 0.99  | PASS |
| 77  | math.numerics              | identify_constant                | YES  | candidate | False | 0.94  | PASS |
| 78  | math.numerics              | verify_fd_certificate            | YES  | candidate | False | 0.94  | PASS |
| 79  | math.optimization          | certificate_check                | YES  | candidate | False | 1.11  | PASS |
| 80  | math.optimization          | numeric_extremum_search          | YES  | candidate | False | 0.93  | PASS |
| 81  | math.optimization          | subset_gap_worst_case            | YES  | candidate | False | 0.95  | PASS |
| 82  | math.probability           | normal_overflow_seats            | YES  | candidate | False | 0.99  | PASS |
======================================================================================
SUMMARY: 82/82 PASSED (100.0%), 0 FAILED
======================================================================================

ALL 82 MATHEMATICAL ASSET BEHAVIORS SUCCESSFULLY VERIFIED VIA FORMAL ENTRY E2E.
```

## 边界说明

- 本报告只记录真实命令输出；失败、超时和未执行不会被写成 PASS。
- 82 项测试只替代远端模型响应；Node、Host、统一数学资产执行和 BFF 均为正式代码。
- `candidate_verified` 始终为 `False`；计算行为成功不等于整题数学证明。
- 本报告不包含任何已执行的真实外部模型评测；如需真实模型结果，必须另记独立证据。
