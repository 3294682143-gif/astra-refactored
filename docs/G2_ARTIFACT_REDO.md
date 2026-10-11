# G2D: actual artifact redo and scoped invalidation

This checkpoint executes redo through the existing public entry and the one TS
AgentLoop. It is structural version management, not mathematical refutation,
verified candidate replacement, general recovery or full G2 completion. DSH
authored implementation/tests; the supervisor reviewed, applied and verified them.

## Lifecycle

A strict `p2a-work-v4` packet preserves the original work fields and adds a
nullable REDO_ARTIFACT suggestion with targetArtifactRef and rationale. A null
target means the just-accepted work itself; otherwise the target must be a real
input ref of that work. TS independently checks current/latest/ACTIVE delivery,
same session/contract/full scope/route, an unclosed pending obligation, one-redo
limit and room for another WORK plus the configured review. The model cannot
choose a new version, task, supersedes ref or budget.

Admission schedules only the particular delivered task, retaining a private
rollback snapshot. It does not invalidate the old artifact or refute a candidate.
M2 schedules that actual task again. M3 runs the normal receipt/scope/dependency
checks through a shared pure preflight; M1 separately prevalidates the precise
delivery/invalidation transaction. Only a real COMPLETE, changed-material reply
commits the same artifact ID at the next version. The old raw response and hash
remain intact. The existing M3 dependency closure is marked STALE, and only the
affected task graph is reopened. An unrelated task sharing the same obligation
is not indiscriminately cleared.

Invalid, no-op, truncated, errored or unknown redo replies do not replace the
old artifact. The ledger restores its backed-up delivery state without rolling
back event sequence or refunding calls. No-op comparison ignores control metadata
such as schema/request/proposal fields and compares actual packet material as
data; it is not a proof of mathematical equivalence.

The original protected candidate remains a separate immutable record. If its
artifact becomes STALE, existing S3 withholds it as STALE_CANDIDATE rather than
silently replacing it with the new model answer. An unaffected candidate remains
eligible under the existing BEST_EFFORT/STRICT policy. Grounded replacement is G3.

## Host evidence and bounded profile

WORK context v6 exposes explicit redo permission, revision provenance and the
old target as revision material—not as an extra mathematical input premise.
Host re-derives artifact IDs, versions, exact raw hashes and availability from
previously validated request/receipt history. It checks the source suggestion,
actual target, full task/scope/route identity and capacity before the redo call.
Old v1/v2/v3 packet schemas and 1.2/1.3 frame files remain unchanged; historical
v2–v5 WORK contexts retain explicit read-only validation.

One successful redo ends further WORK in this preview profile, proceeding to
applicable R2/S3. The retained ready-task view contains the new version refs, but
this slice does not claim resumed downstream solving after that commit. Host
projection does not invent the full post-redo M1 event stream. Durable event
replay/recovery remains G4/later work. The original maximums remain four model
calls, two effects, three accepted work units and five seconds.

## Actual verification

- Public-entry parent → dependent child proposing redo → actual parent redo:
  three calls produce artifact-1@2 ACTIVE, with artifact-1@1 and artifact-2@1
  STALE. The reopened child's ready projection references artifact-1@2.
- Public-entry route-1 → route-2 work requesting its own redo → actual route-2
  redo: the old route-2 version is STALE, its new version ACTIVE, and route-1's
  artifact, task and protected answer remain intact.
- No-op/length/unknown controls preserve old versions and answer, with spent
  calls retained; unknown outcomes block subsequent use of that client adapter.
- Additional supervisor read-only diagnostics rejected six correctly rehashed
  source/ref/version/hash/route/target-raw mutations before a redo client call.
  Invalid redo JSON retained the old answer after three spent calls. A one-call
  run emitted a v4 suggestion but gained no redo. Duplicate/unsafe/extra-authority
  packet fields were rejected. These diagnostics are not additional pytest counts.

Worktree verification: TypeScript build, 269 Node tests, 484 Python tests and
98 real-entry E2E tests passed; the original 24 optional WASI cases remain skipped.
Exact-commit reproduction is recorded separately before promotion. No real math
API, mathematical score or formal target deployment was used or claimed.

Remaining G2 work includes bounded no-progress yielding and complete parameter,
quantifier, branch and multipart scope semantics. Broad RC2 parity, G3 grounded
candidate correction, G4 runtime replay, official evaluation/release and L1/L2
closure are still pending. This checkpoint does not close PR3/G2.
