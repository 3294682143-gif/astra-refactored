import test from "node:test";
import assert from "node:assert/strict";

import { compileP2Contract, prepareP4R0 } from "@astra/math-contract";
import { parseP4R0RecheckReport } from "@astra/math-review";
import { P2Error, p4Hash, type P4R0Preparation, type P4R0Verdict } from "@astra/protocol";

import { codepointSpan, leavesOf } from "./p4-r0-revision-fixtures.js";
import {
  makeRecheck,
  recheckRawOf,
  recheckReport,
  type Mutable,
} from "./p4-r0-recheck-fixtures.js";

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

test("group 1: three conclusions parse, freeze and derive from checks", () => {
  const { preparation } = makeRecheck();
  for (const verdict of ["NO_ISSUE", "ISSUES", "UNKNOWN"] as const) {
    const report = parseP4R0RecheckReport(recheckReport(preparation, verdict), preparation);
    assert.equal(report.conclusion, verdict);
    assert.equal(report.requestId, "model-3");
    assert.equal(report.stage, "R0_RECHECK");
    assert.equal(report.schemaVersion, "p4-r0-recheck-v1");
    assert.deepEqual(report.parent, preparation.parent);
    assert.deepEqual(report.target, preparation.target.binding);
    assert.equal(report.reviewHash, preparation.reviewHash);
    assert.equal(report.revisionHash, preparation.revisionHash);
    assert.deepEqual(
      report.reviewCoverage,
      preparation.target.contract.obligations.map((item) => item.obligationId),
    );
    assert.equal(report.checks.length, 3);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.checks), true);
    assert.equal(Object.isFrozen(report.checks[0]), true);
    assert.equal(Object.isFrozen(report.reviewCoverage), true);
  }
  const mixed = recheckRawOf(preparation, (report) => {
    const checks = report.checks as Record<string, unknown>[];
    checks[0]!.verdict = "ISSUES";
    checks[1]!.verdict = "NO_ISSUE";
    checks[2]!.verdict = "UNKNOWN";
    checks[2]!.problemSpan = null;
    checks[2]!.planSpan = null;
    report.conclusion = "ISSUES";
  });
  assert.equal(parseP4R0RecheckReport(mixed, preparation).conclusion, "ISSUES");
  const allNoIssue = recheckRawOf(preparation, (report) => {
    const checks = report.checks as Record<string, unknown>[];
    checks[0]!.verdict = "NO_ISSUE";
    checks[1]!.verdict = "NO_ISSUE";
    checks[2]!.verdict = "NO_ISSUE";
    report.conclusion = "NO_ISSUE";
  });
  assert.equal(parseP4R0RecheckReport(allNoIssue, preparation).conclusion, "NO_ISSUE");
  const elseUnknown = recheckRawOf(preparation, (report) => {
    const checks = report.checks as Record<string, unknown>[];
    checks[0]!.verdict = "NO_ISSUE";
    checks[1]!.verdict = "NO_ISSUE";
    checks[2]!.verdict = "UNKNOWN";
    checks[2]!.problemSpan = null;
    checks[2]!.planSpan = null;
    report.conclusion = "UNKNOWN";
  });
  assert.equal(parseP4R0RecheckReport(elseUnknown, preparation).conclusion, "UNKNOWN");
  const emptySpan = recheckRawOf(preparation, (report) => {
    const checks = report.checks as Record<string, unknown>[];
    checks[0]!.problemSpan = null;
  });
  assert.throws(() => parseP4R0RecheckReport(emptySpan, preparation), P2Error);
  const nullOk = recheckRawOf(
    preparation,
    (report) => {
      const checks = report.checks as Record<string, unknown>[];
      checks[0]!.problemSpan = null;
      checks[0]!.planSpan = null;
    },
    "UNKNOWN",
  );
  assert.equal(parseP4R0RecheckReport(nullOk, preparation).conclusion, "UNKNOWN");
});

test("group 2: row and envelope mutations are rejected", () => {
  const { preparation } = makeRecheck();
  const good = recheckReport(preparation);
  const bad: readonly string[] = [
    recheckRawOf(preparation, (report) => {
      report.schemaVersion = "p4-r0-review-v1";
    }),
    recheckRawOf(preparation, (report) => {
      report.requestId = "model-1";
    }),
    recheckRawOf(preparation, (report) => {
      report.stage = "R0";
    }),
    recheckRawOf(preparation, (report) => {
      (report.parent as Record<string, unknown>).sessionId = "other";
    }),
    recheckRawOf(preparation, (report) => {
      (report.target as Record<string, unknown>).planHash = "0".repeat(64);
    }),
    recheckRawOf(preparation, (report) => {
      report.reviewHash = "0".repeat(64);
    }),
    recheckRawOf(preparation, (report) => {
      report.revisionHash = "0".repeat(64);
    }),
    recheckRawOf(preparation, (report) => {
      report.extra = 1;
    }),
    recheckRawOf(preparation, (report) => {
      delete report.revisionHash;
    }),
    recheckRawOf(preparation, (report) => {
      const coverage = report.reviewCoverage as string[];
      report.reviewCoverage = [coverage[1]!, coverage[0]!, ...coverage.slice(2)];
    }),
    recheckRawOf(preparation, (report) => {
      report.reviewCoverage = preparation.revision.parentContract.obligations.map(
        (item) => item.obligationId,
      );
    }),
    recheckRawOf(preparation, (report) => {
      const checks = report.checks as Record<string, unknown>[];
      report.checks = [checks[0]!, checks[0]!, checks[2]!];
    }),
    recheckRawOf(preparation, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.dimension = "OTHER";
    }),
    recheckRawOf(preparation, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.verdict = "MAYBE";
    }),
    recheckRawOf(preparation, (report) => {
      report.conclusion = "ISSUES";
    }),
    recheckRawOf(preparation, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.rationale = "x".repeat(2049);
    }),
    recheckRawOf(preparation, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.rationale = "   ";
    }),
    recheckRawOf(preparation, (report) => {
      const span = (report.checks as Record<string, unknown>[])[0]!.planSpan as Record<string, unknown>;
      span.extra = 1;
    }),
    recheckRawOf(preparation, (report) => {
      (report.checks as Record<string, unknown>[])[0]!.planSpan = null;
    }),
    recheckRawOf(preparation, (report) => {
      const span = (report.checks as Record<string, unknown>[])[0]!.planSpan as Record<string, unknown>;
      span.quote = "{}";
    }),
    recheckRawOf(preparation, (report) => {
      const span = (report.checks as Record<string, unknown>[])[0]!.planSpan as Record<string, unknown>;
      span.start = (span.start as number) + 1;
    }),
    recheckRawOf(preparation, (report) => {
      const span = (report.checks as Record<string, unknown>[])[0]!.problemSpan as Record<string, unknown>;
      span.start = 0;
      span.end = 2;
      span.quote = [...preparation.target.contract.problemFullText].slice(0, 1).join("");
    }),
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(() => parseP4R0RecheckReport(text, preparation), P2Error);
  }
  assert.equal(parseP4R0RecheckReport(good, preparation).conclusion, "NO_ISSUE");
});

test("group 3: strict raw guards and the 20000 codepoint boundary", () => {
  const { preparation } = makeRecheck();
  const good = recheckReport(preparation);
  const bad: readonly string[] = [
    good.replace('"requestId":"model-3"', '"requestId":"model-3","requestId":"model-3"'),
    good.replace('"conclusion":"NO_ISSUE"', '"conclusion":1e400'),
    good.replace('"start":0', '"start":9007199254740992'),
    good.replace('"start":0', '"start":0.5'),
    good.replace("fixture recheck", "\\ud800"),
    good.replace("fixture recheck", "\ud800"),
    good + " trailing",
    good.slice(0, good.length - 1),
    "[" + "[".repeat(25) + "]" + "]".repeat(25),
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    assert.throws(() => parseP4R0RecheckReport(text, preparation), P2Error);
  }
  const padded = good + " ".repeat(20000 - [...good].length);
  assert.equal([...padded].length, 20000);
  assert.equal(parseP4R0RecheckReport(padded, preparation).conclusion, "NO_ISSUE");
  const over = padded + " ";
  assert.equal([...over].length, 20001);
  assert.throws(() => parseP4R0RecheckReport(over, preparation), P2Error);
  const byteOver = good + "😀".repeat(17000);
  assert.equal([...byteOver].length <= 20000, true);
  assert.equal(Buffer.byteLength(byteOver, "utf8") > 65536, true);
  assert.throws(() => parseP4R0RecheckReport(byteOver, preparation), P2Error);
});

test("group 4: real child leaf spans use codepoints, not UTF-16 offsets", () => {
  const problem = "😀 Find all real solutions x(x-1)=0";
  const base = compileP2Contract(problem, "r0");
  const scope = {
    ...base.goals[0]!.scope,
    localAssumptions: ["😀 assumption"],
  };
  const contract = compileP2Contract(problem, "r0", [
    {
      goalId: "goal-1",
      kind: "MULTIPART",
      scope,
      subgoals: [
        { goalId: "a", kind: "VALUE", scope, subgoals: [] },
        { goalId: "b", kind: "VALUE", scope, subgoals: [] },
      ],
    },
  ]);
  const original: P4R0Preparation = prepareP4R0(contract, {
    enabled: true,
    planningModelCalls: 1,
    remainingRootCalls: 5,
    remainingMs: 1000,
  });
  const { preparation } = makeRecheck({}, original);
  const child = preparation.target.contract;
  assert.deepEqual(child.goals[0]!.scope.localAssumptions, ["😀 assumption"]);
  const second = leavesOf(child.goals)[1]!;
  assert.equal(second.goalId, "b");
  const goalJson = JSON.stringify(second);
  const span = codepointSpan(preparation.target.planText, goalJson);
  assert.notEqual(preparation.target.planText.indexOf(goalJson), span.start);
  const raw = recheckRawOf(preparation, (report) => {
    for (const item of report.checks as Record<string, unknown>[]) {
      item.planSpan = span;
    }
  });
  assert.equal(parseP4R0RecheckReport(raw, preparation).conclusion, "NO_ISSUE");
  const wrong = recheckRawOf(preparation, (report) => {
    for (const item of report.checks as Record<string, unknown>[]) {
      item.planSpan = { ...span, start: preparation.target.planText.indexOf(goalJson) };
    }
  });
  assert.throws(() => parseP4R0RecheckReport(wrong, preparation), P2Error);
  const verdicts: readonly P4R0Verdict[] = ["NO_ISSUE", "ISSUES", "UNKNOWN"];
  for (const verdict of verdicts) {
    const text = recheckReport(preparation, verdict);
    assert.equal(parseP4R0RecheckReport(text, preparation).conclusion, verdict);
  }
  const tampered = clone(preparation);
  tampered.target.contract.goals[0]!.scope.localAssumptions = [];
  assert.throws(() => parseP4R0RecheckReport(recheckReport(preparation), tampered as never), P2Error);
  assert.equal(p4Hash(JSON.stringify(child)), preparation.target.binding.planHash);
});
