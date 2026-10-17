# Naming decision and mapping — Zygos (ZY / 天轭)

Status: **decided (2026-10-17)**. This supersedes the earlier open naming question
(`DECISION-0156`). It is a *record*, not a source rename: **Phase A does not rename
code**. Code/distribution names migrate only in Phase B, after the entry conditions.

## 1. Frozen names

| Object | Name | Phase |
| --- | --- | --- |
| English product name | **Zygos** | A (docs) |
| Abbreviation | **ZY** | A (docs) |
| Chinese name | **天轭** | A (docs) |
| Chinese brand gloss | **天秤之轭** | A (docs) |
| Pronunciation (proposed brand reading) | **/ˈzaɪɡɒs/** | A (docs) |
| GitHub target repo | `zygos` | B |
| CLI | `zy` | B |
| TypeScript scope | `@zygos/*` | B |
| Runtime core package | `@zygos/runtime-core` | B |
| Python host module | `zygos` | B |
| Agent engine id | `engine="zygos"` | B |
| Env prefix | `ZYGOS_` | B |

- **Zygos** is the product name of a *general* Agent runtime; **Zygos MathAgent** is the
  first complete domain implementation. Mathematics is the current focus; no other
  domain's agent capability is claimed as verified.
- **Astra** is retained as the original project / compatibility entry / migration-history
  name. Historical commits, source identity, frozen assets, audit text and third-party
  attribution stay truthful.
- "天秤之轭" is a Chinese *brand gloss*; the pronunciation is a *proposed brand reading*.
  Neither is presented as a verified Greek etymology. No specific allusion (e.g. Plato's
  *Republic*) is written into the README without a reliable primary citation.

## 2. Current vs target identity (Phase A)

Phase A keeps the working technical identity, so install/import/commands stay accurate:

| Layer | Current (Phase A, working) | Target (Phase B) |
| --- | --- | --- |
| Repo | `astra-refactored` | `zygos` |
| Python import (host) | `mathagent`, `python.astra_bridge` | `zygos` |
| TS scope | `@astra/*` | `@zygos/*` |
| Engine id | `engine="ts"` | `engine="zygos"` (+ `ts` alias) |
| Env prefix | `ASTRA_*` / existing | `ZYGOS_*` |
| CLI | none (until defined) | `zy` |

The target names are marked as **targets** in docs; they are never described as an
already-available install (`pip install zygos`, `npm i @zygos/...`, `zy` are **not**
claimed until Phase B has actually shipped and been verified for that channel).

## 3. Distribution-name caveat

The Python **import** module `zygos` is decided, but the **PyPI project name** and the
`@zygos` npm scope / `zy` CLI name require separate availability + ownership checks
before anything is published (see `docs/RENAME_MIGRATION.md` §"Public name checks").
`import zygos` does not imply `pip install zygos` works.

## 4. Two-phase rule

- **Phase A (now):** brand the docs; complete internal runtime integration; do **not**
  mass-rename source/packages/CLI/env.
- **Phase B (after entry conditions):** one clean migration commit baseline, then batch
  renames (`@astra/* → @zygos/*`, host module `zygos`, `zy`, `engine="zygos"` + `ts` alias,
  `ZYGOS_` prefix), each batch buildable; regeneration of bundle/manifest by the real
  build tools (never hand-edited hashes).

See `docs/RENAME_MIGRATION.md` for the step list, compatibility rules and rollback.
