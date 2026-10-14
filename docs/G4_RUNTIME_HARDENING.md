# G4 / PR5 — Runtime hardening (DSH event source + Pi context/truncation + request responsibility)

Design reference: `Astra_MathAgent_TS_RC2_DSH_Pi_融合执行方案_v4.0_最终.md` §4.5
("PR5：运行底座加固——DSH 事件 + Pi 结束/截断 + 安全能力") and §2.3 (Pi/DSH wiring
points). Baseline `a70f3f2` (G3/PR4 closed); `CURRENT_GATE = G4/PR5`.

This gate hardens the single production loop; it does **not** add a second
solver. All additions are additive and default-path byte-inert.

## ADR — controlled own-loop, Pi/DSH mechanisms ported (not vendored)

Decision: keep Astra's own bounded `runAgentLoop` as the only执行入口 and **port
mechanism/semantics**, never vendor the Pi coding-agent CLI or the DSH/Cordis
runtime. Rationale (v4 §2.3): a full third-party dependency would import its own
model-request path and lifecycle, violating "all model requests go through the
Python Host". Concretely:

- **Pi** contributes: the `AgentMessage -> ModelMessage` boundary
  (`ContextProjector.prepareRequest`), the bounded turn/step model, the
  `finishTurn` termination admission, and the explicit `length` output barrier.
- **DSH** contributes: the immutable event source (`SessionLog`), the monotonic
  tool-guard pipeline `pre -> guards -> dispatch -> execute -> post`, and the
  request-responsibility journal/lifecycle.
- No third-party internal API is reused; nothing here is a compatibility claim.

## Slice 4a — immutable `SessionLog` + `ContextProjector` + read-only replay

`@astra/runtime-core/src/session-log.ts`:

- `SessionLog`: ordered, immutable, monotonic-`seq`, `session-log-v1` events
  (deep-frozen payloads; unknown kind / oversized / lone-surrogate refused).
  Kinds: `SESSION_INIT`, `CONTRACT`, `CONTRACT_REVISED`, `MODEL_REQUEST`,
  `TASK_STARTED`, `WORKUNIT`, `TOOL_OBSERVATION`, `METHOD_LOAD`,
  `REVIEW_CHALLENGE`, `REPAIR`, `TRUNCATION`, `FINAL`.
- `ContextProjector.prepareRequest(event)`: the model-visible context is a pure
  projection of one recorded `MODEL_REQUEST` event; the `contextHash` is
  **recomputed** from the recorded messages, so a log/request drift is
  impossible. Any cache is only a view derived from an event version.
- `ReplayRunner.replay(snapshot)`: in-process, read-only; re-projects every
  request and re-reads the `FINAL` view with **no model/effect port and no
  clock**; `publicTrace()` exposes request identities only (never the private
  raw text).

The loop (apps/stdio-runtime/src/agent-loop.ts + agent-loop-calls.ts) records the
log as the single source and exposes `privateState.sessionLog` (Node-private, not
on the wire). Tests: `apps/stdio-runtime/tests/agent-session-log.test.ts`.

## Slice 4b — Pi truncated-tool-barrier + DSH monotonic tool guards

- **Barrier (E08/E09)**: a reply that is not `COMPLETE` never yields a
  tool/method action, an artifact or a candidate. Explicit `finish_reason=length`
  (`transport=TRUNCATED`) is recorded as `TRUNCATED`; a missing finish reason is
  `COMPLETENESS_UNKNOWN` and conservatively bans actions (`SessionLog` TRUNCATION
  event). Tests: `tests/e2e/test_ts_g4_truncation.py`.
- **Monotonic tool guards**: `@astra/math-gateway/src/p3-admission.ts`
  `monotonicToolGuard` runs the `pre -> guards` stages and returns an
  **irreversible** decision (fixed codes; there is no un-reject and it never
  executes anything). The loop routes action admission through it; the Python
  Host still performs its own whitelist/quota re-check, and a
  `PROGRAM_OBSERVATION` receipt's math-evidence grade stays M5-owned (strictly
  separate from admission). Tests: `apps/stdio-runtime/tests/agent-guard.test.ts`.

## Slice 4c — request-responsibility journal + big-integer IPC fidelity

- **Journal**: `python/astra_bridge/agent_client.py` records one fixed lifecycle
  row per request — `INTENT_RECORDED -> ADMITTED -> DISPATCHED ->
  LOCALLY_RETURNED`, or `OUTCOME_UNKNOWN` (timeout / broken pipe / crash), after
  which the adapter **blocks itself** so a later problem can never wash the spent
  responsibility away; the root budget is never refreshed and no request is
  blindly re-dispatched (E10/E11). `session.close` releases the child.
- **E17**: numbers beyond `Number.MAX_SAFE_INTEGER` travel as canonical strings
  (or an explicit tagged field); the strict scanner refuses a raw unsafe integer
  token (`UNSAFE_INTEGER`) instead of silently rounding it, and the canonical
  encoding hashes deterministically. Tests:
  `apps/stdio-runtime/tests/agent-ipc-exact.test.ts` plus the existing
  `tests/bridge/test_p0_probe.py` unsafe-token controls.

## Acceptance

`tsc -b` 0; `node --test` (>=309, 0 fail); `pytest -q tests/e2e` (>=203);
`pytest -q` (>=589, 0 fail). Default `maxR0=maxRepairs=0` keeps the pre-G4
behaviour byte-identical. L1/L2 and formal Node/official-client/WASI evaluation
remain out of scope (`BLOCKED_EXTERNAL`).

`G4 / PR5` is CLOSED; `CURRENT_GATE -> G5 / PR6`.
