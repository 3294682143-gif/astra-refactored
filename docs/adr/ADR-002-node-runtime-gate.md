# ADR-002 — Node deployment requires target evidence

Status: local prototype only; official target gate is TARGET_UNVERIFIED.

The supplied preliminary rules require root `user_agent.py`,
`ReasoningAgent(client=official_client)`, and
`solve(problem: str, metadata: dict) -> dict` with nonempty `final_response`.
They permit auxiliary modules and dependencies but do not establish that the
official isolated environment supplies Node, allows child processes, allows
writable storage, or installs JavaScript dependencies. Local success is not
evidence of those permissions.

The local developer toolchain observed on 2026-10-10 is Node 24.7.0, pnpm 11.7.0,
TypeScript 6.0.3 and @types/node 22.20.0. The real pnpm lock pins developer
dependencies; the runtime has no third-party runtime dependency beyond the
internal protocol package. TypeScript uses strict NodeNext/ES2022 with project
references and noEmitOnError. Run compiled JS, not runtime TS stripping.

P0 is a source development workspace, not a deployable competition package.
Generated dist and node_modules are intentionally ignored. P6 release acceptance
must provide precompiled JS, schema, relative workspace/package resolution,
accepted Node binary/version, dependency licenses, and a clean-install probe
from the exact artifact to be submitted. Python wheel installation alone does
not install this P0 workspace.

Do not switch the default engine or silently call the old Python solver when
Node is unavailable. Official target evidence and stage approval are required
for target P1 acceptance. A subsequent user-approved development-only exception
allows the MOCK_ONLY P1 prototype described in ADR-005; it does not pass this
deployment gate. If Node/subprocess is prohibited, stop the deployment path
and present a separately reviewed runtime ADR; do not assume an alternative
runtime or bundled binary is permitted.
