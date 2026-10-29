# ADR-004 — Bounded P0 JSON-RPC stdio protocol

Status: P0 contract; test acceptance recorded separately in P0_CAPABILITY_MATRIX.

Version: `1.0-p0`. Transport: UTF-8 JSON-RPC 2.0 NDJSON, one JSON object per LF
frame. The single normative field manifest is
`packages/protocol/schema/p0.schema.json`. Its root is a custom protocol manifest
(`astra-p0-protocol-manifest-v1`), not a standard JSON Schema document. Envelope
and method nodes use the explicitly supported schema subset; both Python and TS
validate those same nodes. Unsupported keywords must fail, not be ignored.

The subset supports object/array/string/boolean/integer/null (including type
unions), properties/required/additionalProperties, items/maxItems, scalar
enum/const, integer minimum/maximum, and code-point minLength/maxLength.
title/description are annotations. Malformed keyword values, negative lengths,
reversed bounds, complex enum/const and type=number are rejected explicitly.
Boolean literals never compare equal to integer 0/1. Non-finite numeric tokens
use NON_FINITE_NUMBER; mathematical quantities outside safe integers must use
future string/tagged contracts, not floating JSON control numbers.

| Direction | P0 operation | Role |
| --- | --- | --- |
| Host → Node | runtime.initialize | Bind protocol/session and report restricted capabilities |
| Host → Node | runtime.probe | Echo a nonce only after catalog callback validation |
| Node → Host | method.catalog | Read the existing 20 ID/title records, no card bodies |
| Host → Node | session.stop | Acknowledge and exit; Host reaps its child |

This is not a production solve protocol. model.generate, tool.execute,
session.solve, method.load and session.event are explicitly refused. An invalid
session fails closed, with fixed diagnostics and a nonzero exit; no invented
success response or implicit retry is permitted.

Limits: 65536 UTF-8 bytes per frame excluding LF; 64 frames total in both
directions; nesting depth 24; safe integer JSON numeric tokens only; request and
session IDs at most 128 Unicode code points. Reject duplicate keys (including
escaped equivalent keys), lone surrogates, BOM, invalid UTF-8, floats/exponents,
unsafe integers, unknown/extra fields, wrong version/session/IDs and wrong
direction/state. Error envelopes may have id=null; request/success IDs cannot.
Host IDs cannot use the reserved `node-` callback prefix.

The Host is the root deadline owner: default five seconds beginning before
spawn, not extended per frame. Cleanup has its own bounded reap allowance.
Single-reader pumping must service a callback while awaiting probe completion.
Writes and stderr consumption are bounded; child authentication environment is
not inherited. This is process/protocol containment, not an OS sandbox.

Protocol completion proves only the local handshake. It neither establishes
mathematical correctness nor proves remote API cancellation (no remote request
exists in this probe). Crash recovery, persisted external-call intent and the
future event/effect protocol belong to later stages.
