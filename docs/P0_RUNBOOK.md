# P0 local development probe

This branch begins the TypeScript five-module migration. It is not a completed
TS mathematical agent or a competition submission. The default Python solver
and `user_agent.py` remain at the frozen 0.10.0a2 baseline.

Use Node 24.7.0 and pnpm 11.7.0 for the recorded local toolchain. Development
dependencies are pinned in pnpm-lock.yaml. TypeScript's license is Apache-2.0;
@types/node and its undici-types dependency use MIT. These packages are not
vendored here; final release license/binary review is still required. Making the
GitHub repository public does not add a new project-wide license grant.

From the repository root, with the locked developer packages already cached:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm build
pnpm test:ts
python -m python.astra_bridge.p0_probe
python -m pytest -q
```

If offline installation reports a cache miss, stop and provision dependencies
through an authorized environment; do not silently download a different version.
P0 requires a source checkout with compiled JS and workspace links; Python wheel
installation alone is insufficient. No API credentials or network calls are
required to run the probe. A missing Node executable or missing JS artifact is
a failure, never an implicit fallback to the Python solver.

The local standalone pnpm binary internally reports Node 22.21.1 when checking
the root engine pin, so it emits an engine warning. `node --version` and
`pnpm exec node --version` both report 24.7.0, the actual probe/test executable.
This warning is recorded, not evidence that the official platform is compatible.

The probe validates one session and a read-only method catalog callback. It
returns only safe protocol evidence. The default five-second root deadline
includes initialization before spawning the child; cleanup is separately bounded.
Model generation, mathematical tools, method bodies and production solve methods
are unavailable. Never interpret a successful handshake as a math score.

See [capability matrix](P0_CAPABILITY_MATRIX.md) for actual acceptance evidence and
[ADR-002](adr/ADR-002-node-runtime-gate.md) for the official-target gate. Do not merge
this branch into the default engine or submit it as the TS competition agent yet.
