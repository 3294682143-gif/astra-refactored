# P2 bounded multi-unit Host and M2 admission slice

The local Host now admits at most three sequential mock model calls. Default
behaviour is still one call; a shared five-second root deadline and the existing
25 ms closeout reserve are unchanged. No production client, mathematical tool,
default-engine switch or accuracy claim is introduced. The result remains
MOCK_ONLY, candidateVerified=false and strictAcceptance=NOT_PERFORMED. Official
deployment remains TARGET_UNVERIFIED.

## Run and protocol change

Use the existing offline cache/build procedure, then:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m python.astra_bridge.p2_host_offline --problem '求全部实数解 x(x-1)=0' --reply 'Synthetic candidate, not a verified answer' --max-model-calls 3 --method-id linearization-spectral
```

This runs actual Python↔Node IPC but consumes only a pure in-memory fixture.
The reply is not a computed solution. Method selection remains trusted solve
configuration, not a model-selected tool action.

The shared manifest is now `1.1-p2-host-local`. Both peers must use the matching
version; 1.0 frames are explicitly rejected. P0/P1 protocols are unchanged.
Changes are restricted to maxModelCalls/modelCalls/artifactCount bounds (0..3),
model-1/model-2/model-3 request IDs and required `candidateRequestId` in the
result. Method loads stay bounded to one; frame/depth/session limits are not
widened. Callback IDs are node-model-N and artifact IDs are artifact-N.

| Successful path | Mock calls | Normal frames | Method reads |
| --- | ---: | ---: | ---: |
| Zero model budget | 0 | 6 | 0 |
| Default direct | 1 | 8 | 0 |
| Two direct units | 2 | 10 | 0 |
| Three direct units | 3 | 12 | 0 |
| Three units with one known card | 3 | 16 | 1 |

These are normal full-delivery counts, not promises to exhaust a budget.
Missing ready tasks, context limits, deadlines or failed/partial delivery stop
earlier. Method catalog/load callbacks occur at most once per session; later
contexts reuse the same admitted card.

## M2 ownership and progression

`@astra/math-gateway` exports `P2ModelGate` and `chooseP2ReadyTask`. It imports
only the shared protocol, not M1/M3. The composition root alone joins modules.

The gate binds session/problem/contract/task/scope, sequential request ID and
remaining time before admitting a call. Rejected admission does not consume a
slot or mutate records. Admission, dispatch and return are distinct states:
ADMITTED → DISPATCHED → RETURNED, or OUTCOME_UNKNOWN for an UNKNOWN receipt.
Only one request may be in flight. Duplicate/gapped IDs, premature settlement,
wrong identities, exhausted budgets and <=25 ms remaining fail closed.

This is a local bounded admission view, not a server permit ledger or durable
event journal. DISPATCHED records local dispatch intent, not proof that an
external service executed anything. Snapshots retain the latest state of each
request, not a persisted transition history. Python independently enforces
sequence, counts and stopping conditions before the mock call.

The rule selector prioritizes candidate validity, then boundary exceptions,
then ready tasks with existing input artifacts, retaining M1 order for ties.
For the all-solutions fixture this produces candidate → boundary →
exhaustiveness, with the third task receiving the first two exact artifacts.
M1's task graph and obligation semantics are not rewritten or automatically
satisfied. The ordering is a scheduling rule, not a proof of plan correctness.

One ledger, store, route and method session are retained for the whole run.
Only COMPLETE transport plus COMPLETE effective artifact delivery permits an
advance. TRUNCATED/ERROR/UNKNOWN, incomplete packets, invalid packets, late
delivery or preparation failure do not trigger retries. A second `advance`
without a new complete delivery cannot skip tasks.

## Provenance and candidate protection

Python retains a bounded private history of request parameters and actual
returned fixture receipts. Every downstream input must refer to an earlier,
unique, exact version-1 artifact in that history, from a declared dependency
task in the same session/problem/contract/scope/route. Boolean versions,
noncanonical IDs, future/self references and unobserved refs are refused.

The artifact's packet and raw text must match the recorded response, its hash
must be correct, and its full scope must match both current and original
contexts. Dependency lists, provisional flags and raw-response references are
also reconciled with the original context. Recomputing the new context hash
does not authorize changing old provenance or assumptions. These are structural
source checks, not proof that the mathematical claims are true.

The first eligible ACTIVE/COMPLETE candidate remains protected. A later
boundary/exhaustiveness proposal cannot replace it; a later partial, unknown or
invalid receipt does not erase it. `candidateRequestId` points to the earlier
request, which Python validates against its actual recorded response and task
kind. `deliveryStatus` describes the latest retained delivery, so it may be
non-complete even when an earlier unverified candidate is returned. The final
contextHash identifies the last dispatched model request, not an unissued
prepared context. Raw history/private snapshots are never added to the public
Host result.

This slice does not implement model action parsing, tool dispatch, route
switching, contract migration, complete M2 policy, full M4/M5 acceptance or
formal-client external-request responsibility. Full a2 parity and deployment
gates also remain unfinished. No mathematical correctness is inferred from
three agreeing fixtures or from successful IPC.

## Verification

Supervisor acceptance on 2026-10-11: build and 77 Node tests passed (72 prior
plus 5 new); Python passed 265 tests (251 prior plus 14 new), with the same 24
WASI skips. Single-call regression remains covered, with its explicitly
versioned wire fixtures updated and the former invalid budget 2 replaced by
the new invalid boundary 4.

Tests cover gate lifecycle/atomic denial, 0..3 real-process calls, exact upstream
handoff, once-only method loading, first-candidate retention, unknown-stop,
replayed callbacks and corrupted third-request inputs. Old solver entries and
network access are disabled in the integration tests; children and pipes are
checked for cleanup.

Additional supervisor probes passed twelve malformed-provenance/receipt
controls, including jointly forged scopes and a recomputed context hash. A
separate 4096-emoji candidate test confirmed that an oversized third context
stops at two calls while retaining the full earlier candidate, without slicing
the input or resetting the budget.

The assigned dsh DeepSeek executor authored implementation and tests. The
supervisor reviewed/applied/tested patches, mechanically normalized package
placement/imports, patch order/wrappers, version fixtures and one debug-snapshot
test type assertion. Incomplete or invented-context hunks were withheld; no
assertion or business rule was removed to obtain a pass.
