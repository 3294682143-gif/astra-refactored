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


