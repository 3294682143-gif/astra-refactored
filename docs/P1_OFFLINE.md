# P1 — offline TypeScript control-loop prototype

Scope: a user-approved local development exception, not official deployment
acceptance. See [ADR-005](adr/ADR-005-p1-offline-prototype.md). The five-module
design remains the implementation baseline; the P0 target gate is still
TARGET_UNVERIFIED. `user_agent.py`, the default engine and the old Python solver
are unchanged.

## Package ownership

| Package | P1 behaviour | Explicitly deferred |
| --- | --- | --- |
| `@astra/math-contract` (M1) | Exact problem text/hash, versioned contract and open answer obligation | Full mathematical obligation templates/task graph |
| `@astra/math-gateway` (M2) | Pure one-call admission with a closing-time reserve | Tool actions, deduplication and repair scheduling |
| `@astra/math-workunit` (M3) | Two-message context, one provisional versioned work result | Multi-route reasoning and method-card use |
| `@astra/math-review` (M4) | Explicit skipped review, no verification claim | R0/R1/R2 semantic review |
| `@astra/math-audit` (M5) | Identity/version checks and unverified candidate/unsolved selection | Complete S1/S2/S3 evidence/repair |
| `@astra/runtime-core` | Bounded immutable public events, private context projection, deadline/call view | Persistent recovery, general plugin container |

The five mathematical packages do not import one another. The stdio application
composes their public APIs. Runtime-core is infrastructure, not a sixth
mathematical module. Its immutable log and private context projection allow
read-only inspection without new model calls; this is not crash recovery or a
general-purpose replay engine.

## What actually runs

Python starts the compiled P1 Node script with a scrubbed environment. Node
compiles the minimal contract and asks Python for one `model.generate` callback.
Python checks identity, exact context and its hard budget, then calls a pure
in-memory `OfflineClient.chat` fixture. Node records the result, records the
skipped review, and selects a candidate or unsolved response. Python returns
that decision; it does not solve or choose a different answer.

All outputs say MOCK_ONLY and candidateVerified=false. COMPLETE refers to
fixture delivery, not mathematical correctness. TRUNCATED/ERROR/UNKNOWN, empty
text and zero-call budget cannot produce a candidate. UNKNOWN is a simulated
receipt case, not an unresolved real external request. No model credentials,
network adapter, mathematical tool or provider configuration exists in this
prototype entry.

The root limit is at most five seconds from entering the Python call, including
spawn/handshake; cleanup has a separate one-second reap bound. Node keeps a
deadline that only tightens. Normal operation uses eight frames; zero-budget
operation uses six. The common framing bound remains 65536 bytes excluding LF,
64 total frames and depth 24. Private problem/reply text never enters public
trace fields, which contain only fixed codes, modules and ordered sequence IDs.

## Local run

Use the already provisioned Node 24.7.0, pnpm 11.7.0 and locked developer
dependencies. If workspace links need refreshing, use an explicitly selected
existing pnpm cache with `pnpm install --offline --ignore-scripts --store-dir
<existing-cache>` and stop immediately if installation fails. Never continue
to a pnpm script after a cache miss: automatic installation was observed in
P0 and is not permitted in this workflow. No new external dependency is needed.

After successful offline setup, from the repository root:

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
python -m pytest -q
python -m python.astra_bridge.p1_offline --problem 'Synthetic offline prompt' --reply 'Fixture candidate, not a verified answer'
```

The CLI is a development fixture runner, not the official ReasoningAgent entry.
Missing Node, bad IPC and timeouts fail closed; they do not invoke the Python
solver. Dist files are generated locally and ignored in Git; this branch is
not a prepackaged competition submission.

## Acceptance record

Local offline slice accepted by the supervisor on 2026-10-10. These are actual
tests, not executor self-reports:

| Check | Observed result |
| --- | --- |
| Direct TypeScript project-reference build | Passed |
| Node test suites | 32 passed: original P0 16, module/runtime 10, P1 protocol 6 |
| Full Python suite | 189 passed; original 143 preserved plus 46 P1 tests; 24 WASI skips unchanged |
| P1 real Node/Host with in-memory client | Eight frames, one mock call, unverified candidate, child reaped |
| Zero-call budget | Six frames, no mock call, nonempty unsolved response |
| TRUNCATED/ERROR/UNKNOWN/empty/whitespace fixtures | Unsolved; no incomplete fixture promoted to a candidate |
| 20 consecutive independent P1 sessions | 20 unique session IDs; distinct private fixtures; file descriptors 4 before and after |
| P0 probe after P1 integration | Still eight frames, 20 catalog entries, child reaped |
| Frozen-lock offline workspace refresh | Passed using the explicitly selected existing cache; no download |
| Frozen source/default checks | user_agent.py, mathagent, math_families, Python project/dependencies unchanged |

Negative controls include wrong protocol/session/hash/IDs, repeated callbacks,
early stop, zero remaining time, short root deadline with stdin still open,
missing Node/script, invalid UTF-8/oversized/noisy stdout, crashed/silent children,
strict fixture validation before spawn, and no leakage of private text in trace.
The Host tests spy on the actual mock callback, disable both old solver paths,
and check real child reaping and pipe closure. They do not replace the Node
application with a mock controller.

Mathematical record IDs are session-scoped; causal references are distinct event
IDs derived as `sessionId:event:seq`, not record IDs masquerading as events.
Private context points at a recorded event; public snapshots and returned events
cannot mutate the internal log. Read-only projection does not dispatch calls.

Code patches were authored through the assigned dsh/MaaS DeepSeek executor and
independently reviewed/applied/tested. Budget/deadline, import-cycle, mutable-log,
callback-state, test-harness and identity-linkage defects found during review
were repaired before acceptance. The development executor is not part of the
shipped mathematical execution path.

P1 offline acceptance does not establish actual-client compatibility, official
Node/subprocess permission, math accuracy or P2/P4 module completion. Those
claims require separate evidence and approval.
