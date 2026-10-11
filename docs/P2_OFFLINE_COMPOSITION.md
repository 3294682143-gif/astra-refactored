# P2 offline M1/M3 composition and method port

Accepted as an offline engineering slice on 2026-10-11. This is not completion
of P2, an accuracy result, or a formal-client deployment. The P0/P1 executables,
default entry, Python solver, original method resources and dependencies stay
unchanged. The deployment gate remains TARGET_UNVERIFIED.

## What runs

`apps/stdio-runtime/src/p2-fixture.ts` exports `runP2Fixture(contract, units,
options)`. It composes real `ContractLedger`, `P2WorkunitStore`,
`prepareP2Context` and `P2MethodSession` public APIs. Units supply literal
synthetic response texts; there is no model client, provider, tool execution or
new RPC protocol in this runner. It does not silently call the old solver.

The runner selects a declared ready task, starts it, obtains its exact input
artifact versions, builds the private context, optionally loads requested
method IDs, consumes one fixture receipt and records delivery back in M1.
COMPLETE means delivered, not mathematically accepted. Other retained receipts
are PARTIAL. No obligation is automatically SATISFIED.

Only an ACTIVE/effectively COMPLETE artifact from CANDIDATE_VALIDITY or
ANSWER_REQUEST can supply an unverified candidate proposal. The first such
proposal is retained across later failures; a boundary-task proposal cannot
replace it. All outputs say MOCK_ONLY, candidateVerified=false and
strictAcceptance=NOT_PERFORMED. M2 action policy and M4/M5 reviews are not being
simulated as completed here.

## Methods remain Host-owned

`python/astra_bridge/p2_methods.py` is a thin fixture adapter over the existing
`mathagent.lite.methods.MethodCatalog`. It exposes `fixture_catalog` and
`fixture_load`; its CLI accepts only an optional `--method ID`. It neither
copies nor rewrites the resource reader, cards or SHA manifest. Catalog access
reads metadata only; explicit loading reads the named card and rechecks its
identity, title, Unicode character count and UTF-8 SHA256. Missing, tampered or
invalid material never produces a partial successful asset. Errors are fixed
statuses without paths or underlying exception text.

Shared DTOs live in `@astra/protocol`. `P2MethodPort` is a trusted Host injection
point, not an authorization claim that model JSON may manufacture. The TS
`P2MethodSession` in runtime-core validates the 20-entry version-1.1.0 catalog,
canonical IDs, exact load shapes and hashes. Its default cumulative character
allowance is 12000 (configurable up to 24000), with at most two actual load
attempts. Failed reads also consume attempts. Successful and failed requests
are deduplicated; successful reuse does not duplicate the asset in a context.
Invalid/unknown IDs never become filesystem paths.

Real integration tests inject a port that invokes the Python adapter in a
bounded subprocess with a scrubbed environment. This test adapter is not a
production transport: each CLI process is independent, while TS owns
session-level deduplication. Formal `method.catalog` / `method.load` Host RPC,
asynchronous cancellation and official-client compatibility remain pending.
Resource integrity does not establish mathematical applicability or add any
new redistribution/license claim.

## Bounds, context and trace

- A run accepts at most three synthetic units and two registered routes. It
  freezes its inputs and captures budget settings before any method callback.
  One root deadline (at most 5000 ms) includes setup; 25 ms is reserved for
  closeout. Callbacks cannot refresh it. Clock regression/non-finite values
  fail closed. A synchronous trusted callback cannot be forcibly interrupted
  by this library; lateness is checked when it returns.
- ERROR/UNKNOWN stops consumption without automatic retries. TRUNCATED and
  INCOMPLETE may be followed by another explicitly supplied fixture. Late
  artifacts are marked STALE and cannot become a new candidate. The M1
  delivery record can still reflect receipt completion; it is not acceptance.
- M3 produces exactly two messages under a fixed prompt version. They contain
  the original problem, contract/task/scope, obligations, exact input artifacts
  and admitted whole method assets. All these texts are untrusted data, never
  tool or shell authority. The serialized messages are bounded to 65536 UTF-8
  bytes and hashed exactly. Only the optional catalog may be omitted to fit;
  a still-oversized context is refused, not truncated.
- `privateState.requests` retains exact messages/hash/byte count, method-use
  records, raw fixture receipts, errors and artifact references. `summary`
  carries fixed flags/counts/trace codes plus the designated candidate proposal,
  not raw problems, method bodies or exceptions. Do not log `privateState`
  publicly. Each new context may contain one copy of a previously loaded card;
  that is reuse, not another read or stronger evidence.

This is bounded in-memory recording, not a persisted event journal, general
session replay or automatic resume. M1 sequences remain the delivery-event
authority; fixture trace indices are not another global event sequence.
Contract migration, model-driven method actions, a2 prompt/behaviour parity,
full M2/M4/M5 policy and default-engine switching still need separate work.

The subsequent [a2 short-path harness](P2_A2_ALIGNMENT.md) adds frozen-source
capture and request-level comparison/replay for five selected baseline paths.
It does not replace this runner's WorkPacket prompt or establish full parity.

The subsequent [P2 local Host bridge](P2_HOST_BRIDGE.md) adds a separate
single-work-unit stdio integration using the existing framing/validation and
Python process supervision. This in-memory runner remains unchanged; formal
client support and multi-unit Host scheduling are still pending.

## Run and acceptance evidence

Use existing locked dependencies and the explicit offline cache procedure in
[the P1 runbook](P1_OFFLINE.md). Stop if offline installation fails. No dependency
or runtime asset download is needed.

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
PYTHONDONTWRITEBYTECODE=1 python -m python.astra_bridge.p2_methods
```

Actual supervisor results: 62 Node tests passed (50 prior + 12 new); 201 Python
tests passed (189 prior + 12 new), with the same 24 WASI skips. Tests cover a
three-task dependency chain, actual Python card loading through M1/M3, duplicate
reads, corrupt resources, zero budgets, deadlines, late invalidation, candidate
retention, privacy, optional-catalog omission and critical-context refusal.
Independent probes also passed ten method negative controls and verified that
callbacks cannot mutate captured budgets, refresh the deadline, alter recorded
input data or expose private method bodies in summaries.

Implementation and repository tests were authored by the assigned dsh DeepSeek
executor and independently reviewed/applied/run. A truncated TS addition was
withheld; its complete Python repair hunk was retained. The supervisor
mechanically normalized patch wrappers, imports/export placement and one test
API-name typo (`P2RouteRegistry.register`, not `registerRoute`). No business
logic or assertions were replaced to make a failing test pass.
