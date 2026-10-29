# G2C: a genuine three-WORK dependency chain

This slice makes successive work units consume the actual preceding artifact,
not merely run three tasks. DSH authored implementation/tests; the supervisor
reviewed, applied and independently ran them. Full G2, mathematical accuracy,
formal deployment, L1 and L2 are not complete.

## Control path

A strict `p2a-work-v3` packet retains all v1 work fields and adds one nullable
DEPENDENT_TASK proposal containing only kind, obligationId and rationale. The
existing strict parser handles v1/v2/v3 without rewriting raw responses. V1/V2
schema objects and the 1.2/1.3 frame files remain unchanged.

TS can admit a child only from an ACTIVE, latest, COMPLETE source artifact for
the source task's pending, unclosed obligation. The control side derives its
task ID, route, scope, envelope and parent dependency. The model cannot choose
those fields or gain budget. Existing M1 task admission and M3 task synchronization
are reused; M1 readiness fills the precise delivered parent ref. No new Loop,
Session, model gate, store, dependency or independent mathematical mechanism is
introduced. At most two continuations fit the unchanged three-work-unit cap.

The same M2 ready chooser can run parent → child → grandchild. M3 records actual
versioned refs and keeps raw WorkPackets/hash/dependencies. A child on the second
route inherits that route only; the earlier first-route artifact is not a shared
premise. Dependent artifacts stay PROVISIONAL/UNKNOWN and cannot independently
replace the protected first candidate or discharge obligations.

WORK context v5 adds allowTaskContinuation and dependencyProvenance, separate
from routeProvenance. Host derives the child definition from earlier real raw
receipts, then checks source/version, full scope, route, parent refs, task envelope
and shared capacity before a client call. Child/tool repeated calls do not
create new admissions. Historical v2/v3/v4 contexts have explicit read-only
validation; active Host requires v5. Appended-task event sequence reconstruction
is bounded to this no-revision profile and is not general event replay.

## Verification

The real public-entry chain has four model calls: WORK1 → WORK2 consuming
artifact-1 → WORK3 consuming artifact-2 (which depends on artifact-1) → R2.
It records three artifacts, two actual TASK_ADDED events and one review under
one root budget. Tests compare consumed raw text/hash/packet to the actual
recorded client response, not a self-consistency or tautological hash check.

A separate case executes NEW_ROUTE → WORK on that route → child consuming only
that route's artifact → R2. Rehashed cross-route and dependency-source tampering
is rejected by the real Host validator before another client call. Other controls
cover missing/foreign obligations despite an emitted v3 proposal, low capacity,
partial/length/unknown replies, blocked subsequent calls after UNKNOWN, distinct
sessions/problems on the same agent and real child-tool execution within the
original 4-model/2-effect/5-second ceiling.

Supervisor worktree results: build passed, 267 Node tests, 478 Python tests and
92 entry E2E tests passed, with the original 24 optional WASI skips. No live math
API or performance evaluation ran. Exact-commit reproduction is recorded
separately before promotion. The former static three-unit test remains intact;
it is not used as proof of this stronger dependency-chain requirement.

## Remaining requirements

Actual artifact redo/replacement versions, transitive STALE propagation through
the main entry, bounded progress yielding and full parameter/quantifier/multipart
scope semantics still require G2 work. In-memory artifact retention is not durable
recovery or G4 event replay. Grounded correction of a protected candidate remains
G3; no proposal alone refutes or invalidates it. Official target/client, separate
real-evaluation authorization, release/default switching and L2 closure remain
independent gates.
