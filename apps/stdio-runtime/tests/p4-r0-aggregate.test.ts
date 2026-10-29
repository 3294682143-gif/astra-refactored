/**
 * P4 R0 controller aggregation — the pure truth table of the three independent
 * role reviews. Every case is built from real role-scoped review sessions; no
 * fabricated verdict and no model text ever enters the aggregate.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { P4R0ReviewSession, aggregateP4R0Reviews, roleVerdictOf } from "@astra/math-review";
import { P2Error, type P4R0Preparation, type P4R0ReviewSnapshot, type P4R0Role, type P4R0Verdict } from "@astra/protocol";

import { makeR0, r0Report } from "./p4-r0-fixtures.js";

const ROLES = ["MEANING", "METHOD", "TASK_TOOL"] as const;

function rejects(run: () => void, code: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof P2Error && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

/** One settled role snapshot from a real session; the reply is a fixture. */
function settled(
  prep: P4R0Preparation,
  role: P4R0Role,
  verdict: P4R0Verdict,
  requestId = "model-1",
): P4R0ReviewSnapshot {
  const session = new P4R0ReviewSession(prep);
  session.admit(role, requestId, 1000, 5);
  session.markDispatched(role);
  session.settle(role, "COMPLETE", r0Report(prep, verdict, role, requestId), 900);
  return session.snapshot(role);
}

/** One settled role snapshot whose reply was unusable (non-OK code). */
function unusable(prep: P4R0Preparation, role: P4R0Role): P4R0ReviewSnapshot {
  const session = new P4R0ReviewSession(prep);
  session.admit(role, "model-1", 1000, 5);
  session.markDispatched(role);
  session.settle(role, "COMPLETE", "not json", 900);
  return session.snapshot(role);
}

test("group 1: ISSUES dominates the aggregate", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const aggregate = aggregateP4R0Reviews([
    settled(prep, "MEANING", "ISSUES", "model-1"),
    settled(prep, "METHOD", "NO_ISSUE", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(aggregate.conclusion, "ISSUES");
  assert.deepEqual(aggregate.issueDimensions, ["PROBLEM_ALIGNMENT"]);
  // Only the roles whose own verdict differs from the aggregate are listed,
  // bounded and ordered by the fixed role vocabulary.
  assert.deepEqual(aggregate.dissents, [
    { role: "METHOD", dimension: "SCOPE", verdict: "NO_ISSUE" },
    { role: "TASK_TOOL", dimension: "TASK_COVERAGE", verdict: "NO_ISSUE" },
  ]);
  assert.deepEqual(aggregate.coverage.roles, ["MEANING", "METHOD", "TASK_TOOL"]);
  assert.deepEqual(aggregate.coverage.missing, []);
  assert.deepEqual(aggregate.coverage.dimensions, ["PROBLEM_ALIGNMENT", "SCOPE", "TASK_COVERAGE"]);

  const twoIssues = aggregateP4R0Reviews([
    settled(prep, "MEANING", "NO_ISSUE", "model-1"),
    settled(prep, "METHOD", "ISSUES", "model-2"),
    settled(prep, "TASK_TOOL", "ISSUES", "model-3"),
  ]);
  assert.equal(twoIssues.conclusion, "ISSUES");
  assert.deepEqual(twoIssues.issueDimensions, ["SCOPE", "TASK_COVERAGE"]);
  assert.deepEqual(twoIssues.dissents, [
    { role: "MEANING", dimension: "PROBLEM_ALIGNMENT", verdict: "NO_ISSUE" },
  ]);
  // ISSUES still dominates an UNKNOWN role.
  const mixed = aggregateP4R0Reviews([
    settled(prep, "MEANING", "UNKNOWN", "model-1"),
    settled(prep, "METHOD", "ISSUES", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(mixed.conclusion, "ISSUES");
  assert.deepEqual(mixed.issueDimensions, ["SCOPE"]);
  assert.deepEqual(mixed.dissents, [
    { role: "MEANING", dimension: "PROBLEM_ALIGNMENT", verdict: "UNKNOWN" },
    { role: "TASK_TOOL", dimension: "TASK_COVERAGE", verdict: "NO_ISSUE" },
  ]);
});

test("group 2: UNKNOWN outranks NO_ISSUE but never ISSUES", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const aggregate = aggregateP4R0Reviews([
    settled(prep, "MEANING", "NO_ISSUE", "model-1"),
    settled(prep, "METHOD", "UNKNOWN", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(aggregate.conclusion, "UNKNOWN");
  assert.deepEqual(aggregate.issueDimensions, []);
  // The role that produced the UNKNOWN aggregate is not a dissent: only the
  // roles whose own verdict differs from the aggregate are listed.
  assert.deepEqual(aggregate.dissents, [
    { role: "MEANING", dimension: "PROBLEM_ALIGNMENT", verdict: "NO_ISSUE" },
    { role: "TASK_TOOL", dimension: "TASK_COVERAGE", verdict: "NO_ISSUE" },
  ]);
  // An unusable reply is an UNKNOWN verdict, never a silent NO_ISSUE.
  const unusableMethod = unusable(prep, "METHOD");
  assert.equal(unusableMethod.record!.code, "INVALID_REPORT");
  assert.equal(roleVerdictOf(unusableMethod), "UNKNOWN");
  const withGarbage = aggregateP4R0Reviews([
    settled(prep, "MEANING", "NO_ISSUE", "model-1"),
    unusableMethod,
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(withGarbage.conclusion, "UNKNOWN");
  assert.deepEqual(withGarbage.coverage.missing, []);
});

test("group 3: all three NO_ISSUE is the only NO_ISSUE aggregate", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const aggregate = aggregateP4R0Reviews([
    settled(prep, "MEANING", "NO_ISSUE", "model-1"),
    settled(prep, "METHOD", "NO_ISSUE", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(aggregate.conclusion, "NO_ISSUE");
  assert.equal(aggregate.issueDimensions.length, 0);
  assert.equal(aggregate.dissents.length, 0);
  assert.deepEqual(aggregate.coverage.missing, []);
});

test("group 4: one missing role is reported, never ignored", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const partial = aggregateP4R0Reviews([
    settled(prep, "MEANING", "NO_ISSUE", "model-1"),
    settled(prep, "METHOD", "NO_ISSUE", "model-2"),
  ]);
  assert.equal(partial.conclusion, "UNKNOWN");
  assert.deepEqual(partial.coverage.missing, ["TASK_TOOL"]);
  assert.deepEqual(partial.coverage.roles, ["MEANING", "METHOD"]);
  assert.deepEqual(partial.coverage.dimensions, ["PROBLEM_ALIGNMENT", "SCOPE"]);
  // The missing role is a coverage entry, never a dissent row.
  for (const dissent of partial.dissents) {
    assert.notEqual(dissent.role, "TASK_TOOL");
  }
  // Even an ISSUES role cannot carry an incomplete aggregate.
  const issuesAndMissing = aggregateP4R0Reviews([
    settled(prep, "MEANING", "ISSUES", "model-1"),
    settled(prep, "METHOD", "NO_ISSUE", "model-2"),
  ]);
  assert.equal(issuesAndMissing.conclusion, "UNKNOWN");
  assert.deepEqual(issuesAndMissing.issueDimensions, ["PROBLEM_ALIGNMENT"]);
  assert.deepEqual(issuesAndMissing.coverage.missing, ["TASK_TOOL"]);
  // No snapshot at all is UNKNOWN with every role missing.
  const empty = aggregateP4R0Reviews([]);
  assert.equal(empty.conclusion, "UNKNOWN");
  assert.deepEqual(empty.coverage.roles, []);
  assert.deepEqual(empty.coverage.missing, [...ROLES]);
  assert.deepEqual(empty.dissents, []);
});

test("group 5: an unsettled record counts as missing, not as a verdict", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const session = new P4R0ReviewSession(prep);
  session.admit("MEANING", "model-1", 1000, 5);
  const admitted = session.snapshot("MEANING");
  const aggregate = aggregateP4R0Reviews([
    admitted,
    settled(prep, "METHOD", "NO_ISSUE", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(aggregate.conclusion, "UNKNOWN");
  assert.deepEqual(aggregate.coverage.missing, ["MEANING"]);
});

test("group 6: duplicate and forged snapshots are refused", () => {
  const prep = makeR0("ALL_SOLUTIONS");
  const meaning = settled(prep, "MEANING", "NO_ISSUE", "model-1");
  rejects(() => aggregateP4R0Reviews([meaning, meaning]), "PACKET_BINDING");
  rejects(
    () =>
      aggregateP4R0Reviews([
        { ...meaning, role: "OTHER" } as never,
      ]),
    "PACKET_SCHEMA",
  );
  rejects(() => aggregateP4R0Reviews(null as never), "PACKET_SCHEMA");
  // A record whose role does not match its snapshot can never be aggregated.
  const forged = { ...meaning, role: "METHOD" } as P4R0ReviewSnapshot;
  rejects(() => aggregateP4R0Reviews([forged]), "PACKET_BINDING");
  // The aggregate never carries raw model text: only enum verdicts and ids.
  const aggregate = aggregateP4R0Reviews([
    meaning,
    settled(prep, "METHOD", "ISSUES", "model-2"),
    settled(prep, "TASK_TOOL", "NO_ISSUE", "model-3"),
  ]);
  assert.equal(JSON.stringify(aggregate).includes("fixture"), false);
  assert.equal(JSON.stringify(aggregate).includes("rationale"), false);
});
