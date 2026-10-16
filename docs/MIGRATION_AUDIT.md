# Migration matrix — evidence re-audit (recomputed)

This audit recomputes `docs/MIGRATION_MATRIX.csv` from the current repository and the
current test tree. It does **not** reuse the previous report's counts.

## Method
For every row: behaviour/contract → current implementation (`target_paths`) → evidence
(`test`, `evidence`, new `coverage`) → closure reason.

Closure rule applied:
- **CLOSED** requires at least one cited **executable behaviour test** that exists in the
  tree (`coverage` column, `;`-separated). Shared tests may support several rows; the
  coverage column states the exact file, not a vague claim.
- Rows whose only support is a file mapping, module reference, registration, hash freeze
  or successful import — with **no** executable behaviour test — are **REVIEW_REQUIRED**.
- Deprecated/merged/not-applicable rows are recorded explicitly rather than closed.

Two asset classes are distinguished for `math_families/**`:
- **registered**: SHA-256 frozen + listed in the catalog baseline (integrity only).
- **consumed at runtime**: reached through a real scoped M3/M5 call path
  (`tests/bridge/test_g7_scoped_asset.py`) — this is the behaviour evidence that lets the
  row close. Hash-only (`registered`) rows are not treated as behaviour-equivalent.

## Recomputed result
| status | count |
|---|---|
| total | 260 |
| CLOSED | 250 |
| REVIEW_REQUIRED | 10 |

**Closed on a dedicated behaviour test (5)** — `tests/bridge/test_g8_retained_modules.py`
exercises the retained Python modules directly (review-input identity, purpose-specific
review identity, closeout-evidence collection, finalization selector, material-conflict
rule): `mathagent/closeout_evidence.py`, `mathagent/finalization.py`, `mathagent/review.py`,
`mathagent/review_context.py`, `mathagent/review_tasks.py`.

**Still REVIEW_REQUIRED (10)**
- MATH (1): `mathagent/workflows/closeout.py` — the `CloseoutWorkflow` still needs a
  dedicated behaviour test (its constructor requires a store/budget/clock/call/registrar/
  review/experiment graph); not closed on a mapping.
- DOC (9): `AGENTS.md`, `INSTALL.md`, `RC-INTEGRATION.md`, `README.md`,
  `docs/architecture_operations_0_8_5.md`, `docs/generated_python_wasi.md`,
  `docs/runtime_contract_0_8_6.md`, `docs/source_manifest.md`,
  `docs/target-runtime-capabilities.md` — need either a runbook smoke check or an explicit
  DOCUMENTED_CONTRACT disposition (documentation is not behaviour evidence).

## Remaining evidence gaps (next actions)
1. `mathagent/workflows/closeout.py` needs a dedicated behaviour test naming the retained
   module (or an explicit "not applicable in the TS engine" decision with its basis).
2. The 9 DOC rows need either a runbook smoke check or an explicit DOCUMENTED_CONTRACT
   disposition (documentation is not behaviour evidence).
3. `math_families/**` `registered`-only rows close on the scoped-call test; no row is
   closed on the hash freeze alone. If a scoped-call path does not exist for a family,
   the row must be reopened.
