# Real Intern-S2 smoke — 2026-10-18 (not a benchmark)

This note records (a) a two-item engineering smoke and (b) a full local
100-item run, through the public `engine="ts"` entry. Neither is an L1 accuracy
score or an official result. No API key, authorization header or raw provider response
is stored in this repository.

## Configuration

- Endpoint: `https://chat.intern-ai.org.cn/api/v1/chat/completions`
- Model: `intern-s2` (server reports `Intern-S2`)
- Request shape: non-thinking, `temperature=0.2`, `top_p=0.9`,
  `max_tokens=8192`, non-streaming
- Public entry: `ReasoningAgent(client=..., engine="ts", mode="local")`
- Maximum profile used: `max_model_calls=32`, `max_work_units=32`,
  `max_effects=2`, `max_reviews=1`, `max_method_loads=1`, `max_repairs=1`,
  `max_r0=1`, `problem_seconds=1800`, `BEST_EFFORT`, `derive_budget=False`

## Direct one-shot reference (same model, same two items)

| test0 idx | expected | direct answer | usage |
| --- | --- | --- | --- |
| 4 | `4` | `4` | 49 tokens, 1.8 s |
| 41 | \((1+4x+\tfrac12x^2)e^{-2x}\) | same expression | 131 tokens, 1.2 s |

These are single calls with a direct-answer system prompt; they are not a
judge-scored baseline.

## Public TS entry after the schema prompt + bounded repair fix

| test0 idx | final response | status | calls | work units | review | effects | tokens | wall |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | `4` | `candidate` / `BEST_EFFORT_CANDIDATE` | 5 | 4 | 1 | 0 | 23,014 | 49.7 s |
| 41 | `y(x)=e^{-2x}(1+4x+\frac{x^2}{2})` | `candidate` / `BEST_EFFORT_CANDIDATE` | 4 | 1 | 1 | 1 (method load), 2 asset.scoped | 15,808 | 41.8 s |

Both final answers match the reference. `candidate_verified` remains `false`
and `strictAcceptance` remains `NOT_PERFORMED`; these are best-effort
candidates, not formally verified results.

## Before the fix (same public entry shape)

The same two items returned `Unsolved.` with `PACKET_REJECTED` after 1–2 model
calls. The model's raw replies were correct but used:

```json
{
  "deliveryStatus": "RUNNING",
  "candidateProposal": {"answer": "4", "complete": true}
}
```

The WorkPacket schema requires `deliveryStatus` in
`COMPLETE|INCOMPLETE|TRUNCATED|ERROR` and `candidateProposal` as
`string|null`. The prompt now states those types, and `max_repairs=1` permits
one same-task schema-repair turn; default `max_repairs=0` still fails closed.

## Scope warning

This smoke establishes only:

1. the real provider is reachable from the public Host path;
2. the model can follow the repaired WorkPacket prompt on two items;
3. a wheel-only install can launch the packaged TS bundle and schema.

It does **not** establish a 100-item accuracy, a comparison against RC2/a2, a
cost advantage, target-environment Node/subprocess permission, or L1/L2
completion. Formal G5 A/B/C/D remains `NOT_RUN (BLOCKED_EXTERNAL)`.

## Full `input/test0.txt` run (2026-10-18, local emulator)

A full 100-item local judge-emulator run was executed through the same public
entry and maximum profile, using the emulator's process-group isolation,
`item_concurrency=3`, `api_concurrency=3`, `model_max_attempts=1` and the
RequestStats client usage store. The latest report is outside the repository at
`/tmp/astra-test0-full2`; the earlier report of the same 100 items is
`/tmp/astra-test0-full`.

| metric | value |
| --- | ---: |
| items | 100 |
| candidate / best-effort | 93 |
| unsolved `PACKET_REJECTED` | 2 |
| unsolved `WORK_UNITS_COMPLETE` | 5 |
| model requests | 399 |
| reported tokens | 1,810,961 |
| wall time (3 concurrent) | ~35 minutes |
| emulator `ReferenceJudge` correct | 14/100 |

The **14/100 is a strict reference-string/numeric match**, not a mathematical
accuracy estimate. It counts `(A)` vs `A`, `A、B` vs `\nAB`, `P_3` equivalent
forms and natural-language equivalents as incorrect. Inspection found many
such formatting/normalization mismatches, as well as genuine model errors
(for example the second-order ODE item returned `1+2x` instead of `1+4x`).
The earlier run before the assumptions/scope repair had 25 `PACKET_REJECTED`
items; the current run has 2. The remaining 2 are the residual shape/control
edge case. The candidate count rose from 70 to 93, but the strict matcher still
under-counts and the average model-call depth stayed at about 4 calls/item.

This run is not an official score, not a 100-item human review, and not a
replacement for the required RC2/a2/TS same-budget comparison.

## Call-depth diagnosis and two bounded depth changes (2026-10-18)

The maximum profile now advertises `max_model_calls=256`, `max_work_units=64`.
The full run consumed **399 calls / 100 items = 3.99 calls per item, median 4,
maximum 6: not one item came near either cap**. The cap was never the binding
constraint. The binding constraint is the compiled task graph: one `VALUE` goal
emits `DOMAIN_VALIDITY`, `CANDIDATE_VALIDITY`, `OUTPUT_COVERAGE` (three WORK
calls) plus one `R2` review, so a successful item stops at four calls with
`WORK_UNITS_COMPLETE` and an unused budget of 252 calls.

Two bounded changes were made to the prompt contract, each measured on the same
first 20 items of `input/test0.txt` (identical `input_sha256`, same profile,
`item_concurrency=3`, `api_concurrency=3`, `model_max_attempts=1`):

| run | prompt state | candidates | calls (sum) | calls/item | effect calls | items using a tool | strict `ReferenceJudge` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/tmp/astra-test0-pilot20` | before | 18/20 | 74 | 3.70 | 0 | 0 | 2/20 |
| `/tmp/astra-test0-pilot20b` | + answer-task tool check | 18/20 | 84 | 4.20 | 7 | 6 | 2/20 |
| `/tmp/astra-test0-pilot20c` | + tool check + unsolved guard | 19/20 | 81 | 4.05 | 0 | 0 | 2/20 |

1. **Answer-task tool check.** The prompt previously said "do not call a tool
   when the task is already decided", which suppressed the numeric check and,
   with it, the only evidence that can ground the post-review repair path. The
   line now asks the answer-bearing task to run at least one registered-tool
   check of its answer while the effect budget allows it.
2. **Unsolved guard.** An `unsolved` action abandons a task for the rest of the
   run, so it is now reserved for unreadable or out-of-scope tasks. In the
   `pilot20b` intermediate state two items answered `unsolved` on the first WORK
   call and ended with 1 call and no candidate; the guard removed that failure
   mode (`pilot20c`: 19/20 candidates, no 1-call items, 4.05 calls/item).

What these numbers do **not** show:

- no accuracy gain: the strict matcher gives 2/20 in all three pilots, with the
  correct items changing between runs (`{0,10}` / `{4,10}` / `{10,19}` for three
  items whose answers differ only in formatting);
- the tool-check instruction is followed inconsistently (7 check calls in one
  run, 0 in the next), so the added depth is not yet structural;
- ~70 calls/item remains unreachable without porting the baseline multi-round
  solve/verify/repair controller, which is a different architecture, not a
  larger cap.

## Deep-loop step 1: the answer-check turn, and why depth is bounded by the Host

A candidate answer is only as good as the attempt to refute it, so the answer
task now carries one extra fixed paragraph in its **system prompt** (never in the
recorded user payload): try once to break the answer with a registered tool
before delivering. A unit test asserts that the flag changes only the system
message and leaves the payload byte-identical, so the Host-side context check is
untouched.

Two designs were rejected against the real Host because the protocol forbids
them, and that is the reason the depth ceiling is structural, not budgetary:

1. A separate `REPAIR`-phase verification call *before* the review is refused:
   `agent_host.py` pins the `REPAIR` phase to `max_repairs >= 1`,
   `review_calls == 1`, `repair_calls < 1`.
2. Dropping the first packet and re-asking the same task is refused as well: a
   `WORK`-phase request requires `task.delivery == "RUNNING"`, and the only
   post-delivery phases are `R2` and the single `REPAIR` revision.

Six 20-item real pilot runs of the same items (identical `input_sha256`, same
profile, `item_concurrency=3`, `api_concurrency=3`, `model_max_attempts=1`):

| run | change on top of the previous | candidates | calls | calls/item | check effects | items with a check | strict `ReferenceJudge` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `/tmp/astra-test0-pilot20` | before | 18/20 | 74 | 3.70 | 0 | 0 | 2/20 |
| `/tmp/astra-test0-pilot20b` | answer-task tool-check line | 18/20 | 84 | 4.20 | 7 | 6 | 2/20 |
| `/tmp/astra-test0-pilot20c` | + `unsolved` guard | 19/20 | 81 | 4.05 | 0 | 0 | 2/20 |
| `/tmp/astra-test0-pilot20d` | + directive answer-check turn | 18/20 | 87 | 4.35 | 7 | 7 | **4/20** |
| `/tmp/astra-test0-pilot20e` | shorter answer-check turn | 19/20 | 83 | 4.15 | 2 | 2 | 2/20 |
| `/tmp/astra-test0-pilot20f` | middle wording | 19/20 | 83 | 4.15 | 1 | 1 | 1/20 |

What this table supports and what it does not:

- the `unsolved` guard is the only monotone improvement: the two 1-call
  no-candidate items disappeared and candidate coverage stayed at 19/20;
- **the check is not reliably produced by any wording tested** (0, 1, 2 or 7 of
  20 items), so the "verify with a tool" behaviour is currently a model
  decision, not a control property;
- strict accuracy across the six runs ranges 1-4/20 with the correct items
  changing every time, which is indistinguishable from sampling noise at n=20;
  the single 4/20 run (`pilot20d`) also lost two items to `PACKET_REJECTED`, so
  it is not evidence of an improvement;
- consequently no accuracy claim is made here, and the earlier instruction not
  to read `ReferenceJudge` as math accuracy still applies.

Reaching the baseline's ~70 calls per item needs the multi-round
solve/verify/repair controller, which cannot be expressed inside the current
Host phase rules: it requires changing the Host protocol (both the Node loop and
`agent_host.py`) so that a verification round and more than one grounded
revision are legal. That is a protocol change with its own acceptance run, not a
prompt or cap change.

### Format-normalized comparison (not the official judge)

`/tmp/fmt_norm.py` applies one uniform normalization (NFKC, LaTeX command
stripping, whitespace/punctuation removal, outer bracket stripping) before
comparing the candidate with the reference answer:

| report | candidates | strict matcher | format-normalized |
| --- | ---: | ---: | ---: |
| `/tmp/astra-test0-full2` | 93/100 | 14 | 18 |
| `/tmp/astra-test0-full` | 70/100 | 16 | 19 |

The strict matcher therefore under-counts by about four items, not by an order
of magnitude: most remaining items are genuine mathematical differences. The
same 100 items at the frozen `0.9.8` baseline were scored 14/100 by the same
style of raw matcher with 5107-5325 calls, so the available evidence does not
support "more calls per item raises this score"; it supports "the remaining
errors are mathematical, not budgetary". Neither number is an official score,
and no 100-item human review exists.

---

## 2026-10-19 follow-up

A 20-item real Intern-S2 pilot on the four-task graph / bounded review loop is
recorded in `docs/REAL_MODEL_PILOT_20261019.md`. Strict local
`ReferenceJudge` was **2/20**, candidates **19/20**, normalized cross-check
**3/19 candidates**, and **0 repairs**. Review-schema compliance improved after
the prompt/locator fixes, but checker observations were nearly absent, so the
repair path was not exercised. This remains a local pilot, not a platform score.
