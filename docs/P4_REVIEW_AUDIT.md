# P4 R2 review and S3 conservative selection

This is the first offline M4/M5 increment, not a complete mathematical review
or verification engine. It adds pure TypeScript libraries and a fixture
composition root. P3 Host protocol `1.1-p3-host-local`, the official Python
entry, solver, resources and dependencies remain unchanged. There is no
new RPC, network client, tool execution or default-engine switch.

## Supported flow

`runP4Fixture` in `apps/stdio-runtime/src/p4-fixture.ts` accepts a problem,
session ID, literal transportStatus/text receipts and trusted options:
maxModelCalls 0..3, maxReviews 0..2, remainingMs 1..5000, policy BEST_EFFORT or
STRICT, and an optional test clock. This is a library/test surface, not a new
competition entry point.

The composition uses ContractLedger, P2ModelGate, P2WorkunitStore and
prepareP2Context for the first work request. The actual response must be a
valid P2 WorkPacket for model-1, route-1 and the selected candidate-bearing
task; it is not manufactured from a final action. The resulting artifact ID
is artifact-1. The same RUNNING task is used through review, then its actual
delivery is recorded without satisfying an obligation. The fixed fixture
route uses equation / derive / no lemmas / offline construction.

Only one dependency-free complete candidate artifact is supported in this
slice. Review requests use model-2/model-3, so the work receipt and up to two
reviews consume the same three-call ceiling and root deadline. The 25 ms
reserve prevents starting another review; it does not erase an earlier
complete best-effort candidate. An exhausted or invalid root clock withholds
delivery. Nonfinite, throwing or regressing clocks cannot refresh the budget.

The mathematical packages import the shared protocol, not each other. Only
the app composition joins M1 through M5. Shared P4 target guards reconcile
M1/M3 session, problem hash, contract/artifact versions, task, goal, scope,
source request, exact raw receipt hash and parsed packet. Scope assumptions
must remain declared. Target availability is separate from target identity.
These checks operate on trusted control snapshots; hashes are identity checks,
not authentication or proof of mathematical equivalence.

## R2 reports and challenges

P4ReviewSession prepares two isolated messages containing the full problem,
target identity/hash, scope, relevant obligations, claim, derivation and
assumptions. It excludes structured solver delivery self-assessment,
candidateProposal, suggestedChecks, raw response packets and previous review
conclusions. Untrusted prose can still contain misleading content; context
isolation is not a guarantee of independent reasoning.

Each context's byte count and SHA256 cover the same complete
`JSON.stringify(messages)` serialization, bounded to 65536 UTF-8 bytes.
No critical material is silently truncated. Prepared contexts, dispatch
states, raw receipts and parsed reports are retained privately.

The strict report schema is p4-review-v1, stage R2. It binds the exact review
request, original target binding and target hash. Conclusions are NO_ISSUE,
ISSUES or UNKNOWN. Every issue provides:

- a half-open Unicode-codepoint span and exact quote from the derivation;
- a fixed suspected-issue kind;
- rationale and a bounded requested check;
- actual obligation IDs included in the report's declared review coverage.

NO_ISSUE requires declared coverage of all relevant goal/scope obligations and
no issues, but remains a model claim, not a proof. Missing coverage, malformed
JSON, extra verification fields, mismatched versions or invalid quotations are
not accepted as successful reports. Duplicate keys, floats, unsafe/nonfinite
numbers, lone surrogates and excessive depth are rejected by existing strict
protocol machinery. A legal UNKNOWN report can carry empty coverage.

One session admits at most two reviews, one at a time. It distinguishes
ADMITTED, DISPATCHED, RETURNED and OUTCOME_UNKNOWN. Invalid, partial, errored,
unknown or late results retain bounded raw material and fixed reason codes;
they do not trigger automatic retries. UNKNOWN responsibility is retained
even if time has also expired.

Suspicions are deduplicated by target identity/version, exact step range,
issue kind and obligation set. Different rationale wording does not create a
new challenge; the first issue and all reporting request IDs remain recorded.
Challenges stay CHALLENGED, never model-declared RESOLVED or CONFIRMED. Staling
a settled target marks challenge/evidence availability STALE, not REFUTED.
No keyword rule is treated as a mathematical counterexample.

Review evidence has source MODEL_REVIEW, level at most REVIEWED and
checkResult UNKNOWN. Partial/invalid/unknown review outcomes stay PROVISIONAL.
Two agreeing reviews cannot produce CHECKED_SCOPE, FORMAL or PASS.

## S3 candidate protection and policies

P4CandidateGate protects the first eligible complete candidate. A later
different candidate cannot overwrite it, and a model suspicion cannot refute
it. The caller supplies the current control-side view of that protected
target at finalization. A stale/missing/different version or changed contract
withholds the old candidate; this increment implements no automatic repair,
replacement or migration.

M5 reconciles review bindings, context identities, report/receipt consistency,
evidence labels and the complete challenge set. Removing a challenge or one
of its reporting request IDs cannot conceal a recorded issue. A repeated
issue within the same report is matched to its first recorded occurrence.
These are structural consistency checks, not an independent mathematical
checker or an authenticated external-snapshot import interface.

BEST_EFFORT can return the original complete candidate while retaining open
obligations and unresolved challenges. STRICT always withholds in this slice,
because no independently accepted checker is available. All outputs retain
candidateVerified=false and strictAcceptance=NOT_PERFORMED. A candidate is
not mathematically accepted merely because it is eligible for best-effort
delivery.

Coverage keeps deliveryCovered, reviewMentioned and checkResult separate.
Every checkResult remains UNKNOWN; mentioning exhaustiveness, a boundary or
a proof obligation does not close it. No M1 acceptance method is called and
no M3 artifact level is promoted. Public summaries contain the designated
answer/unsolved text, fixed codes and counts, not review rationale or private
derivations. Full coverage and binding records remain in privateState.

## Verification and limits

From an already provisioned checkout:

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q
```

Supervisor verification on 2026-10-11: 110 Node tests passed (97 prior plus
13 groups); all 381 Python regressions passed, with the same 24 optional
WASI skips. The new fixture tests use actual M1/M3 artifacts, an explicit
zero-factor omission report, codepoint spans, repeated suspicions, stale
targets, strict/best-effort policies, shared call limits and clock regression.
They verify that neither agreement nor tool-like evidence labels can bypass
the conservative gate. These are synthetic mechanism checks, not a real
model evaluation or demonstrated mathematical accuracy improvement.

Fourteen additional supervisor controls rejected altered challenge/evidence
records and bindings, preserved the first candidate after three incomplete
review transport modes, and verified that a clock callback cannot enlarge
captured call limits. Independent lifecycle checks also exercised complete
context hashing and changed-rationale deduplication.

The assigned dsh DeepSeek executor drafted implementation and repository
tests. The supervisor reviewed/applied patches and independently ran checks.
Incomplete additions were withheld or only complete standalone methods/test
groups retained. Mechanical corrections covered package placement/imports,
duplicate type declarations, a syntax delimiter, negative-test casts and
mutable attack fixtures, and one fixed error-code expectation; no acceptance
assertion was removed to obtain a pass.

R0/R1, S1 semantic check-scope mapping, S2 bounded repair and candidate lineage,
dependency-bearing review targets, real model/Host review calls, durable
external responsibility, complete M2 policy and formal deployment/default
gates remain pending. This increment must not be described as full P4 or
mathematical verification.
