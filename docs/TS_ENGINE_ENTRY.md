# Explicit TS entry — v4 G1, G2A methods and bounded final confirmation

`ReasoningAgent(client=client, engine="ts").solve(problem, metadata)` now
launches the existing TypeScript AgentLoop through the single Node entry
`apps/stdio-runtime/dist/src/main.js --agent-loop`. The Python default is
`engine="ts"`; `lite` and `legacy` remain explicit alternatives. Missing Node or
compiled JS fails closed, with no automatic installation, compilation or
Python-solver fallback.

This is a locally verified production-shaped vertical slice, not official
deployment acceptance, L1 completion, L2 parity or a mathematical-score result.
Use a built source checkout. The current Python wheel does not bundle a Node
runtime or its compiled workspace, so an ordinary wheel install is not an
accepted TS distribution.

## Entry and responsibility boundary

Python retains the official entry, injected public `client.chat`, root deadline,
in-memory request journal, independent admission and existing registered math
execution. Node controls M1–M5 via the already accepted `runAgentLoop`; neither
the frozen Controller nor LiteRuntime is instantiated by the TS branch.

The Host reuses the P0 strict parser/selector pump and process cleanup. Node
reuses P2HostChannel. While `session.solve` is pending, the same reader serves
model/tool/method callbacks without a second parser or parallel solver. The active
`agent-host-v14.schema.json` defines version `1.4-unified-math-assets`, session
IDs, exact fields, nine allowed methods (including `math_asset.execute`) and
bounded frames. The 1.3 schema and the frozen 1.2
`agent-host.schema.json` remain explicit read-only compatibility artifacts;
live Host and Node reject the 1.2 profile. P0 remains the no-argument profile of
main.js and its probe behavior is unchanged.

Initialization declares `math-agent-preview-v2` and explicit capabilities:
injected model access, optional two-tool execution, opt-in read-only methods,
no generated Python, 8192 configured output tokens with verification false,
in-memory journal only, and an explicit-finish requirement for effects.

## Limits and completion signals

TS preview options are keyword-only:

| Option | Default | Accepted range |
| --- | ---: | --- |
| max_model_calls | 4 | 0..4 |
| max_work_units | 2 | 1..3 |
| max_effects | 1 | 0..2 |
| max_reviews | 1 | 0..1 |
| max_method_loads | 0 | 0..1 |
| problem_seconds | 5 | greater than 0 through 5 |
| policy | BEST_EFFORT | BEST_EFFORT or STRICT |
| node | node | trusted executable name/path |

These are conservative development-profile limits, not contest rules. Host time
starts at solve entry and includes startup, framing, calls, tools and closeout.
Only remaining durations cross the process boundary. Host, channel and Loop
can tighten the same root allowance, never renew it for another task.

The adapter calls only public `chat(messages=..., temperature=0.2,
max_tokens=8192)`. Explicit stop/end_turn permits COMPLETE; length produces
TRUNCATED and prevents that message's tool dispatch; content_filter produces
ERROR. A bare string or missing finish signal is conservatively UNKNOWN, not
an invented natural end or truncation. FakeClient E2E uses explicit stop
envelopes. Real official-client completeness capability remains unverified.

Unknown outcomes block subsequent calls on the same engine instance. A daemon
worker bounds local waiting under the original deadline; it does not cancel a
remote call or permit retry. Late completion cannot rewrite the settled journal.
This is process-local responsibility only, not durable exactly-once recovery.

Metrics distinguish actual client method calls, Node logical attempts, effects,
work units, reviews, catalog calls and method loads. Known HTTP attempts stay null when the public client
does not expose them. Public usage totals are aggregated by request; missing
usage stays unknown, not zero. Failure after a spent call preserves those counts.
Children are reaped and streams closed before the return's childReaped status
is determined.

## Context, tools and final output

Host checks exact message hash/bytes, original problem/session, task/scope/version,
prior complete dependency packets and same-task tool observations. A WorkPacket
comes from actual client response text, never from a field invented in the
request context. R2 checks bind to the earlier candidate's exact claim,
derivation, scope, coverage and hash derived from binding plus raw-response hash.

Only polynomial_expand_coefficients and linear_system_solution_set execute.
The Host independently compares each tool request to the immediately recorded,
complete WORK action and its actual binding, enforces global quota and remaining
model/review reserve, and calls the existing registered executor with the root
deadline. Tool completion remains a program observation, not proof. No arbitrary
model-generated Python, shell or network action is permitted.

With `max_method_loads=1`, sufficient follow-up/review capacity and a nonzero
effect allowance, the Host reads the existing General v1.1 method catalog once
before model requests. This metadata read consumes root time but no model or
effect slot. One explicit `method` action can load one catalog ID using the
existing read-only MethodCatalog. The load consumes the SAME global effect
allowance as registered tools, plus the method-specific cap of one; neither
tasks nor cache hits create a fresh budget. A failed attempt still spends its
slot. Default or insufficient-budget paths do not touch the reader.

WORK context v7 retains the complete validated catalog and loaded asset body,
title, version and integrity hash through the existing M3 preparation interface.
Only same-task receipts enter toolObservations; method text may persist across
tasks as advisory material, never a mathematical premise or verification.
Same-task identical requests reuse the original receipt without a new load or
fabricated binding. A new solve has no inherited cache. R2 receives no method
assets or catalog. Invalid assets stop as UNKNOWN; ordinary ERROR observations
can be consumed without loading an asset. Oversized contexts are refused, not
silently truncated or stripped of the catalog.

The existing strict `final` action can now confirm an already protected
candidate, never create or replace one. WORK context retains `allowFinal` and
a minimal `{binding, targetHash, answer}` projection. Confirmation requires
the exact old answer, complete=true and no unresolved items, in the same
session/problem/contract/scope with a strictly earlier source. Host rebuilds
the projection from the actual WorkPacket history; tool/model call ordinals
are not mistaken for artifact ordinals. Final raw text remains a model receipt,
not a synthesized WorkPacket or new artifact. Configured R2 still runs within
the same root capacity. A rejected final stops further calls and may retain
the old BEST_EFFORT candidate; STRICT still withholds it.

Historical v2–v6 WORK contexts have an explicit read-only validator; the active
Host requires v7. The 1.2 and 1.3 frame schema bytes are unchanged by this
context-only migration. Full event replay is still a later gate.

Version-2 WorkPackets may carry one strict, untrusted NEW_ROUTE suggestion.
The original raw packet is preserved. Under the existing capacity allowance,
TS can derive one new route/task for the source's pending obligation; Host
independently checks that provenance. The task has no cross-route mathematical
input refs and cannot replace the first protected candidate. See
G2_DYNAMIC_ROUTES.md for bounded admission, current test results and remaining gaps.

Version-3 WorkPackets may instead propose one DEPENDENT_TASK for the source's
pending obligation. M1 derives the child dependency and fills its real delivered
parent ref; M3 retains the actual raw artifact/version under the same route and
scope. The Host verifies the source chain, not just matching field names. Up to
three dependent WORKs and one R2 fit the same four model calls, without an extra
planning request. See G2_DEPENDENT_CHAIN.md; this does not implement revision,
mathematical acceptance or durable recovery.

Version-4 WorkPackets can request one bounded REDO_ARTIFACT. Admission alone
does not invalidate anything: an actual replacement WORK must pass M1/M3
preflight and changed-material checks before version+1 and scoped STALE
propagation occur. Failures retain old versions without refunding calls.
Host verifies the actual history and provenance. Protected-candidate replacement
is not granted by this action; a stale protected origin is withheld by S3.
See G2_ARTIFACT_REDO.md, including the redo-last-WORK preview limit.

The fixed ProgressPolicy yields only the current task after an explicit unsolved
reply, a valid partial delivery or two consecutive cached effect repeats. Another
actual ready task can then run under the same root; transport UNKNOWN/error/length
still stops the run and cannot be used for retry. Host checks the same policy and
prior task state, including exact ECMAScript non-empty text semantics. See
G2_PROGRESS_POLICY.md for acceptance and remaining limits.

M5 remains the mathematical final selector. Host only verifies the returned
answer's provenance and policy: it must equal the actual eligible candidate
packet, not an arbitrary new string. STRICT withholds unverified candidates;
BEST_EFFORT may retain a valid earlier unverified candidate after an inconclusive
review. The result's candidate_verified flag stays false. Public trace accepts
only fixed codes/IDs and no private problem text or provider exception text.

## Verification

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q tests/e2e
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
```

G1 baseline: 244 Node tests, 406 Python tests and 24 original optional
WASI skips. The original 20 public-entry E2E tests include nested RPC, real registered
polynomial execution with observation consumption, two/three work units,
dependency refs, distinct sessions, strict/cap-zero paths, disabled legacy
solvers, missing Node/dist, length/unknown barriers, timeout/late return,
tampered requests/tools/answer, invalid frames and child crash with spent-call
accounting. No live mathematical model API was used.

G2A adds direct TS method tests and 24 public-entry E2E cases, including the
real method reader and existing polynomial executor. See G2_METHOD_BRIDGE.md
for the acceptance scope and current supervisor verification record.

The final-confirmation slice adds five direct TS tests and 15 real-entry E2E
cases. The final checkpoint's entry suite had 59 passing tests, including
tool → WorkPacket → final → R2 in four calls with one artifact and one effect,
retained original target hashes, STRICT/no-review policies, illegal and
incomplete final actions, rehashed projection tampering and v2 read-only
context validation. This is not grounded candidate replacement or full G2.

Remaining: G2 dynamic routes/tasks/version transitions/progress, G3 grounded candidate repair,
G4 event-source replay and lifecycle hardening, authorized real-model/target
evaluation, release packaging, and L2 source-capability closure. G1 does not
remove those gates or approve a default-engine switch.
