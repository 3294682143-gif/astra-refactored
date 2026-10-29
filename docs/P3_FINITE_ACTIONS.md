# P3 finite-action offline loop

This increment adds a TypeScript finite-action controller and a thin Python
adapter over existing isolated operators. It is an opt-in fixture library,
not a new production agent or a complete P3 migration. P2 Host protocol
`1.1-p2-host-local`, the official entry point, original solver, resources and
dependencies are unchanged. Deployment remains TARGET_UNVERIFIED.

## Composition and boundaries

`runP3Fixture` in `apps/stdio-runtime/src/p3-fixture.ts` composes the existing
M1 contract/ledger, M2 model/effect gates and M3 context preparation. The
mathematical packages import shared protocol types, not one another. Only
the app composition root joins them.

The runner accepts a problem, session ID, at most three literal fixture
receipts, and trusted options: maxTurns 0..3, maxEffects 0..2, remainingMs
1..5000, effectPort or null, and an optional test clock. There is no real
model client, provider configuration or network dispatch. It selects a
candidate-bearing ready task and keeps that task RUNNING throughout the
action sequence. A final action is not converted into a fake WorkPacket or
artifact; no mathematical obligation is satisfied.

M2 accepts exactly four JSON shapes:

- tool: action, name, args, scope;
- method: action, id;
- final: action, answer, complete, unresolved;
- unsolved: action, reason.

Duplicate/extra keys, floats, unsafe/nonfinite numbers, lone surrogates,
excessive depth, invalid IDs and oversized material are rejected. Tool scope
wording is only intent; trusted session/problem/contract/task/scope/request
bindings come from the controller. The only tool names are
`polynomial_expand_coefficients` and `linear_system_solution_set`.

## Effects, caching and stopping

Action proposal, effect admission, dispatch and observation are separate.
M2 records ADMITTED → DISPATCHED → OBSERVED, or OUTCOME_UNKNOWN. A wrong
receipt identity, source, hash or evidence label cannot settle the gate.
The composition root converts an invalid receipt or thrown port call to a
bound UNKNOWN outcome and stops without retrying. A successful tool receipt
remains PROVISIONAL with checkResult UNKNOWN.

Canonical tool name/arguments identify duplicate calls; object-key order and
scope wording do not change identity, while array order does. A method ID is
its cache key. COMPLETE and fixed ERROR receipts are reusable; UNKNOWN is
not. Repetition preserves the original receipt/source request and adds no
second observation or port call. At most two effects and one distinct method
attempt are admitted. Cached requests consume model turns but no new effect
slot. The last model turn permits only final or unsolved, including when a
tool request would otherwise hit the cache.

One root deadline includes preparation and port time, with a 25 ms closeout
reserve. The runner captures options/port binding before clock callbacks and
rejects nonfinite, throwing or regressing clocks. Late outcomes cannot become
candidates or enter subsequent contexts; an UNKNOWN remains UNKNOWN even
when time also expires. These synchronous trusted-port checks are not a
hard preemption mechanism for arbitrary callbacks. The real integration
tests additionally bound the Python subprocess; production Host deadline
and transport integration remains future work.

`python -m python.astra_bridge.p3_effects` reads one strict request from stdin
and returns one bound JSON receipt. It uses the original RegisteredExecutor,
including input validation, isolated worker and original audit, or the
existing integrity-checking MethodCatalog adapter. It executes no generated
Python/shell, accepts no resource path, and enables no additional operator.
Malformed input and failures use fixed codes without exception text. An
unserializable or oversized observation is refused whole; the current adapter
uses OUTPUT_TOO_LARGE for either serialization/size failure.

## Context and result provenance

Every prepared request retains exact private messages, their SHA256/UTF-8
byte count, request identity, and the consumed fixture receipt if dispatched.
The hash and byte count both cover `JSON.stringify(messages)`. M3 retains the
full problem, task, obligations, prior COMPLETE history and unique bound
observations. Individual observations are at most 16000 UTF-8 bytes; the
whole serialized context is at most 65536 bytes. Oversized contexts stop;
critical material is never silently trimmed. System instructions describe
problem/history/effects as untrusted data, not instructions or proof.

The return value separates `public` from `private`. Public data contains
fixed codes, counts, trace, status and the designated candidate text, with
MOCK_ONLY, TARGET_UNVERIFIED, candidateVerified=false and
strictAcceptance=NOT_PERFORMED. Private data contains exact contexts,
receipts, M1 state and gate snapshots. Do not expose the whole private result
as a user trace. Hashes check integrity, not authenticity or mathematical
correctness. Gate snapshots retain latest states, not a durable event journal.

Only a COMPLETE fixture transport carrying final with complete=true and an
empty unresolved list yields a candidate. Tool output never becomes an
answer directly. Incomplete finals, malformed actions and non-COMPLETE
transport stop without a candidate. M4/M5 verification, formal client
integration, full action policy, route changes and full a2 parity are not
implemented by this slice.

## Verification

From an already provisioned checkout:

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
```

Supervisor verification on 2026-10-11: 86 Node tests passed (77 prior plus
9 new groups); 288 Python tests passed (265 prior plus 23 new), with the
same 24 optional WASI skips. Real-process synthetic cases check polynomial
coefficients, the linear solution vector, method body integrity, once-only
dispatch and full next-turn observation. Negative controls cover malformed
actions/bindings, altered receipts, quotas, clocks, UNKNOWN handling and
context overflow. Python checks worker cleanup and invalid arguments before
worker dispatch. These are engineering tests, not competition/API accuracy
measurements.

The assigned dsh DeepSeek executor authored implementation and test patches.
The supervisor reviewed/applied them, corrected mechanical path/import/patch
ordering issues and test-fixture clock/list/expected-state wiring, without
changing business rules or removing assertions. Truncated additions were
withheld except complete, independently valid test groups. Additional
supervisor diagnostics passed 24 controls, including actual root fail-closed
outcomes, non-retry counts, strict numeric parsing and prototype-key identity.
