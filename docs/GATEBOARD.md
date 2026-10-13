# v4 implementation gateboard

Current gate: **G2 / PR3 — bounded dynamic work, redo and E16 yielding; full scope semantics pending**.
G0 source inventory and deployment facts are supporting work, not a competing
math-feature stream. DSH authors implementation/tests; the supervisor reviews,
applies and independently verifies them. No parallel coding agents are used.

| Field | Current evidence |
| --- | --- |
| Baseline | G1 PR2 head `6e45893`, tree `a457740`; PR2 is open, not merged; main/default frozen; see SOURCE_LOCK.md |
| ROOT_E2E | LOCAL_PASS: `python -m pytest -q tests/e2e` — **178** real public-entry tests on v4 head `4f077a1`, including the complete-whole-problem-answer capability (two-part MULTIPART returns the full two-part answer; PARAMETER returns the full classification; budget derived from the task graph; root-aggregation candidate only; missing-branch and preview-budget negatives), E01 `{1}->{0,1}`, out-of-scope v5 fail-closed, downstream read of declared coverage, real task-local yielding, real effect caching and Node/Python text parity; old Controller/Lite init/solve disabled |
| RC2_MIGRATION | 260 actual source paths, 260 classified with candidate owners, 0 unmatched, 260 REVIEW_REQUIRED, 0 CLOSED; 16 a2 changes separately inventoried |
| G0 source locks | commit/tree identities captured for RC2, a2, TS, DSH and Pi; audit script + five real-Git tests passed |
| G0 deployment | BLOCKED_EXTERNAL: no official Node/subprocess permission or target sandbox supplied |
| BUDGET | Preview 4 model calls / 2 effects / 5000 ms maximum; not official contest limits; no math API calls authorized in current implementation work |
| MATH | E08/E09/E10/E11/E12/E18 infrastructure paths locally tested; E01 grounded repair and other full math properties pending; real model comparison NOT_RUN |
| QUALITY | v4 head `4f077a1` exact clean: **287 Node / 564 Python passed (24 WASI skips)**; G1 PR2 exact clean: 244 Node / 406 Python; redo exact clean `5b3ff34`: 269 / 484; progress/parity worktree: 272 / 507, same 24 WASI skips; exact-commit reproduction recorded separately |
| G2A METHODS | Real method → WORK → second WORK → R2; one catalog read/one method load in shared effect quota; opt-in only; see G2_METHOD_BRIDGE.md |
| G2B1 FINAL | Real tool → WORK → final → R2 in four calls; confirms only the protected old candidate; no fabricated artifact; see G2_FINAL_CONFIRMATION.md |
| G2B2 ROUTES | Model v2 proposal → M1 TASK_ADDED → real second-route WORK; full raw provenance, empty cross-route inputs, current-obligation scope; see G2_DYNAMIC_ROUTES.md |
| G2C DEPENDENCIES | v3 proposals → two real task additions → three WORKs consuming preceding artifacts → R2 in four calls; same-route inheritance and shared child-tool budget; see G2_DEPENDENT_CHAIN.md |
| G2D REDO | A real repeated WORK produces version+1; old bytes retained, exact downstream closure STALE, unrelated route stays ACTIVE; no automatic protected-candidate replacement; see G2_ARTIFACT_REDO.md |
| G2 E16 | Real task-only yield on unsolved/partial/two cached repeats; other ready tasks still execute under the same root; Unicode predicate parity independently audited; see G2_PROGRESS_POLICY.md |
| NEXT | Complete scope/quantifier/parameter/multipart semantics and candidate-kind coverage; the fail-closed out-of-scope v5 path and the downstream read of declared coverage are now covered by regressions; review redo-last-WORK limits; do not claim G2/PR3 complete |

Later gates remain pending: G2 dynamic routes/tasks/methods; G3 grounded
candidate repair; G4 event-source replay/lifecycle; G5 separately authorized
official API and environment evaluation; G6 approved L1 release; G7 L2 carriers,
recovery and permitted assets; G8 independent full-inventory closure.

L1: NOT_COMPLETE. L2: NOT_COMPLETE. Do not create MIGRATION_COMPLETION.md as a
signed completion record while ownership/evidence gaps remain. Real API costs,
expanded permissions and default-engine switching retain their separate gates.
