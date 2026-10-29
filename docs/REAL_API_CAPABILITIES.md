# REAL_API_CAPABILITIES — official 书生 S2 client surface (G5/PR6 local)

Status: **SMOKE_RUN (2 items) / formal G5 NOT_RUN (BLOCKED_EXTERNAL)**. This document
fixes the *local* contract the Python Host applies to the platform-injected
official client. A two-item engineering smoke is recorded in
[REAL_MODEL_SMOKE_20261018](REAL_MODEL_SMOKE_20261018.md); it is not a math
benchmark or an L1 comparison.

## Adapter contract (public signature only)

- The official client is injected by the platform and called through its public
  `chat(messages, temperature, max_tokens)` signature only. The Host never
  reflects private attributes, never reads a provider key from the environment,
  and never opens a second model endpoint.
- **Output ceiling**: conservative `max_tokens <= 8192`
  (`python/astra_bridge/model_request_policy.py`); a request never widens it and
  never assumes the model's true maximum.
- **Normalization (public fields only)**:
  - `finish_reason` → fixed token in
    `stop / end_turn / tool_calls / length / content_filter / other`; an absent
    value is `UNKNOWN`.
  - `usage` → safe non-negative ints; a missing/malformed block is `UNKNOWN`
    (`None`), **never `0`**.
  - `thinking`/`reasoning` → `reasoning_used` is `True` only when the public
    response declares non-empty reasoning content.
- Transport mapping: explicit `length` → `TRUNCATED`; missing `finish_reason` →
  `UNKNOWN`; a bare string → `UNKNOWN`. The Pi truncated-tool-barrier (G4 4b)
  then bans actions from a non-`COMPLETE` reply.

## What is NOT established here

The real provider's thinking/usage/finish_reason fields, streaming, native
tools, rate limits and true max output are only partially observed in the smoke;
the formal four-arm comparison and target environment remain
**NOT_RUN (BLOCKED_EXTERNAL)**. No accuracy or cost benefit is claimed.

## Smoke log — 2026-10-15 (engine session)
- Endpoint `https://discovery-api.intern-ai.org.cn/v1/chat/completions` (OpenAI-compatible), model `intern-s2`
  (server reports `model: "Intern-S2"`); outbound via local proxy works.
- Verified with one live call (HTTP 200): response carries
  `choices[0].message.content` (may be `null` when only reasoning is produced),
  `choices[0].message.reasoning_content` (thinking text), `choices[0].finish_reason`
  (`stop` / `length` / ...), and `usage` = {`prompt_tokens`,`completion_tokens`,`total_tokens`,
  `prompt_tokens_details.cached_tokens`}; top-level `id`/`request_id`/`model`/`object`.
- Caveat: with a small `max_tokens` the model may emit only `reasoning_content` and
  `finish_reason=length` with `content=null` — consumers must treat `content=null` + `length`
  as a truncated/thinking-only reply (never a complete answer).
- A prior credential from an earlier round returned HTTP 401 `user token expired`; superseded by the
  working credential above. No credential is persisted here.
