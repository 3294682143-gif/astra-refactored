/**
 * Unified AgentSession root-clock/counter tests plus AgentLoop clock-fault,
 * real-time timeout and capture-before-clock boundary tests.
 *
 * Pure in-process: no network, no child process, no fixture, no prefilled
 * receipt. Every port is a real async function. Nothing here is acceptance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  P2Error,
  type AgentModelReceipt,
  type AgentModelRequest,
  type AgentLoopOptions,
  type AgentPorts,
  type P3EffectReceipt,
  type P3EffectRequest,
} from "@astra/protocol";
import { AgentSession } from "@astra/runtime-core";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  reactivePorts,
  reactiveTool,
  reactiveWork,
  reviewReply,
  type ReactivePorts,
} from "./agent-loop-test-support.js";

const PROBLEM = "Compute 2+2";
const SESSION = "s";
const HASH = "0".repeat(64);

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof P2Error && error.code === code);
}

function sessionOf(maxModelCalls = 4, maxEffects = 2, now: () => number = () => 0): AgentSession {
  return new AgentSession({
    sessionId: SESSION,
    problemHash: HASH,
    maxModelCalls,
    maxEffects,
    remainingMs: 1000,
    now,
  });
}

function portsOf(ports: ReactivePorts): AgentPorts {
  return { model: ports.model, effect: ports.effect };
}

test("AgentSession shares one root ceiling of 4 model and 2 effect calls with a continuous seq", () => {
  const root = sessionOf();
  assert.equal(root.nextModelId(), "model-1");
  assert.equal(root.reserveModel("WORK"), "model-1");
  assert.equal(root.nextModelId(), "model-2");
  root.settleModel("model-1", "COMPLETE");
  assert.equal(root.reserveModel("WORK"), "model-2");
  root.settleModel("model-2", "COMPLETE");
  assert.equal(root.reserveEffect("effect-1"), "effect-1");
  root.settleEffect("effect-1", "COMPLETE");
  assert.equal(root.reserveModel("R2"), "model-3");
  root.settleModel("model-3", "COMPLETE");
  assert.equal(root.reserveEffect("effect-2"), "effect-2");
  root.settleEffect("effect-2", "COMPLETE");
  assert.equal(root.reserveModel("R2"), "model-4");
  root.settleModel("model-4", "COMPLETE");
  assert.equal(root.nextModelId(), null);
  expectCode(() => root.reserveModel("WORK"), "BUDGET_EXHAUSTED");
  expectCode(() => root.reserveEffect("effect-1"), "BUDGET_EXHAUSTED");
  assert.equal(root.modelCalls(), 4);
  assert.equal(root.effectCalls(), 2);
  const snapshot = root.snapshot();
  assert.deepEqual(
    snapshot.events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.events), true);
  assert.equal(Object.isFrozen(snapshot.events[0]), true);
  assert.throws(() => {
    (snapshot.events as unknown as { push: (value: unknown) => void }).push({});
  }, TypeError);
});

test("AgentSession refuses replays, a pending stop and an illegal cap without mutation", () => {
  const root = sessionOf();
  root.reserveModel("WORK");
  expectCode(() => root.reserveModel("WORK"), "ILLEGAL_TRANSITION");
  expectCode(() => root.stop("STOPPED"), "ILLEGAL_TRANSITION");
  expectCode(() => root.settleModel("model-2", "COMPLETE"), "ILLEGAL_TRANSITION");
  root.settleModel("model-1", "COMPLETE");
  expectCode(() => root.settleModel("model-1", "COMPLETE"), "ILLEGAL_TRANSITION");
  root.stop("STOPPED");
  root.stop("STOPPED");
  assert.equal(root.stopped(), true);
  assert.equal(root.snapshot().events.filter((event) => event.kind === "CONTROL").length, 1);
  expectCode(() => root.reserveModel("WORK"), "ILLEGAL_TRANSITION");
  for (const bad of [-1, 33, 1.5, Number.NaN, true]) {
    expectCode(
      () =>
        new AgentSession({
          sessionId: SESSION,
          problemHash: HASH,
          maxModelCalls: bad as never,
          maxEffects: 2,
          remainingMs: 1000,
          now: () => 0,
        }),
      "BOUND_EXCEEDED",
    );
  }
  for (const bad of [-1, 3, 1.5, Number.NaN]) {
    expectCode(
      () =>
        new AgentSession({
          sessionId: SESSION,
          problemHash: HASH,
          maxModelCalls: 4,
          maxEffects: bad as never,
          remainingMs: 1000,
          now: () => 0,
        }),
      "BOUND_EXCEEDED",
    );
  }
});

test("AgentSession tightenRemaining only shrinks and a zero tighten is permanent", () => {
  let now = 0;
  const root = sessionOf(4, 2, () => now);
  assert.equal(root.remainingMs(), 1000);
  assert.equal(root.tightenRemaining(5000), 1000);
  assert.equal(root.remainingMs(), 1000);
  assert.equal(root.tightenRemaining(400), 400);
  assert.equal(root.remainingMs(), 400);
  assert.equal(root.tightenRemaining(900), 400);
  now = 100;
  assert.equal(root.remainingMs(), 300);
  assert.equal(root.tightenRemaining(0), 0);
  assert.equal(root.remainingMs(), 0);
  now = 0;
  assert.equal(root.remainingMs(), 0);
  expectCode(() => root.tightenRemaining(3600001), "BOUND_EXCEEDED");
  expectCode(() => root.tightenRemaining(-1), "BOUND_EXCEEDED");
});

test("AgentSession pins the remaining view to zero after a NaN, rewinding or throwing clock", () => {
  const cases: readonly (() => number)[] = [
    () => Number.NaN,
    () => -1,
    () => {
      throw new Error("clock exploded: secret-token");
    },
  ];
  for (const bad of cases) {
    let calls = 0;
    const root = sessionOf(4, 2, () => {
      calls += 1;
      return calls === 1 ? 0 : bad();
    });
    assert.equal(root.remainingMs(), 0);
    assert.equal(root.remainingMs(), 0);
    assert.equal(root.tightenRemaining(500), 0);
    expectCode(() => root.reserveModel("WORK"), "DEADLINE_EXCEEDED");
    assert.equal(root.modelCalls(), 0);
    assert.equal(root.snapshot().events.length, 0);
  }
});

test("AgentSession refuses an effect reservation that would leave no follow-up model call", () => {
  const root = sessionOf(1, 2);
  assert.equal(root.reserveModel("WORK"), "model-1");
  root.settleModel("model-1", "COMPLETE");
  expectCode(() => root.reserveEffect("effect-1"), "BUDGET_EXHAUSTED");
  assert.equal(root.effectCalls(), 0);
  assert.equal(root.snapshot().pendingEffect, null);
  const roomy = sessionOf(2, 2);
  roomy.reserveModel("WORK");
  roomy.settleModel("model-1", "COMPLETE");
  assert.equal(roomy.reserveEffect("effect-1"), "effect-1");
  roomy.settleEffect("effect-1", "COMPLETE");
  assert.equal(roomy.effectCalls(), 1);
});

test("a clock that fails after the first sample never refreshes the root budget", async () => {
  const baseline = reactivePorts();
  const baselineResult = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 1000, now: () => 0 },
    portsOf(baseline),
  );
  const baselineCalls = baselineResult.summary.modelCalls;
  assert.ok(baselineCalls >= 1);
  assert.equal(baselineResult.summary.modelCalls, baseline.requests.length);
  assert.equal(baselineResult.summary.modelCalls, baselineResult.privateState.modelGate.length);

  const faults: readonly (() => number)[] = [
    () => Number.NaN,
    () => {
      throw new Error("clock exploded: secret-token");
    },
  ];
  for (const fault of faults) {
    for (let failAt = 1; failAt <= 12; failAt += 1) {
      let calls = 0;
      const ports = reactivePorts();
      const options = {
        remainingMs: 1000,
        now: () => {
          calls += 1;
          return calls === failAt ? fault() : 0;
        },
      };
      if (failAt === 1) {
        await assert.rejects(
          () => runAgentLoop(PROBLEM, SESSION, options, portsOf(ports)),
          (error: unknown) => error instanceof P2Error && error.code === "DEADLINE_EXCEEDED",
        );
        assert.equal(ports.requests.length, 0);
        continue;
      }
      const result = await runAgentLoop(PROBLEM, SESSION, options, portsOf(ports));
      assert.ok(result.summary.modelCalls <= 4);
      assert.ok(ports.requests.length <= result.summary.modelCalls);
      assert.ok(result.summary.modelCalls <= result.privateState.modelGate.length);
      assert.ok(result.privateState.modelGate.length <= 4);
      assert.equal(result.summary.modelCalls, result.privateState.session.modelCalls);
      assert.equal(result.summary.effectCalls, result.privateState.session.effectCalls);
      const dispatched = result.privateState.session.events.filter(
        (event) => event.kind === "MODEL" && event.state === "DISPATCHED",
      );
      assert.equal(dispatched.length, result.summary.modelCalls);
      for (const record of result.privateState.modelGate as readonly {
        readonly state: string;
        readonly requestId: string;
      }[]) {
        if (record.state === "ADMITTED") {
          const row = (result.privateState.requests as readonly {
            readonly request?: { readonly requestId?: string };
            readonly receipt?: unknown;
          }[]).find((item) => item.request?.requestId === record.requestId);
          if (row !== undefined) {
            assert.equal(row.receipt, null);
          }
          assert.equal(
            result.privateState.session.events.some(
              (event) => event.kind === "MODEL" && event.state === "DISPATCHED" && event.id === record.requestId,
            ),
            false,
          );
        }
      }
      const portIds = new Set(ports.requests.map((request) => request.requestId));
      for (const row of result.privateState.requests as readonly {
        readonly request?: { readonly requestId?: string };
        readonly receipt: { readonly transportStatus: string } | null;
      }[]) {
        if (row.receipt === null) {
          continue;
        }
        const requestId = row.request?.requestId;
        if (requestId !== undefined && !portIds.has(requestId)) {
          assert.equal(row.receipt.transportStatus, "UNKNOWN");
        }
      }
      assert.ok(result.summary.modelCalls <= result.privateState.modelGate.length);
      assert.ok(result.privateState.modelGate.length <= 4);
      assert.ok(ports.requests.length <= result.summary.modelCalls);
      assert.equal(result.summary.candidateVerified, false);
      assert.equal(result.summary.strictAcceptance, "NOT_PERFORMED");
      assert.equal(result.privateState.session.pendingModel, null);
      assert.equal(result.privateState.session.pendingEffect, null);
      assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
      for (const obligation of result.privateState.contract.obligations) {
        assert.notEqual(obligation.status, "SATISFIED");
      }
    }
  }
});

test("a real-time model timeout ends the root as OUTCOME_UNKNOWN with no retry", async () => {
  let seen = 0;
  const ports: AgentPorts = {
    model: {
      async generate(): Promise<AgentModelReceipt> {
        seen += 1;
        return new Promise<AgentModelReceipt>(() => undefined);
      },
    },
    effect: null,
  };
  const started = performance.now();
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 300, now: () => performance.now() },
    ports,
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `elapsed ${elapsed}`);
  assert.equal(seen, 1);
  assert.equal(result.summary.modelCalls, 1);
  assert.equal(result.summary.effectCalls, 0);
  assert.equal(result.summary.status, "unsolved");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.session.pendingModel, null);
  assert.equal(result.privateState.session.pendingEffect, null);
  assert.equal(result.privateState.session.stopped, true);
  const last = result.privateState.modelGate.at(-1) as { readonly state: string };
  assert.equal(last.state, "OUTCOME_UNKNOWN");
});

test("a real-time effect timeout ends the same root as UNKNOWN without a second model call", async () => {
  let work = 0;
  let effects = 0;
  const ports: AgentPorts = {
    model: {
      async generate(request: AgentModelRequest): Promise<AgentModelReceipt> {
        work += 1;
        return { transportStatus: "COMPLETE", text: work === 1 ? reactiveTool() : reactiveWork(request) };
      },
    },
    effect: {
      async execute(): Promise<P3EffectReceipt> {
        effects += 1;
        return new Promise<P3EffectReceipt>(() => undefined);
      },
    },
  };
  const started = performance.now();
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 300, now: () => performance.now() },
    ports,
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `elapsed ${elapsed}`);
  assert.equal(work, 1);
  assert.equal(effects, 1);
  assert.equal(result.summary.modelCalls, 1);
  assert.equal(result.summary.effectCalls, 1);
  assert.equal(result.summary.status, "unsolved");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.session.pendingModel, null);
  assert.equal(result.privateState.session.pendingEffect, null);
  assert.equal(result.privateState.session.stopped, true);
});

test("a late rejection after a real-time timeout is observed and never unhandled", async () => {
  const ports: AgentPorts = {
    model: {
      async generate(): Promise<AgentModelReceipt> {
        return new Promise<AgentModelReceipt>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("late rejection: secret-token"));
          }, 350);
        });
      },
    },
    effect: null,
  };
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    { remainingMs: 300, now: () => performance.now() },
    ports,
  );
  assert.equal(result.summary.modelCalls, 1);
  assert.equal(result.privateState.session.pendingModel, null);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
});

test("options and ports are captured before the first clock callback", async () => {
  const reads: string[] = [];
  const original = reactivePorts();
  let clockCalls = 0;
  const options: Record<string, unknown> = {};
  for (const key of ["maxModelCalls", "maxWorkUnits", "maxEffects", "maxReviews", "remainingMs", "policy", "now", "goalSpecs"] as const) {
    Object.defineProperty(options, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads.push(key);
        if (key === "maxModelCalls") {
          return 4;
        }
        if (key === "remainingMs") {
          return 1000;
        }
        if (key === "now") {
          return () => {
            clockCalls += 1;
            if (clockCalls === 1) {
              Object.defineProperty(options, "maxModelCalls", {
                value: 0,
                writable: true,
                configurable: true,
                enumerable: true,
              });
              Object.defineProperty(options, "remainingMs", {
                value: 5000,
                writable: true,
                configurable: true,
                enumerable: true,
              });
              ports.model = {
                async generate(): Promise<AgentModelReceipt> {
                  throw new Error("mutated port: secret-token");
                },
              };
            }
            return 0;
          };
        }
        return undefined;
      },
    });
  }
  const ports: Record<string, unknown> = {
    model: original.model,
    effect: original.effect,
  };
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    options as unknown as AgentLoopOptions,
    ports as unknown as AgentPorts,
  );
  assert.equal(clockCalls >= 1, true);
  assert.equal(result.summary.modelCalls, 3);
  assert.equal(result.summary.modelCalls, original.requests.length);
  assert.equal(result.summary.effectCalls, original.effects.length);
  assert.equal(result.summary.status, "candidate");
  assert.equal(result.summary.finalResponse, "4");
  assert.equal(result.summary.candidateVerified, false);
  assert.equal(result.privateState.session.pendingModel, null);
  assert.equal(result.privateState.session.pendingEffect, null);
  assert.equal(JSON.stringify(result.summary).includes("secret-token"), false);
  for (const key of ["maxModelCalls", "maxWorkUnits", "maxEffects", "maxReviews", "remainingMs", "policy", "now", "goalSpecs"]) {
    assert.equal(reads.filter((entry) => entry === key).length, 1, key);
  }
  assert.equal(original.requests.length, 3);
  for (const request of original.requests) {
    assert.ok(request.remainingMs <= 1000);
  }
  assert.equal(original.requests.at(-1)?.phase, "R2");
  assert.equal(reviewReply(original.requests.at(-1)!).length > 0, true);
});

test("a pending-only clock fault leaves no exception and no extra port call", async () => {
  const ports = reactivePorts();
  let calls = 0;
  const result = await runAgentLoop(
    PROBLEM,
    SESSION,
    {
      remainingMs: 1000,
      now: () => {
        calls += 1;
        return calls === 1 ? 0 : Number.NaN;
      },
    },
    portsOf(ports),
  );
  assert.ok(result.summary.modelCalls <= 4);
  assert.equal(result.summary.modelCalls, ports.requests.length);
  assert.equal(result.privateState.session.pendingModel, null);
  assert.equal(result.privateState.session.pendingEffect, null);
  assert.equal(result.summary.candidateVerified, false);
});

test("a fractional start clock constructs and never widens the root budget", () => {
  const root = new AgentSession({
    sessionId: SESSION,
    problemHash: HASH,
    maxModelCalls: 4,
    maxEffects: 2,
    remainingMs: 1000,
    now: () => 123.456789,
  });
  const remaining = root.remainingMs();
  assert.ok(remaining >= 0);
  assert.ok(remaining <= 1000);
  assert.equal(root.tightenRemaining(0), 0);
  assert.equal(root.remainingMs(), 0);
  assert.equal(root.tightenRemaining(1000), 0);
  assert.equal(root.remainingMs(), 0);
  for (const started of [0.1, 0.5, 1.0000000000000002, 123.456789, 999.9999999999999]) {
    const session = new AgentSession({
      sessionId: SESSION,
      problemHash: HASH,
      maxModelCalls: 4,
      maxEffects: 2,
      remainingMs: 1000,
      now: () => started,
    });
    const left = session.remainingMs();
    assert.ok(left >= 0, String(started));
    assert.ok(left <= 1000, String(started));
  }
  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 1e308]) {
    assert.throws(
      () =>
        new AgentSession({
          sessionId: SESSION,
          problemHash: HASH,
          maxModelCalls: 4,
          maxEffects: 2,
          remainingMs: 1000,
          now: () => bad,
        }),
      (error: unknown) => error instanceof P2Error && error.code === "DEADLINE_EXCEEDED",
    );
  }
});
