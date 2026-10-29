import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runP4MappingFixture } from "../src/p4-mapping-fixture.js";
import { P2Error } from "@astra/protocol";
import {
  MAPPING_PROBLEM,
  buildMapping,
  polyAction,
  reportMapping,
} from "./p4-mapping-fixtures.js";
import type { P3Action, P3EffectPort, P3EffectReceipt, P3EffectRequest } from "@astra/protocol";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PROBLEM = MAPPING_PROBLEM;
const LINEAR = {
  action: "tool",
  name: "linear_system_solution_set",
  args: { matrix: [["1", "1"], ["1", "-1"]], rhs: ["3", "1"], variables: ["x", "y"], domain: "RATIONAL" },
  scope: "solve",
} as const;

function realPort(): P3EffectPort {
  return {
    execute(request: P3EffectRequest): P3EffectReceipt {
      const result = spawnSync("python", ["-m", "python.astra_bridge.p3_effects"], {
        input: JSON.stringify(request),
        cwd: REPO_ROOT,
        timeout: 5000,
        maxBuffer: 65536,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout.toString("utf8")) as P3EffectReceipt;
    },
  };
}

function run(
  action: Extract<P3Action, { action: "tool" }>,
  review: string,
  options: Record<string, unknown> = {},
) {
  const built = buildMapping(action);
  return runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    action,
    realPort(),
    {
      maxModelCalls: 2,
      maxChecks: 1,
      remainingMs: 5000,
      policy: "BEST_EFFORT",
      now: () => 0,
      ...options,
    } as never,
  );
}

test("real operators run end to end only after a full MATCH review", () => {
  const cases: readonly [string, Extract<P3Action, { action: "tool" }>][] = [
    ["poly", polyAction()],
    ["linear", LINEAR as unknown as Extract<P3Action, { action: "tool" }>],
  ];
  for (const [label, action] of cases) {
    const built = buildMapping(action);
    const result = run(action, reportMapping(built));
    assert.equal(result.summary.modelCalls, 2, label);
    assert.equal(result.summary.checkCalls, 1, label);
    assert.equal(result.summary.mappingConclusion, "MATCH", label);
    assert.equal(result.summary.candidateVerified, false, label);
    assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED", label);
    assert.equal(result.summary.targetEnvironment, "TARGET_UNVERIFIED", label);
    assert.equal(result.summary.finalResponse, "x=1", label);
    assert.equal(result.summary.parentProtected, true, label);
    const record = result.privateState.diagnostic![0]!;
    assert.equal(record.code, "OBSERVED", label);
    assert.equal(result.privateState.effectGate?.code, "OBSERVED", label);
    assert.equal(record.evidence?.canSupportObligation, false, label);
    assert.equal(record.evidence?.checkResult, "UNKNOWN", label);
    assert.equal(record.evidence?.semanticMapping, "UNKNOWN", label);
    const observation = JSON.parse(record.receipt!.observation) as Record<string, unknown>;
    assert.equal(observation.interpretation, "OBSERVATION_NOT_PROOF", label);
    if (label === "poly") {
      const terms = (observation.result as Record<string, unknown>).terms as readonly Record<string, unknown>[];
      assert.deepEqual(terms.map((term) => term.powers), [[1], [2]], label);
      assert.deepEqual(
        terms.map((term) => {
          const coefficient = (term.coefficient as readonly Record<string, unknown>[])[0]!;
          return coefficient.coefficient;
        }),
        ["-1", "1"],
        label,
      );
    } else {
      assert.deepEqual(
        (observation.result as Record<string, unknown>).particular,
        ["2", "1"],
        label,
      );
    }
    assert.equal(result.privateState.mapping?.record?.level, "REVIEWED", label);
    assert.equal(result.privateState.mapping?.record?.checkResult, "UNKNOWN", label);
    assert.equal(result.privateState.mapping?.record?.canSupportObligation, false, label);
    assert.equal(
      result.privateState.contract.obligations.every((row) => row.status !== "SATISFIED"),
      true,
      label,
    );
    assert.equal(
      result.privateState.requests.some(
        (row) => (row as Record<string, unknown>).requestId === "effect-1",
      ),
      true,
      label,
    );
    const publicText = JSON.stringify(result.summary);
    assert.equal(publicText.includes(PROBLEM), false, label);
    assert.equal(publicText.includes("Divide by x"), false, label);
    assert.equal(publicText.includes("OBSERVATION_NOT_PROOF"), false, label);
    assert.equal(
      JSON.stringify(result.privateState.mapping?.record?.context).includes(PROBLEM),
      true,
      label,
    );
  }
});

test("non-MATCH, malformed and incomplete reviews never execute the port", () => {
  const built = buildMapping();
  const good = JSON.parse(reportMapping(built)) as Record<string, unknown>;
  const rows = good.dimensions as Record<string, unknown>[];
  const cases: readonly [string, string][] = [
    ["MISMATCH", reportMapping(built, "MISMATCH")],
    ["UNKNOWN", reportMapping(built, "UNKNOWN")],
    ["MALFORMED", "{"],
    ["TRUNCATED", reportMapping(built)],
    ["ERROR", reportMapping(built)],
    ["UNKNOWN_TRANSPORT", reportMapping(built)],
    ["ONE_UNKNOWN", JSON.stringify({ ...good, conclusion: "UNKNOWN", dimensions: rows.map((row, index) => (index === 0 ? { ...row, verdict: "UNKNOWN", problemSpan: null, representationSpan: null } : row)) })],
  ];
  for (const [label, review] of cases) {
    const transport = label === "TRUNCATED" ? "TRUNCATED" : label === "ERROR" ? "ERROR" : label === "UNKNOWN_TRANSPORT" ? "UNKNOWN" : "COMPLETE";
    const result = runP4MappingFixture(
      PROBLEM,
      "s",
      [
        { transportStatus: "COMPLETE", text: built.workRaw },
        { transportStatus: transport, text: review },
      ],
      polyAction(),
      realPort(),
      { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
    );
    assert.equal(result.summary.checkCalls, 0, label);
    assert.equal(result.privateState.diagnostic?.length ?? 0, 0, label);
    assert.equal(result.summary.candidateVerified, false, label);
    assert.equal(JSON.stringify(result.summary).includes(PROBLEM), false, label);
  }
});

test("budgets, port failures and a hostile clock never widen the window", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  for (const [calls, checks] of [[0, 1], [1, 1], [2, 0]] as const) {
    const result = run(polyAction(), review, { maxModelCalls: calls, maxChecks: checks });
    assert.equal(result.summary.checkCalls, 0);
    assert.equal(result.privateState.diagnostic, null);
  }
  const throwing: P3EffectPort = { execute() { throw new Error("boom"); } };
  const failed = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    throwing,
    { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
  );
  assert.equal(failed.summary.checkCalls, 1);
  assert.equal(failed.summary.stopReason, "OUTCOME_UNKNOWN");
  assert.equal(failed.privateState.diagnostic![0]!.evidence, null);
  assert.equal(failed.privateState.diagnostic![0]!.receipt?.status, "UNKNOWN");
  assert.equal(failed.privateState.effectGate?.state, "OUTCOME_UNKNOWN");
  const forged: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      return { ...goodReceipt(request, "{}"), observationHash: "0".repeat(64) } as P3EffectReceipt;
    },
  };
  const rejected = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    forged,
    { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
  );
  assert.equal(rejected.summary.stopReason, "CONTROL_REJECTED");
  assert.equal(rejected.privateState.diagnostic![0]!.state, "DISPATCHED");
  assert.equal(rejected.privateState.diagnostic![0]!.evidence, null);
  assert.equal(rejected.privateState.requests.some((row) => (row as Record<string, unknown>).requestId === "effect-1"), true);
  let ticks = 0;
  const hostile = () => {
    ticks += 1;
    return ticks === 1 ? 0 : 5000;
  };
  const late = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    realPort(),
    { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: hostile },
  );
  assert.equal(late.summary.checkCalls, 0);
  assert.equal(late.privateState.diagnostic, null);
  const strict = run(polyAction(), review, { policy: "STRICT" });
  assert.equal(strict.summary.status, "unsolved");
  assert.equal(strict.privateState.decision.submissionEligibility, "WITHHELD");
  assert.equal(strict.summary.candidateVerified, false);
});

test("clock boundaries, frozen options and a late port never widen the window", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  let tick = 0;
  const advancing: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      tick = 5000;
      return goodReceipt(request, "{}");
    },
  };
  const latePort = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    advancing,
    {
      maxModelCalls: 2,
      maxChecks: 1,
      remainingMs: 5000,
      policy: "BEST_EFFORT",
      now: () => tick,
    },
  );
  assert.equal(latePort.summary.checkCalls, 1);
  assert.equal(latePort.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(latePort.privateState.diagnostic![0]!.evidence, null);
  assert.equal(latePort.privateState.diagnostic![0]!.code, "DEADLINE_EXCEEDED");

  const mutable = {
    maxModelCalls: 1,
    maxChecks: 0,
    remainingMs: 100,
    policy: "BEST_EFFORT" as const,
    now: () => {
      mutable.maxModelCalls = 2;
      mutable.maxChecks = 1;
      mutable.remainingMs = 5000;
      mutable.now = () => Number.NaN;
      return 0;
    },
  };
  const frozenOptions = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    realPort(),
    mutable,
  );
  assert.equal(frozenOptions.summary.modelCalls, 1);
  assert.equal(frozenOptions.summary.checkCalls, 0);
  assert.equal(frozenOptions.summary.candidateVerified, false);

  for (const bad of [
    () => Number.NaN,
    () => {
      throw new Error("clock");
    },
  ]) {
    let portCalls = 0;
    const counting: P3EffectPort = {
      execute(request: P3EffectRequest): P3EffectReceipt {
        portCalls += 1;
        return goodReceipt(request, "{}");
      },
    };
    assert.throws(
      () =>
        runP4MappingFixture(
          PROBLEM,
          "s",
          [
            { transportStatus: "COMPLETE", text: built.workRaw },
            { transportStatus: "COMPLETE", text: review },
          ],
          polyAction(),
          counting,
          { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: bad },
        ),
      (error: unknown) => error instanceof P2Error && error.code === "DEADLINE_EXCEEDED",
    );
    assert.equal(portCalls, 0);
  }

  for (const bad of [
    () => Number.NaN,
    () => {
      throw new Error("clock");
    },
    () => -1,
  ]) {
    let calls = 0;
    const result = runP4MappingFixture(
      PROBLEM,
      "s",
      [
        { transportStatus: "COMPLETE", text: built.workRaw },
        { transportStatus: "COMPLETE", text: review },
      ],
      polyAction(),
      realPort(),
      {
        maxModelCalls: 2,
        maxChecks: 1,
        remainingMs: 5000,
        policy: "BEST_EFFORT",
        now: () => (++calls === 1 ? 100 : bad()),
      },
    );
    assert.equal(result.summary.modelCalls, 0);
    assert.equal(result.summary.checkCalls, 0);
    assert.equal(result.summary.status, "unsolved");
    assert.equal(result.summary.candidateVerified, false);
  }

  const seen: P3EffectRequest[] = [];
  const recording: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      seen.push(request);
      return goodReceipt(request, "{}");
    },
  };
  const bounded = runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: review },
    ],
    polyAction(),
    recording,
    { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
  );
  assert.equal(bounded.summary.checkCalls, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.remainingMs <= 5000, true);
  assert.equal(bounded.privateState.mapping?.record?.level, "REVIEWED");
  assert.equal(bounded.privateState.mapping?.record?.checkResult, "UNKNOWN");
  assert.equal(bounded.privateState.mapping?.record?.canSupportObligation, false);
});

function goodReceipt(request: P3EffectRequest, observation: string): P3EffectReceipt {
  return {
    effectId: request.effectId,
    binding: request.binding,
    status: "COMPLETE",
    source: "PROGRAM_OBSERVATION",
    observation,
    observationHash: p4HashOf(observation),
    level: "PROVISIONAL",
    checkResult: "UNKNOWN",
  } as P3EffectReceipt;
}

function p4HashOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
