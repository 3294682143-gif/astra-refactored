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

- `node --test` — **291 pass / 0 fail** (adds `apps/stdio-runtime/tests/p4-revise.test.ts`:
  flagship `{1} -> {0,1}`, the full refusal matrix, stale/forged negatives, and
  the "revision is the only sanctioned replacement" guard).
- `python -m pytest tests/e2e -q` — **188 passed** (adds
  `tests/e2e/test_ts_g3_negatives.py`: unparseable R2 is `REVIEW_STOP` not a
  PASS; an upstream change without a counterexample is `STALE`, never `REFUTED`).
- `python -m pytest -q` — **574 passed / 24 skipped** (old WASI skips).
- `tsc -b` — 0.

## Not yet wired (next slice)

The *online* closure — an independent review/check that raises the challenge,
an S2 repair turn that produces the child, and the M1 obligation reopen — is not
yet connected to `runAgentLoop`. Doing so needs a coordinated Node + Python Host
change: the Host currently forbids any `WORK` after the single `R2` review
(`agent_host.py` `if self.review_calls > 0: _fail()`), so the repair turn needs a
new provenance-gated slot. That wire change is the next PR4 slice; it is
deliberately kept out of this slice so the 287/186/572 baseline keeps zero
regressions.
