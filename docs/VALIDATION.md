# 0.10.0a1 first-slice validation

Date: 2026-10-10. This record is written by the supervising assistant after
executing the checks; it is not an assertion that the coding model ran tests.

## Results

- `PYTHONDONTWRITEBYTECODE=1 python -m pytest -q --tb=short`:
  **66 passed, 24 skipped**, 2.60 seconds in the recorded environment.
- The 24 skipped cases are the existing actual-WASI acceptance suite. No
  accepted WASI profile was configured, so they are not counted as passes.
- Real local registered-operator subprocess checks passed for bounded
  polynomial expansion and rational linear systems. These are not model-based
  mathematical accuracy measurements.
- Existing L3/R4 delivery parsing passed separate positive and truncation
  negative checks; the new adapter branch does not replace those branches.
- `python -m pip wheel . --no-deps --no-build-isolation --no-index` succeeded,
  using existing local build/runtime dependencies without downloading packages.
- The wheel was extracted to a separate temporary directory and imported in a
  fresh isolated Python process outside the source tree. The default lite
  entry returned a candidate through a scripted three-argument public client;
  the legacy entry constructed; package and source versions both read
  `0.10.0a1`; the required general-method resources were present.
- Wheel contents excluded personal installation profiles, WASI binaries,
  mailboxes, run logs and SQLite ledgers.
- `git diff --check`, Python syntax checks and a common credential-pattern
  scan passed. Pattern scanning is a targeted check, not proof of absence of
  every possible secret.

## Supervision and corrections

Implementation patches came from dsh using MaaS `deepseek-v4.1-flash` and were
reviewed, applied and tested by the supervisor. The supervisor corrected one
contradictory explanatory docstring and wrote this validation record. Invalid
or no-op patches were not treated as completed implementation.

Review and tests caught and corrected shared question clocks, stale module
load time, numeric overflow in JSON, missing imports, wrong polynomial input
examples, exception feedback, final-turn budget accounting, explicit zero
public budgets, and an incorrect malformed-budget test expectation. Tool
isolation and the existing coordinator implementations were retained.

## Limits

This is the first implemented experimental refactor slice, not the entire
long-term architecture. Automatic difficulty escalation, on-demand method
selection in the lite path, native tool-call adapters and full WASI deployment
are not implemented here. The original Controller is an explicit alternative,
not an automatic fallback that receives fresh budget.

No real S2 mathematical evaluation, hidden-test access, platform submission or
accuracy-improvement measurement was performed. A well-formed complete final
action is an unverified candidate; `candidate_verified` remains false. The
injected official client remains authoritative for global resources and any
internal SDK retries. Public-budget snapshots are observations, not atomic
global reservations.

GitHub publication was not performed during these checks.
