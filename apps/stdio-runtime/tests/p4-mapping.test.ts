import { test } from "node:test";
import assert from "node:assert/strict";
import { P4MappingReviewSession } from "@astra/math-review";
import { P4DiagnosticEffectGate, p3EffectFailure } from "@astra/math-gateway";
import { P4DiagnosticLedger } from "@astra/math-audit";
import {
  P2Error,
  p2Snapshot,
  p4Hash,
  p4JsonEqual,
  type P3EffectReceipt,
  type P3EffectRequest,
  type P4CheckPlan,
} from "@astra/protocol";
import { buildMapping, polyAction, reportMapping, type MappingBuilt } from "./p4-mapping-fixtures.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function expectReject(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error);
}

function session(built: MappingBuilt, plan: unknown = built.plan): P4MappingReviewSession {
  return new P4MappingReviewSession(built.contract, built.target, plan as P4CheckPlan, 1);
}

function settle(
  built: MappingBuilt,
  text: string,
  transport: "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN" = "COMPLETE",
  remainingMs = 1000,
) {
  const review = session(built);
  review.admit(5000);
  review.markDispatched();
  return review.settle(transport, text, remainingMs);
}

function goodReceipt(request: P3EffectRequest, observation: string): P3EffectReceipt {
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4Hash(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  } as P3EffectReceipt;
}

test("mapping report parses MATCH/MISMATCH/UNKNOWN and keeps the full context", () => {
  const built = buildMapping();
  for (const verdict of ["MATCH", "MISMATCH", "UNKNOWN"] as const) {
    const record = settle(built, reportMapping(built, verdict));
    assert.equal(record.code, "OK");
    assert.equal(record.report?.conclusion, verdict);
    assert.equal(record.report?.dimensions.length, 5);
    assert.equal(record.level, verdict === "UNKNOWN" ? "PROVISIONAL" : "REVIEWED");
    assert.equal(record.checkResult, "UNKNOWN");
    assert.equal(record.canSupportObligation, false);
    assert.equal(record.source, "MODEL_REVIEW");
    assert.equal(record.planHash, p4Hash(JSON.stringify(built.plan)));
    assert.equal(record.rawResponseText, reportMapping(built, verdict));
    const user = record.context.messages[1]!;
    const payload = JSON.parse(user.content) as Record<string, unknown>;
    assert.equal(payload.problemFullText, built.contract.problemFullText);
    assert.equal(payload.targetHash, built.target.targetHash);
    assert.equal(payload.planHash, p4Hash(JSON.stringify(built.plan)));
    assert.equal(payload.representationText, JSON.stringify(built.plan.request.action));
    assert.equal(record.context.contextBytes, Buffer.byteLength(JSON.stringify(record.context.messages), "utf8"));
    assert.equal(record.context.contextHash, p4Hash(JSON.stringify(record.context.messages)));
    assert.equal(JSON.stringify(payload).includes("x=1 only"), true);
    assert.equal(JSON.stringify(payload).includes("\u{1F600}"), true);
  }
  const snapshot = session(built).snapshot();
  assert.equal(snapshot.record, null);
  assert.equal(snapshot.representationText, JSON.stringify(built.plan.request.action));
});

test("strict report parsing rejects malformed, forged and conflicting reports", () => {
  const built = buildMapping();
  const good = JSON.parse(reportMapping(built)) as Record<string, unknown>;
  const mutate = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
  const rows = good.dimensions as Record<string, unknown>[];
  const bad: readonly string[] = [
    mutate({ extra: 1 }),
    mutate({ requestId: "model-3" }),
    mutate({ stage: "R2" }),
    mutate({ targetHash: "0".repeat(64) }),
    mutate({ planHash: "0".repeat(64) }),
    mutate({ target: { ...built.binding, taskId: "other" } }),
    mutate({ conclusion: "MISMATCH" }),
    mutate({ dimensions: rows.slice(0, 4) }),
    mutate({ dimensions: [...rows, rows[0]!] }),
    mutate({ dimensions: [rows[0]!, rows[0]!, rows[2]!, rows[3]!, rows[4]!] }),
    mutate({ dimensions: rows.map((row) => ({ ...row, rationale: "  " })) }),
    mutate({ dimensions: rows.map((row) => ({ ...row, problemSpan: { start: 0, end: 3, quote: "zzz" } })) }),
    mutate({ dimensions: rows.map((row) => ({ ...row, representationSpan: null })) }),
    mutate({ dimensions: rows.map((row) => ({ ...row, verdict: "MAYBE" })) }),
    mutate({ dimensions: rows.map((row) => ({ ...row, extra: 1 })) }),
    reportMapping(built).replace('"requestId":"model-2"', '"requestId":"model-2","requestId":"model-2"'),
    reportMapping(built).replace('"start":0', '"start":0.5'),
    reportMapping(built).replace('"start":0', '"start":9007199254740993'),
    JSON.stringify({ ...good, dimensions: rows.map((row) => ({ ...row, rationale: "\ud800" })) }),
    "",
  ];
  const goodRaw = reportMapping(built);
  for (const text of bad) {
    assert.notEqual(text, goodRaw);
    assert.equal(settle(built, text).code, "INVALID_REPORT");
  }
  const claimSpan = JSON.parse(reportMapping(built)) as Record<string, unknown>;
  const claimRows = claimSpan.dimensions as Record<string, unknown>[];
  const claimQuote = [...built.artifact.packet!.claim].slice(0, 4).join("");
  const forged = JSON.stringify({
    ...claimSpan,
    dimensions: claimRows.map((row) => ({
      ...row,
      problemSpan: { start: 0, end: [...claimQuote].length, quote: claimQuote },
    })),
  });
  assert.notEqual(forged, goodRaw);
  assert.equal(settle(built, forged).code, "INVALID_REPORT");
});

test("session constructor rejects a mismatched target, plan or request", () => {
  const built = buildMapping();
  const plan = built.plan;
  const bad: readonly (() => unknown)[] = [
    () => new P4MappingReviewSession(built.contract, { ...built.target, targetHash: "0".repeat(64) }, plan, 1),
    () => new P4MappingReviewSession(built.contract, { ...built.target, availability: "STALE" }, plan, 1),
    () => session(built, { ...plan, checkId: "check-2" }),
    () => session(built, { ...plan, targetHash: "0".repeat(64) }),
    () => session(built, { ...plan, scope: { ...plan.scope, domain: "INTEGER" } }),
    () => session(built, { ...plan, assumptions: ["x!=0"] }),
    () => session(built, { ...plan, methodOrToolVersion: "tool-registry-v2" }),
    () => session(built, { ...plan, obligationIds: [] }),
    () => session(built, { ...plan, obligationIds: ["nope"] }),
    () => session(built, { ...plan, request: { ...plan.request, effectId: "effect-2" } }),
    () => session(built, { ...plan, request: { ...plan.request, binding: { ...plan.request.binding, sourceRequestId: "model-2" } } }),
    () => session(built, { ...plan, request: { ...plan.request, remainingMs: 25 } }),
    () => session(built, { ...plan, request: { ...plan.request, action: { ...polyAction(), name: "made_up_tool" } } }),
    () => session(built, { ...plan, request: { ...plan.request, action: { ...polyAction(), args: { expression: 1.5 } } } }),
    () => session(built, { ...plan, request: { ...plan.request, action: { ...polyAction(), args: { expression: "\ud800" } } } }),
    () => session(built, { ...plan, extra: true }),
  ];
  for (const fn of bad) {
    expectReject(fn);
  }
  const review = session(built);
  expectCode(() => review.admit(25), "BOUND_EXCEEDED");
  expectCode(() => review.admit(3600001), "BOUND_EXCEEDED");
  expectCode(() => review.settle("COMPLETE", reportMapping(built), 1000), "ILLEGAL_TRANSITION");
  const admitted = review.admit(26);
  assert.equal(admitted.state, "ADMITTED");
  assert.equal(admitted.code, "NOT_DISPATCHED");
  expectCode(() => review.admit(5000), "BUDGET_EXHAUSTED");
  expectCode(() => review.settle("COMPLETE", reportMapping(built), 1000), "ILLEGAL_TRANSITION");
  review.markDispatched();
  expectCode(() => review.markDispatched(), "ILLEGAL_TRANSITION");
  const settled = review.settle("COMPLETE", reportMapping(built), 1000);
  assert.equal(settled.code, "OK");
  expectCode(() => review.settle("COMPLETE", reportMapping(built), 1000), "ILLEGAL_TRANSITION");
  expectCode(() => new P4MappingReviewSession(built.contract, built.target, plan, 0).admit(5000), "BUDGET_EXHAUSTED");
});

test("transport, late and unknown outcomes keep the raw text and never retry", () => {
  const built = buildMapping();
  const good = reportMapping(built);
  for (const transport of ["COMPLETE", "TRUNCATED", "ERROR", "UNKNOWN"] as const) {
    for (const remaining of [0, 25, 26]) {
      const record = settle(built, good, transport, remaining);
      assert.equal(record.rawResponseText, good);
      assert.equal(record.checkResult, "UNKNOWN");
      assert.equal(record.canSupportObligation, false);
      if (transport === "UNKNOWN") {
        assert.equal(record.code, "OUTCOME_UNKNOWN");
        assert.equal(record.state, "OUTCOME_UNKNOWN");
        assert.equal(record.report, null);
      } else if (remaining <= 25) {
        assert.equal(record.code, "DEADLINE_EXCEEDED");
        assert.equal(record.report, null);
      } else if (transport !== "COMPLETE") {
        assert.equal(record.code, "TRANSPORT_INCOMPLETE");
        assert.equal(record.report, null);
      } else {
        assert.equal(record.code, "OK");
        assert.equal(record.report?.conclusion, "MATCH");
      }
      const review = session(built);
      review.admit(5000);
      review.markDispatched();
      review.settle(transport, good, remaining);
      expectCode(() => review.admit(5000), "BUDGET_EXHAUSTED");
      review.markStale();
      const snapshot = review.snapshot();
      assert.equal(snapshot.availability, "STALE");
      assert.equal(snapshot.record?.availability, "STALE");
      assert.equal(snapshot.record?.checkResult, "UNKNOWN");
      assert.equal(snapshot.record?.canSupportObligation, false);
      assert.equal(snapshot.targetHash, built.target.targetHash);
      assert.equal(snapshot.planHash, p4Hash(JSON.stringify(built.plan)));
    }
  }
});

test("diagnostic effect gate clips time, rejects forged receipts and never retries", () => {
  const built = buildMapping();
  const request = built.plan.request;
  const gate = new P4DiagnosticEffectGate(request, 1);
  const admitted = gate.admit(80);
  assert.equal(admitted.request.remainingMs, 80);
  assert.equal(admitted.code, "NOT_DISPATCHED");
  expectCode(() => gate.admit(80), "BUDGET_EXHAUSTED");
  gate.markDispatched();
  expectCode(() => gate.markDispatched(), "ILLEGAL_TRANSITION");
  const good = goodReceipt(admitted.request, JSON.stringify({ tool: "polynomial_expand_coefficients", result: {}, interpretation: "OBSERVATION_NOT_PROOF" }));
  expectReject(() => gate.settle({ ...good, observationHash: "0".repeat(64) }, 1000));
  assert.equal(gate.snapshot()?.state, "DISPATCHED");
  assert.equal(gate.snapshot()?.receipt, null);
  const unknown = gate.settle({ ...good, status: "UNKNOWN" } as P3EffectReceipt, 1000);
  assert.equal(unknown.code, "OUTCOME_UNKNOWN");
  assert.equal(unknown.state, "OUTCOME_UNKNOWN");
  expectCode(() => gate.admit(80), "BUDGET_EXHAUSTED");
  const late = new P4DiagnosticEffectGate(request, 1);
  late.admit(5000);
  late.markDispatched();
  assert.equal(late.settle(goodReceipt(late.snapshot()!.request, "{}"), 25).code, "DEADLINE_EXCEEDED");
  expectCode(() => new P4DiagnosticEffectGate(request, 0).admit(5000), "BUDGET_EXHAUSTED");
  expectCode(() => new P4DiagnosticEffectGate({ ...request, effectId: "effect-2" }, 1), "PACKET_BINDING");
});
