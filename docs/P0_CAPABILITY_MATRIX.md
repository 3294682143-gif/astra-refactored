# P0 capability and acceptance matrix

Scope: five-module TS plan, local P0 only. Date: 2026-10-10.
Supervisor acceptance is separate from executor-authored implementation.

Historical P0 acceptance record at `ea25042`. Subsequent P1 offline development
is separately scoped by [ADR-005](adr/ADR-005-p1-offline-prototype.md); it does not
upgrade any TARGET_UNVERIFIED entry below.

Evidence labels:

- LOCAL_VERIFIED: an actual local check was run; not official-platform evidence.
- SOURCE_ONLY: rules or archived source inspection; no live capability test.
- TARGET_UNVERIFIED: official runtime/permission/behavior still unestablished.
- NOT_TESTED: no corresponding execution in this slice.

| Capability | Local evidence | Official target |
| --- | --- | --- |
| Python official entry and injected public client | SOURCE_ONLY: supplied rules require ReasoningAgent/solve; current entry unchanged | TARGET_UNVERIFIED for TS integration |
| Node and child-process stdio | LOCAL_VERIFIED: Node 24.7.0 and real initialize→catalog callback→probe→stop; child exit 0 | TARGET_UNVERIFIED; rules do not guarantee Node/subprocess |
| TS build/workspace | LOCAL_VERIFIED: pnpm 11.7.0, TS 6.0.3, @types/node 22.20.0; offline resolution, no downloads | TARGET_UNVERIFIED |
| Method resources | LOCAL_VERIFIED: existing MethodCatalog returns 20 integrity-checked ID/title entries | TARGET_UNVERIFIED for final package/permission; no body transfer in P0 |
| Protocol/Host negative tests and root deadline | LOCAL_VERIFIED: 16 TS tests and 39 additional Python P0 tests; see record below | TARGET_UNVERIFIED |
| client.chat public signature | SOURCE_ONLY: rules messages/temperature/max_tokens; archived source adds optional keywords | TARGET_UNVERIFIED for actual accepted args and errors |
| 8192 output limit | NOT_TESTED: configured=8192, verified=false only | TARGET_UNVERIFIED; not asserted as provider maximum |
| thinking/usage/stream/native tool calls/cancel | NOT_TESTED; disabled/unavailable in P0 | TARGET_UNVERIFIED |
| Writable files/persisted audit log | NOT_TESTED as a deployment feature; P0 holds state in memory | TARGET_UNVERIFIED |
| WASI/tool permission and sandbox | NOT_TESTED in P0; disabled, 24 baseline acceptance tests skipped | TARGET_UNVERIFIED; no host-generated Python fallback |
| Frozen baseline regression | LOCAL_VERIFIED: original 104 passed within full 143 passed / 24 WASI skipped | Does not measure TS math quality |
| Competition-ready JS/Node distribution | NOT_TESTED; dist/node_modules excluded from source branch | TARGET_UNVERIFIED; clean artifact gate required |
| Real mathematical quality/API comparison | NOT_TESTED; no real math API request made | P6 scope, requires separate budget/approval |

## Source identities

No raw evaluator data, credentials, development mailbox, or personal installation
paths are included. Source evidence inspected locally:

| Source | SHA256 |
| --- | --- |
| User final five-module design | 266b3372329b189e6d012734cd81ca02abe0b5cd350c4164b3fa2fc511ffc5fe |
| Supplied 初赛要求.md | 9262901e9dac6613259467e8914a024ada265c835c61249abff9c4654664d2fe |
| Archived official-baseline llm_client.py | 1da165e26a13651f4a812be11a836edd040912fc8ba0691e6746fb5a3277f737 |

These are source identities, not a claim of live verification by the organizer.

## Acceptance decision

Local protocol/probe slice accepted. Reproducible commands actually run:

| Command/check | Observed result |
| --- | --- |
| pnpm install --offline --frozen-lockfile --ignore-scripts | Passed; no package download; real lock/workspace links |
| pnpm test:ts | 16 passed, 0 failed; includes the shared 20-case corpus |
| python -m pytest -q | 143 passed, 24 skipped (WASI profile not provisioned); original 104 tests preserved |
| python -m python.astra_bridge.p0_probe | 8 frames; 20 catalog entries; callback acknowledged; child reaped |
| 20 consecutive real probes after session-ID repair | 20 unique sessions; process FD count 4 before and after |
| Node launched with stdin held open and no frames | Exit 1 after approximately 5.07 seconds, DEADLINE_EXCEEDED |
| git diff --check | Passed |

Committed tests cover malformed/duplicate/oversized/invalid-UTF8 frames, safe
numbers, scalar schema parity, depth and Unicode boundaries, wrong IDs/sessions,
forbidden methods, repeated callbacks, early stop, missing Node/script, EOF/crash,
deadline, stderr flood, environment scrubbing, child cleanup and nonblocking pipe
backpressure. The 64-frame budget test is a Host guard unit test: the normal
P0 state machine exchanges only eight frames, not 64 live accepted operations.

Additional supervisor diagnostics exercised an in-memory synthetic Node peer:
one valid session and ten wrong-ID/session/payload/callback/nonce/count/tail/hang
cases all produced the expected result and reaped/closed their child. These are
diagnostics, not extra committed regression-test counts. The executor's proposed
synthetic-peer test harness was rejected (wrong interpreter and missing mode
argument), so it is not shipped or counted as passing. Its independent frame
budget unit was retained and run.

Limits: local Host uses POSIX pipe selectors; portability to other OS/runtime
policies is not established. The standalone pnpm binary's internal Node engine
warning is documented in P0_RUNBOOK; probe/tests use Node 24.7.0.

Clean-checkout caveat: the first temporary checkout resolved a different pnpm
store, failed offline installation, and its subsequent pnpm test command
automatically downloaded the three locked developer dependencies. The automated
install path was stopped and the runbook changed to direct Node build/test
commands. That checkout's passing tests are not evidence of an offline clean
install. A second clean checkout of source commit `af3e195` was independently
tested with the original pre-provisioned store selected explicitly: three
packages reused, zero downloaded; direct Node compilation and all 16 TS / 143
Python tests passed (24 WASI skipped), and the real probe succeeded. Only these
documentation clarifications changed after that source commit. This is clean
local source-checkout reproduction, not a clean official deployment package.
No new package version, runtime dependency or math API was introduced.

P0 official deployment gate remains TARGET_UNVERIFIED. P1–P7, mathematical API
evaluation, default-engine switching, and platform submission have not been
executed. Publishing a development branch does not pass any of those gates.

Next release decision requires an authorized official-equivalent container probe,
documented Node/subprocess permissions and runtime limits, actual public-client
capability evidence, and explicit approval to enter P1. P1 then implements the
minimum real TS model→final/unsolved loop with the old Python solver disabled.
