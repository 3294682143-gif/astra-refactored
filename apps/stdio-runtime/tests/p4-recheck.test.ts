import { test } from "node:test";
import assert from "node:assert/strict";
import { P2Error, p2Snapshot, p4Hash, p4JsonEqual } from "@astra/protocol";
import { parseP4RecheckReport } from "@astra/math-review";
import type { P4RecheckReport } from "@astra/protocol";
import {
  CHILD_DERIVATION,
  CHILD_QUOTE,
  PARENT_DERIVATION,
  RECHECK_PROBLEM,
  acceptedChild,
  buildRecheck,
  makeRecheck,
  reportRecheck,
  spanOf,
} from "./p4-recheck-fixtures.js";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function parse(material: ReturnType<typeof buildRecheck>, raw: string): P4RecheckReport {
  return parseP4RecheckReport(
    raw,
    material.contract,
    material.parent,
    material.child,
    material.parentReview,
    material.repair,
  );
}

test("S2 re-review accepts the real material and records one model-4 opinion", () => {
  const material = buildRecheck();
  const raw = reportRecheck(material);
  const report = parse(material, raw);
  assert.equal(report.schemaVersion, "p4-recheck-v1");
  assert.equal(report.requestId, "model-4");
  assert.equal(report.stage, "S2");
  assert.equal(report.conclusion, "NO_ISSUE");
  assert.equal(p4JsonEqual(report.parent, material.parent.binding), true);
  assert.equal(p4JsonEqual(report.child, material.child.binding), true);
  assert.equal(report.parentHash, material.parent.targetHash);
  assert.equal(report.childHash, material.child.targetHash);
  assert.equal(report.challengeId, material.challenge.challengeId);
  assert.deepEqual([...report.reviewCoverage], [...material.challenge.issue.obligationIds]);
  assert.deepEqual(report.checks.map((row) => row.dimension), ["ISSUE_RESPONSE", "PREMISES", "DEPENDENCIES"]);
  for (const row of report.checks) {
    assert.equal(row.verdict, "NO_ISSUE");
    const locator = row.childStepLocator;
    assert.ok(locator !== null);
    assert.equal(locator.quote, CHILD_QUOTE);
    assert.equal([...CHILD_DERIVATION].slice(locator.start, locator.end).join(""), CHILD_QUOTE);
  }

  const session = makeRecheck(material);
  session.admit(1000, 1);
  session.markDispatched();
  const record = session.settle("COMPLETE", raw, 1000);
  assert.equal(record.code, "OK");
  assert.equal(record.state, "RETURNED");
  assert.equal(record.rawResponseText, raw);
  assert.equal(record.level, "REVIEWED");
  assert.equal(record.checkResult, "UNKNOWN");
  assert.equal(record.canSupportObligation, false);
  assert.equal(record.canReplaceProtected, false);
  assert.equal(record.requiresSemanticRecheck, true);
  assert.equal(record.source, "MODEL_REVIEW");
  const serialized = JSON.stringify(record.context.messages);
  assert.equal(record.context.contextBytes, Buffer.byteLength(serialized, "utf8"));
  assert.equal(record.context.contextHash, p4Hash(serialized));
  assert.equal(record.context.messages.length, 2);
  assert.equal(record.context.messages[0]!.role, "system");
  const payload = JSON.parse(record.context.messages[1]!.content) as Record<string, unknown>;
  assert.equal(payload.problemFullText, RECHECK_PROBLEM);
  assert.equal(payload.parentDerivation, PARENT_DERIVATION);
  assert.equal(payload.childDerivation, CHILD_DERIVATION);
  assert.equal(payload.parentCandidate, "x=1");
  assert.equal(payload.childCandidate, "x=0 or x=1");
  assert.equal(payload.repairHash, record.repairHash);
  assert.equal((payload.challenge as Record<string, unknown>).challengeId, material.challenge.challengeId);
  assert.equal(serialized.includes("x=0 or x=1"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "verified"), false);

  const snapshot = session.snapshot();
  assert.equal(snapshot.availability, "ACTIVE");
  assert.equal(snapshot.record?.code, "OK");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.record), true);
  assert.equal(material.challenge.status, "CHALLENGED");
  assert.equal(material.challenge.availability, "ACTIVE");
  assert.equal(material.repair.record?.lineage?.requiresRecheck, true);
  assert.equal(material.repair.record?.lineage?.canReplaceProtected, false);
  assert.equal(material.repair.record?.lineage?.checkResult, "UNKNOWN");
  assert.equal(p4JsonEqual(material.parentReview, buildRecheck().parentReview), true);
});

test("S2 re-review records ISSUES and UNKNOWN opinions without promoting evidence", () => {
  const material = buildRecheck();
  const beforeChallenge = p2Snapshot(material.challenge);
  const beforeRepair = p2Snapshot(material.repair);
  const cases: readonly ["NO_ISSUE" | "ISSUES" | "UNKNOWN", "REVIEWED" | "PROVISIONAL"][] = [
    ["NO_ISSUE", "REVIEWED"],
    ["ISSUES", "REVIEWED"],
    ["UNKNOWN", "PROVISIONAL"],
  ];
  for (const [verdict, level] of cases) {
    const raw = reportRecheck(material, verdict);
    const report = parse(material, raw);
    assert.equal(report.conclusion, verdict);
    for (const row of report.checks) {
      assert.equal(row.verdict, verdict);
      if (verdict === "UNKNOWN") {
        assert.equal(row.childStepLocator, null);
      } else {
        assert.ok(row.childStepLocator !== null);
        assert.equal(row.childStepLocator.quote, CHILD_QUOTE);
      }
    }
    const session = makeRecheck(material);
    session.admit(1000, 1);
    session.markDispatched();
    const record = session.settle("COMPLETE", raw, 1000);
    assert.equal(record.code, "OK");
    assert.equal(record.report?.conclusion, verdict);
    assert.equal(record.level, level);
    assert.equal(record.checkResult, "UNKNOWN");
    assert.equal(record.canSupportObligation, false);
    assert.equal(record.canReplaceProtected, false);
    assert.equal(record.requiresSemanticRecheck, true);
    assert.equal(record.source, "MODEL_REVIEW");
    assert.equal(session.snapshot().record?.report?.conclusion, verdict);
  }
  assert.equal(p4JsonEqual(p2Snapshot(material.challenge), beforeChallenge), true);
  assert.equal(p4JsonEqual(p2Snapshot(material.repair), beforeRepair), true);
  assert.equal(material.challenge.status, "CHALLENGED");
  assert.equal(material.challenge.availability, "ACTIVE");
  assert.equal(material.repair.record?.lineage?.requiresRecheck, true);
  assert.equal(material.repair.record?.lineage?.canReplaceProtected, false);
});

test("S2 re-review parser rejects malformed reports and the session keeps DISPATCHED", () => {
  const material = buildRecheck();
  const good = reportRecheck(material);
  const base = JSON.parse(good) as Record<string, unknown>;
  const mutate = (changes: Record<string, unknown>): string =>
    JSON.stringify({ ...base, ...changes });
  const rows = base.checks as readonly Record<string, unknown>[];
  const withRows = (next: readonly Record<string, unknown>[]): string =>
    JSON.stringify({ ...base, checks: next });

  const bad: readonly string[] = [
    mutate({ parent: { ...material.parent.binding, taskId: "other" } }),
    mutate({ child: { ...material.child.binding, artifactId: "artifact-1" } }),
    mutate({ parentHash: "0".repeat(64) }),
    mutate({ childHash: "0".repeat(64) }),
    mutate({ stage: "S1" }),
    mutate({ requestId: "model-2" }),
    mutate({ challengeId: "challenge-2" }),
    mutate({ repairHash: "0".repeat(64) }),
    mutate({ reviewCoverage: [] }),
    mutate({ reviewCoverage: [...material.challenge.issue.obligationIds, "extra"] }),
    withRows([rows[0]!, rows[0]!, rows[2]!]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, dimension: "OTHER" }]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, verdict: "UNKNOWN" }]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, childStepLocator: null }]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, childStepLocator: spanOf(PARENT_DERIVATION, "Divide by x.") }]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, childStepLocator: { start: 0, end: 1, quote: "x" } }]),
    withRows([rows[0]!, rows[1]!, { ...rows[2]!, rationale: "   " }]),
    mutate({ extra: 1 }),
    good.replace('"stage":"S2"', '"stage":"S2","stage":"S2"'),
    good.replace('"conclusion":"NO_ISSUE"', '"conclusion":1.5'),
    good.replace('"conclusion":"NO_ISSUE"', '"conclusion":9007199254740993'),
    good.replace('"conclusion":"NO_ISSUE"', '"conclusion":"NO_ISSUE\\ud800"'),
    `${"[".repeat(40)}${good}`,
  ];
  for (const raw of bad) {
    assert.notEqual(raw, good);
    assert.throws(() => parse(material, raw), (error: unknown) => error instanceof P2Error);
  }

  const session = makeRecheck(material);
  session.admit(1000, 1);
  session.markDispatched();
  const record = session.settle("COMPLETE", bad[0]!, 1000);
  assert.equal(record.code, "INVALID_REPORT");
  assert.equal(record.report, null);
  assert.equal(record.rawResponseText, bad[0]);
  assert.equal(record.state, "RETURNED");
  assert.equal(record.level, "PROVISIONAL");
  assert.equal(record.checkResult, "UNKNOWN");
  assert.equal(record.canSupportObligation, false);
  assert.equal(record.canReplaceProtected, false);
  assert.equal(record.requiresSemanticRecheck, true);
  expectCode(() => session.admit(1000, 1), "BUDGET_EXHAUSTED");
});

test("S2 re-review budget, root calls, lateness and staleness are bounded", () => {
  const material = buildRecheck();
  const raw = reportRecheck(material);
  expectCode(() => makeRecheck(material, 0).admit(1000, 1), "BUDGET_EXHAUSTED");
  expectCode(() => makeRecheck(material).admit(1000, 0), "BUDGET_EXHAUSTED");
  expectCode(() => makeRecheck(material).admit(1000, 2), "BOUND_EXCEEDED");
  expectCode(() => makeRecheck(material).admit(1000, true as unknown as number), "BOUND_EXCEEDED");
  expectCode(() => makeRecheck(material).admit(1000, Number.NaN), "BOUND_EXCEEDED");
  expectCode(() => makeRecheck(material).admit(25, 1), "BOUND_EXCEEDED");
  const bounds = makeRecheck(material);
  assert.equal(bounds.admit(26, 1).state, "ADMITTED");
  assert.equal(bounds.snapshot().record?.state, "ADMITTED");
  expectCode(() => bounds.settle("COMPLETE", raw, 1000), "ILLEGAL_TRANSITION");
  expectCode(() => bounds.markStale(), "ILLEGAL_TRANSITION");
  assert.equal(bounds.snapshot().availability, "ACTIVE");
  assert.equal(bounds.snapshot().record?.state, "ADMITTED");
  bounds.markDispatched();
  assert.equal(bounds.settle("COMPLETE", raw, 1000).code, "OK");
  expectCode(() => bounds.admit(1000, 1), "BUDGET_EXHAUSTED");
  expectCode(() => bounds.markDispatched(), "ILLEGAL_TRANSITION");

  const stale = makeRecheck(material);
  stale.admit(1000, 1);
  stale.markDispatched();
  const recorded = stale.settle("COMPLETE", raw, 1000);
  stale.markStale();
  const snapshot = stale.snapshot();
  assert.equal(snapshot.availability, "STALE");
  assert.equal(snapshot.record?.rawResponseText, raw);
  assert.equal(snapshot.record?.code, "OK");
  assert.equal(snapshot.record?.availability, "STALE");
  assert.equal(snapshot.record?.checkResult, "UNKNOWN");
  assert.equal(snapshot.record?.canReplaceProtected, false);
  assert.equal(snapshot.record?.requiresSemanticRecheck, true);
  assert.equal(recorded.report?.conclusion, "NO_ISSUE");
  expectCode(() => stale.admit(1000, 1), "BUDGET_EXHAUSTED");

  const fresh = makeRecheck(material);
  fresh.markStale();
  assert.equal(fresh.snapshot().availability, "STALE");
  assert.equal(fresh.snapshot().record, null);
  expectCode(() => fresh.admit(1000, 1), "STALE_DEPENDENCY");
});

test("S2 re-review transport, lateness and physical raw bounds never refute", () => {
  const material = buildRecheck();
  const raw = reportRecheck(material);
  const cases: readonly ["COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN", number, string][] = [
    ["TRUNCATED", 1000, "TRANSPORT_INCOMPLETE"],
    ["ERROR", 1000, "TRANSPORT_INCOMPLETE"],
    ["COMPLETE", 0, "DEADLINE_EXCEEDED"],
    ["COMPLETE", 25, "DEADLINE_EXCEEDED"],
    ["UNKNOWN", 0, "OUTCOME_UNKNOWN"],
    ["UNKNOWN", 25, "OUTCOME_UNKNOWN"],
    ["UNKNOWN", 1000, "OUTCOME_UNKNOWN"],
  ];
  for (const [transport, remaining, code] of cases) {
    const session = makeRecheck(material);
    session.admit(1000, 1);
    session.markDispatched();
    const record = session.settle(transport, raw, remaining);
    assert.equal(record.code, code);
    assert.equal(record.report, null);
    assert.equal(record.rawResponseText, raw);
    assert.equal(record.transportStatus, transport);
    assert.equal(record.checkResult, "UNKNOWN");
    assert.equal(record.canSupportObligation, false);
    assert.equal(record.canReplaceProtected, false);
    assert.equal(record.requiresSemanticRecheck, true);
    assert.equal(record.level, "PROVISIONAL");
    expectCode(() => session.admit(1000, 1), "BUDGET_EXHAUSTED");
  }
  const late = makeRecheck(material);
  late.admit(1000, 1);
  late.markDispatched();
  assert.equal(late.settle("COMPLETE", raw, 26).code, "OK");

  const physical = makeRecheck(material);
  physical.admit(1000, 1);
  physical.markDispatched();
  expectCode(() => physical.settle("COMPLETE", "\ud800", 1000), "PACKET_SCHEMA");
  expectCode(() => physical.settle("COMPLETE", "x".repeat(65537), 1000), "BOUND_EXCEEDED");
  assert.equal(physical.snapshot().record?.state, "DISPATCHED");
  assert.equal(physical.snapshot().record?.rawResponseText, null);
  assert.equal(physical.snapshot().record?.report, null);
  assert.equal(physical.snapshot().record?.code, "NOT_DISPATCHED");

  const variant = acceptedChild(material, { claim: "x=1 only" });
  assert.equal(variant.child.binding.artifactId, "repair-1");
  assert.equal(variant.child.binding.sourceRequestId, "model-3");
  assert.equal(p4JsonEqual(p2Snapshot(material.child.binding), material.child.binding), true);
  assert.equal(spanOf(CHILD_DERIVATION, CHILD_QUOTE).quote, CHILD_QUOTE);
});
