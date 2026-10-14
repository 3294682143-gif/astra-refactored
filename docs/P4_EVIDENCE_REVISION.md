# P4 evidence-gated candidate revision (G3/PR4 slice 1)

Design reference: `Astra_MathAgent_TS_RC2_DSH_Pi_融合执行方案_v4.0_最终.md` §4.4
"完成 M4/M5 风险—证据—修复—最终候选闭环", specifically the *候选保护改造*
(`CandidateManager.revise(old, proposal, evidence, coverage)`).

G2 is closed (`g2_complete=true`, DECISION-0138) and is not re-opened here: the
G2 suites are re-run only as anti-degradation regression.

## What this slice adds

`@astra/math-audit` now implements the S3 half of the PR4 closure as a pure,
testable capability:

- `reviseCandidate(contract, { parent, child, challenge, basis }, remainingMs)`
  (`packages/math-audit/src/p4-revise.ts`).
- Protocol DTO `P4ReviseBasis` (`packages/protocol/src/p4-repair.ts`) and two new
  final reasons `REVISED_CANDIDATE` / `REVISE_REJECTED`
  (`packages/protocol/src/p4.ts`).

The rule enforced is the §4.4 one: **protection must not become a permanent ban
on repair, and repair must not be a model opinion.**

A protected candidate is replaced by a revised child only when *all* hold:

1. the parent is the protected ACTIVE candidate whose goal has a real answer
   obligation;
2. an M4 challenge is `CHALLENGED`/`ACTIVE`, targets exactly that parent, and
   names the goal's *answer* obligation (a local premise/lemma claim can never
   justify replacing the whole-problem candidate);
3. the basis is grounded and independent — `level=CHECKED_SCOPE`,
   `checkResult=PASS`, `source ∈ {CHECKER_COUNTEREXAMPLE, PROVEN_COVERAGE_GAP}`, a
   non-empty witness, in the parent's scope, covering the challenged answer
   obligation and the child's coverage;
4. the child is a real revision: ACTIVE, same session/problem/contract/goal/scope,
   a non-empty candidate that differs from the parent's.

Every other case is fail-closed: the parent stays the candidate, the challenge
stays unresolved (`unresolvedChallenges=1`), and the decision records
`REVISE_REJECTED`. `candidateVerified` stays `false` and strict acceptance is
never performed — `S1 MATCH`, an R0/R1/R2 `NO_ISSUE`, and a checker's numeric
substitution do not close global exhaustiveness.

## Evidence (supervisor-run)

- `node --test` — **294 pass / 0 fail** (adds `p4-revise.test.ts` and
  `agent-loop-g3.test.ts`).
- `python -m pytest tests/e2e -q` — **188 passed** (adds
  `test_ts_g3_negatives.py`: unparseable R2 is `REVIEW_STOP` not a PASS; an
  upstream change without a counterexample is `STALE`, never `REFUTED`).
- `python -m pytest -q` — **574 passed / 24 skipped** (old WASI skips).
- `tsc -b` — 0.

## Online closure (slice 1b) — the loop wiring

The closure is now wired into the unique main loop for the opt-in
`maxRepairs >= 1` path (default 0 keeps every existing run byte-identical):

- After the R2 review settles with an ACTIVE `CHALLENGED` challenge on the
  answer obligation, the loop issues **one** `REPAIR` model call on the
  candidate task (a new additive `AgentModelPhase`), accepts the reply as a new
  `repair-1` artifact, and calls `reviseCandidate`.
- The grounding basis is a **Host-accepted `PROGRAM_OBSERVATION` checker receipt
  already bound to the goal scope** — a model opinion can never ground it. With
  no such checker, no repair call is made and the parent candidate stays.
- `agent-loop-g3.test.ts` proves the real loop run: `x(x-1)=0` first answers
  `{1}`, the R2 challenge + checker evidence revises to `{0,1}`
  (`reason=REVISED_CANDIDATE`), the `x=1` parent artifact is retained, and the
  no-checker / `maxRepairs=0` negatives stay `{1}` / `BEST_EFFORT_CANDIDATE`.

## Public entry (slice 2) — the real `engine="ts"` flagship

The loop closure is now reachable through the real public entry. The Python Host
accepts the additive `REPAIR` phase (`agent_client._PHASES`, `agent_host`
request/`_STOP_REASONS`/`_SUMMARY_FIELDS` + a `repairCalls` counter,
`agent_context.validate_context`/`_check_repair`, the v1.3 schema, and the
`project_artifacts`/`candidate_packet` REPAIR branches), and `maxRepairs` is
threaded from the Host options through the Node `agent-host-flow` into
`runAgentLoop`.

`tests/e2e/test_ts_g3_flagship.py` proves it end to end on the real
`user_agent.ReasoningAgent → Python Host ⇄ main.js --agent-loop` path:

- flagship: `x(x-1)=0`, the model answers `{1}`, one real registered checker
  action grounds the challenge, the review raises the missing-case challenge, and
  the single `REPAIR` call releases the revised `{0,1}` candidate
  (`status=candidate`, `reason=stopReason=REVISED_CANDIDATE`, `candidate_verified=false`);
- negative: the same run with `maxRepairs` unset (default 0) keeps `{1}` as an
  ordinary best-effort candidate — the challenge can never replace a candidate.

## Evidence (supervisor-run)

- `node --test` — **294 pass / 0 fail** (adds `p4-revise.test.ts` and
  `agent-loop-g3.test.ts`).
- `python -m pytest tests/e2e -q` — **190 passed** (adds
  `test_ts_g3_flagship.py` positive+negative and `test_ts_g3_negatives.py`).
- `python -m pytest -q` — **576 passed / 24 skipped** (old WASI skips).
- `tsc -b` — 0.



## Slice 3a (part 1) — M5 S1 original-problem mapping gate

Before a `PROGRAM_OBSERVATION` receipt may be promoted to a `P4ReviseBasis`
(`CHECKED_SCOPE` / `PASS`), the loop now runs the M5 S1 structural mapping check
(`P4DiagnosticLedger.precheck`) against the trusted target. The check plan is
control-built from the trusted candidate (scope, declared assumptions, tool
checked-property, `tool-registry-v1`) plus the challenged obligations.

- The checker must be bound to the **candidate task**; a checker executed on a
  foreign task (or with an unknown checker tool, or an obligation outside the
  target goal/scope) fails S1 and can never ground a revision (E07). The loop
  records the assessment in `privateState.s1Assessment`.
- `p4CheckedPropertyForTool` is exported from `@astra/math-audit` so the control
  side builds the S1 plan without re-implementing the tool→property mapping.

Tests: `apps/stdio-runtime/tests/agent-loop-g3.test.ts` — the flagship (checker
on the candidate task) still releases `{0,1}`; the new E07 negative (checker on a
foreign task) keeps `{1}` and makes no `REPAIR` call.

Still pending for Slice 3 (next increments): S2 M1 local obligation reopen on an
accepted revision; bounded R0 planning revision + R1 rule risk trigger; the
trusted `boundaryCases` versioned schema (3b); the multi-counterexample flagship
and formal G3/PR4 closure (3c).

## Slice 3c (part 1) — multi-counterexample fail-closed + E07 public entry

- `P4ReviseBasis` gains optional `requiredGaps` / `coveredGaps`. When the review
  proves several missing branches/counterexamples (`requiredGaps`), the revised
  child must cover **every** one of them (`coveredGaps` superset) or the revision
  is fail-closed `REVISE_REJECTED`. An empty, duplicated or over-broad required
  set is refused. Absent `requiredGaps` keeps the single-obligation rule
  (byte-compatible).
  Tests: `apps/stdio-runtime/tests/p4-revise.test.ts` (multi-counterexample
  positive; partial-repair refusal).
- E07 is now exercised at the real public entry:
  `tests/e2e/test_ts_g3_flagship.py::test_public_entry_e07_foreign_checker_cannot_ground_a_revision`
  — a checker bound to a foreign task is refused by S1, no `REPAIR` runs, the
  candidate stays `{1}` and strict acceptance is not performed.

Still pending for Slice 3 (not claimed done): 3a S2 M1 obligation reopen + bounded
R0/R1 (`E13`); 3b trusted `boundaryCases` versioned schema (`E04`); the
multi-counterexample **public-entry flagship** `(x-0)(x-1)(x-2)=0` (needs 3b's
trusted branch set); the remaining §6.1 E2E matrix rows (`E05`, `E06`, `E14`,
`E15`); `MIGRATION_MATRIX.csv` evidence rows; and the formal `G3 / PR4` CLOSED
decision.
