# Explicit TS entry — v4 G1 / PR2

`ReasoningAgent(client=client, engine="ts").solve(problem, metadata)` now
launches the existing TypeScript AgentLoop through the single Node entry
`apps/stdio-runtime/dist/src/main.js --agent-loop`. The Python default remains
`lite`; `legacy` remains explicit. Missing Node or compiled JS fails closed,
with no automatic installation, compilation or Python-solver fallback.

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
model/tool callbacks without a second parser or parallel solver. The shared
`agent-host.schema.json` defines version `1.2-agent-loop-preview`, session IDs,
exact fields, five allowed methods and bounded frames. P0 remains the no-argument
profile of main.js and its probe behavior is unchanged.

Initialization declares `math-agent-preview-v1` and explicit capabilities:
injected model access, optional two-tool execution, no methods yet, no generated
Python, 8192 configured output tokens with verification false, in-memory journal
only, and an explicit-finish requirement for tools. Method bridging is G2 work.

## Limits and completion signals

TS preview options are keyword-only:

| Option | Default | Accepted range |
| --- | ---: | --- |
| max_model_calls | 4 | 0..4 |
| max_work_units | 2 | 1..3 |
| max_effects | 1 | 0..2 |
| max_reviews | 1 | 0..1 |
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
work units and reviews. Known HTTP attempts stay null when the public client
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

Supervisor results: 244 Node tests, 406 Python tests and 24 original optional
WASI skips. The 20 public-entry E2E tests include nested RPC, real registered
polynomial execution with observation consumption, two/three work units,
dependency refs, distinct sessions, strict/cap-zero paths, disabled legacy
solvers, missing Node/dist, length/unknown barriers, timeout/late return,
tampered requests/tools/answer, invalid frames and child crash with spent-call
accounting. No live mathematical model API was used.

Remaining: G2 dynamic routes/methods/progress, G3 grounded candidate repair,
G4 event-source replay and lifecycle hardening, authorized real-model/target
evaluation, release packaging, and L2 source-capability closure. G1 does not
remove those gates or approve a default-engine switch.
