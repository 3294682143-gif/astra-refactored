# P2-A / M3 offline work-unit library

This is a bounded library increment, not completion of M3 or P2. The assigned
dsh DeepSeek executor authors the implementation; the supervisor reviews,
applies and independently tests it. No mathematical API or tool is called.
The P1 executable, official Python entry and frozen solver remain unchanged.
Official Node/subprocess/client deployment remains TARGET_UNVERIFIED.

## Public surface and ownership

`@astra/math-workunit` exports `P2WorkunitStore`, `P2RouteRegistry`,
`p2RouteSignature`, `P2RouteInput`, `P2WorkReceipt` and `P2ArtifactEntry`.
Its implementation imports only the shared protocol and Node standard library,
not another mathematical module. Composition tests use real M1/M3 public APIs.
All P1 exports remain compatible.

The later [offline composition slice](P2_OFFLINE_COMPOSITION.md) also exports
`prepareP2Context` / `P2PreparedContext` from M3 and connects these APIs to M1 and
the bounded method session. The acceptance figures below describe the earlier
M3 storage milestone, not that later increment.

Construct a store from a trusted M1 contract snapshot after adding its tasks.
The snapshot and contract version are fixed for that store. Pass a trusted
RUNNING task from M1, register a route, then accept its bounded raw receipt.
These are control-side APIs, not authorization endpoints for model JSON. The
caller must enforce request admission, current task lifecycle, deadline and
root event sequencing. An artifact's cause points to the task-envelope event;
it does not invent a new task-start event.

Model text is restricted to the existing strict WorkPacket schema. Parsed
packets must match session, exact problem hash, contract version, task, goal,
scope, route and request. Additional local assumptions are conservatively
refused. Input IDs are not silently trimmed or rewritten.

## Implemented safeguards

- Route signatures hash normalized representation, operation, sorted unique
  lemmas and construction. IDs do not change the mechanism signature; titles
  are rejected as extra fields. This is declared-data identity, not a proof of
  mathematical equivalence. At most two routes can be registered.
- At most 32 artifact versions are retained, including stale versions. Old
  artifacts are immutable; availability is a separate immutable entry snapshot.
  Replacing an artifact requires its exact latest reference and the same task,
  scope and route. Availability must be queried again after invalidation;
  previously returned snapshots are not live views.
- All admitted task input references are recorded as dependencies, even when a
  packet reports fewer. References must exist, be latest/ACTIVE/COMPLETE and
  match contract, scope and route. Downstream work inherits provisional inputs.
  Cross-route sharing is refused pending an M5 gate. Replacement cannot depend
  on its own older version or any downstream of that version.
- Replacing or explicitly invalidating a version marks it and its transitive
  dependency closure STALE. Unrelated artifacts stay ACTIVE; no result becomes
  REFUTED merely because of invalidation. This is a structural dependency
  closure, not a claim of mathematically minimal repair.
- Raw response text (up to 65536 UTF-8 bytes), exact SHA256, request identity,
  scope, version, original parsed packet and transport status are retained.
  Malformed non-complete receipts retain raw material with `packet=null`.
  Malformed COMPLETE receipts are rejected. Well-formed packets with wrong
  identities are rejected even when their transport says TRUNCATED.
- Transport TRUNCATED/ERROR/UNKNOWN overrides a packet claiming COMPLETE.
  `candidate(ref)` returns a nonblank proposal only for an ACTIVE artifact with
  effective COMPLETE delivery. Partial material is not reusable as a complete
  dependency. All accepted records remain PROVISIONAL with checkResult UNKNOWN;
  a candidate is not a proof and delivery does not satisfy M1 obligations.
- Duplicate accepted request IDs, invalid bindings, bad references and bounds
  are rejected without consuming a new version, request ID or sequence.

## Deliberate limits

The later offline composition adds a bounded fixture workflow and method port,
not a production P2 scheduler/stdio integration. a2 behaviour alignment,
contract-version migration, production M5 gates and full R0/R1/R2/S1/S2/S3 are
still deferred. Raw partial material can be inspected but automatic partial
resumption is deferred. Route caps are not a root call-budget policy; there is
no route-priority manager or dynamic route replacement. A store is in-memory,
not an event journal, persisted recovery mechanism or authenticated service.
It does not automatically synchronize invalidation back into M1 obligations.
Artifacts contain private problem/model material and must not be copied into
public traces. No generated assets, executor logs or credentials belong in Git.

## Verification

Use the direct build and offline test commands in [the P1 runbook](P1_OFFLINE.md).
No dependency additions are needed. Any workspace-link refresh must use the
explicit existing cache with offline/frozen-lock/ignore-scripts options, and
stop on failure.

Supervisor acceptance on 2026-10-11: direct TypeScript build passed; the complete
Node suite passed 50 tests (43 previous plus 7 M3 tests). Python passed 189 tests
with the same 24 WASI skips. Additional supervisor probes passed 12 atomic
negative controls, including real distinct scopes, wrong task/session/version,
whitespace identity mismatch, repeated/missing input refs, lone surrogates and
UTF-8 byte limits. They also checked route normalization, input mutation
isolation and causal-event binding. These are synthetic offline checks, not
mathematical accuracy or production-client acceptance.

Review rejected a truncated test patch and repaired test wiring before
acceptance. All implementation/test patches in this slice came from the
assigned executor; only patch-path/import formatting was mechanically
normalized by the supervisor. No failed assertion was removed to gain a pass.
