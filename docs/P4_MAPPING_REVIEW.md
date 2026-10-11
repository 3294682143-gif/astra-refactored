# P4 S1 mapping-review library — partial increment

This increment accepts independent TypeScript libraries, not an end-to-end
mapping-review workflow. The previous P4 fixtures, P3 Host, Python entry,
solver, resources and dependencies remain unchanged. No real model client,
RPC, new tool, default switch or mathematical-quality evaluation is added.

## Accepted surface

`P4MappingReviewSession` in M4 reviews one control-supplied `P4CheckPlan`
against a genuine ACTIVE M3 target and the original M1 problem. Its isolated
context retains the complete problem, target/version/hash, scope, goal,
obligations, claim, derivation and check plan. Nested goals are located
recursively. The exact check representation is
`JSON.stringify(plan.request.action)`; it is not a model-selected action in
this slice. Quoted content is untrusted data, not authorization.

The strict `p4-mapping-review-v1` report has exactly five dimension rows:
VARIABLES, DOMAIN, QUANTIFIERS, CONDITIONS and COVERAGE. Every row contains a
MATCH/MISMATCH/UNKNOWN opinion and non-empty rationale. MATCH and MISMATCH
also require exact non-empty Unicode-codepoint quotes from both the original
problem and check representation. UNKNOWN may omit these quotes. Any
MISMATCH forces the aggregate MISMATCH; otherwise MATCH requires all five
MATCH opinions, and every other combination is UNKNOWN.

The parser rejects extra/duplicate fields, malformed JSON, unsafe numbers,
lone surrogates, wrong identities/hashes, duplicate/missing dimensions,
inconsistent conclusions and forged quotes. Input guards rebuild the target,
bind scope/assumptions/tool property/version/obligations and reject an explicit
REAL/RATIONAL mismatch. These are structural guards: quote presence cannot
prove a rationale is correct or that two representations are equivalent.

`planHash` covers the exact `JSON.stringify(plan)` serialization, including
the proposed remaining-time field. It is neither canonical mathematical
identity nor an authorization token. A changed plan needs a new review;
callers must not silently apply a report to another input.

The session permits only one `model-2` review of an original `model-1` target,
with `check-1`/`effect-1`. It records admission, dispatch, complete raw text,
context hash/bytes and settlement. Admission requires 26..5000 ms; settlement
at 25 ms or below is late. UNKNOWN takes precedence over lateness and is not
retried. Invalid/truncated/error/late outcomes produce no usable report.
Staleness changes availability only, never refutation, and cannot conceal a
pending call. The caller still owns the actual original deadline and quota.

Every review record remains MODEL_REVIEW, at most REVIEWED, with
`checkResult=UNKNOWN` and `canSupportObligation=false`. In particular MATCH
does not prove equivalence, satisfy an obligation, resolve a challenge or
authorize replacement of a protected candidate.

`P4DiagnosticEffectGate` in M2 is a separate pure terminal-diagnostic gate
for one pre-bound request to either existing registered operator. It reuses
the P3 request/receipt validators, clips admitted time to the supplied
remaining budget, preserves DISPATCHED on forged receipts and never retries.
UNKNOWN, ERROR and lateness are recorded separately. This gate performs no
I/O and does not interpret a mapping review. A future composition root must
enforce the S1 review policy and existing M5 structural check before calling
it. It does not weaken or replace the existing P3 gate's requirement for a
post-tool model turn and provides no new tool permission.

## Verification and withheld integration

Supervisor verification: TypeScript build passed; 129 Node tests passed
(124 previous plus five library test groups), and 381 Python regressions
passed with the same 24 optional WASI skips. Ten additional supervisor
boundary controls passed, including real original-text/claim disagreement,
Unicode quotes, REAL/RATIONAL disagreement, foreign tool/IDs, forged receipts
and UNKNOWN-over-lateness. Reports are literal synthetic data: these checks
measure mechanism behaviour, not the model's mathematical judgment.

The proposed end-to-end mapping fixture was **not accepted**. Its draft ran
seven of nine new test groups successfully, but two failed because of
incorrect normalized-output assertions and incorrect initial-clock failure
expectations. Independent checking also reproduced an implementation defect:
a non-JSON port result can escape settlement handling instead of preserving
the protected candidate and pending responsibility. The fixture and its four
flow-test groups are retained outside the source repository for repair, not
included in this increment. No pre-existing accepted test was removed.

The assigned dsh DeepSeek executor authored all implementation and tests;
the supervisor reviewed/applied patches, ran checks and separated the accepted
library slice from the failed integration draft. Complete methods/test groups
were retained from length-limited outputs; incomplete units were withheld.

Next work must repair and independently accept the work → mapping review →
diagnostic composition, then address post-repair S2 review. Semantic
equivalence verification, obligation support, protected-candidate replacement,
R0/R1, Host/formal-client integration and full P4 remain unfinished.
