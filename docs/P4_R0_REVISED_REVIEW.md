# P4 R0 revised-plan review libraries

This slice follows the [bounded revision proposal libraries](P4_R0_REVISION_PROPOSAL.md).
It reviews the actual revised contract in a separate model-3 session. It does
not activate a plan, modify a ledger, dispatch real model requests or connect
revision to the existing shared-root workflow. Runtime budgets, defaults,
Host protocols, Python entry, dependencies and resources are unchanged.

## M1 prepares the actual revised version

`prepareP4R0Recheck(originalPreparation, trigger, revision, options)` captures
its inputs and replays the recorded model-2 response through the real M1
revision session. The entire resulting snapshot must match the supplied
ACTIVE, successfully recorded proposal, including context, raw response,
contract, delta, lineage and events. This is pure object replay, not another
network request or resource charge.

The target is the actual child contract. Its planHash hashes that snapshot,
and planText retains its goals, obligations, tasks and risk hints. Existing
affected obligations stay REOPENED; new obligations remain OPEN. The child
is never normalized into a pristine template for the old R0 API. Original
problem text, scope, parent revision records and event sequence are preserved.
Event sequence and contract version are separate identities.

The required options are a caller-supplied remaining budget view: planning
calls 0..1, root calls no greater than the original preparation minus the two
recorded planning calls, and remaining time no greater than the original
preparation. REQUEST_REVIEW requires one planning call, two root calls and
at least 26 ms. Otherwise the result is INSUFFICIENT_BUDGET, never an implicit
review pass. The two root calls reserve one for later work.

These views do not reconstruct elapsed wall-clock time or implement a global
budget authority. The future controller must supply genuinely remaining
resources under the original deadline. The existing cap-one planning
allocation is unchanged and cannot automatically fund revision plus recheck.

## M4 validates the handoff and records a new opinion

M4 `validateP4R0RecheckInput` checks the trusted M1 handoff without importing
M1 or rebuilding its compiler. Checks include parent/child and whole-revision
hashes, actual goal-kind changes with unchanged scopes/topology, version and
event bindings, source report/context correspondence, task graph references,
coverage and exact OPEN/REOPENED states derived from the supplied parent and
delta. This is structural validation, not authentication of arbitrary external
records. M1 remains responsible for complete ledger/template replay.

`parseP4R0RecheckReport` accepts only `p4-r0-recheck-v1`, request model-3,
stage R0_RECHECK, both version bindings and the review/revision hashes.
Coverage must name every child obligation in order. PROBLEM_ALIGNMENT, SCOPE
and TASK_COVERAGE each occur once, with bounded rationales and exact original
problem/child-plan Unicode-codepoint quotes. ISSUES dominates aggregation;
NO_ISSUE requires all three rows; other combinations are UNKNOWN. Duplicate
keys, extra fields, unsafe numbers, invalid Unicode and forged quotes fail.

`P4R0RecheckSession` permits at most one attempt, only on REQUEST_REVIEW.
Fresh admission and settlement views may only shrink. Its isolated context
contains the full original problem and actual new plan, coverage and opaque
lineage bindings. It excludes the old review opinions, revision rationales,
parent plan and solver self-assessment. It does not claim that method premises
have been verified; that representation remains unfinished.

The complete two-message context is limited to 65536 UTF-8 bytes and is never
truncated. Raw responses are bounded by 20000 codepoints and 65536 bytes.
Physical raw violations leave DISPATCHED; legal-size malformed reports settle
INVALID_REPORT with the original raw text retained. UNKNOWN transport outranks
lateness; late or incomplete responses produce no usable report. Terminal
outcomes cannot retry, and STALE cannot hide a pending request.

Every result remains MODEL_REVIEW, at most REVIEWED, checkResult UNKNOWN,
canSupportObligation false and canActivate false. Even NO_ISSUE does not
satisfy an obligation, erase the parent's ISSUES, or enable work by itself.

## Verification and remaining work

Supervisor verification: TypeScript build and 221 Node tests passed (201
existing plus 20 new groups); 381 Python tests passed with the same 24 optional
WASI skips. Another 167 supervisor controls passed: 30 M1 preparation cases,
60 leaf-kind/event-sequence combinations plus one re-hashed state mutation,
60 session budget cases and 16 transport/time combinations.

The assigned dsh DeepSeek executor authored implementation and repository
tests; the supervisor reviewed/applied patches and ran verification. Review
corrected an event-sequence/version mix-up and test-side mistakes involving
imports, valid whitespace/spans used as negative cases, and re-hashing that
accidentally repaired a deliberately invalid test input. Final controls reach
the intended parser/state checks without relaxing their invariants.

All responses are synthetic literals. The oversized-context case uses a real
three-goal revision with 15 child obligations: revision succeeds, but recheck
context admission fails atomically without truncation. Offline success is not
a mathematical-quality or formal deployment result.

Shared-root revision/recheck/work orchestration and fixed-template fallback
still need separate acceptance. Method-premise representation, R1, formal
Host/client integration, mathematical verification and target/default-switch
acceptance remain pending. This library does not complete R0 or the migration.
