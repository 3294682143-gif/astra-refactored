# Deep-loop migration status

Status: **2026-10-19 local baseline is green; the bounded multi-round
review/repair loop, answer consensus, forced method consultation and
malformed-packet recovery are implemented; a 100-item real Intern-S2 pilot
was run.** The pilot is a local `ReferenceJudge` pilot, not a platform score.

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
  (8 incorrect, 1 ambiguous; 91 includes targeted repair reruns of #7/#13/#17/#52/#70; the single-run baseline is 86/13/1 and strict 19), format-normalized **24/100**, **15.18 calls/item**
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
