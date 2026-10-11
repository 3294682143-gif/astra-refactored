/**
 * P4 S2 recheck fixture boundary tests over real M1..M5 material. Pure
 * in-process: no client, no network, no tool execution, no mathematical
 * evaluation. Every clock here is a literal test callback.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { P2Error, type P2Artifact } from "@astra/protocol";
import { runP4RecheckFixture } from "../src/p4-recheck-fixture.js";
import type { P4FixtureReceipt } from "../src/p4-fixture.js";
import {
  RECHECK_PROBLEM,
  RECHECK_SESSION,
  buildRecheck,
  reportRecheck,
  type RecheckMaterial,
} from "./p4-recheck-fixtures.js";

function receiptsFor(material: RecheckMaterial): readonly P4FixtureReceipt[] {
  return [
    { transportStatus: "COMPLETE", text: material.parentRaw },
    { transportStatus: "COMPLETE", text: material.reviewRaw },
    { transportStatus: "COMPLETE", text: material.childRaw },
    { transportStatus: "COMPLETE", text: reportRecheck(material, "NO_ISSUE") },
  ];
}

function options(overrides: Record<string, unknown> = {}): {
  maxModelCalls?: number;
  maxRechecks?: number;
  maxRepairs: number;
  remainingMs: number;
  policy: "BEST_EFFORT" | "STRICT";
  now: () => number;
} {
  return {
    maxModelCalls: 4,
    maxRechecks: 1,
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
    ...overrides,
  };
}

function privateOf(result: unknown): Record<string, unknown> {
  return (result as { privateState: Record<string, unknown> }).privateState;
}

/** Count DISPATCHED/RETURNED/OUTCOME_UNKNOWN rows; ADMITTED is not a call. */
function dispatchedCount(gate: readonly { state: string }[]): number {
  return gate.filter((row) => row.state !== "ADMITTED").length;
}

test("a broken clock at any checkpoint permanently exhausts the root window", () => {
  const material = buildRecheck();
  const receipts = receiptsFor(material);

  for (const now of [
    () => Number.NaN,
    () => {
      throw new Error("PRIVATE_CLOCK_ERROR");
    },
  ]) {
    assert.throws(
      () => runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ now })),
      (error: unknown) =>
        error instanceof P2Error &&
        error.code === "DEADLINE_EXCEEDED" &&
        !error.message.includes("PRIVATE_CLOCK_ERROR"),
    );
  }

  let total = 0;
  const baseline = runP4RecheckFixture(
    RECHECK_PROBLEM,
    RECHECK_SESSION,
    receipts,
    options({
      now: () => {
        total += 1;
        return 0;
      },
    }),
  );
  assert.equal(baseline.summary.modelCalls, 4);
  assert.equal(baseline.summary.recheckCalls, 1);
  assert.ok(total >= 4);

  for (let index = 2; index <= total; index += 1) {
    for (const broken of ["NaN", "throw", "rewind"] as const) {
      let tick = 0;
      const now = (): number => {
        tick += 1;
        if (tick === index) {
          if (broken === "NaN") {
            return Number.NaN;
          }
          if (broken === "throw") {
            throw new Error("PRIVATE_CLOCK_ERROR");
          }
          return -1;
        }
        return 0;
      };
      const result = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ now }));
      assert.ok(result.summary.modelCalls <= 4);
      assert.ok(result.summary.recheckCalls <= 1);
      const privateState = privateOf(result);
      const gate = privateState.modelGate as readonly { state: string }[];
      assert.equal(dispatchedCount(gate), result.summary.modelCalls);
      assert.equal(result.summary.candidateVerified, false);
      assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
      const contract = privateState.contract as { obligations: readonly { status: string }[] };
      for (const obligation of contract.obligations) {
        assert.notEqual(obligation.status, "SATISFIED");
      }
      // A broken clock always exhausts the root window: the run is unsolved and
      // the parent answer is never emitted, even when the parent is protected.
      assert.equal(result.summary.status, "unsolved");
      if (result.summary.parentProtected) {
        const artifacts = privateState.artifacts as readonly { artifact: P2Artifact; availability: string }[];
        assert.equal(artifacts[0]!.artifact.artifactId, "artifact-1");
        assert.equal(artifacts[0]!.availability, "ACTIVE");
      }
      assert.equal(JSON.stringify(result.summary).includes("PRIVATE_CLOCK_ERROR"), false);
    }
  }

  // A raw UNKNOWN fourth transport outranks a later broken clock. The fourth
  // settle read is the last one before finish, so break the clock from there.
  let unknownTick = 0;
  const unknown = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, [
    receipts[0]!,
    receipts[1]!,
    receipts[2]!,
    { transportStatus: "UNKNOWN", text: reportRecheck(material, "NO_ISSUE") },
  ], options({
    now: () => {
      unknownTick += 1;
      return unknownTick >= total - 1 ? Number.NaN : 0;
    },
  }));
  assert.equal(unknown.summary.modelCalls, 4);
  assert.equal(unknown.summary.recheckCalls, 1);
  assert.equal(unknown.summary.recheckRecorded, false);
  const unknownRecheck = privateOf(unknown).recheck as {
    record: { code: string; state: string } | null;
  };
  assert.equal(unknownRecheck.record?.state, "OUTCOME_UNKNOWN");
  assert.equal(unknownRecheck.record?.code, "OUTCOME_UNKNOWN");
});

test("the fourth dispatch needs more than 25ms left and never restarts the root", () => {
  const material = buildRecheck();
  const receipts = receiptsFor(material);

  let total = 0;
  runP4RecheckFixture(
    RECHECK_PROBLEM,
    RECHECK_SESSION,
    receipts,
    options({
      now: () => {
        total += 1;
        return 0;
      },
    }),
  );
  assert.ok(total >= 4);
  // The last read is the finish() sample, the one before it is the fourth
  // settle read, so the pre-dispatch admission read is two before the end.
  const preDispatch = total - 2;

  const at = (value: number): (() => number) => {
    let tick = 0;
    return () => {
      tick += 1;
      return tick >= preDispatch ? value : 0;
    };
  };

  const late = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ now: at(4975) }));
  assert.equal(late.summary.recheckCalls, 0);
  assert.equal(late.summary.recheckRecorded, false);
  assert.equal(late.summary.recheckConclusion, "NONE");
  assert.equal(late.summary.parentProtected, true);
  const lateGate = privateOf(late).modelGate as readonly { state: string }[];
  assert.ok(lateGate.length <= 4);
  assert.equal(dispatchedCount(lateGate), late.summary.modelCalls);
  assert.equal(late.summary.modelCalls, 3);

  const timely = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ now: at(4974) }));
  assert.equal(timely.summary.modelCalls, 4);
  assert.equal(timely.summary.recheckCalls, 1);
  assert.equal(timely.summary.recheckRecorded, true);
  assert.equal(timely.summary.recheckConclusion, "NO_ISSUE");
  assert.equal(timely.summary.parentProtected, true);

  // A post-return 5000 read makes the fourth settle late, not a new window.
  let afterTick = 0;
  const after = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({
    now: () => {
      afterTick += 1;
      return afterTick >= total - 1 ? 5000 : 0;
    },
  }));
  assert.equal(after.summary.modelCalls, 4);
  assert.equal(after.summary.recheckCalls, 1);
  assert.equal(after.summary.recheckRecorded, false);
  assert.equal(after.summary.recheckConclusion, "NONE");
  assert.equal(after.summary.parentProtected, true);
  const afterRecheck = privateOf(after).recheck as { record: { code: string } | null };
  assert.equal(afterRecheck.record?.code, "DEADLINE_EXCEEDED");
});

test("captured options and receipts cannot be widened by a later clock callback", () => {
  const material = buildRecheck();
  const receipts = receiptsFor(material);

  const widened = options({
    maxModelCalls: 3,
    maxRechecks: 0,
    remainingMs: 100,
    now: () => 0,
  });
  widened.now = () => {
    widened.maxModelCalls = 4;
    widened.maxRechecks = 1;
    widened.remainingMs = 5000;
    return 0;
  };
  const capped = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, widened);
  assert.equal(capped.summary.modelCalls, 3);
  assert.equal(capped.summary.recheckCalls, 0);
  assert.equal(capped.summary.recheckConclusion, "NONE");
  assert.equal(capped.summary.stopReason, "REPAIR_RECORDED");

  const mutable: P4FixtureReceipt[] = [
    { transportStatus: "COMPLETE", text: material.parentRaw },
    { transportStatus: "COMPLETE", text: material.reviewRaw },
    { transportStatus: "COMPLETE", text: material.childRaw },
    { transportStatus: "COMPLETE", text: reportRecheck(material, "NO_ISSUE") },
  ];
  const full = options({
    now: () => {
      mutable[3] = { transportStatus: "COMPLETE", text: "{" };
      mutable[0] = { transportStatus: "COMPLETE", text: "{" };
      full.policy = "STRICT";
      return 0;
    },
  });
  const captured = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, mutable, full);
  assert.equal(captured.summary.modelCalls, 4);
  assert.equal(captured.summary.recheckCalls, 1);
  assert.equal(captured.summary.recheckRecorded, true);
  assert.equal(captured.summary.recheckConclusion, "NO_ISSUE");
  assert.equal(captured.summary.policy, "BEST_EFFORT");
  assert.equal(captured.summary.parentProtected, true);
  assert.equal(captured.summary.finalResponse, "x=1");

  let reads = 0;
  const getterOptions = {
    maxRepairs: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT" as const,
    now: () => 0,
    get maxModelCalls(): number {
      reads += 1;
      return 4;
    },
    get maxRechecks(): number {
      reads += 1;
      return 1;
    },
  };
  const getterResult = runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, getterOptions);
  assert.equal(getterResult.summary.modelCalls, 4);
  assert.equal(getterResult.summary.recheckCalls, 1);
  assert.equal(reads, 2);

  const rejected: readonly (() => unknown)[] = [
    () => runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ maxModelCalls: 5 })),
    () => runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, receipts, options({ maxRechecks: 2 })),
    () => runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, [
      receipts[0]!,
      receipts[1]!,
      receipts[2]!,
      { transportStatus: "COMPLETE", text: "x".repeat(65537) },
    ], options()),
    () => runP4RecheckFixture(RECHECK_PROBLEM, RECHECK_SESSION, [
      receipts[0]!,
      receipts[1]!,
      receipts[2]!,
      receipts[3]!,
      receipts[3]!,
    ], options()),
  ];
  for (const fn of rejected) {
    assert.throws(fn, (error: unknown) => error instanceof P2Error);
  }
});
