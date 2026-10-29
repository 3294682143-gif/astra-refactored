# P2 a2 short-path request alignment and offline replay

This increment supplies reproducible request-level evidence, not a new solver,
formal Host integration or completion of P2. The old Python implementation,
P0/P1 executables, P2 fixture runner and default entry are unchanged. Official
deployment remains TARGET_UNVERIFIED. No real model, tool or network service is
used by this harness.

## What is now aligned

The Python capture tool runs the actual frozen `LiteRuntime` with a fixed fake
public client, real method catalog and a tool executor that only refuses.
The profile obtains prompt text and method feedback from the original Python
helpers, not hand-copied approximations. TS independently rebuilds requests
from that trusted profile, problem and recorded receipts: it never receives
the captured request list as reconstruction input.

| Fixed scenario | Captured requests | Runtime method loads | Recorded outcome |
| --- | ---: | ---: | --- |
| direct | 1 | 0 | Unverified candidate |
| method | 2 | 1 | Unverified candidate |
| repeat | 3 | 1 | Unverified candidate after forced closeout |
| truncated | 1 | 0 | Unsolved |
| final-turn-method | 1 | 0 | Unsolved; method refused on last turn |

All five reconstructed sequences match the real Python calls message-for-message
and in order, including catalog, method body, repeat feedback, closing note,
temperature and max_tokens. Repeated loading occurs once in the solving stage;
each later request retains one copy of the previous card in its history.
Profile extraction reads the resource separately and is not included in the
`methodLoads` solver-stage counter.

These scenarios use a fixed synthetic problem with Unicode text and scripted
replies, a one- or three-turn ceiling, max_methods=2, max_method_chars=12000 and
max_tokens=8192. Python's actual temperature 0.2 is represented as the string
`"0.2"` in this diagnostic format; it is not a new official client parameter.
Timing/elapsed metrics are deliberately excluded from deterministic bundles.
This does not establish latency, budget equivalence, mathematical correctness
or arbitrary multi-turn policy equivalence.

## Components and trust boundary

- `python/astra_bridge/a2_capture.py` exposes `capture(scenario)` and a fixed
  `--scenario` CLI. It does not accept a problem, script, provider, root or file
  path. The eight selected baseline files in
  `packages/protocol/schema/a2-source-lock.json` must match before any fake
  request. This selected-source lock is not a complete dependency/environment
  attestation. It is never automatically rewritten to accept drift.
- `@astra/protocol` exports the diagnostic bundle/profile/request/receipt types.
  They are not a new stdio JSON-RPC schema.
- `@astra/math-workunit` exports `rebuildA2Requests(profile, problem, receipts)`.
  This pure builder uses only shared protocol definitions. Only the selected
  final/method paths are supported; arbitrary methods, tools and unresolved
  final-repair workflows fail closed rather than executing anything.
- `@astra/runtime-core` exports `a2Hash`, `a2Request`, `a2Profile`,
  `validateA2Bundle`, `compareA2Requests` and `A2ReplaySession`. These validate
  pre-decoded JSON-shaped data; hostile raw transport still needs the existing
  strict framing/parser boundary. They contain no client, filesystem, method
  or tool port.

Callers must supply the source lock/profile/bundle from a trusted capture path.
A model cannot authenticate itself by supplying the lock or recomputing a hash.
Hashes establish content identity, not authorship or mathematical verification.
The validator checks source identity, fixed settings, field sets, problem/system
binding, request hashes, bounds and the unverified result label. It is not a
second mathematical audit of the reported outcome.

Canonical hashes use compact UTF-8 JSON, Unicode-code-point key ordering and
preserved array order. Python and TS are checked against each other, including
non-BMP keys and an own `__proto__` property. Unsafe integers, floats, non-JSON
objects and lone surrogates are rejected on the TS surface. Limits include three
requests, sixteen messages per request, 60000 Unicode input characters, 65536
UTF-8 bytes per receipt and 262144 bytes per bundle. Contexts cannot silently
drop the turn note to fit; oversized required history is refused.

## Replay and differences

`A2ReplaySession.next(request)` returns only the next stored fixture receipt.
It validates exact request identity before moving the cursor. A mismatch does
not consume anything; exhaustion is a fixed refusal. Internal data and returned
snapshots are deeply isolated. There is no callback, background work, retry or
new model/method/tool call, and no persisted recovery claim.

`compareA2Requests` reports only request counts and indexed fixed codes:
REQUEST_COUNT, MESSAGES, TEMPERATURE, MAX_TOKENS. It never returns the differing
message or response. REQUEST_IDENTICAL means only that the compared inputs
match. Capture bundles themselves contain private prompts/cards/receipts and
must not be logged publicly or committed as raw production traces.

The current P2 `prepareP2Context` output is intentionally tested against the a2
first request and yields DIFFERENT/MESSAGES. Its WorkPacket contract is not the
a2 action protocol. The alignment builder is an opt-in diagnostic component,
not a hidden compatibility mode or Python fallback.

## Host integration gate still pending

Production integration must preserve the Host's injected public client,
root deadline, shared admission and unknown-request responsibility; define the
same schema on both sides; and demonstrate actual environment/client support.
It must also distinguish protocol completion from evidence acceptance and must
not expose private replay data in public traces. This increment supplies test
fixtures and request comparisons for that work; it does not authorize or
implement live evaluations, new RPC methods or default-engine switching.

A later [P2 local Host slice](P2_HOST_BRIDGE.md) adds a separately versioned
six-method channel for one P2 work unit and a pure mock model receipt. It is
not formal target/client acceptance or a switch to the a2 alignment profile.

Further a2 alignment still needs broader protocol/error/tool/context-budget
cases and full behaviour/configuration comparisons. M2/M4/M5 completion, formal
Host integration and release gates remain unfinished.

## Executed verification

Supervisor acceptance on 2026-10-11: direct build and all 69 Node tests passed
(62 previous plus 7 new). Python passed 217 tests (201 previous plus 16 new),
with the original 24 WASI skips. Tests invoke the real baseline capture in a
separate Python process and compare it to TS reconstruction; repeated capture
produces identical bundles. Source/lock drift is refused before dispatch.
Additional supervisor probes passed ten negative controls for bounds, malformed
data and atomic replay, plus mutation isolation and report privacy checks.

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
```

Use only the existing offline cache procedure in [the P1 runbook](P1_OFFLINE.md).
No new dependencies are needed. For a private diagnostic bundle, the capture
CLI accepts `--scenario direct`, `method`, `repeat`, `truncated` or
`final-turn-method`; its stdout contains the full private bundle, not a public
summary. Invalid arguments produce a fixed error without echoing input.

The assigned dsh DeepSeek executor authored the implementation and repository
tests. The supervisor reviewed/applied/tested them, mechanically normalized
patch wrappers, export placement and the test path, and recorded acceptance.
No baseline source, production assertion or mathematical policy was weakened.
