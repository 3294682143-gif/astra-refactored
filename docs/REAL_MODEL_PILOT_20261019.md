# Real Intern-S2 pilot — 2026-10-19 / 20

This is a **local pilot**, not a platform score. The model is `intern-s2`
through the real injected public client. Two judge numbers are reported:

- **strict `ReferenceJudge`** — the emulator's exact string/number match;
- **local semantic judge** — an independent model call comparing the candidate
  with the reference answer while ignoring formatting, TeX and equivalent
  algebraic forms. It is an estimate, not an official or human verdict.

The two must not be mixed.

## A full 100-item rerun (2026-10-21, current code)

This is the **current full-run result** and supersedes the targeted-repair
numbers as the headline score.

- Data root: `/tmp/astra-rerun-ab-10000-20261021-TrfJBe/`
- Frozen submission: commit `36e056f`, bundle sha256
  `f667d344665430ef92d214fd9c9047b736b9c01d71ef8dcf1a421ba7800326b6`
- Input: frozen `input.test0.jsonl`, sha256
  `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`
- Runner: item concurrency 4, API concurrency 4, arm `max_model_calls=10000`,
  per-item profile 256/64/2/2/1/2/8/1, max_tokens 8192.
- Per-item review: `A_item_review_v2.md` / `.json`.
- **68 correct / 12 incorrect / 12 unsolved / 8 ambiguous**
- strict `ReferenceJudge`: **18/100**
- candidates: **88/100**; all 12 unsolved are `FIELD_VALUE` + `NO_CANDIDATE`
- 1459 outer requests / 1459 attempts; 9,739,322 tokens; 14.59 calls/item

Unsolved: `#2,#6,#12,#15,#16,#35,#37,#43,#82,#86,#88,#100`.
Incorrect: `#7,#17,#19,#20,#21,#23,#30,#38,#46,#52,#70,#97`.
Ambiguous: `#8,#13,#27,#45,#48,#84,#95,#96`.

The earlier 96/97 figures were **targeted repair reruns**, not this full run.
In particular `#12` and `#35` were fixed in targeted reruns but still ended
`FIELD_VALUE` in this single full run. The immediate blocker is
`FIELD_VALUE`/binding-schema stability, not another accuracy claim.

## Full 100-item run (maxConsensus=2, audit prompt)

- Input: `/home/ma-user/work/input/test0.txt`, sha256
  `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`
- Report: `/tmp/astra-test0-full-final-20261019`
- Profile: `max_model_calls=256`, `max_work_units=64`, `max_effects=2`,
  `max_reviews=2`, `max_repairs=2`, `max_method_loads=1`,
  `max_consensus=2`, `max_r0=1`, `problem_seconds=1800`, `BEST_EFFORT`,
  `mode=local`; item concurrency 4, API concurrency 4.

| Metric | Value |
| --- | ---: |
| Strict `ReferenceJudge` | **17 / 100 = 17%** |
| Best-effort candidates | **93 / 100** |
| Local semantic judge | **68 / 100 = 68%** |
| Format-normalized cross-check | **22 / 93 candidates** |
| Model requests | 841 |
| Prompt / completion / total tokens | 4,313,714 / 425,730 / 4,739,444 |
| Calls per item | avg 8.41, min 3, max 11 |
| Work units / effects / methods / reviews | 213 / 96 / 95 / 93 |

Stop reasons: `REVIEWS_COMPLETE=82`, `REVIEW_STOP=11`,
`PACKET_REJECTED=4`, `WORK_UNITS_COMPLETE=2`, `ERROR=1`.

The seven unsolved items are listed in the report. This run still uses the
first-generation consensus block (one blind attempt plus one adjudication).

## Merged 100-item max8 evaluation (2026-10-20)

The max8 audit loop needs more input tokens than one upstream quota window
allows. To get a complete item set without weakening the per-item profile, the
run was split into the valid front segment plus two small repair batches. The
merged outputs use the same code, input and per-item profile; the report root is
`/tmp/astra-test0-merged-max8-20261020`.

| Metric | Value |
| --- | ---: |
| Best-effort candidates | **100 / 100** |
| Strict `ReferenceJudge` | **20 / 100** |
| Local semantic judge | **80 / 100 = 80%** |
| Format-normalized cross-check | **24 / 100** |
| Logical model calls | **1518** |
| Calls per item | avg **15.18**, min 13, max 17 |
| Reported tokens (merged batches) | **9,110,467** |
| Effect / method / review calls | 96 / 96 / 100 |
| Work units | 228 |

The 80/100 semantic result is from the same local judge prompt used on the
0.9.8 outputs below. It is an estimate, not a platform or human score.

## Per-item adjudicated review

A second, stricter independent semantic pass was run over all 100 merged
outputs, then every disagreement and every item whose reference answer was
questionable was checked against the problem statement and the existing 0.9.8
human adjudications. The conservative result is:

| Verdict | Count |
| --- | ---: |
| Fully correct | **91 / 100** |
| Incorrect | **8 / 100** |
| Ambiguous (reference under-specified; extra true property) | **1 / 100** |

The ambiguous item is test0 #44 (idx 43): the candidate gives
`symmetry + anti-reflexivity`, while the reference gives only `symmetry`.
The 8 incorrect items are #2, #10, #12, #19, #24, #35, #37 and #99. Seven items initially marked wrong by the judges were promoted after
reference/alternative review: #28 (idx 27), #48 (idx 47), #65 (idx 64), #77
(idx 76), #79 (idx 78), #84 (idx 83), #96 (idx 95). A separate exact
recomputation audit rerun fixed #13 (idx 12, 5117 -> 5129), and later exact-recomputation
batches fixed #7 (idx 6), #17 (idx 16), #52 (idx 51) and #70 (idx 69). The complete
per-item table and reasons are at `/tmp/astra-item-review-20261020.md`.

This 91/100 is a local adjudicated review, not a platform score and not a
formal proof check.

## Comparison with 0.9.8

The 0.9.8 baseline is
`/home/ma-user/work/Astra /baseline-runs/098-test0-intern-s2-20261002T140537Z`
(commit `c3fcd62`, same input hash):

| Metric | 0.9.8 | TS max2 | TS max8 (merged) |
| --- | ---: | ---: | ---: |
| Model requests per item | **51.07** (5107/100, median 36.5) | 8.41 (841/100) | **15.18** (1518/100) |
| Strict `ReferenceJudge` | **14 / 100** | 17 / 100 | **20 / 100** |
| Same local semantic judge | **70 / 100** | 68 / 100 | **80 / 100** |
| Local per-item adjudicated review | **75 / 100** (0.9.8 human review) | not performed | **91 / 100** |
| Candidate hit | 81 / 100 | 93 / 100 | **100 / 100** |

The like-for-like machine number is strict ReferenceJudge: **14 -> 20 (+6)**.
Applying the same local semantic judge to both sides gives **70 -> 80 (+10)**.
The local per-item adjudicated review is **91/100** versus 0.9.8's human
review **75/100**; the two were produced under different review regimes, so
they are shown separately rather than merged into one claim. Depth remains
lower on the TS side (15.18 vs 51.07 calls/item), but the merged result is the
first run where the deeper TS loop improves the strict, same-judge semantic and
adjudicated-review estimates over 0.9.8.

## Deeper audit iteration (maxConsensus=8, 20-item pilot)

The current code adds a full-proof adversarial audit loop: after the blind
independent attempt, each later consensus turn sees the current candidate's
full claim and derivation (and the previous candidate's proof when they
disagree), checks every counterexample, and returns a corrected WorkPacket.
For multiple-choice problems it additionally requires an explicit true/false
decision for every option. Voting is by exact candidate support with latest
tie-break; the Host projection uses the same support/tie rule.

- Report: `/tmp/astra-test0-pilot20-audit8-20261019`
- 20/20 candidates; **281 model requests, 14.05 calls/item** (min 6, max 17);
  **1,742,925 tokens**.
- Strict ReferenceJudge: **2/20**; format-normalized **5/20**.
- Local semantic judge: **13–14/20** (the prior max2 method pilot on the same
  20 items was **15/20**; the difference is model run-to-run variance, not a
  claimed accuracy gain).
- Two single 100-item max8 attempts were cut by the upstream token window
  (`HTTP 400 -20080`). They are not scored by themselves. The valid front
  segment was completed with small repair batches; the merged valid result is
  the **100/100 candidate, strict 20/100, semantic 80/100** table above. The
  earlier 20-item max8 pilot was 13–14/20 semantic, so the gain required the
  full repaired set and is not evidence from the 20 alone.

## Remaining work

- The max2 100-item run still has 7 fail-closed items (4 `PACKET_REJECTED`,
  2 `WORK_UNITS_COMPLETE`, 1 `ERROR`); several re-runs got candidates. The
  merged max8 run is 100/100 candidates.
- The 100-item max8 run needs batching because of the upstream token window;
  it is not a single uninterrupted emulator run. The merged report root is
  `/tmp/astra-test0-merged-max8-20261020`.
- The historical 0.9.8 method layer (22 families / 20 cards, multi-route
  planning, 69 registered tools, obligation scheduler) is still not ported;
  that is the main remaining depth and accuracy gap, together with platform
  and human review of the merged outputs.


## Generic exact-check / certificate iteration (2026-10-20 late)

This iteration adds two bounded, registered tools and a machine-readable final
certificate round. It does **not** add item ids, reference answers or targeted
skill cards to the solver.

- `exact_check_expr`: bounded `SIMPLIFY`, `TRIG_REDUCE`, `MAXIMAL_MINORS`,
  `FACTOR_OVER_EXTENSION`, `DEFINITE_INTEGRAL`, `LIMIT` and `DENSITY_CHECK`
  operations over the existing whitelisted expression parser.
- `bounded_enumeration`: exhaustive k-subset counting over an explicit object
  table or a Cartesian-product `ranges` universe; the predicate is a bounded
  `distinct/count/size/sum/min/max/contains` expression.
- A final `CERTIFICATE SELF-CHECK` turn requires compact `CERT1|CHECK`,
  `CERT1|OPTIONS`, `CERT1|VERDICT` and `CERT1|FINAL` rows. A certified packet
  wins over correlated audit repeats in both Node and the Host projection.
- Finite counting problems get one forced `bounded_enumeration` turn; explicit
  determinant/field/distribution/trig/limit objects get one forced
  `exact_check_expr` turn. These triggers are selected from the mathematical
  object in the problem text, never from the item id.
- A verdict-consistency closure and a density-normalization closure were added;
  `FIELD_VALUE` schema failures may be repaired up to twice.

Targeted reruns on the eight previously incorrect items (same `maxConsensus=8`
profile, independent `ReferenceJudge` plus manual mathematical review; **not a
blind 100-item run**):

| Item | New candidate | Verdict | Calls | Notes |
| ---: | --- | --- | ---: | --- |
| #10 | `2/π` | correct | 15 | strict judge `B` only because the reference is TeX `\frac{2}{\pi}` |
| #12 | `223/8330` | correct | 18 | forced enumeration returned favorable `69,576 / 2,598,960` |
| #24 | `15 + 45/2 e^{-4t}cos x + 9e^{-16t}cos 2x + 3/2 e^{-36t}cos 3x` | correct | 15 | strict `A` |
| #35 | `t^6 - 5t^5 + 10t^4 - 13t^3 + 10t^2 - 5t + 1` | correct | 18 | forced `MAXIMAL_MINORS`; strict `A` |
| #99 | `假` | correct (semantic) | 18 | strict `B`; reference token is `错误` |
| #2 | `Q(5^{1/4}, i); 8; 是` | incorrect | 18 | candidate field misses the roots; the reference `Q(5^{1/4},ζ_8),16` is also not the minimal splitting field |
| #19 | `2Φ(x)Φ(x/2)-1` | incorrect | 17 | `DENSITY_CHECK` reported integral `0.295...`, not 1; the model did not repair it |
| #37 | `A、C` | incorrect | 15 | reference and standard definition are `A、C、D`; option D is a definitional statement the model keeps rejecting |

The ambiguous item #44 is unchanged: its candidate `对称性、反自反性` is
mathematically complete for the stated brother relation, while the reference
lists only `对称`. That is a reference/answer-key issue, not a solver defect.

If these five corrected rows are substituted into the previously repaired
100-item adjudicated table, the local count becomes **96 correct / 3 incorrect
/ 1 ambiguous**; the strict `ReferenceJudge` count is **22/100** (only #24 and
#35 become exact-string matches). If #44's extra true property is accepted
under a completeness rubric, the count is **97 correct / 3 incorrect / 0
ambiguous**; the conservative table keeps it ambiguous. This is a **targeted
repair rerun count**, not one uninterrupted blind 100-item run.

The historical `86` baseline is itself an **adjudicated merged baseline**, not a
single automatic run: the second stricter semantic pass scored 78 correct / 21
incorrect / 1 ambiguous; 8 of the 21 were manually promoted after
reference/alternative review (idx 27,47,57,64,76,78,83,95 = #28,#48,#58,#65,
#77,#79,#84,#96), giving 86 correct / 13 incorrect / 1 ambiguous. Five later
targeted repairs (idx 6,12,16,51,69 = #7,#13,#17,#52,#70) produced the 91/8/1
table. Strict `19/100` belongs to the pre-repair merged snapshot and is a
separate exact matcher; the current merged output directory includes later
repairs, so recomputing strict there gives 20/100. Do not present 86/91/96/97
as one blind full-run score.
