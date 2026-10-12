# G2 E16: bounded task-local progress yielding

The single AgentLoop now yields a stalled task to another genuinely ready task,
without changing the Session or resetting model/effect/time allowances. DSH
authored implementation/tests; the supervisor reviewed, applied and independently
verified them. This does not complete G2, prove mathematics or establish deployment.

## Yield rules

Only COMPLETE transport can produce a task-local yield:

- A strict `unsolved` action yields that task, not the entire problem.
- A valid but incomplete WorkPacket is still retained as its own partial
  artifact; the task then yields, and its artifact cannot become a reusable
  mathematical premise.
- Two consecutive cache hits on the same admitted tool/method identity yield
  the task. One repeat remains allowed, preserving the existing method-cache
  behaviour. Real new effect execution resets this counter.

Both M1 and the progress record are prevalidated before either is committed.
Only the current task moves to BLOCKED; other task definitions, their delivery
state and the obligation's mathematical status are not globally blocked or
refuted. The real M1 event is TASK_YIELDED with eventSchemaVersion
`p2-task-progress-v1`. Older events retain their shapes. M2 then uses the existing
ready chooser; it does not invent a task or dependency.

UNKNOWN, truncated or errored transport, invalid packets, deadline expiration
and illegal effect actions retain the original global-stop rules. They do not
gain a retry or a fresh budget. A pending redo follows its existing bounded
abort/finalization path, not task-local yielding. Its documented last-WORK limit
has not been removed by this slice.

## Host and versioning

WORK context v7 carries a fixed four-field progressPolicy. Host independently
reconstructs yields and cache hits from actual prior replies and confirmed effect
receipts/observations. A changed policy, including boolean/integer substitutions,
or a request for an already yielded task is rejected before another client call.
Partial artifacts retain exact raw text/hash and count in artifact numbering;
yield/start/delivery event sequencing is reflected in later source provenance.

Historical v2–v6 WORK contexts remain explicitly read-only. WorkPacket schemas
1–4 and frame schemas 1.2/1.3 are unchanged. Public trace remains fixed IDs/codes,
not raw reasons or model text. This in-memory projection is not general durable
event replay or recovery.

## Cross-language boundary audit

Independent diagnostics found that Python strip and ECMAScript trim disagreed
on U+FEFF and U+0085: Host could falsely record or omit a yield even while broad
regression tests passed. Acceptance was withheld until a separate parser-parity
slice fixed the underlying non-empty predicate. A shared pure text contract now
uses the fixed ECMAScript whitespace set for the relevant Host checks while
preserving the original string for output, storage and hashing. Existing Unicode,
length, duplicate-key, numeric and effect-scope guards remain in place.

The real-entry parity cases cover FEFF, NEL, ASCII space, U+001C, zero-width space
and ordinary text. A batch of 18 actual Node/Python parser comparisons covers
unsolved.reason, final.answer and tool.scope. Fixed protocol exceptions remain
rejections, not new yields; arbitrary exceptions are not swallowed.

## Verification and limits

Real-entry tests observe unsolved/partial → a different ready task, second cached
tool/method repeat → a different task within four calls and one effect, real
method body retention without cross-task receipt sharing, candidate preservation,
STRICT withholding, length/unknown barriers, policy tampering and rejected
redispatch. Node tests separately assert actual M1 events, task-only BLOCKED
state, preserved other tasks/obligations and retained partial artifact data.

Supervisor worktree results: build passed; 272 Node, 507 Python and 121 entry
E2E tests passed, with the same 24 optional WASI skips. The 18-case parser batch
is one Python test, not 18 additional E2E tests. A separate read-only entry
diagnostic confirmed that yielding the second route keeps the first candidate
and proceeds under the same four-call budget. No live math API or score was used.
Exact-commit reproduction is recorded separately before promotion.

Full parameter/quantifier/branch/multipart scope semantics, broader candidate-kind
coverage, redo continuation limits, G3 grounded candidate correction and G4–G8
runtime/evaluation/release requirements remain. The migration inventory is not
closed and this checkpoint does not declare PR3/G2 or L1/L2 complete.
