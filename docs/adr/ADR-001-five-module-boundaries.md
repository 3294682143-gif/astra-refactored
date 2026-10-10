# ADR-001 — Five mathematical modules, a TypeScript control core

Status: architecture accepted for phased implementation; P0 only is in scope here.

The governing design is `Astra_TS五模块重构_最终实施方案.md`, SHA256
`266b3372329b189e6d012734cd81ca02abe0b5cd350c4164b3fa2fc511ffc5fe`.
This supersedes earlier generic controller proposals. The frozen comparison baseline
is Python `0.10.0a2`, commit `1a58f637e362c4fb16826594adb162508b7a9158`.

| Future independent package | Ownership and public output | Must not do |
| --- | --- | --- |
| M1 `math-contract` | Contracts, obligations, task graph; ContractVersion/Obligation/TaskSpec | Call tools or declare final correctness |
| M2 `math-gateway` | Legal actions, admission, receipts; ActionIntent/AdmissionDecision/ActionReceipt | Relax Host budget or invent tools |
| M3 `math-workunit` | Work units, routes, artifacts; WorkResult/Artifact/CandidateProposal | Promote truncated or unproved output to fact |
| M4 `math-review` | R0/R1/R2, risks, challenges; ReviewReport/Challenge/FollowupRequest | Treat same-model agreement as proof |
| M5 `math-audit` | S1/S2/S3, evidence, revisions, finalization | Generalize a local numerical check into a proof |

`runtime-core` is shared lifecycle/event/budget infrastructure, not a sixth
mathematical module. All five modules depend on `@astra/protocol` and defined
runtime port types, not one another's internals. The composition root routes
versioned events/commands; modules own their own projections. No circular
synchronous object graph or monolithic controller replaces these boundaries.

P0 implements only `@astra/protocol`, `@astra/stdio-runtime`, and a Python probe
Host. The five business packages and runtime-core are deliberately not empty
stubs presented as completed modules. Public mathematical record types in
protocol are declarations, not operational obligation/evidence machinery.

The four evidence axes remain separate:

- Source: MODEL_DERIVATION, MODEL_REVIEW, PROGRAM_OBSERVATION, NUMERIC_CHECK,
  EXACT_INPUT_CHECK, FORMAL_CHECK.
- Level: PROVISIONAL, REVIEWED, CHECKED_SCOPE, FORMAL.
- Availability: ACTIVE, SUSPENDED, STALE, REFUTED.
- Check result: PASS, FAIL, UNKNOWN, UNSUPPORTED, ERROR.

Hash equality establishes identity, not mathematical equivalence. Future evidence
must bind problem, contract/artifact versions, scope, assumptions, checked
property, checker coverage and request provenance. Same-model review cannot
promote evidence beyond REVIEWED. P0 performs no mathematical verification.

Python remains the official injected-client/process/capability Host. In the final
architecture it must not retain a hidden solver loop. For now `user_agent.py`
and the Python baseline remain unchanged; P0 is a separate developer probe.
