# P4 S1 offline mapping-review composition

`runP4MappingFixture` now composes the previously accepted mapping libraries
with the real M1 contract ledger, M2 model gate, M3 workunit store and M5
diagnostic/candidate gates. This completes the previously withheld offline
composition, not semantic-equivalence verification or the full P4 stage.
The P3 Host, previous P4 fixtures, official Python entry, solver, resources
and dependencies are unchanged. There is no real model client, new RPC,
new tool permission or default-engine switch.

## Sequence and limits

1. A literal `model-1` receipt supplies a genuine M3 work packet and protected
   parent candidate for one dependency-free task.
2. M5 structurally prechecks an explicitly supplied fixture tool action.
   M4 then reviews its correspondence using one literal `model-2` receipt.
3. Only a complete, timely, correctly bound five-dimension MATCH report
   permits one injected diagnostic tool call through M2 and M5.
4. S3 retains the original parent under BEST_EFFORT; STRICT withholds.
   Exhausted time also withholds. The protected record remains identifiable.

Both model calls share one original deadline: maxModelCalls 0..2,
maxChecks 0..1, remainingMs 1..5000, with a 25 ms reserve for new calls.
Configuration, input receipts, tool action, clock and execute handle are
captured before the first clock callback. Later callback mutation cannot
increase the captured limits. A first clock exception/non-finite value is
rejected; later exceptions, non-finite values or rewinds permanently stop
new dispatch.

M2 and M5 retain identical admitted requests. Just before dispatch, the
execution request's relative window is additionally clipped to the latest
remaining time. Private records distinguish `admittedEffectRequest` from the
actual `effectRequest`; only the remaining-time field may shrink. Identity,
action and plan hash do not change and neither quota nor deadline restarts.
This prevents a 5000 ms admission from being passed to the tool when only
3000 ms remain. At 25 ms or less the tool is not dispatched.

The controller invokes a trusted synchronous effect port. That executor must
honor its supplied window and provide actual bounded isolation. This fixture
does not preempt an arbitrary blocking callback; it rejects late output once
control returns. Existing Python isolated operators are used only with
synthetic inputs in the engineering tests.

## Receipt responsibility and evidence

The effect request is recorded before execution. A throwing port creates a
fixed UNKNOWN receipt, counts as one attempt and is never retried. A
non-JSON result such as undefined, a function, a cycle or a throwing getter
records `UNSERIALIZABLE_RECEIPT` with null private receipt data. M2/M5 remain
DISPATCHED; this is unresolved responsibility, not cancellation or success.
The original candidate is still returned under BEST_EFFORT if time remains.
Arbitrary exception text and non-serializable objects are not echoed.

A JSON-shaped forged receipt is retained privately with `RECEIVED` meaning
only that data arrived. Failed identity/hash/source/level checks leave both
gates DISPATCHED with no evidence. A valid ERROR is recorded as ERROR; a
valid late receipt is OBSERVED/DEADLINE_EXCEEDED, also without evidence.
UNKNOWN takes precedence over lateness. These are in-memory diagnostic
records, not durable crash-recovery or proof of remote cancellation.

Every accepted review remains MODEL_REVIEW, at most REVIEWED, with
checkResult UNKNOWN and canSupportObligation false. Every diagnostic result
remains PROGRAM_OBSERVATION/PROVISIONAL/UNKNOWN; semanticMapping is UNKNOWN.
Even a synthetic MATCH paired with a wrong parent answer cannot verify it,
satisfy an obligation or replace the protected candidate. This action is
explicit fixture input, not a model-selected or authenticated external plan.

## Verification

Supervisor verification: TypeScript build and all 139 Node tests passed
(129 previous plus 10 new integration/boundary groups); 381 Python tests
passed with the same 24 optional WASI skips. Actual isolated-operator tests
inspect polynomial coefficients [-1, 1] and linear particular solution [2, 1].
Twenty-six additional supervisor controls passed, including every clock
checkpoint, dispatch-window shrinkage, forged/non-JSON returns and
UNKNOWN-over-lateness. All model reports are synthetic literals; no real
mathematical model evaluation was performed.

The assigned dsh DeepSeek executor authored the restored draft and repairs;
the supervisor reproduced failures, reviewed/applied patches and independently
ran verification. The historical withheld draft remains preserved outside
the repository. Its incorrect output-field assertions, clock expectations
and non-JSON handling are not treated as passing historical results.

The [S2 post-repair review libraries](P4_REPAIR_RECHECK.md) are independently
accepted; next is their shared-budget workflow composition.
R0/R1, semantic verification, authorized
candidate replacement, dependency reopening, Host/formal-client integration,
durable responsibility and target/default-switch acceptance remain pending.
