# Deep-loop migration status

Status: **2026-10-22 local baseline is green; the bounded multi-round
review/repair loop, answer consensus, forced method consultation,
malformed-packet recovery and four generic answer closures are implemented.**
The latest two-arm result is retry-default **99/100 candidates, strict 27/100**
and no-retry **88/100 candidates, strict 22/100**. These are local
`ReferenceJudge` results, not platform scores; see the §10.3 section at the
end of this file.

2026-10-21 A full 100-item rerun (frozen 36e056f, 10000-call arm, 4/4):
**68 correct / 12 incorrect / 12 unsolved / 8 ambiguous; strict 18/100;
88/100 candidates; 12 unsolved all `FIELD_VALUE`; 1459 requests; 9.739M
tokens; 14.59 calls/item.** The late-2026-10-20 exact tools/certificate
targeted reruns fixed #10/#12/#24/#35/#99 and gave 96/3/1, but that is a
targeted-repair diagnostic, not the full-run score. Priority is now
`FIELD_VALUE`/binding-schema stability; #12 and #35 still failed in the full
run. See `docs/REAL_MODEL_PILOT_20261019.md` and the A data root
`/tmp/astra-rerun-ab-10000-20261021-TrfJBe/`.

## Resolved baseline failures

The three previously red Python e2e rows are fixed:

1. **Multi-gap repair was refused before the repair call.** The S1 diagnostic
   ledger had a sixth copy of the old `model-1..model-3` request-id table
   (`packages/math-audit/src/p4-s1.ts`). With the four-task graph the checker
   effect was bound to `model-4`, so `precheck` threw `PACKET_BINDING` and S2
   set `REVISE_REJECTED` without ever dispatching REPAIR. The table is now the
   same three-digit ordinal pattern (`^model-(?:[1-9][0-9]{0,2})$`) used by the
   other request-id surfaces. A Node regression test covers `model-4` and
   `model-256`.
2. **Partial-repair reason.** With S2 actually running, a rejected revision
   now returns the revision decision (`REVISE_REJECTED`) instead of the
   fallback `BEST_EFFORT_CANDIDATE`; the complete repair returns
   `REVISED_CANDIDATE` and the revised candidate.
3. **Checkpoint budget assertion.** The checkpoint test now derives its
   tighter carrier from the checkpoint's own four-task budget instead of the
   old three-task constant; the tightening semantics are unchanged.

## Bounded multi-round review -> repair -> R4 re-review

- `apps/stdio-runtime/src/agent-loop.ts` now runs at most `maxReviews` bounded
  rounds. The first review is `R2`; after an accepted evidence-gated revision,
  the next review of the revised child is `R4`. A repair is attempted only
  while `maxRepairs` remains, and every round still requires the same S1
  structural mapping, substantive checker support, grounded basis and
  fail-closed gap coverage. The final candidate gate verifies the first `R2`
  review against the protected parent; the last revision decision remains the
  final candidate for `BEST_EFFORT`.
- A post-repair `R4` may run even when the repair budget is already spent; a
  new challenge then keeps the accepted revision and performs no further
  repair.
- `P4ReviewSession` accepts an explicit `R2`/`R4` stage; the report parser
  validates the matching stage. Review/request ordinal ceilings were widened
  to the shared 256-call root ceiling.
- The Host now accepts `R4`, allows up to three reviews and three repairs,
  permits at most one `REPAIR` per review round, and rejects an `R4` without a
  preceding repair. `REPAIR` sources are projected from Host-owned history for
  a second review: the full scope and obligation list are re-derived from the
  earlier `WORK` of the same task, never trusted from the Node body.
- Artifact identities for REPAIR rows now match the Host projection
  (`repair-<next accepted artifact>`), so a second review can re-bind the
  revised child exactly.
- Protocol schema, release schema, runtime option bounds, trace codes,
  checkpoint journal phases and the AgentSession trace ceiling (64 -> 128)
  were synchronized.
- New public-entry e2e: `tests/e2e/test_ts_g3_multi_round.py` runs two full
  `R2 -> REPAIR -> R4 -> REPAIR` rounds, and a tighter-budget case where the
  post-repair `R4` runs but keeps the first revision.
- Real-review compliance hardening: the review system prompt now spells out the
  exact JSON shapes (notably `reviewCoverage` as an obligation-id array) and
  asks for short exact derivation quotes. The review parser re-anchors a quote
  only when it occurs exactly once in the trusted derivation; missing or
  ambiguous quotes still fail closed. The candidate gate compares the raw model
  report with the normalized report while allowing only those recovered
  `stepLocator` offsets to differ.

## Real 100-item pilot (2026-10-19)

See `docs/REAL_MODEL_PILOT_20261019.md` and
`/tmp/astra-test0-full-final-20261019`.

- Strict `ReferenceJudge`: **17/100**; best-effort candidates **93/100**;
  local semantic-judge estimate **68/100**; format-normalized cross-check
  **22/93 candidates**. The semantic judge is an estimate, not an official or
  human verdict.
- Merged max8 100-item evaluation (same code, valid front segment plus small
  repair batches): **100/100 candidates**, strict **20/100**, same local
  semantic judge **80/100**, **local per-item adjudicated review 91/100**
  (8 incorrect, 1 ambiguous; 91 includes targeted repair reruns of #7/#13/#17/#52/#70; the adjudicated merged baseline is 86/13/1 (78 second-pass correct + 8 manual promotions) and strict 19), format-normalized **24/100**, **15.18 calls/item**
  (1518 requests), 9,110,467 reported tokens. The 0.9.8 outputs score **70/100**
  under the same semantic judge and **75/100** under its human review. See
  `docs/REAL_MODEL_PILOT_20261019.md`.
- **841** model requests / **4,739,444** total tokens / **8.41** calls per
  item (min 3, max 11); **96** effect calls, **95** method loads and **93**
  review calls.
- **213** work units delivered. Stop reasons: 82 `REVIEWS_COMPLETE`, 11
  `REVIEW_STOP`, 4 `PACKET_REJECTED`, 2 `WORK_UNITS_COMPLETE`, 1 `ERROR`.
- The run includes bounded answer consensus, forced method consultation,
  long-packet rejection/replacement, and malformed-packet recovery.
- The previous method+consensus full run produced 89/100 candidates and
  strict 18/100; the strict difference is model run-to-run variance, while
  candidate coverage and real work per item improved. The union of strict
  correct items across the two runs is 22.
- A 20-item audit pilot with `maxConsensus=8` used **14.05 calls/item**
  (281 requests, 1,742,925 tokens), 20/20 candidates and semantic **14/20**.
  A full 100-item max8 run was stopped by the upstream input-token quota
  (`HTTP 400 -20080`); it is not valid evidence.

## Historical 20-item pilot (2026-10-19)

See `/tmp/astra-test0-pilot20-r4d-20261019`.

- Strict `ReferenceJudge`: **2/20** (items #4, #10).
- Best-effort candidates: **19/20**.
- Format-normalized cross-check: **3/19 candidates** (#0, #4, #10).
- 100 model requests; 558,926 total tokens; 5.0 calls/item (max 7). That run
  predates the `maxConsensus` opt-in; a later consensus pilot was invalidated by
  repeated upstream HTTP 503/ProxyError responses and is not reported as a
  score.
- 15/19 reviews completed; 4 failed closed.
- **0 repairs**: 19/20 items produced no checker observation, so the bounded
  repair loop was never authorized. This remains the main real-model blocker.


## Bounded answer consensus (opt-in `maxConsensus`)

- `maxConsensus` is a separate 0..8 option, default 0, threaded through
  protocol/stdio runtime/Host/schema. With 0 the run is byte-identical.
- Every extra consensus turn after the blind attempt is an adversarial audit:
  it sees the current full claim/derivation and the previous proof, checks
  every counterexample, and for multiple-choice problems must decide every
  option. Candidate support is counted by exact candidate with latest tie;
  the Host projection uses the same rule.
- On the answer-bearing task the first complete WorkPacket is not delivered
  immediately. The loop makes one blind independent re-solve (`CONSENSUS`
  phase), and on a candidate disagreement one adjudication turn that sees both
  candidates. The selected packet is the one delivered as the WORKUNIT.
- `CONSENSUS` is not a Host artifact phase. The Host projection collapses a
  same-task run of WORK/CONSENSUS packets to one artifact (last
  candidate-bearing packet), so rejected/pass-through attempts do not shift
  artifact ids, event sequences or work-unit accounting. The full model history
  remains in the session log.
- New public-entry e2e `tests/e2e/test_ts_answer_consensus.py`: first `(A)`,
  blind attempt `(B)`, adjudication `(C)`; final candidate `(C)`, 5 model calls
  for the 3-task UNKNOWN graph, all 3 work units delivered.

## Forced method consultation and malformed-packet recovery

- After a COMPLETE answer draft, and only when `maxConsensus >= 1` and
  `maxMethodLoads >= 1`, the next WORK turn is replaced by one controlled
  `METHOD SELECTION TURN`. The model must return a real catalog card id; the
  ordinary Host effect path loads that card and the next WORK turn sees the
  card body as `methodAssets`.
- An INCOMPLETE draft does not trigger the forced method turn. The Host's
  progress projection already treats a raw partial packet as a task-level
  yield, so a subsequent WORK on the same task is rejected by the Host. The
  draft is instead handled by consensus or accepted as a fail-closed partial
  delivery.
- A complete draft whose claim, derivation or candidate exceeds the Host's
  4096-code-point WorkPacket bound is not accepted directly: a valid consensus
  attempt replaces it, otherwise the run stops as `PACKET_REJECTED` rather than
  producing a later `FIELD_VALUE` crash.
- When the first packet and its bounded schema repair are both unparseable,
  one Host-authorized CONSENSUS turn can recover a valid COMPLETE packet. The
  invalid raw text never becomes an artifact, and a recovered packet skips the
  ordinary consensus block so it cannot exceed the Host's consensus budget.

## Verified in this session

- `node node_modules/typescript/bin/tsc -b`: exit 0.
- Node suite: **330 / 330 pass**.
- Python suite: **695 passed, 24 skipped, 0 failed** (multi-round, consensus,
  forced-method, audit-chain and malformed-recovery e2e cases included).
- `python3 scripts/build_release_manifest.py --verify`: `VERIFY_OK`.
- The release bundle was rebuilt with esbuild after the last TS change; the
  final 100-item report ran against that rebuilt bundle.

## Not done / next work

- The headline local numbers are max8 merged **20/100 strict**, **80/100
  semantic**, **100/100 candidates**; max2 was 17/100 strict, 68/100 semantic,
  93/100 candidates. These are local judge estimates, not platform accuracy.
  Any report must keep strict, normalized, candidate coverage and platform
  scores separate.
- Seven items remain unsolved in the max2 100-item run: four
  `PACKET_REJECTED`, two `WORK_UNITS_COMPLETE`, one `FIELD_VALUE`. Several
  re-runs at lower concurrency produced candidates, so these are stochastic
  output/rate-limit edge cases rather than a deterministic missing task.
- The max8 100-item run needed batching because of the upstream token window;
  the merged valid result is 100/100 candidates, strict 20/100 and semantic
  80/100, now higher than the 0.9.8 same-judge result (70/100). The remaining
  work is platform/human validation and the still-unported 22-family / 20-card
  method layer.
- The historical method layer from `c3fcd62` / `2e5f35b` (22 families / 20
  cards, bounded multiple method loads, soft routing, stage quotas and the
  three R0 reviews) is still not ported. The current TS catalog remains a
  fixture-sized method surface.

## Stability closure: Node/Host parity on the trusted binding (2026-10-21)

Root cause of the remaining A-group `FIELD_VALUE` losses: the Python Host and the
Node loop disagreed about the same history, not about the model output.

- **Trusted binding.** The eight WorkPacket identity fields (`sessionId`,
  `problemHash`, `contractVersion`, `taskId`, `goalId`, `scopeId`, `routeId`,
  `sourceRequestId`) are control data. Both sides now replace exactly those
  fields with the trusted contract/task/scope/route/request values before the
  strict parse (`canonicalizeP2WorkPacketText` in TS; `trusted_packet_binding` +
  `checked_packet(text, binding)` in Python). Mathematics, the raw receipt text
  and its hash are untouched.
- **Dependency admission.** A duplicate-free subset of the task's declared input
  refs is legal on both sides. Foreign, repeated or version-shifted refs remain
  fixed rejections.
- **Ballot.** Only non-empty candidates enter the consensus ballot, compared with
  the shared JavaScript whitespace set. `CERT1|FINAL` still wins; otherwise
  exact-support majority with the latest tie-break.
- **First-packet fallback.** When no packet of a same-task run carries a
  candidate, the delivered artifact is the FIRST attempt of the run, mirroring
  Node's `candidateAttempts[...] ?? consensusAttempts[0]`. The Host previously
  projected the last attempt, which shifted `sourceRequestId` and made the next
  task's `check_inputs` fail closed.
- **Two real bugs.** `candidate_packet` shadowed the body schema version with a
  dependency ref's `artifactVersion`, so every G3/PR4 repair candidate was
  rejected; `agent_history` referenced an unimported `ProtocolError`.

Verification: `tsc -b` 0, Node 334/334, Python 716 passed / 24 skipped / 0
failed, manifest `VERIFY_OK`. On the 12 previously failing A-group items the
subset now yields 11/12 candidates and zero `FIELD_VALUE` (the single unsolved
item is a real transport `OUTCOME_UNKNOWN`, which stays fail-closed).

## §10.3 execution: item audit, answer closures and two-arm rerun (2026-10-22)

- **Full item audit of `/tmp/astra-full100-c9`:** two independent passes over ten
  disjoint batches plus a third adjudication of five disagreements. Result:
  **73 correct / 19 wrong / 5 disputed / 3 unsolved** (the concurrent batch-A
  review in HANDOFF §10.3 reports 77/20/3 with a different method; both are kept,
  neither replaces the other). Full artifact:
  `/tmp/astra-item-audit-20261022/review.jsonl`. The audit corrected HANDOFF
  §10.1 on item 1: `Q(∜5,i)` is not the splitting field of `x^4+5`; the
  reference's degree-16 field is also wrong. Item 64's reference is also wrong
  and the candidate `假` is right.
- **Generic answer closures:** new
  `apps/stdio-runtime/src/agent-answer-closure.ts` checks option coverage,
  degree conservation against an exact `MAXIMAL_MINORS` observation, density
  normalization, and exact-set solution completeness. `agent-loop.ts` spends at
  most one bounded WORK turn per answer after consensus/certificate, and adopts
  the closure packet only when it strictly reduces the defect count. The path is
  off when `maxConsensus < 1`. Regression coverage:
  `apps/stdio-runtime/tests/agent-answer-closure.test.ts` (7 cases) and
  `tests/e2e/test_ts_answer_closures.py` (4 real public-entry cases).
- **Two-arm full rerun** (same input sha256, 10000-call arm, 4/4 concurrency,
  same `MAX_PROFILE`, only the injected client differs):

  | Arm | Candidates | Strict | Calls | Tokens | Calls/item |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | retry-default | **99/100** | **27/100** | 1551 | 10,426,268 | 15.51 |
  | no-retry | **88/100** | **22/100** | 1501 | 10,014,540 | 15.01 |

  The retry arm's only unsolved item is #15: a malformed WorkPacket with an
  unescaped LaTeX backslash (`FIELD_VALUE`), not a transport failure. A
  single-item retry produced a candidate with the correct density in 9 calls
  (`/tmp/astra-one15-103-debug`); a second single-item retry produced a
  candidate with a wrong lognormal parameterisation (`/tmp/astra-lost15-103`).
  The no-retry arm has nine `remote_outcome_unknown` losses and three
  malformed-content `FIELD_VALUE` losses (#11/#15/#46).
- Gates: `tsc -b` 0; Node **341/341**; Python **722 passed / 24 skipped**;
  manifest `VERIFY_OK`; bundle rebuilt. These are local `ReferenceJudge`
  numbers, not platform scores; the strict scorer is format-sensitive.

## §12.5 tool/reliability implementation (this session)

- **Funnel telemetry:** `routed`, `forced`, `obeyed`, `observation_used`,
  `tool_effect_calls`, `method_effect_calls`, `tool_names`, `method_ids` are
  derived only from real SessionLog rows and effect records in
  `python/astra_bridge/agent_runtime.py`; identities are recorded in
  `python/astra_bridge/agent_host.py`. `observation_used` counts only an
  explicit `data.observationUsed === true`, so a captured-but-unused view is
  never overcounted.
- **Forced tool/method turns** are bounded protocol gates: one retry, then a
  fail-open best-effort packet with no fabricated receipt
  (`apps/stdio-runtime/src/agent-loop.ts`, `FORCED_TURN_RETRY`/`TOOL_ROUTE`).
- **Method cards leave the effect budget:** the public quota stays
  `maxEffects <= 2`, while the internal total capacity is
  `maxEffects + maxMethodLoads` (3), split by kind in both Node and Host. The
  schema summaries in all three copies plus `release/schema` were the stale
  binding; `summary.effectCalls.maximum` is now 3 everywhere, which removed the
  `FIELD_VALUE` rejection seen in the earlier 9-item pilot.
- **Whitelist 4 → 8 tools** in `packages/protocol/src/p3.ts`,
  `python/astra_bridge/p3_effect_contract.py` and all schema copies;
  `EFFECT_IDS` is `effect-1..3` in the Host, gateway, workunit and audit
  modules. `^` → `**` normalization happens at the executor seam
  (`mathagent/tools.py`), so the frozen `math_families/**` baseline is intact.
- **Canonical consensus ballot:** TS `canonicalAnswerKey` and Python
  `canonical_answer_key` agree byte-for-byte on the shared fixture vectors
  (`tests/bridge/fixtures/canonical_answer_keys.v2.json`), including lone option
  letters, fractions, solution sets, truth tokens and internal whitespace.
- **Failure coding:** `NO_SOLVE_RESULT`, `ILLEGAL_TRANSITION` and bounded
  `EXC_<Type>` codes replace the previous single `FIELD_VALUE` bucket on the
  Host seam, and the unsolved projection now carries `code`/`stage`/`childExit`/
  `childCode` so a lost item can be localized after the fact.

### Verification (final)

- `tsc -b` 0; Node **370/370**; full pytest **869 passed / 24 skipped**;
  focused bridge **458 passed**; agent e2e (closures/forced/consensus)
  **20 passed**; manifest `VERIFY_OK`; bundle rebuilt after the last source edit.
- **9-item real-API pilot** (`/tmp/astra-tools9-103c`, item-concurrency 3,
  240 model calls): 9/9 items returned without a runner exception — 8 candidates
  and 1 honest `unsolved`. Effects per item were 1 or 3 (never above capacity),
  `tool_effect_calls <= 2` and `method_effect_calls <= 1` on every item, and
  every routed item reported `routed == forced == obeyed` with
  `observation_used == 0` (no closure was expected there, so nothing was
  overcounted).
- One item (52-card distinct-suit/rank probability) ended `unsolved` with the
  old generic `FIELD_VALUE` after 18 model calls / 142k tokens and a truncated
  final response. It claimed no answer, so it is an infra-coded loss, not a
  wrong answer. Re-runs localised it to `stage: session.solve`,
  `childExit: None`, `childCode: None`, i.e. a frame Host-side rejection during
  the solve rather than a child crash.
- That same item, re-run a third time, returned the **correct** candidate
  `223/8330` in 21 model calls / 549 s with 3 effects
  (`routed == forced == obeyed == 2`). An offline enumeration of all
  `C(52,5) = 2,598,960` hands gives 69,576 / 2,598,960 = 223/8330, so the loss
  was intermittent infrastructure, not a capability gap.
- The Host's own refusals now carry their own codes: `BUDGET` for model /
  review / repair / consensus / effect quota refusals and
  `DEADLINE_EXCEEDED` for the root deadline floor, both previously reported as
  `FIELD_VALUE`.
- These numbers are not a score: 9 items cannot replace the 100-item blind arms
  in §12.6 of `HANDOFF.md`, and 86/91/96/97 remain forbidden as scores.

## 2026-10-23 closure→observation wiring

- **Root cause found for `observation_used == 0`:** `toolObservationViews` and
  `exactObservation` were declared *inside* the per-task loop body, while the
  semantic route fires on an earlier task; the answer task therefore started
  with empty views. Both are now hoisted to `runAgentLoop` scope and the exact
  observation is indexed by operation, so a later unrelated `exact_check_expr`
  result cannot overwrite a `MAXIMAL_MINORS` one.
- **Provenance instead of a kind allow-list:** every closure defect records
  `evidence: OBSERVATION | CERTIFICATE | TEXT`; `observationUsed` requires a real
  observation-grounded defect. Option coverage and solution completeness stay
  certificate-based and never claim an observation.
- **Telemetry:** each closure evaluation appends an `ANSWER_CLOSURE` row; Python
  derives `closure_evaluations`, `closure_defects`, `observation_views` in
  addition to `observation_used`.
- **Parsing:** `polynomialOf` now accepts unicode superscripts (`t²`), `⁻¹`,
  `−`, `·`, `×`; the multi-minor case takes the highest-degree invariant only
  when the minors agree, otherwise it reports nothing.
- **Real-API proof** (`/tmp/astra-observe6-107`): item #35 →
  `closure_evaluations=1, closure_defects=1, observation_views=1,
  observation_used=1`; item #2 → `views=1, def=0, USED=0`. Both the positive
  case and the honest zero now exist.
- **Still open:** the fix *rate* is unproven (#35 kept its downgraded answer),
  observation views are not yet keyed by task/input, closure runs at most once
  per run, and the `#16`-class items never reach the consensus block
  (`closure_evaluations=0`).
- Gates: `tsc -b` 0; Node **385/385**; full pytest **875 passed / 24 skipped**;
  focused bridge **464 passed**; manifest `VERIFY_OK`.

## 2026-10-23 method layer port (HANDOFF §5)

- **Real 20-card catalog with routing metadata on the wire.** `MethodCatalog.catalog(include_metadata=True)`
  returns bounded `tasks` / `objects` / `structures` / `role` per card; the default shape stays
  `{id, title}` so the legacy lite runtime is byte-identical. The Host bridge validates every
  token (≤6 items, ≤24 chars, `[a-z0-9_]`) and drops anything out of shape.
- **Bounded multiple card loads.** Effect ids widened 3 → 6 (`effect-1..6` in every TS copy and
  every schema), `maxMethodLoads ≤ 4`, `summary.effectCalls.maximum = 6`, capacity =
  `maxEffects (≤2) + maxMethodLoads (≤4)`. The frozen 1.2 contract keeps `effect-1/2` and bound 3,
  pinned by `test_legacy_manifest_keeps_its_narrow_effect_table`.
- **Soft routing before any body.** `semanticMethodRoute(problemText, entries)` scores each card by
  its own object/structure tokens against the problem wording, returns ≤3 candidates (score desc,
  id asc), never an id outside the catalog, and records `METHOD_ROUTE`. A metadata-free catalog
  leaves the prompt byte-identical to before.
- **Stage quotas host-side.** `front_budget = ceil(cap*25%)`, `tail_reserve = ceil(cap*10%)`, both
  integer-only; reviews/R0 exceeding the front allowance and candidate-stage `WORK` calls that
  would eat the reserve are refused with `BUDGET`. Metrics expose `front_budget` / `tail_reserve` /
  `front_spent`. Enabling `maxR0=1` lifts the front allowance to the stage's fixed four calls.
- **R0 three-review stage.** Roles `MEANING` / `METHOD` / `TASK_TOOL` each bind one dimension and
  each get their own `model.generate` (distinct root ids, disjoint prompts). A pure aggregator
  (`p4-r0-aggregate.ts`) applies ISSUES > UNKNOWN > NO_ISSUE with bounded `dissents` / `missing`.
  Only ISSUES proceeds to at most one revision plus exactly one `R0_RECHECK`; the root bound rises
  4 → 5 and a smaller budget yields `INSUFFICIENT_BUDGET` with zero calls. `maxR0` stays 0/1.
- Gates after the last source change: `tsc -b` 0, Node **407/407**, full pytest
  **909 passed / 24 skipped**, manifest `VERIFY_OK` after a bundle rebuild. Nothing committed.
