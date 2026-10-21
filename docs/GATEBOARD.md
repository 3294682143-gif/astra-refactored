# v4 implementation gateboard

Current gate: **G5 / PR6 (local-ready) + G7 / PR7 in progress** — the official 书生 S2 API + L1 comparison remain `BLOCKED_EXTERNAL`, so G5/G6 are delivered as **locally-verifiable packages** (Slices 5a/5b) and work continues on **G7 / PR7** (Slices 7a-7f). **G4 / PR5 CLOSED** (Slices 4a `63dbeca`, 4b `9d18ef4`, 4c this commit: immutable SessionLog + ContextProjector replay, Pi truncated-tool-barrier E08/E09, DSH monotonic tool guards + request-responsibility journal + E17 exact IPC); **G3 / PR4 CLOSED at `651cb04`**; G2 closed at `899c7fc`.
G4/PR5 is closed; **CURRENT_GATE points to G5 / PR6 (real 书生 S2 API + budget modes + L1 math comparison)**, which stays BLOCKED_EXTERNAL until the official environment/authorization is supplied.
Session update (2026-10-21): **A full 100-item rerun** on frozen `36e056f`
(10000-call arm, 4/4 concurrency) produced **68 correct / 12 incorrect /
12 unsolved / 8 ambiguous; strict 18/100; 88/100 candidates; 12 unsolved all
`FIELD_VALUE`; 1459 requests; 9.739M tokens; 14.59 calls/item.** The earlier
96/97 figures were targeted repair reruns, not this full run. The TS loop now
exposes `exact_check_expr` and `bounded_enumeration` and emits a `CERT1` final
certificate, but `FIELD_VALUE`/binding-schema stability is the immediate
blocker. See `docs/REAL_MODEL_PILOT_20261019.md` and
`/tmp/astra-rerun-ab-10000-20261021-TrfJBe/`.
G0 source inventory and deployment facts are supporting work, not a competing
math-feature stream. DSH authors implementation/tests; the supervisor reviews,
applies and independently verifies them. No parallel coding agents are used.

## Session update — 2026-10-17 (supervised release run; verified on `5545f25`)

- **Math acceptance (§3)**: `solutionSetOf` now returns the WHOLE real solution set or `null`
  (exact rational roots + a Sturm real-root check on the residual); the `ALL_SOLUTIONS`
  revision gate fails closed when completeness is indeterminate. Regression
  `apps/stdio-runtime/tests/agent-semantics-solutions.test.ts` (11 cases). Commits
  `d21192e` + manifest `2742cba`.
- **WASI (local only)**: real acceptance `tests/actual/test_wasi_actual.py` **24/24**
  `LOCAL_T27_T28_PASSED` at an out-of-repo install path, plus an end-to-end
  `PythonSandbox` run (`math.comb(13,6)=1716`). Platform acceptance (B3) is still required.
- **Migration ledger**: **260 = 254 CLOSED / 6 REVIEW_REQUIRED** (6 MATH rows closed on
  `tests/bridge/test_g8_retained_modules.py`; 3 DOC rows on `tests/bridge/test_g8_doc_runbook.py`;
  6 DOC rows still need a `DOCUMENTED_CONTRACT` disposition).
- **Real-model smoke (local, 2 items)**: precise WorkPacket field types were added to the WORK
  prompt and a bounded same-task schema-repair turn is available through
  `max_repairs=1`; both test0 #4 and #41 now reach `candidate` through the real
  `engine="ts"` entry. This is not an accuracy benchmark; see
  `docs/REAL_MODEL_SMOKE_20261018.md`.
- **Full test0 local run (2026-10-18, current code)**: 100 items completed through the public
  `engine="ts"` entry; 93 best-effort candidates, 2 `PACKET_REJECTED`, 5
  `WORK_UNITS_COMPLETE`; 399 model requests / 1,810,961 reported tokens; emulator
  `ReferenceJudge` 14/100 (format-normalized 18/93 candidates with one uniform
  normalizer; the latter is a local cross-check, not the official judge). The matcher number is
  a strict reference-string match, not math accuracy. Average depth is still ~4 calls/item
  (median 4, max 6, no item near the 256-call cap), so this is not a baseline-depth run: the
  compiled task graph, not the cap, bounds depth. See `docs/REAL_MODEL_SMOKE_20261018.md`;
  report at `/tmp/astra-test0-full2`.
- **Depth work (20 items x 6 real pilot runs, 2026-10-18)**: an answer-task tool-check line, an
  `unsolved` guard and an answer-check turn (system prompt only; a unit test pins the payload as
  byte-identical) were added and measured on the same 20 items. Candidates reached 19/20 and the
  1-call no-candidate failure mode disappeared, but the tool check fired on only 0-7 of 20 items
  depending on wording and strict accuracy stayed at 1-4/20, i.e. within noise. Two stronger
  designs are refused by the Host protocol (a `REPAIR` call before the review; a second `WORK`
  turn for a delivered task), so real depth needs a Host protocol change, not a cap or prompt
  change. See `docs/REAL_MODEL_SMOKE_20261018.md`.
- **Distribution (local)**: wheel `astra_mathagent_s2-0.10.0a2-py3-none-any.whl` builds and
  installs into a clean venv; the official entry runs from outside the source tree. The wheel
  now ships the TS bundle and schema, and a wheel-only `engine="ts"` smoke passed locally.
  Target-environment launch remains **B2 BLOCKED_EXTERNAL**.
- **Verified baseline (this session, local)**: `tsc -b` 0; Node **328/0**; `pytest -q`
  **683 passed / 24 skipped**; `tests/e2e` **265 passed**; `build_release_manifest.py --verify`
  **VERIFY_OK**; wheel-only `engine="ts"` smoke passed outside the source tree.
- **Release**: still **NOT_RELEASABLE** — B1–B4 `BLOCKED_EXTERNAL`, 6 DOC rows open,
  7e mapping contract pending. (Formal default entry is now `engine="ts"` per ADR-011;
  Zygos naming/migration recorded in `docs/NAMING.md` + `docs/RENAME_MIGRATION.md`.)

| Field | Current evidence |
| --- | --- |
| Baseline | G1 PR2 head `6e45893`, tree `a457740`; PR2 is open, not merged; main/default frozen; see SOURCE_LOCK.md |
| ROOT_E2E | LOCAL_PASS: `python -m pytest -q tests/e2e` — **261** real public-entry tests on v4 head (G4/PR5 CLOSED: B1/B2/B3/E14 + E08/E09 truncation barrier, E17 exact IPC), including the G2 complete-whole-problem-answer capability, p2a-work-v5 redo, trusted parameter boundaryCases (E04), E01 `{1}->{0,1}`, text parity, the G3/PR4 negative controls, the public-entry flagship (checker-grounded R2 challenge → one REPAIR call → `{1}->{0,1}`), its `maxRepairs=0` negative, the S1/E07 negative (foreign-task checker refused), the E15 honest best-effort negative, the E14 byte-verbatim release negative, the E05/E06 unclosed-auxiliary-obligation rows (`test_ts_g3_evidence.py`), the E14 empty-delivery negative, the B1b R0 rows (`test_ts_g3_r0.py`), the B3 multi-gap rows, and the G4 E08/E09 truncated-tool-barrier rows (`test_ts_g4_truncation.py`); old Controller/Lite init/solve disabled |
| RC2_MIGRATION | 260 rows: 254 CLOSED / 6 REVIEW_REQUIRED (recomputed; 6 MATH rows and 3 DOC rows closed on executable behaviour/runbook tests, 6 DOC rows still need a disposition). Method + gaps: docs/MIGRATION_AUDIT.md |
| math_families freeze | all 60 concrete algorithm files under `math_families/**` (py/md/json, `__pycache__`/`.pyc` excluded) frozen by SHA-256 in `asset_baseline.json` and `release/BUILD_MANIFEST.json`; a 1-byte change fails `ASSET_INTEGRITY_ERROR`; the 20 `general_v11` method cards stay 20/20 |
| S2b mid-run resume | partial-run resume: completed WORK is never re-run (0 WORK calls); the Host rehydrates its `history` from the checkpoint (full source-WORK `messages`, recomputed `contextHash` compared fail-closed); model ordinal/spend carried over monotonically; only REVIEW and subsequent stages execute. Verified online and via the no-node_modules bundle |
| G0 source locks | commit/tree identities captured for RC2, a2, TS, DSH and Pi; audit script + five real-Git tests passed |
| G0 deployment | BLOCKED_EXTERNAL: no official Node/subprocess permission or target sandbox supplied |
| BUDGET | Current code default: 8 model calls / 4 work units / 1 effect / 600 s; hard caps 256 / 64 / 2. Not official contest limits; no real math API calls are required for local tests |
| MATH | E08/E09/E10/E11/E12/E18 infrastructure paths locally tested; E01 grounded repair and other full math properties pending; real model comparison NOT_RUN |
| QUALITY | v4 head (G5/G6 local + G7/PR7 slices 7a-7c) exact clean: **328 Node / 683 Python passed (24 WASI skips)**, **265 e2e**; G4/PR5: 311 / 589, 203 e2e; G3/PR4 `651cb04`: 304 / 587, 201 e2e; prior `a1a1428`: 300 / 582, 196 e2e; prior 3c.3: 300 / 579; slice 3b: 299 / 578; slice 3a.2: 297 / 578; slice 3c.2: 297 / 578; slice 3c.1: 297 / 577; slice 3a.1: 295 / 576; slice 2: 294 / 576; head `899c7fc`: 287 / 572; G1 PR2: 244 / 406; redo `5b3ff34`: 269 / 484; progress/parity worktree: 272 / 507, same 24 WASI skips |
| G2A METHODS | Real method → WORK → second WORK → R2; one catalog read/one method load in shared effect quota; opt-in only; see G2_METHOD_BRIDGE.md |
| G2B1 FINAL | Real tool → WORK → final → R2 in four calls; confirms only the protected old candidate; no fabricated artifact; see G2_FINAL_CONFIRMATION.md |
| G2B2 ROUTES | Model v2 proposal → M1 TASK_ADDED → real second-route WORK; full raw provenance, empty cross-route inputs, current-obligation scope; see G2_DYNAMIC_ROUTES.md |
| G2C DEPENDENCIES | v3 proposals → two real task additions → three WORKs consuming preceding artifacts → R2 in four calls; same-route inheritance and shared child-tool budget; see G2_DEPENDENT_CHAIN.md |
| G2D REDO | A real repeated WORK produces version+1; old bytes retained, exact downstream closure STALE, unrelated route stays ACTIVE; no automatic protected-candidate replacement; see G2_ARTIFACT_REDO.md |
| G2 E16 | Real task-only yield on unsolved/partial/two cached repeats; other ready tasks still execute under the same root; Unicode predicate parity independently audited; see G2_PROGRESS_POLICY.md |
| G3 PR4 (slice 1a) | M5 S3 evidence-gated candidate revision as a pure capability: `reviseCandidate` replaces a protected candidate only under a `CHALLENGED`/`ACTIVE` answer-obligation challenge plus a grounded `CHECKED_SCOPE`/`PASS` basis; every refusal is fail-closed `REVISE_REJECTED`; `p4-revise.test.ts` flagship + refusal matrix; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 1b) | Online closure wired into `runAgentLoop` (opt-in `maxRepairs`): one `REPAIR` model call after an R2 answer-obligation challenge, grounded by a Host-accepted `PROGRAM_OBSERVATION` checker, then `reviseCandidate`; `agent-loop-g3.test.ts`; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 2) | Public-entry flagship: the Python Host accepts the additive `REPAIR` phase (options/`_STOP_REASONS`/`_SUMMARY_FIELDS`/`repairCalls`, `validate_context`+`_check_repair`, schema, `project_artifacts`/`candidate_packet` REPAIR branches); `tests/e2e/test_ts_g3_flagship.py` proves `x(x-1)=0` `{1}->{0,1}` (`REVISED_CANDIDATE`) and its `maxRepairs=0` negative. Negative control B remains separate (R2 parse `UNKNOWN`; no-counterexample `STALE`) |
| G3 PR4 (slice 3a.1) | M5 S1 original-problem mapping gate before any checker becomes a `P4ReviseBasis`: `P4DiagnosticLedger.precheck` against the trusted target (scope/assumptions/tool-property/obligations); a foreign-task / unknown-tool / foreign-obligation checker (E07) is refused and can never ground a revision; `privateState.s1Assessment`; `agent-loop-g3.test.ts` E07 negative; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.1) | Multi-counterexample fail-closed (`P4ReviseBasis.requiredGaps`/`coveredGaps`: child must cover every proven gap, partial repair refused) + E07 promoted to the public entry (foreign-task checker refused, no REPAIR, candidate stays); see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.4) | `docs/MIGRATION_MATRIX.csv`: 30 RC2 review/audit/planning/scope/output-check rows now carry concrete G3/PR4 test+evidence records, and `docs/CAPABILITY_MATRIX.csv` annotates SCOPED_EXACT_CHECKS/WORKFLOW_RESPONSIBILITY/TOP_LEVEL_MATH_CONTROL; the path set is unchanged (260 paths, 0 unmatched, all REVIEW_REQUIRED) |
| G3 PR4 (slice 3c.3) | §6.1 matrix rows `E13` (a fixed deterministic `UNKNOWN` template fallback) and `E14` (S3 releases the delivered answer byte-verbatim, no format distortion); `p2-template-fallback.test.ts` + `test_ts_g3_negatives.py` |
| G3 PR4 (slice 3b) | Trusted `boundaryCases` versioned schema: explicit `P2_SCOPE_COVERAGE_SCHEMA_VERSION`; PARAMETER boundary claims must equal the trusted parameter branches, MULTIPART exhaustion the trusted child set, other goals keep declared data, v1..v4 replay unchanged (E04); `p2-scope-coverage.test.ts` |
| G3 PR4 (slice 3a.2) | S2 local repair transaction: an accepted revision supersedes ONLY the challenged answer obligation; every other obligation and the parent artifact (e.g. the valid local `x=1` derivation) are preserved; `privateState.s2Transaction`; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.2) | §6.1 E2E matrix row `E15`: with no review budget a real candidate is released only as an unverified `BEST_EFFORT` candidate (`candidateVerified=false`, strict acceptance not performed); `test_ts_g3_negatives.py` |
| G3/PR4 B1a (commit `67391d6`) | DECISION-0150 B1a: `agent-host-v13.schema.json` four tool.execute/method.load bindings `contractVersion` widened `const:1 -> enum:[1,2]`; Python Host (`agent_context._ACCEPTED_CONTRACT_VERSIONS`/`_contract_version_ok`, `agent_history`/`agent_workflow`/`agent_progress`) accepts `{1,2}`; default run still compiles v1 so replay is byte-identical; same-round consistency still enforced by the `same_json` projections |
| G3/PR4 B2 E05/E06 (commit `5958142`) | DECISION-0150 B2: `AgentLoopSummary.unresolvedObligations` reports still-open `PREMISES` (proof, E05) and `ATTAINMENT` (optimization, E06); `candidateVerified` stays false; the frozen `P2_ANSWER_OBLIGATION_BY_GOAL`/`test_ts_candidate_kinds.py` are untouched; `tests/e2e/test_ts_g3_evidence.py` |
| G3/PR4 B1b stage 1 (commit `b531b4b`) | DECISION-0150 B1b prerequisite plumbing, inert at default 0: `AGENT_MODEL_PHASE += R0`; `maxR0` option threaded protocol/agent-loop-io/schema init/`agent_runtime`/`AgentHost`; `agent_client._PHASES += R0`. No run emits R0 yet |
| G3/PR4 E14 empty (commit `a1a1428`) | DECISION-0150 ruling 4 (E14): a delivered candidate that is empty breaks the non-empty contract and is never released by S3 (`test_ts_g3_negatives.py::test_e14_empty_delivered_text_is_never_released`) |
| G3/PR4 matrix status | **COVERED: `E01/E04/E05/E06/E07/E13` (fixed-template fallback) `/E14`/`E15` + flagship + B3 PARAMETER two-gap multi-gap + negative control B (R2 parse `UNKNOWN`; no-counterexample `STALE`). `G3 / PR4` is CLOSED at v4 head `651cb04`** |
| G4/PR5 status | **CLOSED**: immutable SessionLog + ContextProjector replay hash parity (Slice 4a `63dbeca`); Pi truncated-tool-barrier E08/E09 + DSH monotonic tool guards (Slice 4b `9d18ef4`); request-responsibility journal + E17 exact big-int/rational IPC + docs (Slice 4c). `docs/G4_RUNTIME_HARDENING.md` holds the ADR (controlled own-loop + Pi/DSH mechanism port). |
| DECISION-0150 resolved | The USER issued the official DECISION-0150 resolution (recorded as `DECISION-0151`): B1 `contractVersion{1,2}` + bounded R0; B2 E05/E06 bounded scope (frozen authority untouched); B3 option (a) checker witness or (b) PARAMETER boundaryCases; E14 empty/format reject; atomic B1/B2/B3 commits; docs + CLOSED + CURRENT_GATE->G4/PR5; push only after all-green (one-shot URL, no token persisted) |
| CLOSED (this gate) | B1a `67391d6`; B2 `5958142`; B1b stage 1 `b531b4b`; E14 `a1a1428`; B1b stage 2 `e4da5b8`+`6af4e74`; B3 `7279344`; B1c `651cb04`; docs `b2583f0`+this commit. Deferred: fast-forward push (all-green gate satisfied) |
| NEXT | G5/PR6: supply the official environment/authorization (real API + target sandbox) — external; G7/PR7: continue remaining L2 carriers/asset acceptance and ledger closure |

| G5/PR6 (local, Slice 5a `89e6358`) | Conservative OfficialClient request policy (`model_request_policy.py`: max_tokens<=8192, public-only finish_reason/usage/thinking, missing usage = UNKNOWN not 0) + offline four-arm A/B/C/D harness & judge (`math_ab_harness.py`; C/D run offline via engine=ts, A/B honestly NOT_RUN). Docs REAL_API_CAPABILITIES/MATH_AB_REPORT/RUN_CONFIG_LOCK/RELEASE_BLOCKERS. Real API **NOT_RUN (BLOCKED_EXTERNAL)** |
| G6 (local, Slice 5b `829cb86`) | `release/BUILD_MANIFEST.json` + `scripts/build_release_manifest.py` (verify) binding precompiled JS sha256, source commit/tree, schema version, asset SHAs, locked run profile; precompiled JS launches engine=ts multi-turn E2E with no npm/tsc |
| G7/PR7 Slice 7a (`0839e9c`) | Run carriers platform/local/shared_public + recovery discipline (`host_carriers.py`) wired through `AgentRuntime` (validated mode) with cross-problem isolation at the real engine=ts entry (`tests/e2e/test_ts_g7_carriers.py`); budget may only tighten; OUTCOME_UNKNOWN never auto-replayed |
| G7/PR7 Slice 7b (`2e74675`) | Host math-asset registry + integrity (`host_assets_registry.py`): 10 output checkers + math families + skills + prompts; Python retained; Host-side scoped asset call enforced (`scoped_asset_call.py`: registry + scope hash + contractVersion{1,2}); MIGRATION_MATRIX evidence rows |
| G7/PR7 Slice 7c (this commit) | Controlled generative-execution gate (`generated_execution_gate.py`): fail-closed without an approved, bounded WASI profile; never host-runs model code. GATEBOARD/CAPABILITY_MATRIX updated |
| G7/PR7 Slice 7d (`5510160`) | Cross-process checkpoint/resume under engine=ts: `host_checkpoint.py` (signed/hashed export/verify/resume_plan; root budget only tightens; an in-flight `OUTCOME_UNKNOWN` blocks the resume and is never replayed) wired through `AgentRuntime`/`AgentHost`/`user_agent` plus the additive TS `session.solve` resume prefix (`agent-host-flow`/`agent-loop`/`agent-loop-io`/protocol, `agent-host-v13` schema); `tests/e2e/test_ts_g7_checkpoint_resume.py`. Node 311/0, e2e 213, pytest 615+24 |
| G7/PR7 Slice 7e host+registry layer (`f2c794d`) | 8th Host method `asset.scoped` (frozen method set synced across TS/Python/schema); `AgentHost.on_asset` -> `scoped_asset_call` -> bounded integrity descriptor, fixed-code fail-closed; `tests/e2e/test_ts_g7_scoped_assets_e2e.py` (10 outputCheckers + all mathFamilies; catalog enumerates 22). pytest 619+24. **TS M2/M3/M5 caller + S1/S3 evidence binding still PENDING -> Slice 7e NOT complete** |
| EXTERNAL BLOCKER (rounds 1-9) | dsh code-author channel (MaaS gateway, mass/deepseek-v4.1-flash) returned HTTP 503/429 for nine consecutive rounds; every dispatch was refused before any model call (safe failure, no new UNKNOWN, source unmodified). Remaining 7e TS caller / 7f / Intern S2 100-question eval await gateway recovery or supervisor-direct authorization |
| G7/PR7 Slice 7e (S1+S3 binding, `e3bf2e1`/`e5e6f5a`) | In the S1 gate `runAgentLoop` now issues one `asset.scoped` call (group `outputCheckers`, real registered checker key via `S1_CHECKER_ASSET`) when `ports.asset` is present, recording the descriptor sha256 into `privateState.s1AssetDescriptor`. **S3 binding added (`e5e6f5a`, gated to `maxRepairs>=1`)**: one `asset.scoped` (group `outputCheckers`) after `candidateGate.finalize`, descriptor sha256 into `privateState.s3AssetDescriptor`; default/redo-preview paths byte-identical. A refused descriptor is fail-closed / unset (never fabricated). `method.catalog`/`method.load` untouched. Node 313/0, pytest 619+24. **M2/M3 mathFamilies/skills/prompts consumption still PENDING -> 7e not yet fully complete** |
| LOCAL VERIFY (2026-10-16, DECISION-0155) | Independent re-run on a clean copy at `c5326a1`: `tsc -b` 0; `node --test` **314/0**; `python3 -m pytest -q` **663 passed / 24 skipped**; `tests/e2e` **261 collected**; `scripts/build_release_manifest.py --verify` **VERIFY_OK**; `MIGRATION_MATRIX.csv` **245 CLOSED / 15 REVIEW_REQUIRED**. Stale docs numbers 311/611/619 corrected. Still **NOT releasable** (preview profile, default engine `lite`, Slice 7e incomplete, external blockers). |
Gate status (corrected 2026-10-16, DECISION-0155): G2/G3/G4 **CLOSED**; G5/PR6 + G6 delivered as **locally-verifiable packages** (Slices 5a/5b); G7/PR7 in progress (Slices 7a-7f); G8/PR8 local pre-audit only.
Pending: G5 real official API + target environment (external); G6 approved L1 release; G7 remaining L2 carriers/asset acceptance and ledger closure; G8 independent full-inventory closure.

L1: NOT_COMPLETE. L2: NOT_COMPLETE. Do not create MIGRATION_COMPLETION.md as a
signed completion record while ownership/evidence gaps remain. Real API costs,
expanded permissions and default-engine switching retain their separate gates.

## Session update — 2026-10-19 (deep-loop repair closure + bounded multi-round review)

- **Baseline reds cleared**: the last missing `model-1..model-3` pin was in the
  S1 diagnostic ledger (`packages/math-audit/src/p4-s1.ts`), not in the repair
  branch itself. With it widened, the four-task PARAMETER flagship reaches the
  real REPAIR call: complete revision -> `REVISED_CANDIDATE`; partial revision
  -> fail-closed `REVISE_REJECTED`; both keep `candidateVerified=false`.
- **Checkpoint budget row** moved to the four-task graph's own checkpoint
  budget; the resume tightening semantics are unchanged.
- **Bounded review/repair rounds** are now implemented end to end: `R2` review
  of the protected candidate, one grounded `REPAIR`, then an `R4` re-review of
  the revised child, up to the synchronized `maxReviews`/`maxRepairs` cap of 3.
  The Host enforces one repair per review round, R4 only after a repair, and
  re-derives a REPAIR source's full scope/obligations from Host-owned `WORK`
  history for the next review.
- **New e2e**: `tests/e2e/test_ts_g3_multi_round.py` covers two complete
  `R2 -> REPAIR -> R4 -> REPAIR` rounds and a post-repair R4 where the repair
  budget is already spent and the first revision is kept.
- **Answer consensus + forced methods**: `maxConsensus` (0..8, default 0)
  adds a blind re-solve followed by full-proof adversarial audit turns; forced
  method consultation loads a real catalog card before the answer-bearing
  packet; choice problems must decide every option; long/partial/malformed
  packets are fail-closed or recovered through a Host-authorized CONSENSUS turn.
  Host projection collapses same-task WORK/CONSENSUS rows to the same artifact,
  including runs containing an unusable consensus packet.
- **Verified**: `tsc -b` 0; Node suite **330/330**; Python suite **695 passed,
  24 skipped, 0 failed**; `build_release_manifest.py --verify` `VERIFY_OK`.
- **Not claimed**: corrected accuracy. The historical 22-family / 20-card
  method layer remains unported.

### 2026-10-19 real 100-item pilot (local ReferenceJudge)

- Max2: strict **17/100**, 93/100 candidates, semantic **68/100**, 8.41 calls/item.
- Max8 merged (2026-10-20): **100/100 candidates**, strict **20/100**, same
  local semantic judge **80/100**, local per-item adjudicated review **91/100**
  (8 incorrect, 1 ambiguous; 91 includes targeted repair reruns; adjudicated merged baseline is 86/13/1 (78 second-pass correct + 8 manual promotions), strict 19), normalized **24/100**, **15.18 calls/item**
  (1518 requests), 9,110,467 tokens, 96 effect/method loads and 100 reviews.
- Seven unsolved: 4 `PACKET_REJECTED`, 2 `WORK_UNITS_COMPLETE`, 1 `ERROR`.
- **0.9.8 comparison**: strict **14 -> 19** (+5); the same local semantic judge
  gives 0.9.8 **70/100** vs TS max8 **80/100**; per-item adjudicated review is
  0.9.8 **75/100** vs TS max8 **91/100**; candidate hit 81 -> 100. 0.9.8 used
  **51.07 calls/item** vs **15.18** here. The review regimes differ, so these
  are reported separately.
- The max8 100-item run required batching because of the upstream input-token
  window; the merged valid result is reported above. The earlier 20-item max8
  pilot was 14.05 calls/item and semantic 13–14/20.
- Report: `docs/REAL_MODEL_PILOT_20261019.md`.

### Session update — 2026-10-21 (stability closure: Node/Host binding parity)

- WorkPacket identity fields are control data on both sides: TS
  `canonicalizeP2WorkPacketText` (receipt, P4 binding rebuild, revision target
  rebuild) and Python `trusted_packet_binding`/`checked_packet`.
- Dependencies are a duplicate-free **subset** of the declared refs everywhere.
- Consensus ballot keeps only non-empty candidates; a same-task run with no
  candidate at all falls back to its **first** packet (Node parity).
- Tests updated to the new contract (forged identity is rebound, undeclared
  assumptions / duplicate refs / bad JSON / empty claim still fail closed); new
  `tests/e2e/test_ts_binding_parity.py`.
- Gates: Node 334/334, Python 716 passed / 24 skipped, manifest `VERIFY_OK`.
- 12-item A-group failure subset: 11/12 candidates, 0 `FIELD_VALUE`.
