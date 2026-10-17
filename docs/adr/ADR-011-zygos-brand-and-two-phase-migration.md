# ADR-011 — Zygos naming, two-phase migration, and the authorized default-entry switch

Status: accepted (2026-10-17). Amends the "no default-engine switch / no rename" reservations
recorded in ADR-002 (Node runtime gate), ADR-005 (P1 offline prototype) and ADR-010 (v4 single
entry + external gates) **only to the extent below**.

## Context
- The product is named **Zygos (ZY / 天轭)**; `Astra` is retained as the original/compatibility
  name. Names and mapping are frozen in `docs/NAMING.md`.
- Earlier ADRs reserved: default engine stays `lite`; `engine="ts"` explicit-only; no rename.
- The current round authorizes: Phase A brand unification (docs), internal runtime integration,
  and — for the formal entry — `engine="ts"` as the default with `lite` explicit-only and **no
  silent fallback**; Phase B concentrated rename after the entry conditions.

## Decision
1. **Phase A (now):** brand docs as Zygos; keep working technical identity (`astra-refactored`,
   `@astra/*`, `mathagent`, `engine="ts"`). No mass source rename.
2. **Default official entry:** the formal default is the verified `engine="ts"` path; `lite`
   remains available only as an explicit choice; a failure on the TS path must surface as an
   error/unsolved result, never a silent fallback to `lite`/legacy. This supersedes the
   "default remains lite" reservation for the formal release entry.
3. **Phase B (after entry conditions in `docs/RENAME_MIGRATION.md`):** migrate
   `@astra/*→@zygos/*`, host module `zygos`, CLI `zy`, `engine="zygos"` (with `ts` alias),
   `ZYGOS_` prefix, in buildable batches; regenerate bundle/manifest with the real tools.
4. **Repo rename** (`astra-refactored → zygos`, same owner) only after local migration is
   verified and only with owner permission; keep history/Issues/version identity; no owner or
   default-branch changes; do not bypass protections.

## Consequences
- ADR-002/005/010 keep their IPC/security/gate content; their "no default switch" clause is
  narrowed by decision 2 above. A compatibility alias keeps `engine="ts"` working after Phase B,
  so existing callers and historical replay are not broken by the engine-id migration.
- The published artifact must bind the actual source: after any rename, bundle + manifest are
  regenerated, never hand-edited.
- Branding does not itself decide a version number and does not create new npm/PyPI channels.
- No publish is implied by this ADR; the original L1/L2 and G0–G8 gates still apply separately.
