# P4 R0 review/work shared-root offline workflow

`runP4R0Fixture` connects the accepted M1 pristine-plan preflight and M4 R0
review to one M3 work unit and M5 candidate selection. It consumes keyed
synthetic receipt slots, not a real model client. Existing workflows, Host
protocols, Python entry, resources, dependencies and defaults are unchanged.

## Shared root and planning call allocation

The new fixture defaults to maxModelCalls 1, r0Enabled false and
planningPercent 25. remainingMs (1..5000) and BEST_EFFORT/STRICT policy are
explicit. One `P4R0ModelGate` records the entire run, with one original
deadline and a 25 ms new-call reserve. There is no nested runner or budget
restart.

The planning allowance is `min(1, floor(rootCeiling * planningPercent / 100))`.
It counts **model calls only**, not tokens or wall-clock consumption. Its
denominator is the frozen root ceiling, not the calls eventually consumed.
For example, four available root calls at 25% permit one R0 call; three at
25% permit none; two at an explicitly configured 50% permit one. R0 must
also leave a call for work, so a one-call root cannot run R0 even at 100%.
The fixture performs at most one R0 and one work call; it does not consume
unused quota merely because the ceiling allows it.

M1 preflight remains mandatory on normal in-budget paths. When policy skips
R0 or its allocation is insufficient, the fixture takes an explicitly
unreviewed work path; neither outcome is recorded as PASS. When M1 requests
review, a missing `r0` slot stops execution rather than treating `work` as
the review. Only a complete, timely NO_ISSUE report opens the reviewed work
path. ISSUES, UNKNOWN, malformed reports, incomplete transport and lateness
stop without work, retry or automatic plan revision.

## Phase and identity binding

R0 is admitted against the pristine plan binding before any M1 task starts.
Its gate record has phase R0 and null task/scope IDs; no RUNNING task is
fabricated to satisfy a work-call API. The planHash is the actual SHA-256 of
the initial contract. It does not become a mathematical equivalence claim.

Work follows a real M1 task start. Unreviewed work uses model-1; after R0
model-1, work uses model-2. Both phases share the same gate and initial plan
identity. The M3 work packet must match its actual request ID. The supported
work path is one dependency-free CANDIDATE_VALIDITY or ANSWER_REQUEST task;
this is not a complete multi-task solver for every reviewed goal kind.

Options, receipt values and clock handle are captured before the first
clock callback. Unknown option/slot keys and malformed slot shapes are
rejected. Later callback mutation cannot raise limits or replace captured
messages. Initial invalid clocks fail explicitly; later exceptions, NaN or
rewinds permanently exhaust remaining time. Admission and settlement use
the same original deadline, including R0 context construction and work
preparation. An unfinished request is not counted as a dispatched call.

## Conservative results

The model's R0 opinion remains MODEL_REVIEW, at most REVIEWED, with
checkResult UNKNOWN, canSupportObligation false and canReviseContract false.
R0 is not passed to S3 as an artifact-level R2 report. Its issues and raw
report remain in the separate R0 record; the S3 challenge count is not an
R0 issue count.

Only complete, timely M3 work with a usable candidate can be protected.
Incomplete material may remain ACTIVE in storage without being eligible as
an answer. BEST_EFFORT may emit the unverified candidate; STRICT and exhausted
time withhold. No obligation is satisfied, plan revised or proof claimed.

The private result preserves initial/current contracts, preparation, R0
snapshot, full request contexts and hashes/bytes, raw receipts, M1 events,
artifacts, shared model records and final decision. Public output contains
fixed codes/counts and the designated answer, not problem/plan text or review
rationales. These in-memory records do not implement durable crash recovery.

## Verification and remaining work

Supervisor verification: TypeScript build and 187 Node tests passed (175
previous plus 12 new groups); 381 Python tests passed with the same 24
optional WASI skips. Another 113 supervisor controls passed, including 45
root/percentage combinations, 54 clock-fault cases across both paths,
26/25 ms boundaries and UNKNOWN-over-lateness. Reports and model responses
are synthetic literals, not real mathematical evaluation.

The assigned dsh DeepSeek executor authored implementation and tests; the
supervisor reviewed/applied patches and independently verified them. An
incomplete workflow draft was withheld and replaced with a complete one.
Tests were corrected to exercise actual clock samples and elapsed time,
without weakening the rejection of invalid candidates.

Next: at most one directed plan revision, revised-plan review and fallback
policy under the same root budget. Method-premise representation, R1,
formal Host/client integration, mathematical verification and target/default
switch acceptance remain unfinished. This slice does not complete all R0.
