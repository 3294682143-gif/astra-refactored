# ADR-005 — P1 offline prototype before target deployment acceptance

Status: development-only exception approved in follow-up; implementation and
tests must be accepted separately. Official runtime gate remains TARGET_UNVERIFIED.

After P0 local acceptance, the supervisor explicitly proposed advancing a P1
prototype with only a simulated client, unchanged default entry, no mathematical
API calls and no official submission. The user requested continuation on that
basis. This permits offline development to proceed without claiming that the
official Node/subprocess gate has passed. It does not authorize P2 or a default
engine switch.

P1 introduces five independent mathematical workspace packages and runtime-core.
Only the minimum single-work-unit path is in scope. M1 preserves the full problem
and an open answer obligation; M2 checks a one-call budget; M3 records a model
receipt as provisional material; M4 explicitly skips semantic review; M5 selects
an unverified best-effort candidate or a nonempty unsolved response. Mathematical
coverage, proof validity, R0/R1/R2 and complete S1/S2/S3 remain later-stage work.

The Node composition root owns control flow. Python only hosts the process,
validates requests, enforces the root budget, serves a pure in-memory fixture
through a mock public-client-shaped interface, and returns the TS decision.
Neither side imports or calls the old solver as a fallback. No real client or
provider configuration is accepted by this prototype's public entry.

Event sequence, private context projection, bounded capability admission and
cleanup borrow mechanisms from the dsh architecture. This is not a claim of
framework-level dsh compatibility, persistent recovery, or mathematical accuracy.
Public traces contain fixed event/reason codes, never private problem/model text.

Keep P0 protocol version and probe available. P1 uses a separate
`1.0-p1-local` manifest and script, sharing strict frame/schema primitives but not
relaxing the P0 allowlist. All P1 results remain MOCK_ONLY, candidateVerified=false,
strictAcceptance=NOT_PERFORMED. UNKNOWN receipts are simulated fixtures, not
evidence that an external model request was made or cancelled.

Publication, if accepted, is source development on `ts-five-module-rewrite`, not
a deployable competition release. Official environment evidence, an independently
accepted actual-client adapter, packaging and quality gates remain mandatory.
