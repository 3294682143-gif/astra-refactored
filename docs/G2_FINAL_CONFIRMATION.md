# G2B1: bounded final confirmation through the real entry

This checkpoint implements the existing strict P3 `final` action as confirmation
of an already protected candidate. It does not implement new-answer generation,
candidate replacement, mathematical verification, dynamic routes, revision or
the whole G2 gate. DSH authored implementation/tests; the supervisor reviewed,
applied and independently tested them.

## Behaviour

WORK context v3 exposes only a minimal protected binding, target hash and
answer, plus an explicit allowance. The projection is rebuilt using the
existing P4 target guard; Host independently derives it from earlier real
client receipts. Artifact sequence counts completed WorkPackets, not tool or
model-call ordinals. The projection is not exposed across scopes.

A COMPLETE final must match that exact earlier answer, have complete=true and
unresolved=[]. It ends further WORK without fabricating a task delivery or a
second artifact. The current task honestly remains undelivered in private
state. The old candidate source and raw-response hash remain unchanged.
Configured R2 and M5 selection then follow the existing bounded path. Invalid
final confirmations stop subsequent calls, including review, but do not erase
an earlier valid BEST_EFFORT candidate. Non-COMPLETE transports keep the original
stop/unknown-responsibility rules. STRICT never labels a candidate verified.

Python remains provenance/admission/IO Host, not the mathematical selector.
The default engine, 4-model/2-effect/5-second ceilings, existing method quota,
single root Session, M1–M5 interfaces and old schemas are unchanged. No extra
model provider, dependency, Fixture, executable capability or live math API was
introduced. Context v2 is accepted only by its explicit read-only WORK validator;
this does not claim full lifecycle/event replay.

## Actual verification scope

- Real entry tool → WorkPacket → final → R2: four client calls, one real
  COMPLETE registered effect, one artifact/work unit and one review; R2 targets
  model-2's original candidate, not model-3's final text.
- No-review and STRICT paths; first-turn/changed-answer/incomplete/unresolved
  final refusals; length and unknown-finish barriers; blocked second solve after
  UNKNOWN; old candidate retention without verification.
- Answer/source/hash/scope projection mutations with correctly recomputed
  envelope hashes are rejected before another client call. Tests invoke the
  actual validator, not a timeout stub.
- Direct TS tests separately assert no fabricated artifact and retention of
  the actual final raw receipt.

The final-specific suite has 15 Python E2E cases and five direct Node tests;
all 59 combined entry cases pass. Full worktree regression: TypeScript build,
262 Node tests and 445 Python tests passed with the same 24 optional WASI skips.
Exact-checkpoint reproduction is recorded separately by the supervisor. Both legacy frame hashes are
unchanged: 1.2 `18a7ef79448396afaac75bbaf65c9ab5d27658cf596d19624b0ac3616ff705ad`,
1.3 `239195bc2abe082af0e095b37dd867bfb902e70cba2dc4428905e1f182b9323a`.

## Still pending

True dynamic mechanism routes, task scheduling/progress and version invalidation
remain G2 work. Grounded candidate correction is G3. Official target permission,
official-client/real-model evaluation, publication approval gates and L1/L2
completion are unaffected. No PR3-complete or formal-release claim is made.
