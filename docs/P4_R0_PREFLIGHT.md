# P4 R0 pristine-plan preflight and review libraries

Historical library-slice record: the subsequent
[R0/work offline shared-root workflow](P4_R0_WORKFLOW.md) is now accepted,
including a model-call-count planning allocation. Existing runtime defaults
are unchanged; plan revision/fallback and R1 are not yet implemented.

This slice adds M1 planning preflight and an independent M4 R0 review session.
It does not insert R0 into any existing solver or Host workflow. Existing
call limits, fixtures, Python entry, resources and dependencies are unchanged.
There is no real model request, new tool or default-engine switch.

## M1 decides whether to request review

`prepareP4R0(contract, options)` accepts only a pristine initial template
produced by the existing P2 compiler, including explicitly supplied goal specs
and version/event sequence. It recompiles that template and compares the
whole contract structurally. Missing obligations, altered tasks, custom graph
changes, inserted acceptance or an already-running plan are rejected; they
are not silently repaired into a new plan. Object-key order does not affect
structural equality, while declared array order remains significant.

The target retains the full contract and an exact planText serialization of
goals, obligations, tasks and risk hints. planHash is SHA-256 of the exact
JSON.stringify(contract) bytes; it is not a canonical mathematical identity
or proof that the template matches the original problem.

R0 model review defaults to disabled. Risk codes come from goal kinds and
existing non-assumptive risk hints. All-solutions, counting, optimization,
proof, multipart and unknown goals have explicit coverage-related risk codes;
a VALUE goal without hints takes the short path. Hints are never added to
local assumptions. The three outcomes are:

- SKIPPED_BY_POLICY when disabled or low risk, never a claimed R0 PASS;
- INSUFFICIENT_BUDGET when review is enabled and risky but the supplied budget
  cannot cover it;
- REQUEST_REVIEW when enabled, risky and the supplied view permits review.

The view allows planningModelCalls 0..1, remainingRootCalls 0..4 and
remainingMs 0..5000. A request requires one planning allowance, at least two
remaining root calls (reserving one for work), and more than 25 ms. These are
trusted-controller inputs, not a new resource authority or an implementation
of the design's proposed 25% planning sub-ledger. Both producer and consumer
enforce at most 32 risk hints; neither truncates them.

## M4 records an opinion, not planning acceptance

`validateP4R0Input` checks the preparation's exact fields, original problem
hash, contract identity, scope hashes, initial OPEN/READY states, task and
obligation links, dependency graph and plan hash/text. M4 does not import M1
or reimplement its template coverage algorithm. This is a trusted in-process
handoff, not authentication of arbitrary external objects.

`parseP4R0Report` accepts a strict p4-r0-review-v1 report bound to model-1,
stage R0, the exact target and every obligation ID in its original order.
PROBLEM_ALIGNMENT, SCOPE and TASK_COVERAGE must each occur once. Non-UNKNOWN
opinions need a rationale and exact Unicode-codepoint quotes from both the
original problem and plan text. Any ISSUES row forces ISSUES; NO_ISSUE needs
all three rows to agree; otherwise the conclusion is UNKNOWN. Duplicate or
extra keys, unsafe numbers, invalid Unicode, missing coverage, forged quotes
and inconsistent conclusions are rejected.

`P4R0ReviewSession` accepts only REQUEST_REVIEW for admission, at most once.
Fresh budget views cannot exceed the frozen preparation, and settlement time
cannot exceed the admitted remaining time. UNKNOWN transport outranks
lateness. Invalid-length/invalid-Unicode raw receipts leave DISPATCHED;
valid-length malformed reports settle as INVALID_REPORT with raw text kept.
No outcome grants another attempt. STALE preserves identity and history and
cannot hide a pending request.

The complete original problem, plan, risk codes and coverage stay in the
isolated context. Both messages, their byte count/hash and raw response are
retained. A plan under 65536 bytes can still create an oversized context
after serialization; admission then fails without truncation or a record.

All opinions remain MODEL_REVIEW, at most REVIEWED, checkResult UNKNOWN,
canSupportObligation false and canReviseContract false. No obligation is
satisfied or contract modified. Method-premise representation is not yet
modeled here, so this slice does not complete every R0 responsibility.

## Verification and remaining work

Supervisor verification: TypeScript build and 175 Node tests passed (164
previous plus 11 new groups); 381 Python tests passed with the same 24
optional WASI skips. Twenty-six additional supervisor controls passed,
covering all goal kinds, budget dispatch policy, 32/33 hints, exact hashing,
mutation isolation, re-hashed invalid links and shrinking settlement windows.
Tests use real compiler/preflight records and literal synthetic reports, not
real mathematical model evaluation.

The assigned dsh DeepSeek executor authored code and tests; the supervisor
reviewed/applied patches and independently verified them. An incomplete
input-validator draft was withheld and subsequently supplied in full.

Next work includes R0 shared-root orchestration, at most one directed plan
revision and fallback policy, R1 branch pre-review, formal Host/client
integration, mathematical verification and target/default-switch acceptance.
