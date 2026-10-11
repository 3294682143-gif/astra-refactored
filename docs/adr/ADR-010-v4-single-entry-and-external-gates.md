# ADR-010 — v4 single-entry priority and external gates

Status: accepted execution boundary, not deployment acceptance.

The v4 plan supersedes the earlier library-by-library implementation sequence.
Reuse `runAgentLoop`; do not create a second solver or another production
fixture runner. Preserve P0 probe behavior while making `main.ts` the explicit
agent-loop profile selected by the Python TS Host. Keep lite/legacy defaults
unchanged and forbid hidden solver fallback.

Pi/DSH remain mechanism references. No third-party coding-agent CLI, dynamic
plugin installation, private API key or provider route is embedded in the
competition package. Retain the five mathematical packages and shared protocol
and runtime boundaries.

G0 cannot certify formal deployment: current evidence covers only the local
development machine. Official Node/subprocess allowance, official client
parameters and permitted WASI assets need external evidence. This blocks L1
release claims, not the safe local FakeClient G1 implementation.

Missing v4 companion CSV/script attachments are recorded, not invented.
Replacement audit tooling will enumerate actual Git objects and preserve
unmapped/review-required states. No source-file count is a feature-completion
count. Existing historical external UNKNOWN responsibility is neither deleted
nor interpreted as a new evaluation authorization.
