import { test } from "node:test";
import assert from "node:assert/strict";
import { runP4MappingFixture } from "../src/p4-mapping-fixture.js";
import {
  MAPPING_PROBLEM,
  buildMapping,
  polyAction,
  reportMapping,
} from "./p4-mapping-fixtures.js";
import {
  P2Error,
  p4Hash,
  type P3Action,
  type P3EffectPort,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";

const PROBLEM = MAPPING_PROBLEM;
const SECRET = "SECRET_BOUNDARY_MARKER";

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

function countingPort(): { readonly port: P3EffectPort; readonly calls: () => number } {
  let calls = 0;
  const port: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      calls += 1;
      return goodReceipt(request, JSON.stringify({ tool: "polynomial_expand_coefficients", result: {}, interpretation: "OBSERVATION_NOT_PROOF" }));
    },
  };
  return { port, calls: () => calls };
}

function run(
  port: P3EffectPort,
  policy: "BEST_EFFORT" | "STRICT",
  now: () => number = () => 0,
) {
  const built = buildMapping();
  return runP4MappingFixture(
    PROBLEM,
    "s",
    [
      { transportStatus: "COMPLETE", text: built.workRaw },
      { transportStatus: "COMPLETE", text: reportMapping(built) },
    ],
    polyAction(),
    port,
    { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy, now },
  );
}

function effectRequestRow(result: ReturnType<typeof run>): Record<string, unknown> {
  const row = result.privateState.requests.find(
    (item) => (item as Record<string, unknown>).requestId === "effect-1",
  );
  assert.ok(row !== undefined);
  return row as Record<string, unknown>;
}

test("non-JSON port returns keep the protected parent and never retry", () => {
  const cyclic: Record<string, unknown> = { marker: SECRET };
  cyclic.self = cyclic;
  const cases: readonly [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["function", () => () => SECRET],
    ["nan", () => Number.NaN],
    ["date", () => new Date(0)],
    ["cyclic", () => cyclic],
    [
      "getter",
      () => {
        const hostile = {
          get effectId(): string {
            throw new Error(SECRET);
          },
        };
        return hostile;
      },
    ],
  ];
  for (const [label, make] of cases) {
    for (const policy of ["BEST_EFFORT", "STRICT"] as const) {
      let calls = 0;
      const port: P3EffectPort = {
        execute(): P3EffectReceipt {
          calls += 1;
          return make() as P3EffectReceipt;
        },
      };
      const result = run(port, policy);
      assert.equal(calls, 1, `${label}/${policy}`);
      assert.equal(result.summary.modelCalls, 2, `${label}/${policy}`);
      assert.equal(result.summary.checkCalls, 1, `${label}/${policy}`);
      assert.equal(result.summary.parentProtected, true, `${label}/${policy}`);
      assert.equal(result.privateState.effectGate?.state, "DISPATCHED", `${label}/${policy}`);
      assert.equal(result.privateState.effectGate?.receipt, null, `${label}/${policy}`);
      assert.equal(result.privateState.diagnostic![0]!.state, "DISPATCHED", `${label}/${policy}`);
      assert.equal(result.privateState.diagnostic![0]!.receipt, null, `${label}/${policy}`);
      assert.equal(result.privateState.diagnostic![0]!.evidence, null, `${label}/${policy}`);
      const row = effectRequestRow(result);
      assert.equal(row.receiptCode, "UNSERIALIZABLE_RECEIPT", `${label}/${policy}`);
      assert.equal(row.receipt, null, `${label}/${policy}`);
      assert.equal(result.summary.candidateVerified, false, `${label}/${policy}`);
      assert.equal(JSON.stringify(result.summary).includes(SECRET), false, `${label}/${policy}`);
      if (policy === "BEST_EFFORT") {
        assert.equal(result.summary.finalResponse, "x=1", label);
      } else {
        assert.equal(result.summary.status, "unsolved", label);
      }
    }
  }
});

test("forged JSON receipts are preserved raw and rejected without success", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  const attacks: readonly [string, (request: P3EffectRequest) => unknown][] = [
    ["empty", () => ({})],
    ["null", () => null],
    ["string", () => SECRET],
    ["effectId", (request) => ({ ...goodReceipt(request, "{}"), effectId: "effect-2" })],
    ["sourceRequestId", (request) => ({ ...goodReceipt(request, "{}"), binding: { ...request.binding, sourceRequestId: "model-3" } })],
    ["hash", (request) => ({ ...goodReceipt(request, "{}"), observationHash: "0".repeat(64) })],
    ["level", (request) => ({ ...goodReceipt(request, "{}"), level: "CHECKED_SCOPE" })],
    ["source", (request) => ({ ...goodReceipt(request, "{}"), source: "METHOD_REFERENCE" })],
    ["status", (request) => ({ ...goodReceipt(request, "{}"), status: "PASS" })],
  ];
  for (const [label, make] of attacks) {
    let calls = 0;
    let raw: unknown = null;
    const port: P3EffectPort = {
      execute(request: P3EffectRequest): P3EffectReceipt {
        calls += 1;
        raw = make(request);
        return raw as P3EffectReceipt;
      },
    };
    const result = runP4MappingFixture(
      PROBLEM,
      "s",
      [
        { transportStatus: "COMPLETE", text: built.workRaw },
        { transportStatus: "COMPLETE", text: review },
      ],
      polyAction(),
      port,
      { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
    );
    assert.equal(calls, 1, label);
    assert.equal(result.privateState.effectGate?.state, "DISPATCHED", label);
    assert.equal(result.privateState.diagnostic![0]!.state, "DISPATCHED", label);
    assert.equal(result.privateState.diagnostic![0]!.evidence, null, label);
    assert.equal(result.summary.parentProtected, true, label);
    const row = effectRequestRow(result);
    assert.equal(row.receiptCode, "RECEIVED", label);
    assert.deepEqual(row.receipt, JSON.parse(JSON.stringify(raw)), label);
    assert.equal(result.summary.candidateVerified, false, label);
    assert.equal(result.privateState.mapping?.record?.checkResult, "UNKNOWN", label);
  }
});

test("non-MATCH and incomplete reviews never reach the port", () => {
  const built = buildMapping();
  const good = JSON.parse(reportMapping(built)) as Record<string, unknown>;
  const rows = good.dimensions as Record<string, unknown>[];
  const cases: readonly [string, string, "COMPLETE" | "TRUNCATED" | "ERROR" | "UNKNOWN"][] = [
    ["MISMATCH", reportMapping(built, "MISMATCH"), "COMPLETE"],
    ["UNKNOWN", reportMapping(built, "UNKNOWN"), "COMPLETE"],
    [
      "ONE_UNKNOWN",
      JSON.stringify({
        ...good,
        conclusion: "UNKNOWN",
        dimensions: rows.map((row, index) =>
          index === 0 ? { ...row, verdict: "UNKNOWN", problemSpan: null, representationSpan: null } : row,
        ),
      }),
      "COMPLETE",
    ],
    ["MALFORMED", "{", "COMPLETE"],
    ["MISSING_DIMENSION", JSON.stringify({ ...good, dimensions: rows.slice(0, 4) }), "COMPLETE"],
    ["BAD_PLAN_HASH", JSON.stringify({ ...good, planHash: "0".repeat(64) }), "COMPLETE"],
    ["TRUNCATED", reportMapping(built), "TRUNCATED"],
    ["ERROR", reportMapping(built), "ERROR"],
    ["UNKNOWN_TRANSPORT", reportMapping(built), "UNKNOWN"],
  ];
  for (const [label, review, transport] of cases) {
    const { port, calls } = countingPort();
    const result = runP4MappingFixture(
      PROBLEM,
      "s",
      [
        { transportStatus: "COMPLETE", text: built.workRaw },
        { transportStatus: transport, text: review },
      ],
      polyAction(),
      port,
      { maxModelCalls: 2, maxChecks: 1, remainingMs: 5000, policy: "BEST_EFFORT", now: () => 0 },
    );
    assert.equal(calls(), 0, label);
    assert.equal(result.summary.modelCalls, 2, label);
    assert.equal(result.summary.reviewCalls, 1, label);
    assert.equal(result.summary.checkCalls, 0, label);
    assert.equal(result.summary.parentProtected, true, label);
    assert.equal(Array.isArray(result.privateState.diagnostic), true, label);
    assert.equal(result.privateState.diagnostic!.length, 0, label);
    assert.equal(result.privateState.effectGate, null, label);
    assert.equal(result.privateState.mapping?.record?.rawResponseText, review, label);
    assert.equal(result.summary.candidateVerified, false, label);
  }
});

test("a clock that fails after dispatch never widens the window", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  const receipts = [
    { transportStatus: "COMPLETE" as const, text: built.workRaw },
    { transportStatus: "COMPLETE" as const, text: review },
  ];
  let probeTick = 0;
  let portTick = -1;
  const probePort: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      portTick = probeTick;
      return goodReceipt(request, "{}");
    },
  };
  runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), probePort, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      probeTick += 1;
      return 100;
    },
  });
  assert.equal(portTick > 0, true);

  for (const bad of [
    () => Number.NaN,
    () => 99,
    () => {
      throw new Error(SECRET);
    },
  ]) {
    for (const target of [portTick - 1, portTick, portTick + 1]) {
      let tick = 0;
      let calls = 0;
      const port: P3EffectPort = {
        execute(request: P3EffectRequest): P3EffectReceipt {
          calls += 1;
          return goodReceipt(request, "{}");
        },
      };
      const result = runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), port, {
        maxModelCalls: 2,
        maxChecks: 1,
        remainingMs: 5000,
        policy: "BEST_EFFORT",
        now: () => {
          tick += 1;
          return tick === target ? bad() : 100;
        },
      });
      assert.equal(result.summary.modelCalls <= 2, true);
      assert.equal(result.summary.checkCalls <= 1, true);
      assert.equal(result.summary.checkCalls, calls);
      assert.equal(result.summary.candidateVerified, false);
      assert.equal(JSON.stringify(result.summary).includes(SECRET), false);
      if (calls === 0) {
        const records = result.privateState.diagnostic;
        assert.equal(Array.isArray(records), true);
        for (const record of records!) {
          assert.equal(record.state, "ADMITTED");
          assert.equal(record.receipt, null);
          assert.equal(record.evidence, null);
        }
        const gate = result.privateState.effectGate;
        assert.equal(gate === null || gate.state === "ADMITTED", true);
      } else {
        assert.equal(result.privateState.effectGate?.state, "OBSERVED");
        assert.equal(result.privateState.effectGate?.code, "DEADLINE_EXCEEDED");
        assert.equal(result.privateState.diagnostic![0]!.state, "OBSERVED");
        assert.equal(result.privateState.diagnostic![0]!.code, "DEADLINE_EXCEEDED");
        assert.equal(result.privateState.diagnostic![0]!.evidence, null);
        assert.equal(result.summary.status, "unsolved");
        assert.equal(result.summary.parentProtected, true);
      }
    }
  }

  let flag = false;
  let tick = 0;
  let calls = 0;
  const flagPort: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      calls += 1;
      flag = true;
      return goodReceipt(request, "{}");
    },
  };
  const late = runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), flagPort, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      tick += 1;
      return flag ? Number.NaN : 100;
    },
  });
  assert.equal(calls, 1);
  assert.equal(late.summary.checkCalls, 1);
  assert.equal(late.privateState.effectGate?.code, "DEADLINE_EXCEEDED");
  assert.equal(late.privateState.diagnostic![0]!.code, "DEADLINE_EXCEEDED");
  assert.equal(late.privateState.diagnostic![0]!.evidence, null);
  assert.equal(late.summary.status, "unsolved");
  assert.equal(late.summary.parentProtected, true);

  let unknownTick = 0;
  let unknownFlag = false;
  const unknownPort: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      unknownFlag = true;
      return { ...goodReceipt(request, "{}"), status: "UNKNOWN" } as P3EffectReceipt;
    },
  };
  const unknown = runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), unknownPort, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      unknownTick += 1;
      return unknownFlag ? Number.NaN : 100;
    },
  });
  assert.equal(unknown.summary.stopReason, "OUTCOME_UNKNOWN");
  assert.equal(unknown.privateState.effectGate?.code, "OUTCOME_UNKNOWN");
  assert.equal(unknown.privateState.diagnostic![0]!.evidence, null);
  assert.equal(unknown.summary.parentProtected, true);
});

test("inputs are snapshotted before any callback can mutate them", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  const receipts = [
    { transportStatus: "COMPLETE" as const, text: built.workRaw },
    { transportStatus: "COMPLETE" as const, text: review },
  ];
  const action = polyAction() as { action: "tool"; name: string; args: Record<string, unknown>; scope: string };
  let calls = 0;
  const port: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      calls += 1;
      return goodReceipt(request, "{}");
    },
  };
  const result = runP4MappingFixture(PROBLEM, "s", receipts, action as never, port, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      receipts[1]!.text = "{";
      action.args.expression = 1.5;
      (port as { execute: unknown }).execute = () => {
        throw new Error(SECRET);
      };
      return 0;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.summary.modelCalls, 2);
  assert.equal(result.summary.checkCalls, 1);
  assert.equal(result.summary.mappingConclusion, "MATCH");
  assert.equal(result.privateState.mapping?.record?.rawResponseText, review);
  assert.equal(result.summary.parentProtected, true);
  assert.equal(JSON.stringify(result.summary).includes(SECRET), false);
});

test("the execution window is clamped to the last pre-dispatch time check", () => {
  const built = buildMapping();
  const review = reportMapping(built);
  const receipts = [
    { transportStatus: "COMPLETE" as const, text: built.workRaw },
    { transportStatus: "COMPLETE" as const, text: review },
  ];
  const seen: P3EffectRequest[] = [];
  const port: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      seen.push(request);
      return goodReceipt(request, "{}");
    },
  };
  let ticks = 0;
  let dispatchTick = -1;
  const result = runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), port, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      ticks += 1;
      if (ticks === 12) {
        dispatchTick = ticks;
      }
      return ticks <= 11 ? 100 : 2100;
    },
  });
  assert.equal(dispatchTick, 12);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.remainingMs, 3000);
  assert.equal(result.summary.checkCalls, 1);
  const row = effectRequestRow(result);
  const admitted = row.admittedEffectRequest as P3EffectRequest;
  const executed = row.effectRequest as P3EffectRequest;
  assert.equal(admitted.remainingMs, 5000);
  assert.equal(executed.remainingMs, 3000);
  assert.equal(executed.effectId, admitted.effectId);
  assert.deepEqual(executed.binding, admitted.binding);
  assert.deepEqual(executed.action, admitted.action);
  assert.equal(result.privateState.effectGate?.request.remainingMs, 5000);
  assert.equal(result.privateState.diagnostic![0]!.plan.request.remainingMs, 5000);
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.summary.parentProtected, true);

  const lateSeen: P3EffectRequest[] = [];
  const latePort: P3EffectPort = {
    execute(request: P3EffectRequest): P3EffectReceipt {
      lateSeen.push(request);
      return goodReceipt(request, "{}");
    },
  };
  let lateTicks = 0;
  const late = runP4MappingFixture(PROBLEM, "s", receipts, polyAction(), latePort, {
    maxModelCalls: 2,
    maxChecks: 1,
    remainingMs: 5000,
    policy: "BEST_EFFORT",
    now: () => {
      lateTicks += 1;
      return lateTicks <= 11 ? 100 : 5075;
    },
  });
  assert.equal(lateSeen.length, 0);
  assert.equal(late.summary.checkCalls, 0);
  assert.equal(late.summary.stopReason, "DEADLINE_EXCEEDED");
  assert.equal(late.privateState.effectGate?.state, "ADMITTED");
  assert.equal(late.privateState.diagnostic![0]!.state, "ADMITTED");
  assert.equal(late.privateState.diagnostic![0]!.receipt, null);
  assert.equal(late.summary.parentProtected, true);
});
