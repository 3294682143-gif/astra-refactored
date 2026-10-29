# Astra refactor work copy

This is a separate source-only work copy of General Full RC2. Frozen baselines, historical evaluations and the model mailbox are outside this repository and must not be modified.

The supervising assistant owns scope and acceptance. Implementation patches are authored by the explicitly assigned dsh `mass/deepseek-v4.1-flash` executor, reviewed and applied by the supervisor. Do not claim model-authored tests were run until the supervisor records actual results.

Keep the official `user_agent.ReasoningAgent(client=...).solve(problem, metadata)` interface. All submitted model access goes through the injected public client. Provider endpoints may be recorded in configuration. API keys/credentials must come from the environment or a secrets store and must never be committed. Standard answers, targeted question cards or hidden-test data do not belong here.

Preserve request admission, original deadlines, unknown-request responsibility and bounded tool execution. Never evaluate arbitrary model Python on the host. Never equate tool completion, protocol completion or model self-assessment with mathematical verification.

Use apply_patch for source edits. Do not commit personal installation profiles, local logs, evaluator state or model mailbox files. Optional WASI assets must be separately provisioned and accepted at the actual installation path; absence must not trigger host-Python fallback.

Run focused offline tests for each slice. Live mathematical evaluation, installing dependencies, publishing and pushing require their own explicit scope; no repository or account defaults may be changed as a side effect.
