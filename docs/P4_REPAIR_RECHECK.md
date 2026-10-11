# P4 S2 post-repair model review — independent libraries

This increment adds a strict report protocol, material validator, parser and
single-review session for a repair proposal. It does not add a fourth call
to an existing workflow. P2ModelGate still caps model calls at three, and all
existing fixtures, P3 Host, Python entry, solver, resources and dependencies
are unchanged. There is no network call, new tool or default-engine switch.

## Material binding

`validateP4RecheckInput(contract, parent, child, parentReview, repair)`
rebuilds the ACTIVE M3 targets. The original parent comes from model-1; the
child is repair-1/version 1 from model-3, with the same task, goal, scope,
route and used assumptions. At least one of claim, derivation and candidate
must change. Only the existing dependency-free repair slice is supported.

The validator replays the recorded R2 model-2 report through the existing
pure M4 session and compares the whole snapshot. This is an object replay,
not another model request. The triggering challenge must be the actual
ACTIVE/CHALLENGED entry and the repair must be a COMPLETE, RETURNED,
PROPOSAL_RECORDED record. The original child raw text, repair context payload
and parent/child lineage must match, including unchanged unverified flags.

Repair messages retain their roles, exact context bytes/hash and original
problem, parent, scope, assumptions, route, challenge and obligations.
Re-hashing an altered payload does not make it admissible. The already
validated frozen repair is returned; the caller object is not read again
after validation. `repairHash` covers its exact JSON.stringify serialization,
not mathematical equivalence. These APIs assume a trusted controller; they
are not cryptographic authentication for arbitrary external records.

## Review and evidence

`parseP4RecheckReport` accepts the versioned `p4-recheck-v1` report for
model-4/stage S2, bound to both target identities/hashes, the original
challenge and repair hash. Coverage must equal the challenge's obligation
IDs, in their original order. Each of ISSUE_RESPONSE, PREMISES and
DEPENDENCIES must occur exactly once, with a NO_ISSUE/ISSUES/UNKNOWN opinion
and non-empty rationale. Non-UNKNOWN opinions require an exact non-empty
Unicode-codepoint quote from the child's derivation. Parent quotes cannot
stand in for child quotes.

Any ISSUES row forces ISSUES; NO_ISSUE requires all three NO_ISSUE rows;
otherwise the conclusion is UNKNOWN. Strict JSON guards reject duplicate or
extra fields, unsafe numbers, lone surrogates, excessive depth/size, missing
coverage, inconsistent conclusions and forged quotes. Such checks cannot
establish that the model's rationale or repair is mathematically correct.

`P4RecheckSession` captures all inputs and builds an isolated context with
the full original problem, both versions, scopes, premises, dependencies,
candidates, changed fields and triggering challenge. Quoted content is
untrusted data, not instructions or permissions. No other review score is
included. Full context, bytes/hash and raw response are retained.

Every record remains MODEL_REVIEW, at most REVIEWED, checkResult UNKNOWN,
canSupportObligation false, canReplaceProtected false and
requiresSemanticRecheck true. Neither NO_ISSUE nor ISSUES changes the
original challenge, supersedes the parent, transfers evidence to the child,
satisfies an obligation or authorizes candidate replacement.

## Budget boundary and unfinished integration

The session permits at most one review. `admit(remainingMs, remainingRootCalls)`
requires 26..5000 ms and exactly one remaining call; zero remaining calls
are refused without mutation. The caller supplies this view and must enforce
the actual original root deadline and shared quota. The library does not
authenticate that budget view or allocate new quota.

Dispatch is explicit. UNKNOWN takes precedence over lateness; valid-length
malformed reports return INVALID_REPORT with raw text retained, while invalid
raw values or exceeded bounds leave the record DISPATCHED. Late, ERROR and
TRUNCATED settlements yield no usable report. No second admission or retry
is allowed. Staleness preserves identity/history and cannot conceal a
pending call.

The existing work → R2 review → repair fixture already consumes three
calls. A future four-step composition must separately accept a shared root
budget before dispatching model-4. This increment does not nest or restart
that fixture and is not a live post-repair review integration.

## Verification

Supervisor verification: TypeScript build and 149 Node tests passed (139
previous plus 10 new groups); 381 Python tests passed with the same 24
optional WASI skips. Twenty additional supervisor controls passed, including
mutation before admission, changing getters, Unicode spans, original-call
cap preservation, forged lineage and UNKNOWN-over-lateness.

Tests construct real M1/M3/M4/M5 records using synthetic literal model
receipts, including genuinely M3-accepted no-op and newly used declared
assumption children. No real mathematical model evaluation occurred. The
assigned dsh DeepSeek executor authored code/tests; the supervisor reviewed,
applied and independently verified them.

Next: shared-budget post-repair review composition. Mathematical verification,
authorized replacement, dependency reopening, R0/R1, formal Host/client and
target/default-switch acceptance remain pending.
