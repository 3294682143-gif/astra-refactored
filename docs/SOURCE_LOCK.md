# v4 source identity lock — G0 facts, not migration completion

Governing plan: `Astra_MathAgent_TS_RC2_DSH_Pi_融合执行方案_v4.0_最终.md`,
SHA-256 `1af5094c3c4a5d083975fadb3b09a05bf1b3bc3e04a16c4050bf02f3887201a7`.
Observed 2026-10-12. Commit and tree IDs are different Git object identities.

| Source | Commit SHA | Tree SHA |
| --- | --- | --- |
| RC2 / python-full-rc2-frozen | 049f35f7b6e6d957dd849030aaa4b7a848bbfa3c | 1c7752d585bafd907af3935b8e144be87d9da8d4 |
| a2 / frozen main | 1a58f637e362c4fb16826594adb162508b7a9158 | 4637b0b814e29161d697a8c839e6cce44acc2bc1 |
| TS / merged Integration PR1 | 1dc1113d4d89ad4f494c18a96fdc731674202c65 | 31f415ac0f7a6a442071992b0a55a6e61aa75de3 |
| deepseek-ai/deepseek-harness reference | 528c682e061696f5a160f363f236ecbf53cbd006 | 19e109115f57ace4170caf25dadbb59021126174 |
| earendil-works/pi reference | 97195ec3c4a40665a9008c3658e67b0782f33b18 | 4305792475c3c1cf9d6e601c710db411f79f0949 |

The RC2 Git tree contains 260 tracked files: 258 original source-bundle files
plus `.gitignore` and `AGENTS.md` import/governance files. The frozen TS base
contains 492 tracked files. These include code, assets, tests, configuration and
documentation; they are not counts of migrated capabilities. The a2 change
set relative to RC2 has 16 paths. All require explicit responsibility tracking.

For local Astra refs, reproduce with:

```sh
git rev-parse 'python-full-rc2-frozen^{commit}' 'python-full-rc2-frozen^{tree}'
git rev-parse 'main^{commit}' 'main^{tree}'
git rev-parse '1dc1113d4d89ad4f494c18a96fdc731674202c65^{commit}' '1dc1113d4d89ad4f494c18a96fdc731674202c65^{tree}'
git ls-tree -r -z -l python-full-rc2-frozen
git diff --name-status python-full-rc2-frozen main
```

DSH identities were read from committed Git objects in the existing local
checkout. That installation has unrelated working-tree changes and is not
claimed to be a clean reproduction of the reference tree. It is not modified
or bundled here. Pi commit/tree identities were read from the public GitHub Git
API after resolving public HEAD; this lock does not follow future HEAD changes.

| Reference file | Git blob SHA | License observation |
| --- | --- | --- |
| DSH LICENSE | c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785 | MIT, copyright 2026 DeepSeek |
| Pi LICENSE | b0a8e9b81083294360c69b4ec45d3d39a2b28197 | MIT, copyright 2025 Mario Zechner |
| Pi packages/agent/src/agent-loop.ts | f406aba5647adeb6d879a94d946a52436bfb6af3 | Mechanism reference only; no code imported |

Pi's observed `prepareRequest`, `finishTurn` and explicit-length tool barrier
are reference mechanisms, not proof of Astra compatibility. No Pi/DSH package
or new provider is added to the competition runtime. Direct reuse needs its own
license/compatibility decision; the existing Astra loop is retained.

The plan's companion CSV and `Astra_G0_source_inventory.py` were not found in
the supplied Astra/input locations. Replacement audit tooling and mapping seeds
are explicitly derived from the v4 plan, not presented as the missing original
attachments. Mechanical mapping never promotes a row to VERIFIED or CLOSED.

Official-target Node/subprocess permission, official-client capabilities and
WASI permission remain BLOCKED_EXTERNAL/TARGET_UNVERIFIED. Local Node 24.7.0
and Python 3.10.6 are development facts only. No real model math evaluation or
official deployment probe was performed for this lock.

## Mechanical inventory reproduction

The generated CSVs are snapshots of the frozen source/a2/TS commits above,
not the uncommitted working tree. Reproduce the migration rows with:

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/audit_source_inventory.py \
  --repo . --source-ref python-full-rc2-frozen --a2-ref main \
  --target-ref 1dc1113d4d89ad4f494c18a96fdc731674202c65 \
  --seed docs/source-locks-g0-rules.json --format csv
```

Exit 2 is the expected migration-closure refusal: 260 classified paths,
0 unmatched, 260 REVIEW_REQUIRED, 0 CLOSED. Target existence is only a Git-tree
path check, not behavioral parity. Rules assign candidate responsibility groups;
the broad SPLIT groups still need capability-level review. None is an approved
retirement or L2 deferral. `CAPABILITY_MATRIX.csv` records the candidate groups,
not a completed function inventory. `A2_SOURCE_CHANGES.csv` keeps the 16 changed
paths and their source/a2 object identities separately.

The DSH-authored script is read-only and emits stdout; it does not alter refs,
source files or evidence status. Supervisor checks passed five tests using real
temporary Git repos, including Unicode/tab paths, seed validation, conflicts,
ref-option rejection and conservative evidence state. No test result implies
that the mapped mathematics is already migrated.

G1 evidence overlay: the `user_agent.py` / EXPLICIT_TS_ENTRY rows now cite the
public-entry tests and target implementation commit
`f55dc1ec3656b6c252f810123ca236751a4c58ed`. Their status remains REVIEW_REQUIRED:
local entry progress is not full mathematical/target parity or L2 closure.
The command above reproduces the initial G0 mapping, not this curated evidence
overlay; never regenerate over independently recorded evidence silently.
