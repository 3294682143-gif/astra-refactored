# G2A: existing methods through the unified TS entry

This is a bounded G2 supporting slice, not completion of G2/PR3, L1 or L2.
DSH `mass/deepseek-v4.1-flash` authored the code/tests; the supervisor reviewed,
applied patches and ran verification. No separate Fixture, production loop,
mathematical mechanism, dependency or model provider was introduced.

## Contract

- Public entry remains `ReasoningAgent(client=..., engine="ts").solve(...)`.
  Python retains only the authorized Host/client/reader/operator responsibilities.
  Old solver construction/execution is disabled by the entry tests.
- `max_method_loads=0` is the default; explicit 1 enables the existing read-only
  General v1.1 catalog. One Session still owns at most four model calls, two
  effects and five seconds. These are preview limits, not official contest rules.
- Metadata is read once before models when a follow-up WORK and configured R2
  fit. A method load uses the same root effect slots as a tool. No retry refunds
  an attempt, no second method ID is admitted, and no effect starts from model-4.
- Successful body/title/version/hash validation provides integrity only, not
  mathematical acceptance. Context v2 preserves the exact asset across work
  units as advisory text; receipts stay task-scoped. R2 sees neither resource
  bodies nor method self-assessment. STRICT still withholds unverified answers.
- Active protocol/profile: 1.3-agent-loop-preview / math-agent-preview-v2.
  Frozen 1.2 schema SHA256 is
  `18a7ef79448396afaac75bbaf65c9ab5d27658cf596d19624b0ac3616ff705ad`.
  Both languages validate old frames read-only and reject live legacy startup.
  The new schema generator reads old schemas and emits JSON, without editing them.

## Evidence and limitations

The real entry positive case performs method → WORK → second WORK → R2, with
four public-client calls, one catalog read, one body load, one shared effect,
two work units and one R2. The loaded body equals the real reader's output.
An explicit max_reviews=0 case runs method → registered tool → WORK using two
shared effects. Same-ID cache reuse retains the original source binding; a
second solve loads anew. No live math API calls or formal math scores occurred.

Negative controls isolate title, identity, body and hash corruption, forged
model-context data despite recomputed envelope hashes, falsified counters,
incomplete finish signals, exhausted capacity, catalog unavailability and
root-clock exhaustion. One proposed context negative initially only timed out
because its test wrapper omitted the real validator call; it was corrected to
invoke that validator, and the timeout-only result was not accepted as evidence.
All original assertions and optional WASI skips remain in place.

G1 had 244 Node / 406 Python tests. Supervisor worktree verification on
2026-10-12: TypeScript build passed; 257 Node tests passed; 430 Python tests
passed with the same 24 optional WASI skips; all 44 public-entry E2E tests
passed. Exact-commit reproduction is recorded separately before this slice
is promoted. G2 still requires dynamic
mechanism routes, real dependency/version transitions and bounded final/progress
handling. G3's grounded repair is not implemented by this method bridge.

Official Node/subprocess permission, official client acceptance, real API/data/
cost authorization, release packaging and default-engine switching remain
separate gates. No public PR3 completion or merge is claimed here.
