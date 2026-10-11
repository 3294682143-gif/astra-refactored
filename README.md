# Astra — TypeScript five-module migration (offline development)

This branch follows the approved five-module design. It contains the P0 protocol
probe and the P1 offline prototype: five independent TypeScript mathematical
packages, runtime-core, a Node composition root and a Python mock-client Host.
The modules implement only the minimum candidate/unsolved control loop, not
their complete mathematical functionality. The Python 0.10.0a2 solver and
official entry point below are unchanged. No default-engine switch or
mathematical-quality claim is made.

Start with the [P1 offline runbook and scope](docs/P1_OFFLINE.md),
[P0 runbook](docs/P0_RUNBOOK.md),
[capability/acceptance matrix](docs/P0_CAPABILITY_MATRIX.md), and
[five-module boundaries](docs/adr/ADR-001-five-module-boundaries.md).
The official Node/subprocess deployment gate remains **TARGET_UNVERIFIED**.

P1 accepts only an in-memory simulated client. It does not call a real model or
use the Python solver behind the scenes. M4 review is explicitly skipped, all
candidates remain unverified, and complete R0/R1/R2 and S1/S2/S3 are deferred.
Use the direct Node build/test commands in the runbook; do not treat this source
development branch as a packaged competition submission.

The [P2-A M1 compiler/ledger slice](docs/P2_M1_LEDGER.md) adds
scoped obligations, dependency-aware task delivery, guarded mock acceptance and
ordinary goal revision. The next [M3 offline library slice](docs/P2_M3_WORKUNITS.md)
adds versioned artifacts, dependency invalidation and bounded route identities.
The [P2 offline composition](docs/P2_OFFLINE_COMPOSITION.md) now joins M1 task
delivery, M3 context/artifacts and bounded on-demand method loading, with real
Python resource-reader integration tests. **P2 and the full M3 migration are
not complete.** This is a separate synthetic fixture runner, not a real model
client or new RPC stack. The P1 executable and default entry remain unchanged.

The [a2 short-path alignment harness](docs/P2_A2_ALIGNMENT.md) now captures five
real Python-a2 offline request sequences and independently rebuilds them in TS.
It provides strict in-memory replay and private-text-free difference reports.
This is request-level evidence for those five cases, not full a2 equivalence;
the existing P2 WorkPacket prompt is explicitly detected as different.

The [P2 local Host bridge](docs/P2_HOST_BRIDGE.md) runs P2 work through a real
Python↔Node process channel with on-demand method callbacks. The
[M2/multi-unit increment](docs/P2_MULTI_WORKUNIT.md) admits up to three sequential
mock receipts with dependency checks and protected candidates; the default is
still one call. It remains opt-in and MOCK_ONLY. Full action policy, formal
client integration and default switching are unfinished.

The [P3 finite-action offline loop](docs/P3_FINITE_ACTIONS.md) now parses
tool/method/final/unsolved actions, admits and deduplicates controlled effects,
and carries full recorded observations into the next TypeScript context.
Integration tests execute the two existing isolated Python operators and the
method reader on synthetic inputs. This is a separate fixture library and
one-shot effect adapter, not a P2 Host protocol upgrade or a production client.
P2 Host 1.1 and the official Python entry point remain unchanged.

The [P3 local tool Host profile](docs/P3_TOOL_HOST.md) additionally runs
`model → tool → model → final` over the existing Python↔Node channel.
Python independently admits each tool request against its recorded model
response and root deadline. This opt-in profile still uses literal model
fixtures. The [method Host increment](docs/P3_METHOD_HOST.md) adds a bounded
catalog callback and on-demand card loading with `--max-method-loads 1`.
Method loading defaults to off; enabled methods and tools share one effect
budget and root deadline. P3 peers now use protocol `1.1-p3-host-local`.

The [P4 R2/S3 offline slice](docs/P4_REVIEW_AUDIT.md) adds version-bound review
reports, deduplicated challenges and a conservative protected-candidate gate.
Its fixture composition uses real M1/M2/M3 components with one work receipt
and up to two review receipts under one budget. Model approval never verifies
a candidate or closes mathematical obligations. P3 Host and the default entry
are unchanged; full P4 review, checking and repair remain unfinished.

This repository is the refactored Astra source tree. It is a source-only work
copy: it does not carry local installation assets, runtime-install profiles,
WASI binaries, model-mailbox files, run logs or credentials.

## Engines

The public entry point keeps the official interface:

```python
from user_agent import ReasoningAgent

agent = ReasoningAgent(client=client)                 # default: experimental lite
agent = ReasoningAgent(client=client, engine="legacy")  # original Controller
result = agent.solve(problem, metadata)
```

- `engine="lite"` (default) is the experimental lightweight typed-action path.
  It is a bounded model/tool loop over two existing registered operators and an
  on-demand advisory method reader. It does not claim any accuracy improvement.
- `engine="legacy"` selects the original Controller implementation unchanged.
- Unknown engines and unsupported parameters are rejected, not silently ignored.

`solve` returns a non-empty `final_response`, a `status`, `candidate_verified`
and a JSON-serializable `trace`. `candidate_verified` is always `False` on the
lite path: no local operator check upgrades the original problem to verified.

## Lite path behaviour

- Each `solve` builds its own coordinator and adapter. There is no cross-question
  state, no question index and no standard-answer input.
- Experimental defaults: 5 model calls, 120 seconds, single concurrency. These
  are local experimental defaults, not an official guarantee. An explicit
  `PlatformPolicy` is honoured and jointly bounds the local step count.
- One closeout turn is reserved per problem; the last turn cannot dispatch a
  tool.
- The model emits exactly one strict JSON action per turn:
  `tool(name,args,scope)`, `method(id)`, `final(answer,complete,unresolved)` or
  `unsolved(reason)`. Parsing uses `json` only (no `eval`/`exec`) and rejects
  duplicate fields, `NaN`/`Infinity`, extra fields, malformed structures and
  oversized input.
- Only `polynomial_expand_coefficients` and `linear_system_solution_set` are
  allowed. They run through the original `RegisteredExecutor` with its original
  input validation, process isolation, deadline and independent audit. No
  arbitrary model-authored Python is executed on the host.
- Tool output is an observation, never a final answer and never a proof.
- Method requests name only registered IDs, never file paths. The compact
  catalog lists 20 IDs/titles without reading their bodies. Requested bodies
  are checked against the bundled SHA256 manifest and included whole or refused;
  the full corpus is never injected. Local symlinks outside the resource root
  are rejected. Missing or damaged resources disable the method capability,
  not direct reasoning.
- Each problem can load at most two distinct methods and 12000 body characters
  by default. A repeated ID keeps the earlier body in context exactly once.
  Method cards remain advisory data with unproved prerequisites, not answers.
- Identical tool names and canonical JSON arguments execute once per problem,
  even if the scope wording changes. Repeats reuse only a complete bounded
  observation, explicitly marked as cached; oversized results are not replayed.
  Repetition requests a final/unsolved closeout within the existing turn and
  time limits. No new coordinator or budget is created.
- A `final` is a submittable candidate only when `complete=true`, `unresolved`
  is empty and the transport is complete; it is still `candidate_verified=false`.
  Truncated, late, errored or unfinished transport is never accepted as an
  answer, and the last `RESULT` line or a self-reported `COMPLETED` is not used.
- Proof problems are asked for a complete argument in the answer text. The
  program does not verify proof completeness.

## Tool safety

Problem text and tool output are data. They cannot override the system
instructions. `metadata` fields such as `answer` or `idx` never enter the
solving decision. Traces record fixed states, counters, tool names and safe
summaries only: no raw model stream, no problem text, no private paths and no
exception text.

## Optional WASI generated-Python sandbox

The generated-Python path remains optional and is **not** bundled here. This
source repository carries no WASI binary assets and no accepted profile. A
usable sandbox must be provisioned separately and accepted at its actual final
installation path; absence fails closed and never falls back to host Python.
The older `INSTALL.md` procedure is not automatically complete for this
repository.

## Offline verification

Offline tests exercise the protocol, the bounded loop, the public entry point
and the registered operators in their isolated subprocess. Passing offline
tests demonstrates source-level behaviour only. It is not a mathematical
accuracy result, not a formal-target acceptance and not evidence that model
quality improved.

Install and run the offline suite from the repository root:

```bash
python -m pip install .
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

When an explicit `PlatformPolicy` is passed, `problem_seconds` must stay at its
default value: the policy is then the single time authority and controls the
deadline. `max_steps` still additionally bounds the number of model calls.

Additional trusted lite options are `max_methods` (integer 0..3, default 2),
`max_method_chars` (integer 1..24000, default 12000), and `method_catalog`
(a `MethodCatalog` instance, intended for tests). `max_methods=0` skips catalog
construction and refuses method loads. These are constructor options, not
model-controlled settings. Method use consumes existing model turns rather than
adding model calls. The final turn permits neither tool nor method requests.

See `docs/REFRACTOR.md` for the slice description and `requirements-dev.txt`
for the offline test dependencies.
