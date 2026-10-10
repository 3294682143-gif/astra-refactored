# ADR-003 — Official client capabilities are negotiated, not assumed

Status: SOURCE_ONLY; no live official-client call authorized in P0.

The supplied rules document public `chat(messages, temperature, max_tokens)`
and injection by the platform. An archived baseline client source also exposes
keyword-only thinking_mode, tools, and request_args. Static source inspection
does not verify current platform acceptance or behavior of those parameters.
Do not access private client fields or carry development-provider credentials
into submitted code.

P0 advertises model/tool calls UNAVAILABLE, output limit UNVERIFIED, WASI
DISABLED, and native tool calls UNAVAILABLE. A configured max_tokens of 8192
with verified=false is a conservative configuration, not a tested provider
maximum. Streaming, usage, cancellation and actual token-limit boundaries remain
NOT_TESTED locally and TARGET_UNVERIFIED on the official platform.

The dsh/MaaS DeepSeek executor is a development code author, not the competition
model. Its successful request completion is not evidence about Intern-S client
support, mathematical correctness, or remote cancellation semantics. P0's probe
never makes model requests or clears earlier unrelated request responsibility.
