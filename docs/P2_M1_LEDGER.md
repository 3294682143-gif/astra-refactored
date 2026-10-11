# P2-A / M1 offline compiler and ledger slice

This is an accepted **M1 repair slice**, not completion of P2-A or P2. The P1
mock-client stdio entry, the official Python entry and the default solver remain
unchanged. No real mathematical API, tools or WASI are enabled. Official runtime
and deployment capabilities remain TARGET_UNVERIFIED.

## Implemented

`@astra/math-contract` publicly exports `compileP2Contract`, `ContractLedger`
and `validateGraph`. Shared P2 types, WorkPacket schema/parser and scope/snapshot
helpers live in `@astra/protocol`. Mathematical packages do not import one
another's private implementation.

The compiler preserves the exact original text and its hash. It provides finite
working templates for value, all-solutions, counting, optimization, proof,
explicit multipart and unknown goals. Keyword classification is conservative:
ambiguous input falls back to UNKNOWN, and `semanticStatus` is always UNKNOWN.
This is not a general semantic parser or proof that the template matches a
problem. Explicit scopes retain domain, bindings, quantifiers, assumptions,
branch conditions and referenceable premises. Canonical identity is data
identity, never a test of mathematical equivalence.

For the public zero-factor example, all-solutions work includes candidate,
boundary/exception and exhaustiveness obligations. A zero-factor check is stored
as a **risk hint**, not silently added as an assumed branch condition. Explicit
multipart children have their own tasks and parent coverage dependencies.

The ledger separates task input references from its delivered output references.
Ready tasks obtain inputs from recorded upstream deliveries. A partial task must
start again before its next delivery. A completed candidate task is not offered
again; boundary work is prioritized. Graph changes reject duplicate IDs, dangling
references, cycles and inconsistent bindings.

Delivery never automatically satisfies a mathematical obligation. Only the
trusted control-side `acceptObligation` operation can do so, with a MOCK_ONLY M5
receipt bound to the session, problem, contract version, goal and scope, a policy
and nonempty references to actual latest recorded deliveries. An empty list,
unknown reference or extra receipt field is rejected without a state change.
These mock labels are not cryptographic authentication or a production M5
checker. Never forward untrusted model text directly to this control API.
SATISFIED here means satisfaction under the supplied **simulated policy**, not
mathematical correctness or formal proof. WorkPacket data cannot contain an
acceptance command.

Events have strictly increasing safe-integer sequences and a 128-event bound.
Batch additions allocate distinct sequences; empty additions consume none.
Failed validation, capacity admission or sequence checks leave the tested
projection and event history unchanged. Snapshots and stored reference copies
are isolated from external mutation. The constructor accepts fresh OPEN/READY
contracts, not injected already-satisfied state.

## Deliberate limits

- Ordinary compiler-template goal revisions create a new version and reopen
  affected obligations/tasks while preserving unrelated state and reference
  provenance. Existing external snapshots remain unchanged.
- Revision with custom-added tasks is **explicitly refused** with
  ILLEGAL_TRANSITION, rather than silently dropping or rebinding those tasks.
- Preserved acceptance receipts retain their original version as provenance;
  this does not authorize cross-version artifact reuse. A later M3/M5 binding
  policy is required.
- The event log is an ordered structural summary, not enough to restore all
  private historical state. There is no persisted recovery or automatic resume.
- At this M1 acceptance milestone, P2 WorkPacket/Artifact/Route types were only
  forward contracts. The subsequent [M3 library slice](P2_M3_WORKUNITS.md)
  implements versioned storage, dependency invalidation and route identities;
  it does not integrate them into the executable yet.
- P2 fixture composition, method-card runtime bridge and a2 behaviour alignment
  remain unfinished. Complete R0/R1/R2 and S1/S2/S3 also remain deferred.

## Actual acceptance evidence

Direct TypeScript compilation passed. The complete Node suites passed **43
tests** (the existing 32 plus 11 new M1/protocol tests). The complete Python suite
passed **189 tests**, with the same **24 WASI skips** as P1. The original solver
and Python project/dependency files are unchanged.

The new tests cover empty/unknown evidence, proper mock acceptance, partial
restart, input/output separation, external-ref mutation, priority, graph errors,
fresh-constructor validation, ordinary and refused-custom revisions, exact event
capacity, safe-integer edges, immutable snapshots, prototype-key handling,
canonical scope identity, strict WorkPacket parsing and long valid artifact IDs.
No new dependency or online install was required.

From an already provisioned checkout, run:

```sh
node node_modules/typescript/bin/tsc -b
node --test packages/protocol/dist/tests/*.test.js apps/stdio-runtime/dist/tests/*.test.js
python -m pytest -q
```

If workspace links need provisioning, use only an authorized existing cache and
stop on offline-install failure. See the P1/P0 runbooks for the pnpm auto-install
caveat. This source branch is not a packaged competition submission.
