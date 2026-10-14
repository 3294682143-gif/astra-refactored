# RUN_CONFIG_LOCK — frozen run profiles (G5/PR6 local)

## TS comparison profiles (frozen)

| arm | meaning | profile |
| --- | --- | --- |
| C | TS behaviour alignment | `max_model_calls=8, max_work_units=3, max_effects=1, max_reviews=1, max_repairs=0, max_r0=0` |
| D | TS full math mechanism | `max_model_calls=8, max_work_units=3, max_effects=1, max_reviews=1, max_repairs=1, max_r0=1` |

Both arms share the same budget and the same judge; only the enhancement switches
differ. Source: `python/astra_bridge/math_ab_harness.py` (`ARM_PROFILES`).

## Replay identity (required for any evaluation)

`sourceCommit/tree`, `targetCommit/tree`, `promptVersion`, `runConfigHash`,
`problemHash`, `fakeResponseCorpusHash`, `methodAssetHash`, `judgeVersion`. The
judge is offline and deterministic; a real comparison must bind these fields and
is `NOT_RUN (BLOCKED_EXTERNAL)` until the official environment is supplied.

## Default engine

`user_agent.py` default engine is unchanged; `engine="ts"` remains explicit only.
