# P3 method catalog and on-demand Host loading

The local TypeScript action loop now supports a real method directory/load
round trip through the Python Host. It reuses the original integrity-checked
MethodCatalog and resource corpus; no new cards, tools, dependencies, model
provider or default-engine switch are introduced. Model replies are still
literal offline fixtures. All candidates remain unverified and deployment
remains TARGET_UNVERIFIED.

## Run and version change

Build TypeScript first, then opt into method loading:

```sh
node node_modules/typescript/bin/tsc -b
PYTHONDONTWRITEBYTECODE=1 python -m python.astra_bridge.p3_host_offline --problem 'Synthetic method demonstration' --max-method-loads 1 --action '{"action":"method","id":"linearization-spectral"}' --action '{"action":"final","answer":"Unverified fixture candidate","complete":true,"unresolved":[]}'
```

The candidate above is supplied fixture text, not a model-generated solution
or a proof. The corresponding API is `run_p3_host(..., max_method_loads=1)`.
The accepted range is integer 0..1, default 0; booleans/floats are rejected.
No caller-supplied resource path or catalog object is exposed by this runner.

The single P3 manifest is now `1.1-p3-host-local`, with seven methods:
runtime.initialize, session.solve, session.stop, model.generate, tool.execute,
method.catalog and method.load. Initialization requires maxMethodLoads;
the public solve result adds catalogCalls and methodLoads. effectCalls remains
the aggregate number of tool and method attempts. Old P3 1.0 peers are refused,
not silently widened. P0/P1/P2 schemas, the official Python entry and existing
solver behaviour are unchanged.

M3 uses `p3-action-context-v2`, adding the complete methodCatalog id/title list
to each private context. The trailing catalog argument defaults to an empty
list for existing fixture callers. Context and wire byte bounds are unchanged.

## Directory before body

Only when method loading is enabled, more than one model turn is available,
and the total effect quota is nonzero does TS request a directory before its
first model call. Python constructs MethodCatalog at that point, reads the
existing SOURCE/registry metadata and returns only IDs and titles. The valid
catalog is empty (unavailable) or contains exactly 20 unique canonical IDs.
The reply is bound to node-catalog-1, validated and retained; no second catalog
call is permitted in the session.

A disabled capability, zero/one-turn budget or zero effect quota causes no
catalog construction or resource read. Missing/damaged catalog resources
produce an empty capability, leaving direct reasoning and tool work available.
Malformed protocol/catalog replies are rejected; they are not interpreted as
authority to read arbitrary files.

The model may request only an advertised canonical method ID. Unknown IDs,
paths, extra fields, a mismatched source action or binding are rejected before
body loading. The original MethodCatalog/fixture_load path checks resource
integrity, body SHA256, character count, version, ID and catalog title. The
Node resource validator rechecks the normalized observation and asset before
the receipt is settled or used in another context. These hashes establish
content integrity, not mathematical preconditions or authenticity of claims.

The observation contains the complete asset and ADVISORY_NOT_PROOF, with
source METHOD_REFERENCE, level PROVISIONAL and checkResult UNKNOWN. A card
does not satisfy an M1 obligation or turn a candidate into a verified answer.
Only the requested body is read; the full corpus is never injected.

## One budget, one recorded observation

Methods and tools share maxEffects 0..2, maxModelCalls 0..3 and the original
Python root deadline of at most five seconds. Method attempts have an
additional cap of one. Catalog I/O consumes root time but is counted
separately, not as an additional effect allowance. The 25 ms closeout reserve
and the rule forbidding effects on the last model turn remain in force.

Both effect types use the same effect-N/node-effect-N sequence. Python admits
a load only when it exactly matches its latest actual COMPLETE method action
and trusted session/problem/contract/task/scope binding. Replays and forged
requests cannot obtain a second read. A repeated ID reuses the original
COMPLETE or ERROR receipt, keeping its original sourceRequestId and only one
observation in the next context. A different second method is refused even
when a tool slot remains.

Resource failure yields a bounded ERROR observation without partial body or
raw exception text; a later fixture may still propose an unverified candidate.
An UNKNOWN or late result stops without retrying. Late COMPLETE receipts do
not become reusable observations; UNKNOWN is not downgraded after expiry.
Host checks each subsequent directory/history/effect against its actual
records with type-preserving JSON comparisons, including after hashes are
recomputed. Body, directory and context material are not silently truncated.

Public results include only the designated candidate/unsolved text, fixed
labels/reasons and counters. Full requests, card text, catalog and effect
records remain private. The underlying records are in-memory snapshots, not
a durable external-service responsibility ledger.

| Normal synthetic path | Model callbacks | Catalog calls | Body loads | Total effects | Frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| Method then final | 2 | 1 | 1 | 1 | 14 |
| Method, same method, final | 3 | 1 | 1 | 1 | 16 |
| Method, tool, final | 3 | 1 | 1 | 2 | 18 |
| Tool, method, final | 3 | 1 | 1 | 2 | 18 |

These are measured normal-path counts, not a promise to consume all budgets.
With default max_method_loads=0, the earlier tool-only path counts are unchanged.

## Acceptance and remaining work

Supervisor verification on 2026-10-11: build and 97 Node tests passed (92 prior
plus five groups), and 381 Python tests passed (347 prior plus 34). The same
24 optional WASI tests remain skipped. Existing tool/P2/P1 regression tests
remain in the full suite; P3 wire fixtures were explicitly versioned.

The Python suite uses real Node processes and the original resource reader,
records exact metadata/body reads, checks both method/tool orders and
once-only body loading, and tests damaged resources on temporary copies.
Network and old solver entry points are disabled. Success/failure paths check
child exit, closed pipes and selector cleanup. Live interception tests verify
pre-read refusal of altered requests, disabled-capability bypass attempts,
replays, rehashed context/body tampering, forged counters and late results.
Node tests separately verify catalog shape, asset integrity, atomic rejection,
quota sharing and no next model call after an unknown or late receipt.

Eight additional supervisor live mutations were rejected: four before body
reading and four against recorded provenance. A synthetic 7000-character
quoted body with an 8192-emoji problem made the next context exceed its bound:
the runner stopped after one model call and one method load while retaining
the full private body, with no candidate or public body leak. This diagnostic
used a synthetic asset, not a changed bundled resource.

The assigned dsh DeepSeek executor authored implementation and repository
tests; the supervisor reviewed/applied them and independently ran verification.
An output-truncated test group was withheld, and fixture/import/type mistakes
were repaired by the executor without weakening the acceptance checks. No
mathematical accuracy or real model quality claim follows from these tests.

This completes the local offline method round trip, not the entire approved
five-module migration. Full M2 policy, M4/M5 review and acceptance, formal
client integration, persistent external request responsibility, complete a2
parity and target/default-switch gates remain unfinished.
