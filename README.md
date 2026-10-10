# Astra mathagent 0.10.0a2 (source repository)

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
