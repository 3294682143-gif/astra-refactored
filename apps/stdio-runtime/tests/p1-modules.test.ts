/**
 * Compact P1 module invariants. These tests exercise the six packages
 * directly; they start no child process and make no model call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { compileContract, problemHashOf } from "@astra/math-contract";
import { admitModelCall } from "@astra/math-gateway";
import { acceptModelResult, prepareMessages } from "@astra/math-workunit";
import { reviewSkipped } from "@astra/math-review";
import { finalize, UNSOLVED_RESPONSE } from "@astra/math-audit";
import { Session } from "@astra/runtime-core";
import { P1_SYSTEM_PROMPT, p1EventId } from "@astra/protocol";

const PROBLEM = "Compute 2 + 2 and explain.";
const HASH = problemHashOf(PROBLEM);

function contract(sessionId = "s-1") {
  return compileContract(PROBLEM, sessionId, HASH, 1);
}

test("M1 keeps the full text and one open obligation", () => {
  const c = contract();
  assert.equal(c.problemFullText, PROBLEM);
  assert.equal(c.problemHash, HASH);
  assert.equal(c.contractVersion, 1);
  assert.equal(c.obligations.length, 1);
  assert.equal(c.obligations[0]?.status, "OPEN");
  assert.throws(() => compileContract(PROBLEM, "s-1", "0".repeat(64), 1), RangeError);
  assert.throws(() => compileContract(PROBLEM, "", HASH, 1), RangeError);
  assert.throws(() => compileContract(PROBLEM, "s-1", HASH, 0), RangeError);
});

test("M2 refuses zero, NaN and the 25ms tail", () => {
  assert.equal(admitModelCall(1000, 0).admitted, false);
  assert.equal(admitModelCall(Number.NaN, 1).admitted, false);
  assert.equal(admitModelCall(25, 1).admitted, false);
  assert.equal(admitModelCall(26, 1).admitted, true);
});

test("M3 keeps truncated, errored and unknown receipts non-complete", () => {
  const c = contract();
  for (const status of ["TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    const w = acceptModelResult(c, status, "partial", "model-1", 2);
    assert.equal(w.deliveryStatus, status);
    assert.equal(w.provisional, true);
  }
  assert.throws(() => acceptModelResult(c, "COMPLETE", "x", "model-2", 2), RangeError);
  const messages = prepareMessages(c);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, P1_SYSTEM_PROMPT);
  assert.equal(messages[1]?.content, PROBLEM);
});

test("M4 records the skipped review", () => {
  const r = reviewSkipped(contract(), 2);
  assert.equal(r.status, "SKIPPED_BY_POLICY");
  assert.equal(r.candidateVerified, false);
  assert.equal(r.strictAcceptance, "NOT_PERFORMED");
  assert.equal(r.envelope.causeEventId, p1EventId("s-1", 1));
  assert.notEqual(r.envelope.causeEventId, r.envelope.recordId);
});

test("M3/M5 causeEventId names the causing event, not a record", () => {
  const c = contract();
  const work = acceptModelResult(c, "COMPLETE", "4", "model-1", 2);
  assert.equal(work.envelope.causeEventId, p1EventId("s-1", 1));
  assert.notEqual(work.envelope.causeEventId, c.envelope.recordId);
  const review = reviewSkipped(c, 3);
  const decided = finalize(c, work, review);
  assert.equal(decided.envelope.causeEventId, p1EventId("s-1", 3));
  assert.notEqual(decided.envelope.causeEventId, review.envelope.recordId);
  assert.throws(() => p1EventId("", 1), RangeError);
  assert.throws(() => p1EventId("s-1", 0), RangeError);
  assert.throws(() => p1EventId("s-1", 1.5), RangeError);
});

test("M5 emits an unverified candidate or a fixed unsolved text", () => {
  const c = contract();
  const review = reviewSkipped(c, 3);
  const good = acceptModelResult(c, "COMPLETE", "4", "model-1", 2);
  const decided = finalize(c, good, review);
  assert.equal(decided.status, "candidate");
  assert.equal(decided.finalResponse, "4");
  assert.equal(decided.candidateVerified, false);
  assert.equal(decided.strictAcceptance, "NOT_PERFORMED");
  assert.equal(decided.envelope.sourceModule, "M5");
  assert.equal(decided.envelope.sessionId, "s-1");
  assert.equal(decided.envelope.problemHash, HASH);
  assert.equal(decided.envelope.contractVersion, 1);
  assert.equal(decided.envelope.artifactVersion, 1);
  assert.equal(decided.envelope.recordId, "s-1:m5:1");
  assert.equal(decided.envelope.eventSeq, review.envelope.eventSeq + 1);
  const empty = acceptModelResult(c, "COMPLETE", "   ", "model-1", 2);
  assert.equal(finalize(c, empty, review).status, "unsolved");
  const cut = acceptModelResult(c, "TRUNCATED", "4", "model-1", 2);
  assert.equal(finalize(c, cut, review).status, "unsolved");
  assert.equal(finalize(c, null, review).finalResponse, UNSOLVED_RESPONSE);
  const other = contract("s-2");
  assert.throws(() => finalize(c, good, reviewSkipped(other, 3)), RangeError);
  const otherWork = acceptModelResult(other, "COMPLETE", "4", "model-1", 2);
  const otherDecision = finalize(other, otherWork, reviewSkipped(other, 3));
  assert.equal(otherDecision.envelope.recordId, "s-2:m5:1");
  assert.notEqual(otherDecision.envelope.recordId, decided.envelope.recordId);
});

test("Session tightens the absolute deadline and never refreshes it", () => {
  let now = 1000;
  const session = new Session({
    sessionId: "s-1",
    problemHash: HASH,
    remainingMs: 100,
    maxCalls: 1,
    now: () => now,
  });
  assert.equal(session.remainingMs(), 100);
  assert.equal(session.tightenRemaining(20), 20);
  now += 21;
  assert.equal(session.remainingMs(), 0);
  assert.equal(session.tightenRemaining(5000), 0);
});

test("Session admits one call and a replay has no side effect", () => {
  let now = 0;
  const session = new Session({
    sessionId: "s-1",
    problemHash: HASH,
    remainingMs: 1000,
    maxCalls: 1,
    now: () => now,
  });
  assert.equal(session.reserveModelCall().admitted, true);
  assert.equal(session.reserveModelCall().admitted, false);
  assert.equal(session.modelCalls(), 1);
  const event = session.append("MODEL_ADMITTED", "M2", "ADMITTED");
  session.recordContext(prepareMessages(contract()), event.seq);
  assert.equal(session.projectContext()?.messages.length, 2);
  assert.equal(session.modelCalls(), 1);
  assert.throws(() => session.recordContext(prepareMessages(contract()), event.seq), RangeError);
  assert.throws(() => session.recordContext(prepareMessages(contract()), 99), RangeError);
});

test("Session rejects a context eventSeq that does not exist yet", () => {
  const session = new Session({
    sessionId: "s-1",
    problemHash: HASH,
    remainingMs: 1000,
    maxCalls: 1,
    now: () => 0,
  });
  assert.throws(() => session.recordContext(prepareMessages(contract()), 1), RangeError);
  assert.equal(session.projectContext(), null);
});

test("Session trace is immutable and rejects unknown codes", () => {
  const session = new Session({
    sessionId: "s-1",
    problemHash: HASH,
    remainingMs: 1000,
    maxCalls: 1,
    now: () => 0,
  });
  const event = session.append("SESSION_INITIALIZED", "HOST", "START");
  assert.throws(() => {
    (event as { seq: number }).seq = 99;
  }, TypeError);
  const snapshot = session.snapshot();
  assert.equal(snapshot[0]?.seq, 1);
  assert.throws(() => {
    (snapshot[0] as { seq: number }).seq = 99;
  }, TypeError);
  assert.equal(session.snapshot()[0]?.seq, 1);
  assert.throws(() => session.append("NOT_AN_EVENT" as never, "M1", "START"), RangeError);
  assert.throws(() => session.append("SESSION_INITIALIZED", "M1", "NOPE" as never), RangeError);
  assert.throws(() => session.append("SESSION_INITIALIZED", "M9" as never, "START"), RangeError);
});
