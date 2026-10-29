# Zygos rename & migration plan (Phase B preparation)

This is the executable plan for Phase B (concentrated code/distribution rename). It is
prepared during Phase A but **not executed** until the entry conditions below hold.
Names and mapping are frozen in `docs/NAMING.md`.

## Entry conditions (all must hold)
1. Python Host + unified TS AgentLoop stable; math-acceptance and repair positive/negative
   cases pass (source, real loop, public Python entry, final bundle).
2. Real API integration verified under its own contract (simulated ports do not count).
3. Standard type-check/build/applicable regressions + a real distribution install pass.
4. Migration scope, compatibility strategy and rollback written; the pre-rename baseline
   commit is recorded and traceable.

If a condition is missing (e.g. real API), finish Phase A + name inventory + reproducible
migration steps + a candidate package, and mark **Phase B not executed** — do not mass-rename.

## Baseline & rollback
- Before Phase B, record a **pre-rename baseline commit** (the last fully verified commit on
  the working branch) and its tree SHA; tag it locally if helpful. Every rename batch starts
  from a buildable commit; a failed batch reverts to the previous batch commit.
- Never `push --force`, never rewrite history, never move a published tag, never edit a
  frozen baseline to make a rename pass.

## Migration batches (each must build)
1. TS scope `@astra/* → @zygos/*`; core package becomes `@zygos/runtime-core`. Update
   imports/exports, workspace config, lockfiles, build scripts, resource locators.
2. Python host module → `zygos` (thin forwarders for old public modules; no second registry
   or singleton). Distribution project name only after a real, owned PyPI name is confirmed.
3. CLI `zy` (help/version/diagnostics consistent with the real implementation).
4. Engine id `engine="zygos"` mapping to the **same** TS implementation as `engine="ts"`
   (compat alias); `lite` stays explicit-only; unknown engines refused (no silent lite).
5. Env prefix `ASTRA_* → ZYGOS_*` (readers, schema, CLI, examples, CI, manifest, docs).
   `ZYGOS_*` wins when both present; old name emits a non-sensitive deprecation notice;
   illegal new value fails loudly (no silent fallback to the old value).
6. Regenerate bundle/manifest/derived artifacts with the real build tools.

Use `rg` to build a reference inventory first; edit by semantics, **not** a global
find-replace. Do not rename third-party names, frozen evaluations, historical records,
source identity, license attribution or original math evidence. Any residual old name
needs an allow-list entry + reason.

## Compatibility rules
- Old Python modules that are already public get thin forwarders or a documented migration
  path; never load two registries/singletons.
- Old CLI (if it belongs to this project) gets an explicit transition strategy; do not grab
  an unrelated command.
- Old checkpoint/event/cache/IPC/schema/asset-manifest identity: if it stores an old name,
  migrate with an explicit version + read adapter (validate raw first, then a traceable
  conversion, keeping the provenance/responsibility chain). Never string-replace inside
  signed/hashed/frozen files, and never replay an `OUTCOME_UNKNOWN` request as a side effect.
- Verify old-checkpoint resume, task isolation, budget-only-tightens, continuous resume and
  evidence binding still hold; formats that cannot be migrated are refused clearly (no
  "lossless" claim).

## Repo rename (remote)
Do the GitHub repo rename (`astra-refactored → zygos`, same owner) only after the local
migration is verified and references are revised, and only with the owner/permission in hand.
Do not change owner, default branch, or account/org settings; do not bypass protection rules.
Inventory and re-verify: repo URL, git remotes, CI, badges, docs, Pages, Actions/reusable
workflow refs, release config, package source links. Do not infer Actions/publish auth from
web redirects. Keep history/Issues/version identity; do not create an unrelated repo.

## Public name checks (do early; record date + source)

**Results recorded 2026-10-17 in [NAMING_VERIFICATION.md](NAMING_VERIFICATION.md)** (GitHub,
npm, PyPI, CLI, brand/trademark leads + required actions). Summary: all channels are
**UNKNOWN** pending owner/registry checks; the `zy` CLI name has collision risk; a real
same-name legal-software brand and an abandoned USPTO `ZYGOS` application are leads (not a
clearance). Plain search is never a legal no-conflict guarantee.

- **GitHub:** does owner `3294682143-gif` have `zygos` available / rename permission? Goal is
  continuity of the same repo identity.
  - 2026-10-17 read-only probe: `git ls-remote https://github.com/3294682143-gif/zygos.git`
    → **"Repository not found"** ⇒ availability/ownership **UNKNOWN** (may exist privately or
    be taken); requires an owner-side check (no API token scopes were used).
- **npm:** `@zygos` scope ownership + per-package publish permission (unknown until checked).
- **Python:** import module vs distribution project name vs install collisions — check
  separately; do not install an unverified same-name third-party package.
- **CLI:** `zy` command conflicts in supported environments (no single global registry proves
  uniqueness; never shadow an unrelated program).
- **Brand:** record public same-name products + potential trademark leads with date/source;
  a plain search is **not** a legal no-conflict guarantee.

Occupied/permission-missing findings keep the decided brand; report the affected channel and
the required action. Do not invent a different name or open paid services.

## Verification after Phase B (each supported channel separately)
- Type-check, build, applicable Node/Python tests, cross-process E2E, asset verification,
  migration audit — all on the **final artifact**.
- Build → clean-env install → **leave the source dir** → official default entry → solve →
  method-card consumption → math-algorithm call → cancel/resume. No editable install, manual
  copy, source `PYTHONPATH`, dev `node_modules` or runtime `tsc`.
- Channels without naming permission are reported "not published"; a local package verify is
  never written up as a public-registry release.
