# Astra General Full RC2 — full architecture with measured performance repairs

This is a new, isolated release candidate based on the frozen general 0.9.8 core.
It is not the earlier code-only ZIP, a targeted answer package, or a claimed score improvement.

RC2 changes versus RC1: the same target/purpose yields after two consecutive UNASSESSED
continuations, without labeling the mathematics false. Independently checked progress resets
this resource counter. Other targets, computation/repair/consumption and closeout remain available.
The local evaluation also allocates each question from the real six-hour remaining wall budget,
with at most 40 logical calls including final checks. This is an explicit scheduling-condition
change: RC1's interrupted outputs are not pooled with RC2.

The external client now requests and reads the SSE usage-only tail. Reported provider usage is
validated; absent usage is never filled with zero. Only a complete, non-thinking stop can replace
the unused maximum-output reservation with a conservative observed-text bound. Unknown/length
responses keep the full reservation and original responsibility.

The public interface remains `user_agent.ReasoningAgent(client).solve(problem, metadata)`.

## Enabled native chain

- Original problem contract, planning/review, task graph, registered operators and final selection.
- General v1.1 runtime method registry/selector and on-demand complete method bodies, with original
  registered-tool contracts retained. Profiles are unverified model suggestions/vocabulary evidence,
  not fixed ODE profiles. No reference solutions, question identifiers, exact-match cards or answer table.
- Model-generated Python runs only in the provisioned WASI guest (CPython, SymPy 1.12, mpmath 1.3).
  No host-Python fallback, network, installation, NumPy or SciPy in the guest. Limits remain 30 seconds,
  512 MiB guest / 1 GiB host, 64 KiB output.
- Actual tool failure receipts are classified as resource, program or output failures. The existing
  Controller retry path carries the same mathematical task, actual program and traceback into the
  next model request. A repair must execute and pass the existing result-consumption path.
- Native content-bound ReviewTask reuse is retained and logged. Failed/unknown replies are not
  converted into synthetic successful model responses; no process-global review-answer cache.
- Candidate closeout lists unresolved challenges and incomplete dependencies in the selected candidate
  lineage. Challenge replacements are artifact IDs; task-state joins use artifact.work_unit.
- The optional explicit client port `public_budget_snapshot()` supplies remaining logical/HTTP budget.
  Public dispatch metadata is transferred into the actual worker thread. In the bundled local test
  runner, the authoritative transport transaction preserves outstanding final/compute reservations.
  On an official client lacking that port, global availability stays unknown and only local guards apply.

## Provisioning

The portable ZIP ships code and raw WASI assets, not a portable acceptance claim. Use the existing
`scripts.prepare_target_runtime`, `scripts.run_wasi_acceptance`, `scripts.accept_wasi_profile`, then
`scripts.activate_wasi_profile` at the final install path. The 100-item run uses the activated installation
whose code matches the submitted archive. Relocation requires fresh local acceptance.

## Evidence boundaries

24 actual local WASI tests, native failure→repair→second execution→ADOPTED coverage, focused integration
tests and core regressions are recorded separately. Scripted model replies in those tests are not real
S2 responses. The 100-question evaluation must report actual requests, unresolved responsibilities,
execution/consumption events, completion count and independent local scoring. It is not an official
hidden-platform score or a held-out generalization result.
