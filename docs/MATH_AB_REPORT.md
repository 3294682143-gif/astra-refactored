# MATH_AB_REPORT — four-arm same-budget comparison (G5/PR6 local)

Arms (v4.0 §4.6): **A** = RC2 frozen; **B** = a2 `lite` (if rules allow);
**C** = TS behaviour-alignment profile; **D** = TS full math-mechanism profile.
All arms share a frozen model/toolset/budget/judge.

## Offline result (C/D) — RUN

`python/astra_bridge/math_ab_harness.py` runs the four-arm comparison. Offline,
**C and D run through the real `engine="ts"` entry with an injected fake client**
over a frozen corpus; **A and B are recorded `NOT_RUN (BLOCKED_EXTERNAL)`** and
are never faked. The judge reports per-cell: accuracy, right→wrong, wrong→right,
unsolved, missing branch, repair-retention, `length` truncation,
`OUTCOME_UNKNOWN`, wall time, known/unknown tokens
(`tests/e2e/test_ts_g5_ab.py`).

## Real S2 API comparison — NOT_RUN (BLOCKED_EXTERNAL)

The real four-arm accuracy/cost comparison requires the separately authorized
official API run and the frozen problem set; it has **not** been executed. No
accuracy, cost or "better than Python" claim is made. Thresholds, sample size and
call authorization must be fixed before that run (see `RUN_CONFIG_LOCK.md`).
