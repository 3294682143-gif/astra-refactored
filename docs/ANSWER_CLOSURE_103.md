# HANDOFF §10.3 answer closures (2026-10-22)

This slice adds four generic, answer-free controls to the answer-bearing
consensus path. They are diagnostics and bounded closure requests, not
verification: `candidateVerified` stays false and no tool result or model
self-check becomes a proof.

## What changed

- `apps/stdio-runtime/src/agent-answer-closure.ts` (new, pure):
  - **OPTION_COVERAGE** reads the option letters stated by the problem and
    checks that a `CERT1|OPTIONS` table covers exactly that set. A short answer
    made only of option letters with no table is also a defect.
  - **DEGREE_CONSERVATION** compares a candidate univariate polynomial with a
    single exact `MAXIMAL_MINORS` polynomial observation. A lower-degree factor
    cannot replace the full invariant.
  - **NORMALIZATION** rejects a `DENSITY_CHECK` observation whose integral is
    not 1, and requires a passing `DENSITY_CHECK` row (or exact observation) for
    a formula-shaped continuous density answer.
  - **SOLUTION_COMPLETENESS** compares an explicit rational candidate set with
    the independently solved complete rational set, and otherwise requires a
    `CERT1|COMPLETENESS|... => PASS` marker when the problem asks for all
    solutions/cases.
- `apps/stdio-runtime/src/agent-loop.ts` captures the latest exact-tool result
  and, after the selected consensus/certificate packet, spends at most one
  bounded `WORK` turn on a defect note. A closure packet replaces the candidate
  only when it strictly reduces the machine-visible defect count. The path is
  disabled when `maxConsensus < 1`.
- `apps/stdio-runtime/src/agent-semantics.ts` exports canonical rational-set
  keys used by the completeness check.
- The final certificate prompt now uses the same option-letter extractor, so a
  problem whose first option follows full-width punctuation is still asked for
  complete option coverage.

## Regression coverage

- `apps/stdio-runtime/tests/agent-answer-closure.test.ts`: 7 pure cases.
- `tests/e2e/test_ts_answer_closures.py`: 4 real public-entry e2e cases using
  the real Host, Node loop, bundle/dist entry and registered exact-check tool
  where applicable:
  - incomplete option table -> missing option added;
  - degree-2 candidate vs exact degree-6 maximal minor -> full polynomial
    restored;
  - unnormalized density -> normalized density plus `DENSITY_CHECK`;
  - incomplete `{1}` vs independently solved `x^2=1` -> complete `{-1,1}`.

Focused e2e run: `4 passed`. Full Node suite: `341 passed`. Full pytest:
`722 passed, 24 skipped`. `tsc -b` 0 and manifest `VERIFY_OK`.

## Live rerun

Both arms used `input.test0.txt` (sha256
`d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`), the
same 10000-call / 8192-token / 4+4 runner configuration, and the same
`MAX_PROFILE` (256 calls, 64 units, 2 effects, 2 reviews, 1 method load,
2 repairs, 8 consensus, 1 R0, 1800 s, BEST_EFFORT, local). Only the injected
client's transport policy differs.

| Arm | Candidates | Strict | Calls | Tokens | Calls/item |
| --- | ---: | ---: | ---: | ---: | ---: |
| retry-default (`real_client_factory_retry`) | **99/100** | **27/100** | 1551 | 10,426,268 | 15.51 |
| no-retry control (`no_retry_factory`) | **88/100** | **22/100** | 1501 | 10,014,540 | 15.01 |

The retry arm's only lost candidate is #15 (`FIELD_VALUE`: the model emitted a
WorkPacket with an unescaped LaTeX backslash, not a transport failure). A
single-item retry took 9 calls and returned a candidate with the mathematically
correct density (first output at
`/tmp/astra-one15-103-debug`); a second single-item retry returned a candidate
but a different, wrong lognormal parameterisation
(`/tmp/astra-lost15-103`). The loss is therefore stochastic model/protocol
output, not a deterministic task or binding failure.

The no-retry arm has 12 unsolved rows: 9 carry
`remote_outcome_unknown=true` (transport/HTTP), and 3 are malformed-content
`FIELD_VALUE` (#11, #15, #46). The strict scores count all 100 items in the
denominator and remain format-sensitive local `ReferenceJudge` results, not
platform scores.

The full human audit of the earlier c9 run (independent of these two arms) is
**73 correct / 19 wrong / 5 disputed / 3 unsolved**, with the full artifact in
`/tmp/astra-item-audit-20261022` and a repository summary in
`docs/ITEM_AUDIT_20261022.md`. The machine-readable two-arm summary is
`/tmp/astra-full100-103-summary.json`
(sha256 `4f628325f5ffef20dd7ee6f6d19a2c9163b6c74a6982ddc2d796b7c657bd6c75`).
