# RELEASE_BLOCKERS — L1/L2 external blockers (G5/PR6 local)

Everything below is `BLOCKED_EXTERNAL`: it needs the separately authorized real
official API, the target contest sandbox, or a WASI/environment approval. None of
it may be self-approved.

| # | blocker | what is needed | affected gate |
| --- | --- | --- | --- |
| B1 | Real official 书生 S2 client run (thinking/usage/finish_reason, rate limits, true max_tokens) | authorized API + data/cost approval | G5 / PR6 |
| B2 | Target environment Node/subprocess probes; precompiled JS actually launched there | official sandbox access | G6 / L1 release |
| B3 | WASI accepted profile / generative-execution sandbox | platform permission + accepted profile | G7 / PR7 (Slice 7c) |
| B4 | Real math A/B/C/D accuracy/cost comparison on a frozen problem set | authorized same-budget run + judge freeze | G5 / PR6 |

Local (non-external) work continues: the offline harness, the precompiled-JS
manifest, the RC2 capability migration and the ledger closure all proceed without
these blockers; online cells stay honestly `NOT_RUN`.
