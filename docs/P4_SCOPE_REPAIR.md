# P4 S1 diagnostic binding and S2 single repair branch

This increment adds two pure TypeScript M5 libraries and a separate offline
repair fixture. It does not complete S1 semantic verification or prove a
repair correct. P3 Host `1.1-p3-host-local`, the existing R2/S3 fixture,
official Python entry, solver, resources and dependencies remain unchanged.
There is no new RPC, real model client, tool permission or default switch.

A later [S1 mapping-review library slice](P4_MAPPING_REVIEW.md) adds bounded
model correspondence opinions, followed by an accepted
[offline composition](P4_MAPPING_WORKFLOW.md). The diagnostic ledger described
here still has semanticMapping UNKNOWN and cannot support mathematical
obligations; the new workflow does not prove representation equivalence.

## S1: diagnostic identity, not semantic equivalence

`P4DiagnosticLedger` binds a P4 target to at most two existing P3 tool
request/receipt pairs. It is a pure ledger: the caller still owns effect
dispatch and the actual root deadline. The library is not yet inserted into
the existing Host protocol.

A plan binds the exact target identity/hash, full scope, assumptions, requested
obligation IDs, request identity and declared tool-registry-v1 version.
Only supplied-polynomial-coefficients and supplied-linear-solution-set
properties are recognized, for their respective existing operators.
The full scope must agree with the target, and the used assumptions must be
unchanged. Explicit REAL/RATIONAL domain disagreement for a linear-system
request is refused. Wrong identities, unsupported shapes and unknown tools
are not admitted.

A matching assessment says STRUCTURAL_MATCH_ONLY. Its semanticResult is
UNKNOWN and canSupportObligation is false. Matching fields or hashes cannot
prove that a supplied polynomial/system represents the original problem.
Requested obligation IDs in checkerCoverage are provenance links, not proof
that those obligations were checked or satisfied.

Admission is single-flight and bounded to 0..2 checks. Check, effect and source
request IDs cannot be replayed. The stored effect window is tightened to the
minimum of the plan's window and the caller's remaining-time view. This does
not create a second budget or an absolute-clock authority inside the ledger.
The actual Host/executor remains responsible for bounded execution.

After explicit dispatch, settlement checks the exact receipt shape, binding,
source, status, UTF-8 size and observation hash. A forged receipt leaves the
record DISPATCHED rather than silently claiming an outcome. A timely COMPLETE
receipt creates only PROGRAM_OBSERVATION / PROVISIONAL / UNKNOWN evidence,
with semanticMapping UNKNOWN and canSupportObligation=false. Even observation
text containing PASS or complete_for_input cannot promote it.

Evidence retains target, scope, assumptions, checked property, tool version,
request/effect IDs, requested coverage and input/output hashes. inputHash
covers the exact `JSON.stringify([toolName, args])` serialization, not a claim
of mathematical or cross-encoding canonical equivalence. ERROR and late
receipts create no evidence. UNKNOWN wins over lateness; UNKNOWN/late outcomes
block further admission. Marking a settled target stale changes evidence
availability to STALE, never REFUTED, and preserves its historical identity.

## S2: one explicitly unverified child proposal

`P4RepairSession` requires an ACTIVE parent and an actual ACTIVE/CHALLENGED R2
challenge supplied by the controller. It rechecks version/hash/scope binding,
the codepoint quote, issue kind, obligation references and model-2 provenance.
This is not an authenticated import interface for arbitrary external JSON.

At most one repair admission is allowed. Its model-3 context includes the
original problem, parent identity/hash, scope, claim, derivation, candidate,
assumptions, route and complete challenge. Both messages are recorded whole;
their byte count and hash cover the same serialized array. Quoted candidate
and challenge material is explicitly untrusted data, not permission to alter
budgets, tools, premises or verification status.

The child must be a genuine M3-accepted COMPLETE WorkPacket, with the exact
returned raw text, source model-3, artifact ID repair-1/version 1 and the same
session/problem/contract/task/goal/scope/route as the parent. Its used
assumptions must remain identical, even if an additional assumption was
declared in the broader scope. At least one of claim, derivation and
candidateProposal must actually change. A no-op, stale/foreign child or
malformed/incomplete response cannot become a repair proposal.

Successful structural delivery records S2 lineage: parent and child bindings
and hashes, triggering challenge, source request and the changed fields.
checkResult remains UNKNOWN, requiresRecheck=true and canReplaceProtected=false.
The challenge is not changed to RESOLVED or CONFIRMED, and no evidence or
review from the parent is transferred to the child's identity.

This is a forked draft, not a superseding M3 version: parent artifact-1 and
child repair-1 have distinct IDs. The parent remains available until a future
accepted refutation/replacement policy authorizes otherwise. Storage ACTIVE
on the child means that its data exists, not that it is eligible for protected
submission. Invalid children created during fixture processing are marked
STALE without invalidating the parent.

## Offline composition and budgets

`runP4RepairFixture` in `apps/stdio-runtime/src/p4-repair-fixture.ts` composes
real M1/M2/M3/M4/M5 components with literal receipts:

1. model-1 supplies a P2 WorkPacket and the first protected candidate.
2. model-2 supplies one strict R2 report; an actionable challenge is required.
3. model-3 may supply one repair WorkPacket when quota and time remain.

Options are maxModelCalls 0..3, maxRepairs 0..1, remainingMs 1..5000,
BEST_EFFORT/STRICT policy and an optional test clock. All three calls share
the original deadline and the 25 ms new-call reserve. Captured configuration
cannot be enlarged by clock callbacks. Unknown, incomplete or invalid review
responses do not trigger a repair; a failed repair is not retried.

The parent delivery is recorded once in M1. The child gets a separate local
M3 sequence and an explicit lineage record, not a replacement M1 delivery.
These in-memory records are not a unified durable event journal, and this
slice does not implement dependency-bearing repair or selective reopening of
previously verified obligations. No mathematical obligation is satisfied here.

S3 is always given the original protected target and original unresolved
review. BEST_EFFORT therefore preserves the parent answer after a proposed
repair; STRICT still withholds because no accepted checker is available.
An exhausted root clock also withholds. parentProtected reports whether a
protected record actually exists, including false for zero-call/invalid-work
runs. Public results expose fixed codes/counts and the designated answer, not
the child proposal, original problem or challenge rationale. Full context,
receipts, artifacts and lineage stay in privateState.

## Verification

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
```

Supervisor verification on 2026-10-11: 124 Node tests passed (110 prior plus
14 groups), and all 381 Python regressions passed, with the same 24 optional
WASI skips. S1 positive controls execute the actual two isolated operators
through the existing Python adapter and inspect their real normalized outputs.
No real model or competition evaluation is performed.

Tests cover single-flight admission, duplicate IDs, malformed/forged receipts,
scope and assumption mismatches, UNKNOWN/late precedence, stale evidence,
genuine M3-accepted no-op/changed-assumption repair children, preserved parent
and challenge state, shared budgets, raw receipt retention and clock failure.
Fourteen additional supervisor boundary controls passed, including an actual
REAL-target/RATIONAL-input mismatch, cross-bound receipts, elevated evidence
labels and invalid repair challenge provenance. Passing these checks proves
mechanism behaviour, not mathematical accuracy.

The assigned dsh DeepSeek executor authored the implementation and tests.
The supervisor reviewed/applied patches and independently verified results.
Truncated additions were withheld except complete methods/test groups, then
completed or repaired by the executor. Patch wrappers, paths and hunk order
were mechanically normalized; no acceptance assertions were removed to obtain
a pass. R0/R1, semantic S1 mapping, post-repair semantic validation, authorized
candidate replacement, dependent-claim propagation, Host integration, durable
external responsibility and target/default-switch gates remain unfinished.
