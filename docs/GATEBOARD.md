# v4 implementation gateboard

Current gate: **G3 / PR4 — M4/M5 risk-evidence-repair-final closure: slice 1/2 done, slice 3 IN PROGRESS (3a.1 S1 gate, 3c.1 multi-counterexample + E07/E15 delivered; NOT yet CLOSED)**; G2 closed at v4 head `899c7fc`.
Once G3/PR4 closes, **CURRENT_GATE points to G4 / PR5 (event-source `SessionLog`/`ContextProjector` replay, Pi finish/truncation, controlled tool pipeline)**.
G0 source inventory and deployment facts are supporting work, not a competing
math-feature stream. DSH authors implementation/tests; the supervisor reviews,
applies and independently verifies them. No parallel coding agents are used.

| Field | Current evidence |
| --- | --- |
| Baseline | G1 PR2 head `6e45893`, tree `a457740`; PR2 is open, not merged; main/default frozen; see SOURCE_LOCK.md |
| ROOT_E2E | LOCAL_PASS: `python -m pytest -q tests/e2e` — **193** real public-entry tests on v4 head (G3 PR4 slice 3), including the G2 complete-whole-problem-answer capability, p2a-work-v5 redo, trusted parameter boundaryCases (E04), E01 `{1}->{0,1}`, text parity, the G3/PR4 negative controls, the public-entry flagship (checker-grounded R2 challenge → one REPAIR call → `{1}->{0,1}`), its `maxRepairs=0` negative, the S1/E07 negative (foreign-task checker refused), and the E15 honest best-effort negative, and the E14 byte-verbatim release negative; old Controller/Lite init/solve disabled |
| RC2_MIGRATION | 260 actual source paths, 260 classified with candidate owners, 0 unmatched, 260 REVIEW_REQUIRED, 0 CLOSED; 16 a2 changes separately inventoried |
| G0 source locks | commit/tree identities captured for RC2, a2, TS, DSH and Pi; audit script + five real-Git tests passed |
| G0 deployment | BLOCKED_EXTERNAL: no official Node/subprocess permission or target sandbox supplied |
| BUDGET | Preview 4 model calls / 2 effects / 5000 ms maximum; not official contest limits; no math API calls authorized in current implementation work |
| MATH | E08/E09/E10/E11/E12/E18 infrastructure paths locally tested; E01 grounded repair and other full math properties pending; real model comparison NOT_RUN |
| QUALITY | v4 head (G3 PR4 slice 3c.3) exact clean: **300 Node / 579 Python passed (24 WASI skips)**; slice 3b: 299 / 578; slice 3a.2: 297 / 578; slice 3c.2: 297 / 578; slice 3c.1: 297 / 577; slice 3a.1: 295 / 576; slice 2: 294 / 576; head `899c7fc`: 287 / 572; G1 PR2: 244 / 406; redo `5b3ff34`: 269 / 484; progress/parity worktree: 272 / 507, same 24 WASI skips |
| G2A METHODS | Real method → WORK → second WORK → R2; one catalog read/one method load in shared effect quota; opt-in only; see G2_METHOD_BRIDGE.md |
| G2B1 FINAL | Real tool → WORK → final → R2 in four calls; confirms only the protected old candidate; no fabricated artifact; see G2_FINAL_CONFIRMATION.md |
| G2B2 ROUTES | Model v2 proposal → M1 TASK_ADDED → real second-route WORK; full raw provenance, empty cross-route inputs, current-obligation scope; see G2_DYNAMIC_ROUTES.md |
| G2C DEPENDENCIES | v3 proposals → two real task additions → three WORKs consuming preceding artifacts → R2 in four calls; same-route inheritance and shared child-tool budget; see G2_DEPENDENT_CHAIN.md |
| G2D REDO | A real repeated WORK produces version+1; old bytes retained, exact downstream closure STALE, unrelated route stays ACTIVE; no automatic protected-candidate replacement; see G2_ARTIFACT_REDO.md |
| G2 E16 | Real task-only yield on unsolved/partial/two cached repeats; other ready tasks still execute under the same root; Unicode predicate parity independently audited; see G2_PROGRESS_POLICY.md |
| G3 PR4 (slice 1a) | M5 S3 evidence-gated candidate revision as a pure capability: `reviseCandidate` replaces a protected candidate only under a `CHALLENGED`/`ACTIVE` answer-obligation challenge plus a grounded `CHECKED_SCOPE`/`PASS` basis; every refusal is fail-closed `REVISE_REJECTED`; `p4-revise.test.ts` flagship + refusal matrix; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 1b) | Online closure wired into `runAgentLoop` (opt-in `maxRepairs`): one `REPAIR` model call after an R2 answer-obligation challenge, grounded by a Host-accepted `PROGRAM_OBSERVATION` checker, then `reviseCandidate`; `agent-loop-g3.test.ts`; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 2) | Public-entry flagship: the Python Host accepts the additive `REPAIR` phase (options/`_STOP_REASONS`/`_SUMMARY_FIELDS`/`repairCalls`, `validate_context`+`_check_repair`, schema, `project_artifacts`/`candidate_packet` REPAIR branches); `tests/e2e/test_ts_g3_flagship.py` proves `x(x-1)=0` `{1}->{0,1}` (`REVISED_CANDIDATE`) and its `maxRepairs=0` negative. Negative control B remains separate (R2 parse `UNKNOWN`; no-counterexample `STALE`) |
| G3 PR4 (slice 3a.1) | M5 S1 original-problem mapping gate before any checker becomes a `P4ReviseBasis`: `P4DiagnosticLedger.precheck` against the trusted target (scope/assumptions/tool-property/obligations); a foreign-task / unknown-tool / foreign-obligation checker (E07) is refused and can never ground a revision; `privateState.s1Assessment`; `agent-loop-g3.test.ts` E07 negative; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.1) | Multi-counterexample fail-closed (`P4ReviseBasis.requiredGaps`/`coveredGaps`: child must cover every proven gap, partial repair refused) + E07 promoted to the public entry (foreign-task checker refused, no REPAIR, candidate stays); see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.3) | §6.1 matrix rows `E13` (a fixed deterministic `UNKNOWN` template fallback) and `E14` (S3 releases the delivered answer byte-verbatim, no format distortion); `p2-template-fallback.test.ts` + `test_ts_g3_negatives.py` |
| G3 PR4 (slice 3b) | Trusted `boundaryCases` versioned schema: explicit `P2_SCOPE_COVERAGE_SCHEMA_VERSION`; PARAMETER boundary claims must equal the trusted parameter branches, MULTIPART exhaustion the trusted child set, other goals keep declared data, v1..v4 replay unchanged (E04); `p2-scope-coverage.test.ts` |
| G3 PR4 (slice 3a.2) | S2 local repair transaction: an accepted revision supersedes ONLY the challenged answer obligation; every other obligation and the parent artifact (e.g. the valid local `x=1` derivation) are preserved; `privateState.s2Transaction`; see P4_EVIDENCE_REVISION.md |
| G3 PR4 (slice 3c.2) | §6.1 E2E matrix row `E15`: with no review budget a real candidate is released only as an unverified `BEST_EFFORT` candidate (`candidateVerified=false`, strict acceptance not performed); `test_ts_g3_negatives.py` |
| G3/PR4 matrix status | COVERED: `E01/E04/E07/E13` (fixed-template fallback) `/E14` (byte-verbatim release) `/E15` + flagship + negative control B (R2 parse `UNKNOWN`; no-counterexample `STALE`). OPEN: `E05` (proof provisional/contrapositive assumptions not discharged), `E06` (only a bound with no attainment witness), and the `E13` bounded R0 revision (revision half, needs R0 wired via the production chain). `G3 / PR4` is NOT yet CLOSED |
| NEXT | Close G3 / PR4 (slice 3 remainder): 3a S2 M1 local obligation reopen + bounded R0 revision / R1 rule trigger (E13); 3c multi-counterexample public-entry flagship `(x-0)(x-1)(x-2)=0`; matrix E05/E06/E14; `MIGRATION_MATRIX.csv` evidence rows; then `CURRENT_GATE -> G4 / PR5` |

Later gates remain pending: G2 dynamic routes/tasks/methods; G3 grounded
candidate repair; G4 event-source replay/lifecycle; G5 separately authorized
official API and environment evaluation; G6 approved L1 release; G7 L2 carriers,
recovery and permitted assets; G8 independent full-inventory closure.

L1: NOT_COMPLETE. L2: NOT_COMPLETE. Do not create MIGRATION_COMPLETION.md as a
signed completion record while ownership/evidence gaps remain. Real API costs,
expanded permissions and default-engine switching retain their separate gates.
