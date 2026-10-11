# P2 local Host bridge

The original single-unit acceptance milestone is recorded below. The current
[multi-unit increment](P2_MULTI_WORKUNIT.md) upgrades the local protocol to
`1.1-p2-host-local`, allows 0..3 sequential mock calls (default 1), and adds
`candidateRequestId`. All single-call examples still work with matching current
Host/Node versions; old 1.0 frames are rejected rather than silently widened.

This opt-in slice connects a real Python Host to a real Node child process.
It does not enable a production model provider, competition client, arbitrary
tool, Python solver fallback or default-engine switch. All outputs remain
MOCK_ONLY, candidateVerified=false and strictAcceptance=NOT_PERFORMED; the
official environment gate is TARGET_UNVERIFIED.

## Run

After the direct TypeScript build and existing-cache offline setup described
in [the P1 runbook](P1_OFFLINE.md):

```sh
node node_modules/typescript/bin/tsc -b
PYTHONDONTWRITEBYTECODE=1 python -m python.astra_bridge.p2_host_offline --problem 'Synthetic offline prompt' --reply 'Fixture candidate' --method-id linearization-spectral
```

Omit `--method-id` for direct work. `--max-model-calls 0` disables all callbacks;
`--max-method-loads 0` disables method loading. `--delivery-status` accepts
COMPLETE/TRUNCATED/ERROR/UNKNOWN. The CLI accepts no provider, credential,
`--node` or `--script`; child/script overrides exist only as trusted Python
function arguments for fault-injection tests.

The library entry is `run_p2_host(problem, *, reply, method_id=None, ...)` in
`python/astra_bridge/p2_host_offline.py`. `reply` is fixture data, not an actual
client response. `OfflineP2Client.chat` has the public three-argument shape but
only wraps that data into a bound synthetic WorkPacket. No external request is
made and the receipt's derivation explicitly says it is not a proof.

## End-to-end path

Python sends initialize → solve → stop. Node compiles a real M1 contract,
starts its first ready task, optionally requests a catalog and named method
from Python, prepares a real M3 context, requests one mock receipt, accepts it
into the versioned M3 store and records delivery in M1. It does not satisfy
obligations. Only CANDIDATE_VALIDITY/ANSWER_REQUEST tasks may offer a candidate;
this one-task slice is not a complete proof solver or multi-task scheduler.

| Configuration | Total normal frames | Mock calls | Method body loads |
| --- | ---: | ---: | ---: |
| Direct | 8 | 1 | 0 |
| Known method | 12 | 1 | 1 |
| Unknown canonical method ID | 10 | 1 | 0 |
| Method loading disabled | 8 | 1 | 0 |
| Model budget zero | 6 | 0 | 0 |

`packages/protocol/schema/p2-host.schema.json` is the shared field specification,
version `1.0-p2-host-local`. It allows exactly runtime.initialize, session.solve,
session.stop, method.catalog, method.load and model.generate, with fixed
directions. P0/P1 manifests and entry points are unchanged. Both sides reuse
the P0 strict parser and schema subset rather than inventing a new JSON parser.

The Node implementation separates a transport-only channel, a protocol flow
controller and the M1/M3/method-session composition. The Python implementation
reuses P0's selector pump, single reader, environment allowlist, child reaping
and stream cleanup. Mathematical packages do not gain process or network I/O.

## Checks and limits

- One root deadline starts on entry to the Python call, includes validation,
  startup and handshake, and is at most five seconds. Node's own timer and
  remaining-time receipts can only tighten it. New operations require more
  than 25 ms remaining. Late results cannot become new candidates; recorded
  artifacts can be invalidated independently of delivery status. Cleanup has
  the inherited separate one-second child-reaping bound.
- One reader handles both ordinary results and callbacks. Fixed host/callback
  IDs and phase checks reject replays, wrong sessions, early stop and unsolicited
  replies. The existing bounds remain 65536 bytes per NDJSON frame and 64 total
  frames. Empty/noisy/duplicate-key/invalid-UTF-8/oversized frames fail closed.
  Stop waits for the acknowledgment write to flush and rejects buffered tails.
- Method selection is trusted solve configuration, not a model tool action.
  Python uses the existing integrity-checked MethodCatalog; TS validates it
  again through P2MethodSession. Unknown/disabled/oversized/corrupt cards cannot
  be injected as successful assets. Rejected optional cards can still permit
  direct reasoning. At most one load attempt is admitted.
- Python checks the context hash, two-message structure, inner task/session/
  problem/version/scope identities and exact Host-provided method assets. This
  is structural validation, not an independent reconstruction of M1 semantics
  or a mathematical proof. Node/compiler/manifest remain trusted deployment
  components. A hash is content identity, not authentication.
- The context and method bodies are private channel data. The returned result
  contains only the designated candidate/unsolved response, fixed labels,
  counts and context hash; it does not include raw messages or method bodies.
  Stderr failures are fixed codes, not SDK exceptions or private payloads.
- The fixture client is synchronous, has no general injection hook, and never
  retries. Host-owned synchronous resource reads are checked when they return;
  this is not a claim of forcible cancellation of arbitrary callbacks. An
  actual model/client adapter and external-request responsibility integration
  are not enabled by these tests.

The P2 in-memory runner and a2 diagnostic profile remain separate, unchanged
surfaces. This slice adds a local Host integration; it does not establish full
a2 behaviour parity, formal platform permission or improved math accuracy.
Full M2/M4/M5 policy, model-driven method actions, tools, multi-unit Host
scheduling, official-client adaptation and release/default gates remain open.

## Executed acceptance

Supervisor acceptance on 2026-10-11: direct build and 72 Node tests passed
(69 prior + 3 new). Python passed 251 tests (217 prior + 34 new); the original
24 actual-WASI tests remain skipped, not passed. The new Python suite disables
all old solver entries, checks real child processes and closed pipes, inspects
the actual mock callback context, verifies resource SHA256 and checks repeated
session IDs/file-descriptor stability. It covers silent/crashed/noisy children,
missing Node/scripts, invalid budgets, non-complete receipts and private data.

Twelve additional supervisor controls passed: malformed frames sent to the
actual Node entry, same-chunk data after stop, context/hash/scope/card tampering
and a corrupt-card rejection that still permits unverified direct work.
All diagnostic children were reaped. No credentials, generated build assets or
raw model logs are included in the source commit.

The assigned dsh DeepSeek executor authored source and tests. Complete hunks
were reviewed and applied; four truncated responses had their incomplete new
files withheld. Wrapper/Add-prefix formatting was mechanically normalized.
Tests and implementation errors were repaired before acceptance without
changing the frozen solver, P0/P1 behaviour or mathematical acceptance policy.
