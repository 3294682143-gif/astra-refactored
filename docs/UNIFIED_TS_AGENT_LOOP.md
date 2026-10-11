# Unified TS AgentLoop — integration PR 1

Historical PR1 record. [PR2's explicit TS engine entry](TS_ENGINE_ENTRY.md)
now connects this same loop through the real Python Host and Node main profile.
The remaining v4 gates are tracked in [GATEBOARD.md](GATEBOARD.md).

The integration phase freezes new independent P4 fixtures, R1 expansion and
additional R0 revision/review rounds. Existing safety checks and test suites
remain in place. This PR adds an actual async composition API, not another
prefilled-receipt fixture. A second PR will connect the explicit Python
`ReasoningAgent(client=..., engine="ts")` entry; defaults remain unchanged.

The original complete Python architecture is available for third-party review
on [python-full-rc2-frozen](https://github.com/3294682143-gif/astra-refactored/tree/python-full-rc2-frozen),
commit `049f35f7b6e6d957dd849030aaa4b7a848bbfa3c`. Its 258 original files match
the frozen General Full RC2 source byte-for-byte. This is a source archive,
not a claim of the highest mathematical score; local WASI binaries, activated
installation profiles and evaluation data are not included.

## One composition API and one root

`runAgentLoop(problem, sessionId, options, ports)` is exported from
`apps/stdio-runtime/src/agent-loop.ts`. `ports.model.generate(request)` and
optional `ports.effect.execute(request)` are async injected capabilities.
There is no receipt-array runtime API, no call to `run*Fixture`, and no Python
solver call. Model requests carry the actual root request ID, phase, task/scope
binding, exact context messages and hash/bytes, remaining time and 8192 output
token ceiling. The future Host must enforce the token ceiling and real client
admission; the TS library does not authenticate arbitrary injected ports.

One AgentSession owns the original deadline, global logical call/effect
counters and ordered control trace. One M2 P4RecheckModelGate validates task
bindings and call state across the whole run; it is not restarted per task.
The existing four-call ceiling is reused, not raised.

| Option | Default | Allowed |
| --- | ---: | --- |
| maxModelCalls | 4 | 0..4 |
| maxWorkUnits | 2 | 1..3 |
| maxEffects | 1 | 0..2 |
| maxReviews | 1 | 0..1 |
| remainingMs | required | 1..5000 |
| policy | BEST_EFFORT | BEST_EFFORT or STRICT |

All settings and port method handles are captured before the first injected
clock callback. Later clock faults pin remaining time to zero. Fractional
clock starts use a conservatively rounded deadline; a receipt can tighten but
cannot increase it. S3 uses that same remaining-time view.

ModelCalls counts charged logical attempts. Private records distinguish M2
ADMITTED records, root logical dispatch and port receipts; a clock failure
between reservation and port entry can charge an attempt without entering the
port. Do not equate that count with client calls or HTTP attempts, or claim a
remote request was dispatched merely from the root trace. A port exception,
invalid receipt or timeout stops new dispatch and records UNKNOWN; it is not
confirmed remote cancellation. There is no retry or durable crash-recovery
implementation in this in-memory API.

## Reused mathematical interfaces

M1 compiles the original problem and supplies real ready/running tasks through
ContractLedger. M3 prepares full task contexts and accepts strict WorkPackets
into P2WorkunitStore. Dependency input refs come from actual previous task
deliveries; they are not guessed or dropped. COMPLETE task delivery never
satisfies a mathematical obligation.

WORK accepts the existing WorkPacket format or an existing bounded tool/unsolved
action. The two registered tools are the only tool names accepted. Tool receipts
remain PROVISIONAL/UNKNOWN and are carried into the next request for the same
task even when further tool dispatch is disabled. They are not reused across
tasks. Per-task effect guards receive remaining global quota and global effect
ordinals; they cannot renew the root allowance. Method and action-final messages
are not supported by this integration API; final candidates come from validated
WorkPackets, not synthetic packet construction by the supervisor.

The first eligible dependency-free candidate is retained. Auxiliary work and
later proposals cannot silently replace it. Existing p4Target limitations
on candidate dependencies remain enforced even though other work units may
consume dependencies. M4 performs at most one R2 review on the actual candidate
using the next root ordinal. Optional ordinal parameters preserve the old M4/M5
default model-2 behavior while allowing the real model-3/model-4 identity; IDs
are not rewritten to hide resource use. M2 can explicitly admit R2 against a
real DELIVERED task, without pretending it is RUNNING.

M5 P4CandidateGate makes the final decision under the unchanged policy.
BEST_EFFORT may return the unverified protected candidate, including when a
later review is inconclusive; STRICT withholds it. No review or tool response
upgrades evidence or marks an obligation SATISFIED. Summaries contain fixed
codes/counts and the designated answer; detailed contexts/raw receipts remain
in the private in-memory result.

## Verification and limits

Supervisor verification: Node 24.7 build, 244 Node tests (221 existing and 23
new) and 381 Python tests pass; the same 24 optional WASI tests remain skipped.
Another 446 supervisor controls pass: 180 option combinations, 66 clock faults
at the 22 post-construction samples, and 200 fractional-clock starts.

Reactive async mock ports demonstrate tool → work → second work → R2 → S3
with model-1..model-4, two distinct tasks and one effect under one root. Another
case delivers three work units, with two real input artifact refs in the third
unit, and then R2. Tests also cover global effect limits across tasks, malformed
receipts, port errors, real timer expiry and late promise rejection. These are
engineering tests, not live mathematical evaluation or score improvements.

The assigned dsh DeepSeek executor authored implementation and tests. Review
withheld a truncated loop draft and corrected integration/clock defects before
acceptance. Python public-client/stdio integration and the explicit TS engine
entry belong to PR 2. Official target deployment, full mathematical completeness
and any default-engine switch remain unaccepted.
