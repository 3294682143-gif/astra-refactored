# P4 S2 shared-root four-step offline workflow

`runP4RecheckFixture` composes the real M1 contract/ledger, M2 model gate,
M3 workunit store, M4 R2 and post-repair review sessions, and M5 repair and
candidate gates. It consumes literal synthetic receipts, not a real model
client. There is no tool execution, new RPC, dependency or default switch.
The old fixtures, P2 model gate, P3 Host, official Python entry, solver and
resources remain unchanged.

## Explicit opt-in and one root

The sequence is work model-1 → R2 review model-2 → repair model-3 → S2
post-repair review model-4. The fourth step requires all of:

- explicit `maxModelCalls: 4` and `maxRechecks: 1`;
- a real ACTIVE/CHALLENGED R2 challenge and PROPOSAL_RECORDED repair;
- an ACTIVE repair child accepted by M3, matching the prior material;
- a fourth receipt and more than 25 ms left in the original root window.

The new options default to maxModelCalls 3 and maxRechecks 0. maxRepairs
remains explicit and bounded to 0..1. Setting only one of the two opt-in
options does not dispatch model-4. With default options, all previous
three-step summary fields and the model ledger agree with runP4RepairFixture.
The existing P2ModelGate still rejects a four-call cap.

The independent `P4RecheckModelGate` defaults to three and has a hard ceiling
of four. It records every admission from model-1 onward in one ledger with
immutable snapshots and sequential request IDs and ordinals. Pending, duplicate, skipped,
foreign-bound or non-COMPLETE preceding calls prevent another admission.
There is no nested runner, second gate for the fourth step, quota refill or
deadline restart. The recheck session receives the actual remaining quota
derived from this ledger, rather than a fresh allowance.

All steps share a single remainingMs budget of 1..5000 ms and a 25 ms new-call
reserve. Options, the clock and all input receipts are captured before the
first clock callback. Later mutation cannot widen configuration or replace
receipts. An initial exception/non-finite clock is rejected; a subsequent
exception, non-finite value or rewind permanently exhausts remaining time.
Context construction is followed by fresh deadline checks before dispatch.

## Conservative outcomes

The first complete parent remains protected. Recheck NO_ISSUE, ISSUES and
UNKNOWN are only model opinions: at most MODEL_REVIEW/REVIEWED, always
checkResult UNKNOWN, canSupportObligation false and canReplaceProtected false.
They do not resolve the original challenge, satisfy obligations, supersede
the parent or transfer its evidence to the child. The repair lineage still
requires rechecking.

`recheckCalls` counts dispatched fixture receipts; `recheckRecorded` means
that an OK report was parsed, including a valid UNKNOWN opinion. It never
means mathematical verification. Malformed reports and incomplete transport
retain their raw text but do not produce an accepted report. UNKNOWN transport
keeps OUTCOME_UNKNOWN even when late. No result triggers another repair or
fifth call.

BEST_EFFORT selects the original parent when time remains. STRICT withholds,
and an exhausted root withholds under either policy while preserving the
protected record. A review can settle on time and the root can expire later
at finalization; this is distinct from a late review. An incomplete first
work packet may remain ACTIVE as material without being an eligible candidate.
An invalid/no-op repair child that was stored is made STALE, not REFUTED;
the parent remains available.

The private result retains full contexts, hashes/byte counts, original
receipts, artifacts, original review, repair, recheck and the shared model
ledger. The public summary exposes fixed codes/counts and the designated
parent answer, not the child proposal, original problem or review rationales.
The M1 parent delivery and separate local M3 child sequence are not a unified
durable journal, and the workflow does not implement crash recovery.

## Verification

Supervisor verification: TypeScript build and 164 Node tests passed (149
previous plus 15 new gate/flow/boundary groups); 381 Python tests passed with
the same 24 optional WASI skips. Ninety additional supervisor controls passed,
including three opinions under both policies, all caps 0..4, default parity,
upstream incomplete transports, 63 clock-fault cases across the 22 normal
clock samples, and the fourth-call 26/25 ms boundary. Model receipts are
synthetic literals; these are mechanism tests, not mathematical evaluation.

The assigned dsh DeepSeek executor authored the implementation and tests.
The supervisor reused the author's previous fixture as a separate starting
file, reviewed/applied changes and ran verification. A length-limited output
was used only for complete test units; its incomplete group was withheld and
subsequently supplied in full. Existing accepted tests were not weakened.

The four-step root is accepted only for this offline fixture. The separate
[R0 pristine-plan libraries](P4_R0_PREFLIGHT.md) and initial
[R0/work workflow](P4_R0_WORKFLOW.md) are accepted,
but full R0 revision/fallback and R1 review,
mathematical verification, authorized candidate replacement, dependency
reopening, formal Host/client integration, durable external responsibility
and target/default-switch acceptance remain pending.
