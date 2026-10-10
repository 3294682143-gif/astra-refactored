# 0.10.0a2 second-slice validation

Date: 2026-10-10. Recorded by the supervising assistant after executing the
checks. Implementation patches were produced by dsh/MaaS
`deepseek-v4.1-flash`; the supervisor reviewed, applied and tested them. The
supervisor integrated the proposed documentation into the actual files and
corrected patch context markers; truncated or non-code responses were not
treated as implementation.

## Implemented and checked

- On-demand reading of the existing 20-method General Math v1.1 registry.
  The catalog exposes IDs/titles without pre-reading bodies; loaded bodies and
  the registry are checked against the existing SHA256 manifest.
- Canonical IDs, strict action fields, resource-root boundaries and symlink
  escape rejection. Missing or damaged resources cannot become successful loads.
- Independent per-problem method count/character limits, whole-body inclusion
  or refusal, final-turn restrictions, context reservation and optional-catalog
  omission without blocking otherwise valid direct reasoning.
- Method deduplication and exact computation-request deduplication. Cached tool
  observations do not become fresh verification. Oversized observations are
  not replayed; changed arguments can execute normally. A repeat can force an
  early closeout without resetting the original budget.

## Executed checks

- `PYTHONDONTWRITEBYTECODE=1 python -m pytest -q --tb=short`:
  **104 passed, 24 skipped**, 2.94 seconds in the recorded environment.
- The 24 skips are the pre-existing actual-WASI acceptance tests, for which no
  accepted installation profile was configured. They are not passes.
- An independent same-bytes symlink escape check passed: the escaped body would
  match the expected hash but the resource-root check still refuses it.
- An independent early-closeout check used a five-turn allowance: after two
  identical tool requests, a third changed-argument request was refused; only
  one tool execution occurred and the result remained unsolved/unverified.
- All original General Math resource-file hashes still match `SOURCE.json`.
  No method texts or manifest hashes were changed to make tests pass.
- `python -m pip wheel . --no-deps --no-build-isolation --no-index` built
  `astra_mathagent_s2-0.10.0a2-py3-none-any.whl` using existing dependencies.
- Fresh isolated Python processes imported both an extracted wheel and the
  wheel directly as a zip. Both resolved all 20 methods and completed a scripted
  method-then-final exchange in two public-client calls, with one whole body
  inclusion and `candidate_verified=false`. Source/distribution versions agreed.
- `git diff --check`, Python syntax checks and a common credential-pattern
  scan passed. The wheel excluded mailboxes, raw run logs, private installation
  profiles, WASI binary assets and SQLite ledgers.

## Evidence limits

These are offline engineering and local tool checks, not a mathematical score.
No real S2 evaluation, hidden-test access or platform submission was performed.
The method cards remain advisory; their prerequisites and the final candidate
are not automatically proven. Automatic full-Controller escalation, native
tool-call adapters and actual WASI deployment remain outside this slice.

The earlier a1 record remains in `docs/VALIDATION.md` for historical comparison.
