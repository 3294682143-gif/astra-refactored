# Web 与统一数学资产整合验收报告

- 生成时间（epoch）：`1792924605`
- Git HEAD：`9b645887e07a8014bf0ac5dbc652d313e9cc7a67`
- 工作树有未提交改动：`True`
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
| `web-schema-check` | PASS | 0 | 0.19 |
| `web-manifest-check` | PASS | 0 | 0.04 |
| `tsc` | PASS | 0 | 0.13 |
| `node-tests` | PASS | 0 | 9.29 |
| `web-typecheck` | PASS | 0 | 2.82 |
| `web-build` | PASS | 0 | 3.27 |
| `browser-smoke` | PASS | 0 | 2.26 |
| `web-unit-bff` | PASS | 0 | 5.83 |
| `bff-82` | PASS | 0 | 88.11 |
| `core-82` | PASS | 0 | 89.16 |

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
ck callback (30.821319ms)
✔ S2 non-COMPLETE, late and unknown outcomes keep the raw text and never refute (23.324312ms)
✔ P4 repair fixture composes M1..M5 under one root budget and keeps the parent protected (42.943071ms)
✔ P4 repair fixture caps, review outcomes and a rewound clock never retry or replace the parent (168.193569ms)
✔ p4Target guards reject malformed inputs without mutating the artifact (40.634332ms)
✔ p4Target rejects a self-added scope assumption and a boolean version (12.589007ms)
✔ a real multi-codepoint quote is accepted while malformed reports are rejected (46.162193ms)
✔ strict JSON guards reject duplicate keys, floats, unsafe numbers, lone surrogates and depth (10.602419ms)
✔ review session enforces the cap, the 26/25ms boundary and atomic replay rejection (16.123778ms)
✔ two reports with the same step and kind but different rationale merge into one challenge (20.536939ms)
✔ a duplicated issue inside one report is deduplicated and the context excludes private fields (5.630842ms)
✔ invalid, unknown, truncated, error, blank and late settlements keep the raw text and block new admits (11.537685ms)
✔ a legal UNKNOWN report stays PROVISIONAL and markStale never refutes (9.756043ms)
✔ the candidate gate protects the first candidate and never replaces it (10.655347ms)
✔ two NO_ISSUE reviews never verify, PASS or satisfy anything (5.946659ms)
✔ S3 strict, stale and forged review cannot upgrade (20.449094ms)
✔ P4 fixture composes five modules under one budget (47.854464ms)
✔ flagship: a grounded {1} -> {0,1} revision replaces the protected candidate (50.070421ms)
✔ refusal keeps the parent candidate and records REVISE_REJECTED (40.933157ms)
✔ a stale challenge or a forged child binding is refused (20.673592ms)
✔ the revision path is the only sanctioned replacement of a protected candidate (17.124417ms)
✔ multi-counterexample: a revision covering every challenged gap is accepted (9.680561ms)
✔ multi-counterexample: a partial repair that leaves a proven gap fails closed (14.111233ms)
✔ real registered operators produce diagnostic evidence that never supports an obligation (1235.55344ms)
✔ error, unknown and late outcomes never produce evidence and never retry (12.679539ms)
✔ precheck accepts S1 evidence produced on a deep model ordinal (3.155618ms)
✔ precheck reports structural reasons without promoting anything (5.449115ms)
✔ admission enforces the cap, the 26/25ms boundary and single-flight (6.952038ms)
✔ forged receipts are rejected and leave the last record DISPATCHED (4.653502ms)
✔ shared corpus: envelope parseFrame (6.03665ms)
✔ null const is a legal scalar literal (0.297029ms)
✔ invalid utf8 bytes rejected (0.267071ms)
✔ frame byte boundary 65536 ok / 65537 too large (0.910345ms)
✔ depth 24 ok / 25 rejected inside a legal envelope (0.637314ms)
✔ astral id 128 ok / 129 rejected (1.189658ms)
✔ escaped duplicate key and prototype-named extra keys rejected (0.624945ms)
✔ unsupported schema keyword is a hard failure (0.241675ms)
✔ failure null id ok, request null id rejected (0.653138ms)
✔ manifest wrong direction and limits rejected (1.282055ms)
✔ maxTokens verified true rejected (0.435297ms)
✔ payload extra field and session binding (0.311893ms)
✔ classifyMethod allowlist and rejected set (0.22914ms)
✔ present-but-null schema keywords are rejected, not treated as absent (0.318984ms)
✔ invalid bounds and unsupported scalar forms are rejected (0.310023ms)
✔ integer type rejects unsafe value and bool never equals 0 (0.300018ms)
✔ the shipped P1 manifest validates (2.49798ms)
✔ manifest drift is rejected (1.092795ms)
✔ initialize params reject wrong mode, extra field and out-of-range budgets (1.471928ms)
✔ solve result rejects a verified candidate and a performed acceptance (0.954262ms)
✔ a zero remainingMs receipt is syntactically valid (0.759702ms)
✔ parseP1Frame reuses the strict envelope checks (2.136703ms)
ℹ tests 540
ℹ suites 0
ℹ pass 540
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9248.886965
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
dist/assets/index-D6Z8EW5o.js   439.72 kB │ gzip: 131.45 kB │ map: 1,939.53 kB
✓ built in 2.99s
```

### browser-smoke

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 scripts/web_browser_smoke.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
PASS assets_title
PASS asset_count
PASS behavior_count
PASS catalog_digest
PASS solve_title
PASS effect_budget
PASS no_method_switch
BROWSER_SMOKE_PASS
```

### web-unit-bff

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 -m pytest -q -p no:cacheprovider tests/test_web_bff.py tests/test_web_contract.py tests/test_web_math_assets.py tests/test_web_solver_adapter.py tests/e2e/test_web_math_failure_paths.py tests/e2e/test_web_math_streaming.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
.................................................                                                                                                        [100%]
49 passed in 5.41s
```

### bff-82

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 -m pytest -q -p no:cacheprovider tests/e2e/test_web_math_assets_82_e2e.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
..................................................................................                                                                       [100%]
82 passed in 87.63s (0:01:27)
```

### core-82

- 命令：`/home/ma-user/anaconda3/envs/PyTorch-2.1.0/bin/python3 tests/e2e/test_ts_math_assets_82_e2e.py`
- 工作目录：`/home/ma-user/work/Astra /astra-refactored-web-unified`
- 状态：`PASS`，退出码：`0`

```text
earch       | YES  | candidate | False | 1.03  | PASS |
| 51  | math.lattices              | count_lattice_hexagons           | YES  | candidate | False | 1.00  | PASS |
| 52  | math.lattices              | hexagon_lattice_points           | YES  | candidate | False | 1.02  | PASS |
| 53  | math.lattices              | lattice_points_in_polygon        | YES  | candidate | False | 1.09  | PASS |
| 54  | math.finite-states         | deletion_divisible_largest       | YES  | candidate | False | 1.05  | PASS |
| 55  | math.finite-states         | digit_sum_window                 | YES  | candidate | False | 1.03  | PASS |
| 56  | math.finite-states         | hamiltonian_paths_grid           | YES  | candidate | False | 1.08  | PASS |
| 57  | math.games                 | deck_game_outcome                | YES  | candidate | False | 1.02  | PASS |
| 58  | math.games                 | gap_subsequence_discrepancy      | YES  | candidate | False | 1.06  | PASS |
| 59  | math.games                 | independent_reply_certificate    | YES  | candidate | False | 1.03  | PASS |
| 60  | math.games                 | minimax_value_graph              | YES  | candidate | False | 1.03  | PASS |
| 61  | math.games                 | pairing_strategy_verify          | YES  | candidate | False | 1.04  | PASS |
| 62  | math.games                 | win_draw_loss_graph              | YES  | candidate | False | 1.05  | PASS |
| 63  | math.tiling                | check_tiling_certificate         | YES  | candidate | False | 1.03  | PASS |
| 64  | math.tiling                | coloring_bound                   | YES  | candidate | False | 1.06  | PASS |
| 65  | math.tiling                | count_tilings                    | YES  | candidate | False | 1.06  | PASS |
| 66  | math.tiling                | min_tiles_cover                  | YES  | candidate | False | 1.02  | PASS |
| 67  | math.tiling                | unique_tiling_check              | YES  | candidate | False | 0.99  | PASS |
| 68  | math.algebraic-structures  | algebraic_polynomial_check       | YES  | candidate | False | 1.14  | PASS |
| 69  | math.algebraic-structures  | wronskian_root_identity          | YES  | candidate | False | 1.38  | PASS |
| 70  | math.diophantine           | quadratic_discriminant_family    | YES  | candidate | False | 1.05  | PASS |
| 71  | math.integer-structure     | frobenius_semigroup              | YES  | candidate | False | 1.05  | PASS |
| 72  | math.integer-structure     | odd_part                         | YES  | candidate | False | 1.03  | PASS |
| 73  | math.integer-structure     | odd_part_table                   | YES  | candidate | False | 1.04  | PASS |
| 74  | math.invariants            | double_counting                  | YES  | candidate | False | 1.04  | PASS |
| 75  | math.invariants            | polynomial_invariant             | YES  | candidate | False | 1.07  | PASS |
| 76  | math.numerics              | closed_form_conjecture           | YES  | candidate | False | 1.08  | PASS |
| 77  | math.numerics              | identify_constant                | YES  | candidate | False | 1.14  | PASS |
| 78  | math.numerics              | verify_fd_certificate            | YES  | candidate | False | 1.03  | PASS |
| 79  | math.optimization          | certificate_check                | YES  | candidate | False | 1.17  | PASS |
| 80  | math.optimization          | numeric_extremum_search          | YES  | candidate | False | 1.15  | PASS |
| 81  | math.optimization          | subset_gap_worst_case            | YES  | candidate | False | 1.07  | PASS |
| 82  | math.probability           | normal_overflow_seats            | YES  | candidate | False | 1.04  | PASS |
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
