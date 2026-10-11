# P4 R0 bounded goal-kind revision proposal libraries

This library slice follows the [R0/work offline workflow](P4_R0_WORKFLOW.md).
It does not connect revision to that workflow or any Host/client. Existing
runtime budgets, defaults, Python entry, dependencies and resources are unchanged.
There is no real mathematical model call or mathematical-quality claim.

## Version-bound trigger and restricted report

M4 `createP4R0RevisionTrigger` replays an already-recorded R0 response through
the existing review session, using objects only and no network request.
The entire replayed snapshot must match: ACTIVE, RETURNED, COMPLETE, code OK,
and conclusion ISSUES. NO_ISSUE, UNKNOWN, stale and altered records cannot
trigger revision. The trigger retains the parent binding, SHA-256 of the full
review snapshot and the dimensions actually marked ISSUES.

M1 independently rebuilds the pristine preparation, validates the trigger's
identity, context and raw/report correspondence, and parses the strict
`p4-r0-plan-revision-v1` model-2 report. M1 does not import M4; M4 owns full
R0 report replay. These are trusted-controller handoffs, not authentication
of arbitrary external records.

A report may change only the kind of an existing leaf goal. It cannot add
goals or assumptions, edit scope, remove subquestions, change tree topology,
or convert a MULTIPART parent. Each change must differ from its recorded kind,
name an actual ISSUES dimension, and quote exact Unicode-codepoint slices of
the original problem and the exact old leaf's JSON in planText. Duplicate
goals, no-ops, extra fields and malformed JSON are rejected. At most eight
changes are allowed in one report; existing compiler capacity limits still apply.

## Single-attempt session and budget contract

`P4R0PlanRevisionSession` captures frozen inputs and owns a private real
`ContractLedger`. Admission is at most once, with maxRevisions 0..1. Its
supplied budget view must reserve both revised-plan review and later work:
at least two remaining planning calls and three remaining root calls, with
planning <= root - 1 and root <= preparation.remainingRootCalls - 1.
Time must be 26 ms through the preparation's remaining time; settlement
cannot increase the admitted view. These numbers are caller-owned views,
not new quota or a clock implementation.

The existing workflow's `min(1, floor(rootCeiling * planningPercent / 100))`
planning allocation is unchanged and cannot fund this additional sequence.
No current runner silently raises that allowance or dispatches model-2 for
revision. Integration needs separately accepted shared-root reservation and
revised-plan review/fallback policy.

Both full context messages, their hash/UTF-8 byte count and raw response are
retained. Contexts over 65536 bytes fail without truncation or admission.
Physically oversized or invalid-Unicode receipts leave DISPATCHED. Legal-size
malformed reports settle INVALID_REVISION with raw text retained. UNKNOWN
transport outranks lateness; late, errored or truncated receipts never apply
a proposal. No outcome permits retry, and STALE cannot hide a pending request.

## Private ledger application is not activation

A valid proposal copies the original goal tree, changes only selected leaf
kinds, and calls the private ledger's `reviseGoals` once. Version, delta and
events come from the actual ledger. Existing affected obligations remain
REOPENED, new obligations are OPEN, and unrelated state is preserved. The
lineage uses the actual changedGoalIds, including affected multipart ancestors,
and hashes the actual revised contract snapshot.

The parent and its R0 report remain unchanged. The child always has
requiresRecheck true, checkResult UNKNOWN, canActivate false and canSupport
false. It is not silently normalized into a pristine OPEN-only template for
the old R0 API. There is no automatic review, work, fallback or parent replacement.
Successful recording does not prove the proposed goal kind is correct.

## Verification and remaining work

Implementation and repository tests are authored by the assigned dsh DeepSeek
executor; the supervisor reviews/applies patches and runs the actual checks.
Tests use real compiler, ledger and review components with synthetic literal
responses, not mathematical evaluations.

Supervisor verification: TypeScript build and 201 Node tests passed (187
existing plus 14 new groups); 381 Python tests passed with the same 24 optional
WASI skips. Another 222 supervisor controls passed: 180 admission-budget
combinations, 30 leaf-kind transitions, and 12 identity/version/size checks.
The existing P3 method Host regression retains three model fixture calls,
one catalog call, one method load, one cache reuse and an unverified candidate.

Review withheld a truncated test-file draft and corrected test-side mistakes:
wrong package imports, new obligations incorrectly expected as REOPENED,
negative controls that stopped before reaching the parser, and a fixture
helper that discarded declared scopes. Final tests exercise the actual parser,
Unicode offsets, oversized context and private-ledger capacity rejection.

Revised-plan review, shared-root revision/fallback orchestration, method-premise
representation, R1, formal Host/client integration, mathematical verification
and target/default-switch acceptance remain pending. This is a restricted
proposal library, not a complete plan editor or complete R0 implementation.
