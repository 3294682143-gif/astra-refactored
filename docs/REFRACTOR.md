# Astra refactor: lightweight typed-action slice

This document describes the first implemented slice of the Astra refactor. It
records what exists, what does not, and which claims are deliberately withheld.

## Scope of this slice

Implemented:

- A typed JSON action protocol (`mathagent/lite/protocol.py`) with strict,
  total parsing: no `eval`/`exec`, no duplicate fields, no `NaN`/`Infinity`, no
  extra fields, no implicit defaults, bounded size and nesting.
- A lightweight bounded model/tool loop (`mathagent/lite/runtime.py`) that
  builds a fresh coordinator and adapter per `solve`, reserves one closeout
  turn, and never treats tool output as an answer.
- An explicit engine switch in `user_agent.py`: `engine="lite"` (default,
  experimental) and `engine="legacy"` (original Controller, unchanged).
- A `protocol="lite"` transport-integrity branch in
  `mathagent/runtime/platform_adapter.py`. The `l3` and `r4` branches are
  unchanged, and all model access still goes through the injected public client
  and the existing admission path.
- Offline tests for the protocol, the runtime loop, the public entry point and
  the registered operators.

Not implemented / not claimed:

- No arbitrary model-authored Python execution on the host.
- No new tools beyond the two existing registered operators.
- No automatic upgrade of the legacy Controller and no budget reallocation.
- No mathematical verification of the original problem. `candidate_verified`
  stays `False`; a local operator check never promotes the whole problem.
- No accuracy improvement claim. The lite path is experimental.
- No bundled WASI assets or accepted profile.

## Public interface

```python
ReasoningAgent(client, *args, **kwargs).solve(problem, metadata=None)
```

Lite keyword arguments: `policy`, `load_started`, `executor`, `max_steps`,
`problem_seconds`. Anything else raises `TypeError`. An unknown `engine` raises
`ValueError`. The lite path does not inherit the module import timestamp; only
an explicit `load_started` constrains the first solve.

## Budgets

Experimental defaults: 5 model calls, 120 seconds, single concurrency. These
are local experimental defaults, not an official allocation. When an explicit
`PlatformPolicy` is supplied it is authoritative and jointly bounds the local
step count. One closeout turn per problem is reserved, and the final turn
cannot dispatch a tool. Time and call budgets are never silently increased.

## Tool boundary

Only `polynomial_expand_coefficients` and `linear_system_solution_set` may be
requested. Execution goes through the original `RegisteredExecutor`, preserving
its input validation, process isolation, deadline and independent audit. A
registered operator that raises is converted at a narrow boundary into a fixed,
text-free error observation so the bounded loop can still repair; the exception
type, message and traceback are never recorded, and such an execution never
marks a candidate as verified.

## Transport integrity

`PlatformAdapter.invoke_packet` remains the only transport. The `lite` protocol
branch accepts a raw string return only when the public method returned normally
and no explicit truncation is present. Explicit truncation, exceptions, late
returns and unfinished transport are never accepted as answers. A local
deadline is not a confirmed remote cancellation; metrics keep that fact
`unknown`.

## WASI generated-Python sandbox

Optional and separately provisioned. This source repository carries no WASI
binary assets and no accepted profile. The sandbox must be accepted at its
actual final installation path; absence fails closed and never falls back to
host Python. The legacy `INSTALL.md` procedure is not automatically complete
for this repository.

## Verification status

Offline tests cover the protocol, the loop, the entry point and the registered
operators. Passing them demonstrates source-level behaviour only. It is not a
mathematical accuracy result, not a formal-target acceptance and not evidence
of improved model quality.
