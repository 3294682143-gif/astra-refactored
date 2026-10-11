# v4 implementation gateboard

Current gate: **G2 / PR3 — methods, final confirmation and a bounded dynamic second route**.
G0 source inventory and deployment facts are supporting work, not a competing
math-feature stream. DSH authors implementation/tests; the supervisor reviews,
applies and independently verifies them. No parallel coding agents are used.

| Field | Current evidence |
| --- | --- |
| Baseline | G1 PR2 head `6e45893`, tree `a457740`; PR2 is open, not merged; main/default frozen; see SOURCE_LOCK.md |
| ROOT_E2E | LOCAL_PASS: `python -m pytest -q tests/e2e` — 76 public-entry E2E tests; includes real second-route task execution and provenance negatives; old Controller/Lite init/solve disabled |
| RC2_MIGRATION | 260 actual source paths, 260 classified with candidate owners, 0 unmatched, 260 REVIEW_REQUIRED, 0 CLOSED; 16 a2 changes separately inventoried |
| G0 source locks | commit/tree identities captured for RC2, a2, TS, DSH and Pi; audit script + five real-Git tests passed |
| G0 deployment | BLOCKED_EXTERNAL: no official Node/subprocess permission or target sandbox supplied |
| BUDGET | Preview 4 model calls / 2 effects / 5000 ms maximum; not official contest limits; no math API calls authorized in current implementation work |
| MATH | E08/E09/E10/E11/E12/E18 infrastructure paths locally tested; E01 grounded repair and other full math properties pending; real model comparison NOT_RUN |
| QUALITY | G1 PR2 exact clean: 244 Node / 406 Python; G2A exact clean `7446f79`: 257 / 430; final exact clean `42a7dc6`: 262 / 445; dynamic-route worktree: 264 / 462, same 24 WASI skips; exact-commit reproduction recorded separately |
| G2A METHODS | Real method → WORK → second WORK → R2; one catalog read/one method load in shared effect quota; opt-in only; see G2_METHOD_BRIDGE.md |
| G2B1 FINAL | Real tool → WORK → final → R2 in four calls; confirms only the protected old candidate; no fabricated artifact; see G2_FINAL_CONFIRMATION.md |
| G2B2 ROUTES | Model v2 proposal → M1 TASK_ADDED → real second-route WORK; full raw provenance, empty cross-route inputs, current-obligation scope; see G2_DYNAMIC_ROUTES.md |
| NEXT | Artifact version transitions/STALE propagation, progress and remaining scope/quantifier/multipart semantics through the same entry; do not claim G2/PR3 complete |

Later gates remain pending: G2 dynamic routes/tasks/methods; G3 grounded
candidate repair; G4 event-source replay/lifecycle; G5 separately authorized
official API and environment evaluation; G6 approved L1 release; G7 L2 carriers,
recovery and permitted assets; G8 independent full-inventory closure.

L1: NOT_COMPLETE. L2: NOT_COMPLETE. Do not create MIGRATION_COMPLETION.md as a
signed completion record while ownership/evidence gaps remain. Real API costs,
expanded permissions and default-engine switching retain their separate gates.
