# G2B2: a real second route and independently scheduled task

This slice replaces the unified Loop's fixed route ID with a mechanism-derived
identity and admits one bounded alternative route from an actual model receipt.
It is not full G2, a semantic independence certificate, a mathematical score or
formal deployment acceptance. DSH authored the implementation/tests; the
supervisor reviewed, applied and independently ran them.

## Entry behaviour

The first COMPLETE WorkPacket can use `p2a-work-v2`, preserving every v1 field
and adding one required `workflowProposal` (null or a strict NEW_ROUTE suggestion).
It names a mechanism, obligation and rationale, not route/task IDs, scope,
dependencies or budget. Original raw text, parsed packet and hash retain the
proposal. The frozen v1 parser remains v1-only; the shared strict decoder supports
both versions for M3/P4. Duplicate keys, unsafe numbers and extra fields are refused.

TS admits only a proposal naming the source task's currently unclosed obligation
in pendingObligations, in the same scope. Admission needs a new WORK plus configured
R2 capacity, an unused work-unit slot and root time. Invalid suggestions do not
erase a valid source artifact. Only one alternative route can be admitted.

The existing registry normalizes whitespace and hashes representation, operation,
lemmas and construction. IDs derive from that signature, not a problem ID.
Changing only representation/lemmas while operation and construction stay the same
is refused. This establishes declared-data identity, not mathematical independence.

M1 appends a real READY task through its public interface. M3 prevalidates and
synchronizes only added definitions without replacing the store or resetting its
artifacts, sequence, requests or routes. Existing definitions, contract identity
and acceptance evidence cannot be rewritten through task synchronization. M2
selects the admitted task from the actual ready set. It runs on the new route
with empty mathematical input/dependency refs. Source provenance is not promoted
into a cross-route premise; all existing cross-route and scope guards remain.

Host reconstructs provenance from earlier COMPLETE raw receipts and checks the
canonical mechanism/signature, source artifact/version, task, scope and capacity.
It does not choose the mathematical route. The first protected candidate remains
protected if the second route proposes a different answer. Model, tool, method,
final and R2 retain one Session and the original 4-model/2-effect/5-second ceiling.

WORK context v4 adds allowRouteProposal and routeProvenance. Historical v2/v3
WORK contexts remain explicitly read-only; active Host requires v4. Both 1.2 and
1.3 frame schema files remain byte-identical to the preceding checkpoint.

## Evidence and limitations

Real entry tests exercise proposal-WORK → new-route-WORK → R2 in three calls,
and tool → proposal-WORK → new-route-WORK → R2 in four. In the latter, the source
is model-2 but artifact-1: tools are not work artifacts. Tests assert actual new
task/route contexts, empty cross-route inputs, full v2 source hashes, original
candidate preservation and child cleanup.

Negatives cover same/renamed mechanisms, absent pending obligation, foreign
obligation, illegal fields, low capacity despite an emitted proposal, incomplete
finish signals and rehashed route/source/artifact/task/dependency tampering.
Node tests cover actual TASK_ADDED, lossless v2 parsing and immutable task sync.

Supervisor worktree verification: build passed, 264 Node and 462 Python tests
passed; the original 24 optional WASI skips remain. All 76 entry E2E tests passed.
An extra read-only diagnostic confirmed self/two-task cycles are rejected by
validation and commit without mutation. The v1 schema object equals the prior
clean checkpoint exactly. No live math API ran. Exact-commit reproduction is
recorded separately before promotion.

This profile only proposes another route for the current source obligation,
not an arbitrary other goal. Appended-task event-sequence checks rely on no
revision and at most one extra route; they are not general replay. Synthetic
client responses do not establish mathematical independence or accuracy.
Full parameter/quantifier/multipart semantics, artifact-revision invalidation,
progress yielding and the other G2 acceptance items still need implementation.
G3 grounded repair, G4–G8, official deployment/client acceptance and L1/L2 remain
incomplete; no PR3-complete or release claim is made.
