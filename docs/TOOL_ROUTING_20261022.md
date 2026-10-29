# Tool routing and effect-budget hardening (2026-10-22)

This slice implements the tool-facing changes in `HANDOFF.md` §12.3/§12.5.
It is an answer-free control change: tool output remains a provisional
observation, never a proof or a verified candidate.

## 1. Canonical consensus ballot

- New `apps/stdio-runtime/src/agent-answer-key.ts` and
  `python/astra_bridge/answer_semantics.py` map presentation-equivalent answers
  to one comparison key:
  - exact rationals, `\frac{a}{b}`, `\frac ab`, and finite decimals;
  - finite numeric sets with sorted/deduplicated members;
  - whole-answer option notation (`A`, `(A)`, `A.`, `A、C`, `A, C`, `AC`);
  - truth tokens (`正确/真/true` and `错误/假/false`);
  - whole polynomial coefficient maps.
- Both the Node consensus count and the Python Host artifact ballot count
  canonical keys, while the delivered candidate keeps its original model text.
  CERT1 precedence, latest tie-break, and first-packet fallback are unchanged.
- A sentence containing option letters is never collapsed into an option set;
  adjacent numeric literals with internal whitespace are not merged into a
  different number.
- Shared fixture: `tests/bridge/fixtures/canonical_answer_keys.v2.json`;
  differential test: `tests/bridge/test_answer_semantics_parity.py`.

## 2. Eight-tool whitelist

The closed P3 whitelist is now exactly:

1. `polynomial_expand_coefficients`
2. `linear_system_solution_set`
3. `exact_check_expr`
4. `bounded_enumeration`
5. `real_root_count_expr`
6. `splitting_field_degree_expr`
7. `circle_laplacian_expr`
8. `planar_laplacian_expr`

The list is mirrored in `packages/protocol/src/p3.ts`,
`python/astra_bridge/p3_effect_contract.py`, all four schema copies, and the
focused whitelist test. The four new tools already have dispatch entries and
input contracts; no mathematics was changed.

## 3. Semantic routing and forced-turn gate

`apps/stdio-runtime/src/agent-semantics.ts` has a deterministic first-match
router:

1. finite enumeration
2. real-root count
3. splitting-field degree
4. circle Laplacian
5. planar Laplacian
6. exact maximal minors
7. exact factorization over an extension
8. exact density normalization
9. exact trig reduction
10. exact limit

Routing uses only problem wording. It never reads an item id, reference answer,
or answer table. The generic determinant and bare `分布` cases were deliberately
narrowed so an unrelated question cannot burn the tool slot.

A forced method/tool turn is now a protocol gate: a non-obeying reply triggers
one identical bounded retry; after that the turn fails open to the model's
best-effort packet and never fabricates a receipt. The session log records
`TOOL_ROUTE`, `FORCED_TURN_RETRY`, `TOOL_OBSERVATION` (name/operation/forced/
route) and `METHOD_LOAD` (method id). A wrong tool executed after fail-open is
logged as `forced:false`, `routeId:null`.

## 4. Method cards and tool effects are separate quotas

- Public `maxEffects` remains the **tool** quota (0..2).
- The internal total effect-id capacity is `maxEffects + maxMethodLoads`
  (currently max 3): one method card plus up to two tools.
- `effect-1..3` are accepted at every boundary; `effect-4` is rejected.
- Node and Host independently enforce total capacity, then the per-kind quota.
  `maxMethodLoads=0` preserves the old shared-budget path.
- The root `AgentSession` accepts the internal capacity of three while the
  public option capture still rejects `maxEffects=3`.

## 5. All tool observations and closure

The Node loop now captures every completed tool result in a typed
`ToolObservationView[]`, not only `exact_check_expr`. The closure consumer adds
safe structural comparisons for:

- real-root count vs a whole numeric candidate;
- splitting-field degree vs an explicitly stated degree;
- the existing maximal-minor degree and density-normalization checks.

Tool observations are still never promoted to an answer without a complete
model packet. The earlier unanchored `problemRelationPolynomial` solution-set
inference was removed from this path: completeness is closed only by an explicit
`CERT1|COMPLETENESS` marker until a trusted solver supplies a verified set.

## 6. Host metrics

Every solved and unsolved result now carries:

`routed`, `forced`, `obeyed`, `observation_used`, `tool_effect_calls`,
`method_effect_calls`, `tool_names`, `method_ids`.

They derive only from the real SessionLog/effect records; no raw arguments,
observations or model text enter the metrics.

## 7. Caret power syntax at the executor seam

The family expression parsers accept Python `**`, while the model-facing
contract also advertises TeX `^`. `mathagent/tools.py` normalizes `^` to `**`
only in declared expression-bearing arguments before dispatch. The frozen
`math_families/**` baseline is unchanged, so `test_g7_registry.py` and the scoped
asset checks remain valid.

## 8. Verification

Final gates after the last source edit:

- `tsc -b`: 0
- Node (protocol + stdio-runtime suites): **370/370**
- Full pytest: **869 passed, 24 skipped**
- Focused bridge suites (canonical keys, parity, whitelist/effect ids, Host
  effect budget, unsolved code vocabulary): **458 passed**
- Focused agent e2e (closures, forced protocol, consensus): **20 passed**
- `release/BUILD_MANIFEST.json`: `VERIFY_OK` (3 JS + 4 assets + 2 bundle)
- No commit, no push.

The 9-item real API smoke lives in `/tmp/astra-tools9-103c`; see HANDOFF §12.7 for
candidate/funnel numbers and for the one item that ended `unsolved`.

## 9. Failure coding on the Host seam

Three failure classes on the Python side used to collapse into one generic
`FIELD_VALUE` code, which made a lost item impossible to localize after the run:

| Case | Code | Where |
| --- | --- | --- |
| Unexpected driver exception | `EXC_<TypeName>` (type only, bounded, no message) | `agent_runtime._exception_code` |
| Clean child exit with no `session.solve` result | `NO_SOLVE_RESULT` | `agent_runtime` wait branch |
| Out-of-phase frame (e.g. stop while solve is pending) | `ILLEGAL_TRANSITION` | `agent-host-flow.onRequest` |
| Model/review/repair/consensus/effect budget refused | `BUDGET` | `agent_host.on_model` / `on_effect` phase gates |
| Root deadline floor reached | `DEADLINE_EXCEEDED` | `agent_host` callback deadline checks |

`python/astra_bridge/p0_probe.py` now retains the child's own fixed stderr code
(`host.stderr_code`, first bounded upper-case token only), and the unsolved
projection carries `code`, `stage`, `childExit` and `childCode`, so a later run
names the exact Host step that failed. None of those fields can carry model
text, problem text, tool arguments or a traceback.
