# Public name verification — Zygos (ZY / 天轭)

Recorded **2026-10-17**. These are **plain public-search leads**, not legal conclusions and
not an ownership guarantee. "Not found" ≠ "available"; a scope/registry may be private or
taken. Each row states the affected channel and the required action.

## GitHub
- Target: same owner `3294682143-gif`, repo `zygos`.
- Read-only probe: `git ls-remote https://github.com/3294682143-gif/zygos.git` →
  **"Repository not found"** ⇒ availability/ownership **UNKNOWN** (may be private or taken).
- Action: owner-side check of availability + rename permission. Goal is continuity of the
  existing repo identity, not a new copy. (No API scopes beyond the session PAT were used.)

## npm (`@zygos` scope)
- No evidence found that `@zygos` exists or is owned by this project.
- Unrelated namesakes exist (e.g. `zycode`, `@zytech/zycode`, `zy`, `zyn-ai`).
- Action: check `@zygos` scope ownership + per-package publish permission on npm before any
  publish. Do not presume `import`/scope availability.

## Python (PyPI)
- No `zygos` project found on PyPI; a different `zygo-sdk` exists.
- Action: **separately** verify (a) the import module name `zygos`, (b) the **distribution
  project name**, and (c) install collisions. `import zygos` does **not** imply
  `pip install zygos` works; do not install an unverified same-name third-party package.

## CLI (`zy`)
- Multiple unrelated tools already use the short name or a `zy` prefix — e.g. a `zy` crate on
  crates.io, `zycode` / `@zytech/zycode` CLIs. There is no single global registry proving
  uniqueness.
- Action: check conflicts in supported environments; never shadow an unrelated program; ship
  `zy` only when its behavior matches this project.

## Brand / trademark leads
- **Real same-name entity found**: "Zygos" is used by a legal-tech company — litigation
  management / legal CRM software at `getzygos.com` (also a "Zygos" mobile app). Potential
  same-name conflict lead in an unrelated class (legal software).
- **USPTO lead**: `ZYGOS` — USPTO Serial **99397899**, applicant "Zygos LLC", status
  **DEAD (abandoned 2026-05-27)** (per TrademarkElite record). An abandoned application is a
  lead, **not** a clearance.
- Action: record retrieval date + source; a plain search is **not** a legal no-conflict
  guarantee. Formal trademark/prior-use search is a **pre-publication** item.

## Summary by channel
| Channel | Status | Required action |
| --- | --- | --- |
| GitHub repo `zygos` | UNKNOWN | owner checks availability + rename permission |
| npm `@zygos` scope | UNKNOWN | verify scope ownership + publish rights |
| PyPI `zygos` | UNKNOWN | verify import vs distribution name + collisions |
| CLI `zy` | conflict risk | check per-environment conflicts |
| Brand "Zygos" | same-name lead (legal-software co.) + dead USPTO app | formal trademark search before publishing |

None of these blocks the internal Phase A/B engineering work; they block only the affected
**publication** channels until resolved. The brand name itself is unchanged.
