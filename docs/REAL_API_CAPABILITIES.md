# REAL_API_CAPABILITIES — official 书生 S2 client surface (G5/PR6 local)

Status: **NOT_RUN (BLOCKED_EXTERNAL)** for the real provider. This document fixes
the *local* contract the Python Host applies to the platform-injected official
client; it is not a real provider measurement.

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
tools, rate limits and true max output are **NOT_RUN (BLOCKED_EXTERNAL)** — they
require the separately authorized real API run and the target environment. No
benefit is claimed from any real-model measurement.


## Smoke log — 2026-10-15 (engine session)
- Outbound HTTPS via the local proxy (`127.0.0.1:9999`) is reachable; a direct POST to
  `https://chat.intern-ai.org.cn/api/v1/chat/completions` (model `intern-s2`) returned
  **HTTP 401 `user token expired` (msgCode A0211)** with the supplied credential.
- Therefore no real Intern S2 request/usage structure could be measured. Real API remains
  **NOT_RUN**; the capability table above is unchanged. A valid, unexpired Intern S2
  credential is required (process-internal one-shot only; never persisted).
